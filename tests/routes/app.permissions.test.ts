/**
 * Tests for app/routes/app.permissions.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session and admin context.
 *   - Mock billing, models, and services to avoid real DB/API calls.
 *   - Verify loader returns the correct state for each scenario:
 *     feature-gated, scope-request, onboarding (no apps), and active (apps found).
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopByDomain: vi.fn(),
}));

vi.mock("../../app/lib/billing.server", () => ({
  getPlanFeatures: vi.fn(),
}));

vi.mock("../../app/models/installed-app.server", () => ({
  getInstalledApps: vi.fn(),
  getRemovedApps: vi.fn(),
}));

vi.mock("../../app/services/permission-fetcher.server", () => ({
  fetchAllInstalledApps: vi.fn(),
  syncInstalledApps: vi.fn(),
}));

vi.mock("../../app/services/permission-scorer.server", () => ({
  scoreApp: vi.fn(),
  scoreStore: vi.fn(),
}));

vi.mock("../../app/services/app-enrichment.server", () => ({
  enrichApps: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getPlanFeatures } from "../../app/lib/billing.server";
import { getInstalledApps, getRemovedApps } from "../../app/models/installed-app.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.permissions";
import { enrichApps } from "../../app/services/app-enrichment.server";
import {
  fetchAllInstalledApps,
  syncInstalledApps,
} from "../../app/services/permission-fetcher.server";
import { scoreApp, scoreStore } from "../../app/services/permission-scorer.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;
const mockGetInstalledApps = getInstalledApps as ReturnType<typeof vi.fn>;
const mockGetRemovedApps = getRemovedApps as ReturnType<typeof vi.fn>;
const mockFetchAllInstalledApps = fetchAllInstalledApps as ReturnType<typeof vi.fn>;
const mockSyncInstalledApps = syncInstalledApps as ReturnType<typeof vi.fn>;
const mockScoreApp = scoreApp as ReturnType<typeof vi.fn>;
const mockScoreStore = scoreStore as ReturnType<typeof vi.fn>;
const mockEnrichApps = enrichApps as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Standard",
};

const MOCK_ADMIN = {
  graphql: vi.fn(),
};

function makeLoaderArgs(overrides?: Partial<LoaderFunctionArgs>): LoaderFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/app/permissions"),
    params: {},
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP.domain, scope: "read_themes" },
    admin: MOCK_ADMIN,
  });

  mockGetShopByDomain.mockResolvedValue(SHOP);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.permissions loader", () => {
  describe("feature-gated state", () => {
    it("returns feature-gated when permissionAuditEnabled is false", async () => {
      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: false,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      const result = await loader(makeLoaderArgs());

      expect(result).toEqual({ state: "feature-gated" });
      // Should not call any downstream services
      expect(mockFetchAllInstalledApps).not.toHaveBeenCalled();
      expect(mockGetInstalledApps).not.toHaveBeenCalled();
      expect(mockScoreApp).not.toHaveBeenCalled();
    });
  });

  describe("scope-request state", () => {
    it("returns scope-request when read_apps scope is not granted", async () => {
      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: true,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      // Default session has scope: "read_themes" (no read_apps)
      const result = await loader(makeLoaderArgs());

      expect(result).toEqual({ state: "scope-request" });
      // Should not call any downstream services
      expect(mockFetchAllInstalledApps).not.toHaveBeenCalled();
      expect(mockGetInstalledApps).not.toHaveBeenCalled();
      expect(mockScoreApp).not.toHaveBeenCalled();
    });

    it("returns scope-request when session scope is null", async () => {
      mockAuthenticateAdmin.mockResolvedValue({
        session: { shop: SHOP.domain, scope: null },
        admin: MOCK_ADMIN,
      });

      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: true,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      const result = await loader(makeLoaderArgs());

      expect(result).toEqual({ state: "scope-request" });
    });

    it("returns scope-request when session scope is undefined", async () => {
      mockAuthenticateAdmin.mockResolvedValue({
        session: { shop: SHOP.domain },
        admin: MOCK_ADMIN,
      });

      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: true,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      const result = await loader(makeLoaderArgs());

      expect(result).toEqual({ state: "scope-request" });
    });
  });

  describe("onboarding state", () => {
    it("returns onboarding when scope is granted but no apps are found", async () => {
      mockAuthenticateAdmin.mockResolvedValue({
        session: { shop: SHOP.domain, scope: "read_themes,read_apps" },
        admin: MOCK_ADMIN,
      });

      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: true,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      mockFetchAllInstalledApps.mockResolvedValue([]);
      mockGetInstalledApps.mockResolvedValue([]);

      const result = await loader(makeLoaderArgs());

      expect(result).toEqual({ state: "onboarding" });
      expect(mockFetchAllInstalledApps).toHaveBeenCalledWith(MOCK_ADMIN);
      // syncInstalledApps should not be called when no apps fetched
      expect(mockSyncInstalledApps).not.toHaveBeenCalled();
    });
  });

  describe("active state", () => {
    it("returns scored apps and store score when apps are found", async () => {
      mockAuthenticateAdmin.mockResolvedValue({
        session: { shop: SHOP.domain, scope: "read_themes,read_apps" },
        admin: MOCK_ADMIN,
      });

      mockGetPlanFeatures.mockReturnValue({
        permissionAuditEnabled: true,
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true,
      });

      const fetchedApps = [
        {
          id: "gid://shopify/App/111",
          title: "Test App",
          handle: "test-app",
          description: "A test app",
          publicCategory: "Marketing",
          accessScopes: [
            { handle: "read_orders", description: null },
            { handle: "write_orders", description: null },
          ],
          hasActiveSubscription: true,
        },
      ];

      const installedApps = [
        {
          id: "installed-1",
          shopId: "shop-1",
          shopifyAppId: "gid://shopify/App/111",
          appHandle: "test-app",
          appName: "Test App",
          appDescription: "A test app",
          publicCategory: "Marketing",
          presence: "INSTALLED",
          grantedScopes: '["read_orders","write_orders"]',
          grantedScopeCount: 2,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago — triggers re-sync
          removedAt: null,
          hasActiveSubscription: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const appRiskScore = {
        score: 65,
        level: "high" as const,
        factors: [{ description: "Holds 2 scopes (1 critical, 1 medium)", impact: 5 }],
      };

      const storeRiskScore = {
        score: 65,
        level: "high" as const,
        appCount: 1,
        criticalApps: 0,
        highApps: 1,
        topRiskFactors: ["Holds 2 scopes (1 critical, 1 medium)"],
      };

      mockFetchAllInstalledApps.mockResolvedValue(fetchedApps);
      mockSyncInstalledApps.mockResolvedValue(undefined);
      mockGetInstalledApps.mockResolvedValue(installedApps);
      mockGetRemovedApps.mockResolvedValue([]);
      mockEnrichApps.mockReturnValue(
        new Map([
          [
            "test-app",
            {
              categorySlug: "marketing",
              categoryName: "Marketing",
              rating: 4.5,
              reviewCount: 100,
              pricingModel: "Subscription",
              appStoreUrl: null,
            },
          ],
        ]),
      );
      mockScoreApp.mockReturnValue(appRiskScore);
      mockScoreStore.mockReturnValue(storeRiskScore);

      const result = (await loader(makeLoaderArgs())) as {
        state: string;
        apps: Array<{
          id: string;
          appName: string;
          scopeCount: number;
          riskScore: typeof appRiskScore;
          categoryName: string | null;
        }>;
        storeScore: typeof storeRiskScore;
      };

      expect(result.state).toBe("active");
      expect(result.apps).toHaveLength(1);
      expect(result.apps[0].appName).toBe("Test App");
      expect(result.apps[0].scopeCount).toBe(2);
      expect(result.apps[0].riskScore).toEqual(appRiskScore);
      expect(result.apps[0].categoryName).toBe("Marketing");
      expect(result.storeScore).toEqual(storeRiskScore);

      expect(mockSyncInstalledApps).toHaveBeenCalled();
      expect(mockScoreApp).toHaveBeenCalledWith(["read_orders", "write_orders"], "marketing");
      expect(mockScoreStore).toHaveBeenCalledWith([appRiskScore]);
    });
  });

  describe("error handling", () => {
    it("throws 404 when shop is not found", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      await expect(loader(makeLoaderArgs())).rejects.toThrow();
    });
  });
});
