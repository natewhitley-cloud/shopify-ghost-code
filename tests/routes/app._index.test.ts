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
  fetchAllThemes: vi.fn(),
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
import { fetchMainTheme, fetchAllThemes } from "../../app/services/theme-fetcher.server";
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
const mockFetchAllThemes = fetchAllThemes as ReturnType<typeof vi.fn>;
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
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
  mockFetchAllThemes.mockResolvedValue([]);
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

// ---------------------------------------------------------------------------
// Theme picker fixtures
// ---------------------------------------------------------------------------

const ALL_THEMES = [
  {
    id: "gid://shopify/Theme/123456",
    name: "Dawn",
    role: "MAIN",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "gid://shopify/Theme/789",
    name: "Craft",
    role: "UNPUBLISHED",
    updatedAt: "2026-01-02T00:00:00Z",
  },
];

const PRO_FEATURES = {
  maxScansPerMonth: Infinity,
  maxScansPerWeek: Infinity,
  showFindingDetails: true,
  maxThemes: Infinity,
  autoRescan: true,
  scanDiffing: true,
  scheduledScan: true,
};

const STANDARD_FEATURES = {
  maxScansPerMonth: Infinity,
  maxScansPerWeek: 1,
  showFindingDetails: true,
  maxThemes: 1,
  autoRescan: false,
  scanDiffing: false,
  scheduledScan: false,
};

// ---------------------------------------------------------------------------
// Loader: theme picker data
// ---------------------------------------------------------------------------

describe("app._index loader — theme picker", () => {
  describe("allThemes population", () => {
    it("returns non-empty allThemes for Standard plan", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Standard" });
      mockGetPlanFeatures.mockReturnValue(STANDARD_FEATURES);
      mockFetchAllThemes.mockResolvedValue(ALL_THEMES);
      mockGetScanUsage.mockResolvedValue({
        used: 0,
        limit: 1,
        period: "week" as const,
        periodStart: new Date("2026-03-16T00:00:00Z"),
      });

      const result = (await loader(makeLoaderArgs())) as {
        allThemes: typeof ALL_THEMES;
      };

      expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
      expect(result.allThemes).toEqual(ALL_THEMES);
    });

    it("returns non-empty allThemes for Professional plan", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Professional" });
      mockGetPlanFeatures.mockReturnValue(PRO_FEATURES);
      mockFetchAllThemes.mockResolvedValue(ALL_THEMES);
      mockGetScanUsage.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as {
        allThemes: typeof ALL_THEMES;
      };

      expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
      expect(result.allThemes).toEqual(ALL_THEMES);
    });

    it("returns empty allThemes for Free plan and does not call fetchAllThemes", async () => {
      // Default SHOP fixture has plan: "Free" — no override needed
      mockFetchAllThemes.mockResolvedValue(ALL_THEMES); // would be non-empty if called

      const result = (await loader(makeLoaderArgs())) as {
        allThemes: unknown[];
      };

      expect(mockFetchAllThemes).not.toHaveBeenCalled();
      expect(result.allThemes).toEqual([]);
    });
  });

  describe("canSelectTheme flag", () => {
    it("returns canSelectTheme: true for Professional plan (maxThemes > 1)", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Professional" });
      mockGetPlanFeatures.mockReturnValue(PRO_FEATURES);
      mockGetScanUsage.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as {
        canSelectTheme: boolean;
      };

      expect(result.canSelectTheme).toBe(true);
    });

    it("returns canSelectTheme: false for Standard plan (maxThemes: 1)", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Standard" });
      mockGetPlanFeatures.mockReturnValue(STANDARD_FEATURES);
      mockGetScanUsage.mockResolvedValue({
        used: 0,
        limit: 1,
        period: "week" as const,
        periodStart: new Date("2026-03-16T00:00:00Z"),
      });

      const result = (await loader(makeLoaderArgs())) as {
        canSelectTheme: boolean;
      };

      expect(result.canSelectTheme).toBe(false);
    });

    it("returns canSelectTheme: false for Free plan (maxThemes: 1)", async () => {
      // Default SHOP fixture + default getPlanFeatures mock (maxThemes: 1)

      const result = (await loader(makeLoaderArgs())) as {
        canSelectTheme: boolean;
      };

      expect(result.canSelectTheme).toBe(false);
    });
  });

  describe("null shop early return", () => {
    it("includes allThemes: [] and canSelectTheme: false when shop is null", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as {
        allThemes: unknown[];
        canSelectTheme: boolean;
      };

      expect(result.allThemes).toEqual([]);
      expect(result.canSelectTheme).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Action: theme picker
// ---------------------------------------------------------------------------

describe("app._index action — theme picker", () => {
  beforeEach(() => {
    mockCanStartScan.mockResolvedValue({ allowed: true });
    mockCreateScan.mockResolvedValue({ id: "scan-new", shopId: "shop-1" });
    mockInngestSend.mockResolvedValue(undefined);
    mockHasCompletedScans.mockResolvedValue(false);
  });

  describe("no themeId in form body", () => {
    it("falls back to MAIN theme when no themeId is submitted", async () => {
      // Default action args have no form body with themeId

      const result = await action(makeActionArgs());

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
      expect(mockFetchAllThemes).not.toHaveBeenCalled();
      expect(mockCreateScan).toHaveBeenCalledWith(
        "shop-1",
        "gid://shopify/Theme/123456",
        "Dawn",
        expect.anything(),
      );
    });

    it("falls back to MAIN theme when themeId is an empty string", async () => {
      const request = new Request("https://test-shop.myshopify.com/app", {
        method: "POST",
        body: new URLSearchParams({ themeId: "" }),
      });

      const result = await action(makeActionArgs({ request }));

      expect(result).toBeInstanceOf(Response);
      expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
      expect(mockFetchAllThemes).not.toHaveBeenCalled();
    });
  });

  describe("valid themeId on Professional plan", () => {
    it("uses the selected theme and scans it instead of the MAIN theme", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Professional" });
      mockGetPlanFeatures.mockReturnValue(PRO_FEATURES);
      mockFetchAllThemes.mockResolvedValue(ALL_THEMES);

      const request = new Request("https://test-shop.myshopify.com/app", {
        method: "POST",
        body: new URLSearchParams({ themeId: "gid://shopify/Theme/789" }),
      });

      const result = await action(makeActionArgs({ request }));

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      // fetchAllThemes validates the selection; fetchMainTheme should not be called
      expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
      expect(mockFetchMainTheme).not.toHaveBeenCalled();
      // Professional plan has no scan quota (Infinity limits), so quota is null
      expect(mockCreateScan).toHaveBeenCalledWith(
        "shop-1",
        "gid://shopify/Theme/789",
        "Craft",
        null,
      );
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ themeId: "gid://shopify/Theme/789" }),
        }),
      );
    });
  });

  describe("invalid themeId on Professional plan", () => {
    it("returns error when submitted themeId is not found in shop theme list", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Professional" });
      mockGetPlanFeatures.mockReturnValue(PRO_FEATURES);
      // Return themes list that does NOT contain the submitted ID
      mockFetchAllThemes.mockResolvedValue([
        {
          id: "gid://shopify/Theme/123456",
          name: "Dawn",
          role: "MAIN",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const request = new Request("https://test-shop.myshopify.com/app", {
        method: "POST",
        body: new URLSearchParams({ themeId: "gid://shopify/Theme/SPOOFED" }),
      });

      const result = (await action(makeActionArgs({ request }))) as { error: string };

      expect(result.error).toBe(
        "The selected theme could not be found. Please refresh and try again.",
      );
      expect(mockCreateScan).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  describe("themeId on Free plan (downgrade protection)", () => {
    it("ignores submitted themeId and uses MAIN theme when plan is Free", async () => {
      // Default SHOP has plan: "Free"; default getPlanFeatures returns maxThemes: 1
      const request = new Request("https://test-shop.myshopify.com/app", {
        method: "POST",
        body: new URLSearchParams({ themeId: "gid://shopify/Theme/789" }),
      });

      const result = await action(makeActionArgs({ request }));

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      // Selection ignored — should NOT validate via fetchAllThemes
      expect(mockFetchAllThemes).not.toHaveBeenCalled();
      // Should fall back to MAIN theme
      expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
      expect(mockCreateScan).toHaveBeenCalledWith(
        "shop-1",
        "gid://shopify/Theme/123456",
        "Dawn",
        expect.anything(),
      );
    });
  });

  describe("themeId on Standard plan (downgrade protection)", () => {
    it("ignores submitted themeId and uses MAIN theme when plan is Standard", async () => {
      mockGetShopByDomain.mockResolvedValue({ ...SHOP, plan: "Standard" });
      mockGetPlanFeatures.mockReturnValue(STANDARD_FEATURES);

      const request = new Request("https://test-shop.myshopify.com/app", {
        method: "POST",
        body: new URLSearchParams({ themeId: "gid://shopify/Theme/789" }),
      });

      const result = await action(makeActionArgs({ request }));

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      expect(mockFetchAllThemes).not.toHaveBeenCalled();
      expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
      expect(mockCreateScan).toHaveBeenCalledWith(
        "shop-1",
        "gid://shopify/Theme/123456",
        "Dawn",
        expect.anything(),
      );
    });
  });
});
