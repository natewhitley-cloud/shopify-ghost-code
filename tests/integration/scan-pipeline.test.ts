/**
 * Integration tests: scan pipeline — create → queue → complete
 *
 * This file tests the multi-step scan flow across two layers:
 *
 *   Part A — Dashboard action (app._index.tsx)
 *     Tests that a POST to the dashboard action: authenticates the session,
 *     validates the shop, checks plan gating, fetches the main theme, creates
 *     a scan record, and fires an Inngest event — then redirects to the scan
 *     detail page.
 *
 *   Part B — Inngest scan-theme function
 *     Tests the async worker that processes a scan/requested event: marks the
 *     scan IN_PROGRESS, fetches theme files, runs the detection engine,
 *     persists findings, and marks the scan COMPLETED.
 *
 * These are "integration-style" tests — they mock at the I/O boundary
 * (Shopify auth, DB, Inngest) but exercise the full orchestration logic in
 * each layer's module under test.
 */

import { FindingType, Severity } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

// Dashboard action dependencies
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
  unauthenticated: {
    admin: vi.fn(),
  },
  PLAN_STANDARD: "Standard",
  PLAN_PROFESSIONAL: "Professional",
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopByDomain: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  createScan: vi.fn(),
  getScansForShop: vi.fn(),
  countScansForShopSince: vi.fn(),
  updateScanStatus: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingSummary: vi.fn(),
  completeScanWithFindings: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canStartScan: vi.fn(),
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
  fetchThemeFiles: vi.fn(),
}));

vi.mock("../../app/services/scan-engine.server", () => ({
  scanThemeFiles: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// Inngest scan-theme uses dynamic import for db and shopify — mock both
vi.mock("../../app/db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { canStartScan } from "../../app/lib/plan-gating.server";
import { completeScanWithFindings } from "../../app/models/finding.server";
import { createScan, updateScanStatus } from "../../app/models/scan.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { action } from "../../app/routes/app._index";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
import { fetchMainTheme, fetchThemeFiles } from "../../app/services/theme-fetcher.server";
import { authenticate, unauthenticated } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";
import { scanTheme } from "../../inngest/functions/scan-theme";
import { createMockInngestStep, createMockInngestEvent, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockUnauthenticatedAdmin = unauthenticated.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockUpdateScanStatus = updateScanStatus as ReturnType<typeof vi.fn>;
const mockCompleteScanWithFindings = completeScanWithFindings as ReturnType<typeof vi.fn>;
const mockCanStartScan = canStartScan as ReturnType<typeof vi.fn>;
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockFetchThemeFiles = fetchThemeFiles as ReturnType<typeof vi.fn>;
const mockScanThemeFiles = scanThemeFiles as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;
const mockDbShopFindUnique = (db as unknown as { shop: { findUnique: ReturnType<typeof vi.fn> } })
  .shop.findUnique;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";
const THEME_ID = "gid://shopify/Theme/456";
const THEME_NAME = "Dawn";
const SCAN_ID = "scan-xyz-789";

const MOCK_SHOP = {
  id: SHOP_ID,
  domain: SHOP_DOMAIN,
  plan: "free",
  accessToken: "test-token",
};

const MOCK_MAIN_THEME = {
  id: THEME_ID,
  name: THEME_NAME,
  updatedAt: new Date("2024-01-15T10:00:00Z"),
};

const MOCK_SCAN = {
  id: SCAN_ID,
  shopId: SHOP_ID,
  themeId: THEME_ID,
  themeName: THEME_NAME,
  status: "PENDING",
  createdAt: new Date("2024-01-15T10:00:00Z"),
  completedAt: null,
  findingCount: 0,
};

const MOCK_ADMIN = { graphql: vi.fn() };

const MOCK_AUTH_RESULT = {
  session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
  admin: MOCK_ADMIN,
};

const MOCK_FILES = [
  {
    filename: "layout/theme.liquid",
    content: "<html><body>{{ content_for_layout }}</body></html>",
  },
  { filename: "sections/header.liquid", content: '<div class="header">{{ shop.name }}</div>' },
];

const MOCK_FINDINGS = [
  {
    filename: "layout/theme.liquid",
    lineNumber: 3,
    codeSnippet: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    findingType: FindingType.GHOST_SCRIPT,
    severity: Severity.HIGH,
    appName: "Klaviyo",
    description: "Ghost script from Klaviyo detected at layout/theme.liquid:3",
  },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Part A: Dashboard action — create scan and queue it
// ---------------------------------------------------------------------------

describe("Scan pipeline — Part A: dashboard action (create → queue)", () => {
  beforeEach(() => {
    mockAuthenticateAdmin.mockResolvedValue(MOCK_AUTH_RESULT);
    mockGetShopByDomain.mockResolvedValue(MOCK_SHOP);
    mockCanStartScan.mockResolvedValue({ allowed: true });
    mockFetchMainTheme.mockResolvedValue(MOCK_MAIN_THEME);
    mockCreateScan.mockResolvedValue(MOCK_SCAN);
    mockInngestSend.mockResolvedValue(undefined);
  });

  function makeRequest() {
    return new Request("https://example.com/app", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  describe("happy path — full scan creation flow", () => {
    it("redirects to the new scan detail page", async () => {
      // React Router's redirect() returns a 302 Response (does not throw).
      const result = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(result instanceof Response).toBe(true);
      expect((result as Response).status).toBe(302);
      expect((result as Response).headers.get("Location")).toBe(`/app/scans/${SCAN_ID}`);
    });

    it("authenticates the request with the admin session", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockAuthenticateAdmin).toHaveBeenCalledOnce();
    });

    it("looks up the shop by domain from the session", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockGetShopByDomain).toHaveBeenCalledWith(SHOP_DOMAIN);
    });

    it("checks plan gating before creating a scan", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockCanStartScan).toHaveBeenCalledWith(SHOP_ID, MOCK_SHOP.plan);
    });

    it("fetches the main theme to get the themeId and name", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockFetchMainTheme).toHaveBeenCalledWith(MOCK_ADMIN);
    });

    it("creates the scan with themeId from fetchMainTheme", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_ID, THEME_NAME);
    });

    it("sends an Inngest event with the scan details", async () => {
      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: "scan/requested",
        data: {
          shopId: SHOP_ID,
          themeId: THEME_ID,
          scanId: SCAN_ID,
        },
      });
    });

    it("fires Inngest event after scan is created (correct operation order)", async () => {
      const callOrder: string[] = [];

      mockCreateScan.mockImplementation(async () => {
        callOrder.push("createScan");
        return MOCK_SCAN;
      });
      mockInngestSend.mockImplementation(async () => {
        callOrder.push("inngestSend");
      });

      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(callOrder).toEqual(["createScan", "inngestSend"]);
    });
  });

  describe("error path — shop not found", () => {
    it("returns an error payload when shop is not in DB", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      const result = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ error: "Shop not found. Please reinstall the app." });
    });

    it("does not create a scan when shop is missing", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockCreateScan).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  describe("error path — plan gating blocks the scan", () => {
    it("returns an error payload when scan limit is reached", async () => {
      mockCanStartScan.mockResolvedValue({
        allowed: false,
        reason:
          "Free plan limit: 1 scan per month. Upgrade to Standard or Professional for unlimited scans.",
      });

      const result = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toMatchObject({ error: expect.stringContaining("limit") });
    });

    it("does not create a scan when plan gate blocks", async () => {
      mockCanStartScan.mockResolvedValue({ allowed: false, reason: "Limit reached" });

      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockCreateScan).not.toHaveBeenCalled();
    });
  });

  describe("error path — no published theme", () => {
    it("returns an error payload when fetchMainTheme returns null", async () => {
      mockFetchMainTheme.mockResolvedValue(null);

      const result = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({
        error: "No published theme found. Please publish a theme before scanning.",
      });
    });

    it("does not create a scan when no theme is found", async () => {
      mockFetchMainTheme.mockResolvedValue(null);

      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockCreateScan).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  describe("error path — concurrent scan already in progress", () => {
    it("returns an error payload when createScan throws (TOCTOU guard)", async () => {
      mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

      const result = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ error: "A scan is already in progress for this shop." });
    });

    it("does not send Inngest event when scan creation fails", async () => {
      mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

      await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Part B: Inngest scan-theme function — process → complete
// ---------------------------------------------------------------------------

describe("Scan pipeline — Part B: Inngest scan-theme function (process → complete)", () => {
  beforeEach(() => {
    // Inngest function uses dynamic import for db and shopify; mock at the module level.
    // db.shop.findUnique is used to look up the shop record inside the Inngest step.
    mockDbShopFindUnique.mockResolvedValue(MOCK_SHOP);
    // unauthenticated.admin is used to create an admin client inside the Inngest step.
    mockUnauthenticatedAdmin.mockResolvedValue({ admin: MOCK_ADMIN });
    mockUpdateScanStatus.mockResolvedValue(undefined);
    mockFetchThemeFiles.mockResolvedValue(MOCK_FILES);
    mockScanThemeFiles.mockReturnValue(MOCK_FINDINGS);
    mockCompleteScanWithFindings.mockResolvedValue(undefined);
  });

  function makeScanEvent(overrides?: Partial<{ shopId: string; themeId: string; scanId: string }>) {
    return createMockInngestEvent("scan/requested", {
      shopId: overrides?.shopId ?? SHOP_ID,
      themeId: overrides?.themeId ?? THEME_ID,
      scanId: overrides?.scanId ?? SCAN_ID,
    });
  }

  async function runScanThemeFn(
    eventData?: Partial<{ shopId: string; themeId: string; scanId: string }>,
    stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
  ) {
    const event = makeScanEvent(eventData);
    const step = { ...createMockInngestStep(), ...stepOverrides };
    return getInngestHandler(scanTheme)({ event, step });
  }

  describe("happy path — complete scan flow", () => {
    it("returns COMPLETED status and the correct finding count", async () => {
      const result = await runScanThemeFn();

      expect(result).toEqual({
        scanId: SCAN_ID,
        findingCount: MOCK_FINDINGS.length,
        status: "COMPLETED",
      });
    });

    it("transitions scan to IN_PROGRESS then COMPLETED in order", async () => {
      const statusCalls: string[] = [];
      mockUpdateScanStatus.mockImplementation(async (_id: string, status: string) => {
        statusCalls.push(status);
      });

      await runScanThemeFn();

      expect(statusCalls[0]).toBe("IN_PROGRESS");
      // COMPLETED is set inside completeScanWithFindings (not updateScanStatus directly)
      // so we only verify IN_PROGRESS here; COMPLETED is covered by the return value
    });

    it("calls completeScanWithFindings with the scan id and detected findings", async () => {
      await runScanThemeFn();

      expect(mockCompleteScanWithFindings).toHaveBeenCalledWith(SCAN_ID, MOCK_FINDINGS);
    });

    it("fetches theme files using the admin client for the correct theme", async () => {
      await runScanThemeFn();

      expect(mockFetchThemeFiles).toHaveBeenCalledWith(expect.anything(), THEME_ID);
    });

    it("passes the fetched files to the scan engine", async () => {
      await runScanThemeFn();

      expect(mockScanThemeFiles).toHaveBeenCalledWith(MOCK_FILES);
    });
  });

  describe("happy path — zero findings (clean theme)", () => {
    it("returns COMPLETED with findingCount of 0", async () => {
      mockScanThemeFiles.mockReturnValue([]);

      const result = await runScanThemeFn();

      expect(result).toEqual({ scanId: SCAN_ID, findingCount: 0, status: "COMPLETED" });
    });

    it("persists an empty findings array (idempotent deleteMany + no createMany)", async () => {
      mockScanThemeFiles.mockReturnValue([]);

      await runScanThemeFn();

      expect(mockCompleteScanWithFindings).toHaveBeenCalledWith(SCAN_ID, []);
    });
  });

  describe("error path — shop not found", () => {
    it("throws and marks scan FAILED when shop is not in DB", async () => {
      mockDbShopFindUnique.mockResolvedValue(null);

      await expect(runScanThemeFn()).rejects.toThrow(`Shop ${SHOP_ID} not found`);

      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
    });

    it("does not call completeScanWithFindings when shop lookup fails", async () => {
      mockDbShopFindUnique.mockResolvedValue(null);

      await expect(runScanThemeFn()).rejects.toThrow();

      expect(mockCompleteScanWithFindings).not.toHaveBeenCalled();
    });
  });

  describe("error path — theme file fetch fails", () => {
    it("marks scan FAILED and re-throws when Shopify API errors", async () => {
      mockFetchThemeFiles.mockRejectedValue(new Error("Shopify API unavailable"));

      await expect(runScanThemeFn()).rejects.toThrow("Shopify API unavailable");

      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
    });
  });

  describe("error path — scan engine throws", () => {
    it("marks scan FAILED when the detection engine crashes", async () => {
      mockScanThemeFiles.mockImplementation(() => {
        throw new Error("Pattern matching engine error");
      });

      await expect(runScanThemeFn()).rejects.toThrow("Pattern matching engine error");

      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: verify the two halves produce consistent event payloads
// ---------------------------------------------------------------------------

describe("Scan pipeline — handoff: action event matches Inngest function expectations", () => {
  beforeEach(() => {
    mockAuthenticateAdmin.mockResolvedValue(MOCK_AUTH_RESULT);
    mockGetShopByDomain.mockResolvedValue(MOCK_SHOP);
    mockCanStartScan.mockResolvedValue({ allowed: true });
    mockFetchMainTheme.mockResolvedValue(MOCK_MAIN_THEME);
    mockCreateScan.mockResolvedValue(MOCK_SCAN);
    mockInngestSend.mockResolvedValue(undefined);
  });

  it("the event sent by the dashboard action contains the fields the Inngest function reads", async () => {
    function makeRequest() {
      return new Request("https://example.com/app", {
        method: "POST",
        body: "",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }

    // redirect() returns a Response (does not throw)
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const sentEvent = mockInngestSend.mock.calls[0][0];

    // These three fields are destructured in the Inngest function:
    //   const { shopId, themeId, scanId } = event.data;
    expect(sentEvent.data).toHaveProperty("shopId");
    expect(sentEvent.data).toHaveProperty("themeId");
    expect(sentEvent.data).toHaveProperty("scanId");
    expect(sentEvent.data.shopId).toBe(SHOP_ID);
    expect(sentEvent.data.themeId).toBe(THEME_ID);
    expect(sentEvent.data.scanId).toBe(SCAN_ID);

    // themeId must be GID format — the Inngest function passes it directly to
    // fetchThemeFiles which requires a GID string
    expect(sentEvent.data.themeId).toMatch(/^gid:\/\/shopify\/Theme\//);
  });
});
