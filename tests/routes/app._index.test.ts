/**
 * Tests for app/routes/app._index.tsx (dashboard)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session and admin context.
 *   - Mock models, services, plan-gating, and inngest to avoid real I/O.
 *   - Verify loader returns correct data shape for each scenario.
 *   - Verify action creates a scan and dispatches to Inngest, with plan gating.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopByDomain: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
  createScan: vi.fn(),
  hasCompletedScans: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingSummary: vi.fn(),
}));

vi.mock("../../app/lib/billing.server", () => ({
  getPlanFeatures: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canStartScan: vi.fn(),
  getScanUsage: vi.fn(),
  getWeekStartUTC: vi.fn(),
}));

vi.mock("../../app/lib/health-score", () => ({
  computeHealthScore: vi.fn(),
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
  },
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
}));

vi.mock("../../app/lib/plans", () => ({
  PLANS: { FREE: "Free", STANDARD: "Standard", PROFESSIONAL: "Professional" },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getPlanFeatures } from "../../app/lib/billing.server";
import { computeHealthScore } from "../../app/lib/health-score";
import { canStartScan, getScanUsage, getWeekStartUTC } from "../../app/lib/plan-gating.server";
import { getFindingSummary } from "../../app/models/finding.server";
import { getScansForShop, createScan, hasCompletedScans } from "../../app/models/scan.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { loader, action } from "../../app/routes/app._index";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockGetScansForShop = getScansForShop as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockHasCompletedScans = hasCompletedScans as ReturnType<typeof vi.fn>;
const mockGetFindingSummary = getFindingSummary as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;
const mockCanStartScan = canStartScan as ReturnType<typeof vi.fn>;
const mockGetScanUsage = getScanUsage as ReturnType<typeof vi.fn>;
const mockComputeHealthScore = computeHealthScore as ReturnType<typeof vi.fn>;
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;
const mockGetWeekStartUTC = getWeekStartUTC as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Free",
  lastThemePublishAt: null,
};

const MOCK_ADMIN = {
  graphql: vi.fn(),
};

const MAIN_THEME = {
  id: "gid://shopify/Theme/123456",
  name: "Dawn",
};

const COMPLETED_SCAN = {
  id: "scan-1",
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/123456",
  themeName: "Dawn",
  status: "COMPLETED",
  findingCount: 5,
  startedAt: new Date("2026-03-20T10:00:00Z"),
  completedAt: new Date("2026-03-20T10:05:00Z"),
  createdAt: new Date("2026-03-20T10:00:00Z"),
};

const FINDING_SUMMARY = {
  total: 5,
  bySeverity: { HIGH: 2, MEDIUM: 2, LOW: 1 },
  byType: { GHOST_SCRIPT: 3, GHOST_STYLE: 2 },
};

const HEALTH_SCORE = {
  score: 69,
  label: "Fair",
  tone: "warning" as const,
};

function makeLoaderArgs(overrides?: Partial<LoaderFunctionArgs>): LoaderFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/app"),
    params: {},
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

function makeActionArgs(overrides?: Partial<ActionFunctionArgs>): ActionFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/app", {
      method: "POST",
    }),
    params: {},
    context: {},
    ...overrides,
  } as ActionFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP.domain },
    admin: MOCK_ADMIN,
  });

  mockGetShopByDomain.mockResolvedValue(SHOP);
  mockFetchMainTheme.mockResolvedValue(MAIN_THEME);
  mockGetScansForShop.mockResolvedValue([COMPLETED_SCAN]);
  mockGetFindingSummary.mockResolvedValue(FINDING_SUMMARY);
  mockGetPlanFeatures.mockReturnValue({
    maxScansPerMonth: 1,
    maxScansPerWeek: Infinity,
    showFindingDetails: false,
    maxThemes: 1,
    autoRescan: false,
    scanDiffing: false,
    scheduledScan: false,
  });
  mockGetScanUsage.mockResolvedValue({
    used: 0,
    limit: 1,
    period: "month" as const,
    periodStart: new Date("2026-03-01T00:00:00Z"),
  });
  mockHasCompletedScans.mockResolvedValue(true);
  mockComputeHealthScore.mockReturnValue(HEALTH_SCORE);
  mockGetWeekStartUTC.mockReturnValue(new Date("2026-03-16T00:00:00Z"));
});

// ---------------------------------------------------------------------------
// Loader Tests
// ---------------------------------------------------------------------------

describe("app._index loader", () => {
  describe("correct data shape", () => {
    it("returns full data shape with shop, theme, scans, healthScore, and usage", async () => {
      const result = (await loader(makeLoaderArgs())) as Record<string, unknown>;

      expect(result).toHaveProperty("shop");
      expect(result).toHaveProperty("latestScan");
      expect(result).toHaveProperty("findingSummary");
      expect(result).toHaveProperty("mainTheme");
      expect(result).toHaveProperty("scanUsage");
      expect(result).toHaveProperty("isFirstScan");
      expect(result).toHaveProperty("healthScore");
      expect(result).toHaveProperty("previousHealthScore");
      expect(result).toHaveProperty("showRescanNudge");
      expect(result).toHaveProperty("showThemeChangeNudge");
    });

    it("returns latestScan from first element of getScansForShop", async () => {
      const result = (await loader(makeLoaderArgs())) as {
        latestScan: typeof COMPLETED_SCAN;
      };

      expect(result.latestScan).toEqual(COMPLETED_SCAN);
    });

    it("returns healthScore from computeHealthScore when scan is completed", async () => {
      const result = (await loader(makeLoaderArgs())) as {
        healthScore: typeof HEALTH_SCORE;
      };

      expect(result.healthScore).toEqual(HEALTH_SCORE);
      expect(mockComputeHealthScore).toHaveBeenCalledWith(FINDING_SUMMARY.bySeverity);
    });
  });

  describe("plan tier behavior", () => {
    it("returns scanUsage for Free plan", async () => {
      const result = (await loader(makeLoaderArgs())) as {
        scanUsage: { used: number; limit: number; period: string } | null;
      };

      expect(result.scanUsage).toEqual({ used: 0, limit: 1, period: "month" });
    });

    it("returns scanUsage for Standard plan (weekly)", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Standard" });
      mockGetPlanFeatures.mockReturnValue({
        maxScansPerMonth: Infinity,
        maxScansPerWeek: 1,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false,
      });
      mockGetScanUsage.mockResolvedValue({
        used: 1,
        limit: 1,
        period: "week" as const,
        periodStart: new Date("2026-03-16T00:00:00Z"),
      });

      const result = (await loader(makeLoaderArgs())) as {
        scanUsage: { used: number; limit: number; period: string } | null;
      };

      expect(result.scanUsage).toEqual({ used: 1, limit: 1, period: "week" });
    });

    it("returns null scanUsage for Professional plan (unlimited)", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Professional" });
      mockGetPlanFeatures.mockReturnValue({
        maxScansPerMonth: Infinity,
        maxScansPerWeek: Infinity,
        showFindingDetails: true,
        maxThemes: Infinity,
        autoRescan: true,
        scanDiffing: true,
        scheduledScan: true,
      });
      mockGetScanUsage.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as {
        scanUsage: null;
      };

      expect(result.scanUsage).toBeNull();
    });
  });

  describe("shop not found", () => {
    it("returns minimal data when shop is not found", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as Record<string, unknown>;

      expect(result.shop).toBeNull();
      expect(result.latestScan).toBeNull();
      expect(result.findingSummary).toBeNull();
      expect(result.mainTheme).toBeNull();
      expect(result.scanUsage).toBeNull();
      expect(result.isFirstScan).toBe(true);
      expect(result.healthScore).toBeNull();
      expect(result.previousHealthScore).toBeNull();
      expect(result.showRescanNudge).toBe(false);
      expect(result.showThemeChangeNudge).toBe(false);
    });

    it("does not call downstream services when shop is null", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      await loader(makeLoaderArgs());

      expect(mockFetchMainTheme).not.toHaveBeenCalled();
      expect(mockGetScansForShop).not.toHaveBeenCalled();
      expect(mockGetFindingSummary).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("returns isFirstScan=true when no completed scans exist", async () => {
      mockHasCompletedScans.mockResolvedValue(false);

      const result = (await loader(makeLoaderArgs())) as { isFirstScan: boolean };

      expect(result.isFirstScan).toBe(true);
    });

    it("returns null healthScore when no scans exist", async () => {
      mockGetScansForShop.mockResolvedValue([]);

      const result = (await loader(makeLoaderArgs())) as {
        latestScan: null;
        healthScore: null;
      };

      expect(result.latestScan).toBeNull();
      expect(result.healthScore).toBeNull();
    });

    it("returns previousHealthScore when two completed scans exist", async () => {
      const previousScan = {
        ...COMPLETED_SCAN,
        id: "scan-0",
        status: "COMPLETED",
        completedAt: new Date("2026-03-19T10:05:00Z"),
      };
      mockGetScansForShop.mockResolvedValue([COMPLETED_SCAN, previousScan]);
      mockGetFindingSummary.mockResolvedValueOnce(FINDING_SUMMARY).mockResolvedValueOnce({
        total: 10,
        bySeverity: { HIGH: 5, MEDIUM: 3, LOW: 2 },
        byType: {},
      });
      const prevScore = { score: 43, label: "Poor", tone: "caution" };
      mockComputeHealthScore.mockReturnValueOnce(HEALTH_SCORE).mockReturnValueOnce(prevScore);

      const result = (await loader(makeLoaderArgs())) as {
        previousHealthScore: typeof prevScore;
      };

      expect(result.previousHealthScore).toEqual(prevScore);
    });
  });
});

// ---------------------------------------------------------------------------
// Action Tests
// ---------------------------------------------------------------------------

describe("app._index action", () => {
  beforeEach(() => {
    mockCanStartScan.mockResolvedValue({ allowed: true });
    mockCreateScan.mockResolvedValue({ id: "scan-new", shopId: "shop-1" });
    mockInngestSend.mockResolvedValue(undefined);
    mockHasCompletedScans.mockResolvedValue(false);
  });

  describe("successful scan creation", () => {
    it("creates scan and dispatches to Inngest, then redirects", async () => {
      const result = await action(makeActionArgs());

      // action returns redirect() which throws a Response
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      expect((result as Response).headers.get("Location")).toBe("/app/scans/scan-new");

      expect(mockCreateScan).toHaveBeenCalledWith(
        "shop-1",
        "gid://shopify/Theme/123456",
        "Dawn",
        expect.anything(),
      );
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: "scan/requested",
        data: {
          shopId: "shop-1",
          themeId: "gid://shopify/Theme/123456",
          scanId: "scan-new",
        },
      });
    });
  });

  describe("plan gating", () => {
    it("returns error when scan limit reached", async () => {
      mockCanStartScan.mockResolvedValue({
        allowed: false,
        reason: "Weekly scan limit reached.",
      });

      const result = (await action(makeActionArgs())) as { error: string };

      expect(result.error).toBe("Weekly scan limit reached.");
      expect(mockCreateScan).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("returns error when shop not found", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      const result = (await action(makeActionArgs())) as { error: string };

      expect(result.error).toBe("Shop not found. Please reinstall the app.");
      expect(mockCreateScan).not.toHaveBeenCalled();
    });

    it("returns error when no published theme found", async () => {
      mockFetchMainTheme.mockResolvedValue(null);

      const result = (await action(makeActionArgs())) as { error: string };

      expect(result.error).toBe(
        "No published theme found. Please publish a theme before scanning.",
      );
      expect(mockCreateScan).not.toHaveBeenCalled();
    });
  });

  describe("Inngest dispatch failure", () => {
    it("still redirects to scan when Inngest dispatch fails", async () => {
      mockInngestSend.mockRejectedValue(new Error("Inngest unreachable"));

      const result = await action(makeActionArgs());

      // Scan was created — redirect should still happen
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      expect((result as Response).headers.get("Location")).toBe("/app/scans/scan-new");

      // Scan was created even though dispatch failed
      expect(mockCreateScan).toHaveBeenCalled();
    });
  });

  describe("createScan failure", () => {
    it("returns error when createScan throws (e.g., active scan exists)", async () => {
      mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

      const result = (await action(makeActionArgs())) as { error: string };

      expect(result.error).toBe("A scan is already in progress for this shop.");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });
});
