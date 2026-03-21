/**
 * Tests for app/routes/app.permissions.$appId.tsx (detail view)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session and admin context.
 *   - Mock models, services, and data layer to avoid real DB/API/SQLite calls.
 *   - Verify loader returns correct data for each scenario:
 *     normal app, unknown app, null enrichment, and REMOVED app.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

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

vi.mock("../../app/models/installed-app.server", () => ({
  getInstalledAppById: vi.fn(),
}));

vi.mock("../../app/services/app-enrichment.server", () => ({
  enrichApp: vi.fn(),
}));

vi.mock("../../app/services/permission-scorer.server", () => ({
  scoreApp: vi.fn(),
}));

vi.mock("../../app/services/permission-fetcher.server", () => ({
  fetchAllInstalledApps: vi.fn(),
  syncInstalledApps: vi.fn(),
}));

vi.mock("../../app/data/category-permissions.server", () => ({
  getScopeSensitivity: vi.fn(),
  getUnexpectedScopes: vi.fn(),
  ScopeSensitivity: {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    CRITICAL: "CRITICAL",
  },
}));

vi.mock("../../app/lib/billing.server", () => ({
  getPlanFeatures: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getInstalledAppById } from "../../app/models/installed-app.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.permissions.$appId";
import { enrichApp } from "../../app/services/app-enrichment.server";
import {
  fetchAllInstalledApps,
  syncInstalledApps,
} from "../../app/services/permission-fetcher.server";
import { scoreApp } from "../../app/services/permission-scorer.server";
import {
  getScopeSensitivity,
  getUnexpectedScopes,
} from "../../app/data/category-permissions.server";
import { authenticate } from "../../app/shopify.server";
import { getPlanFeatures } from "../../app/lib/billing.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockGetInstalledAppById = getInstalledAppById as ReturnType<typeof vi.fn>;
const mockEnrichApp = enrichApp as ReturnType<typeof vi.fn>;
const mockScoreApp = scoreApp as ReturnType<typeof vi.fn>;
const mockFetchAllInstalledApps = fetchAllInstalledApps as ReturnType<typeof vi.fn>;
const mockSyncInstalledApps = syncInstalledApps as ReturnType<typeof vi.fn>;
const mockGetScopeSensitivity = getScopeSensitivity as ReturnType<typeof vi.fn>;
const mockGetUnexpectedScopes = getUnexpectedScopes as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;

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

const NOW = new Date("2026-03-21T12:00:00Z");

const INSTALLED_APP = {
  id: "installed-1",
  shopId: "shop-1",
  shopifyAppId: "gid://shopify/App/111",
  appHandle: "test-app",
  appName: "Test App",
  appDescription: "A test app",
  publicCategory: "Marketing",
  presence: "INSTALLED",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  removedAt: null,
  hasActiveSubscription: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const FETCHED_APP = {
  id: "gid://shopify/App/111",
  title: "Test App",
  handle: "test-app",
  description: "A test app",
  publicCategory: "Marketing",
  accessScopes: [
    { handle: "read_orders", description: "Read orders" },
    { handle: "write_orders", description: null },
  ],
  hasActiveSubscription: true,
};

const APP_RISK_SCORE = {
  score: 65,
  level: "high" as const,
  factors: [
    { description: "Holds 2 scopes (1 critical, 1 high)", impact: 5.3 },
    {
      description: "Holds 1 unexpected scope for this category (1 critical: write_orders)",
      impact: 4,
    },
  ],
};

const ENRICHMENT = {
  categorySlug: "marketing-and-conversion",
  categoryName: "Marketing and conversion",
  rating: 4.5,
  reviewCount: 100,
  pricingModel: "Subscription",
  appStoreUrl: "https://apps.shopify.com/test-app",
};

function makeLoaderArgs(
  appId: string,
  overrides?: Partial<LoaderFunctionArgs>,
): LoaderFunctionArgs {
  return {
    request: new Request(`https://test-shop.myshopify.com/app/permissions/${appId}`),
    params: { appId },
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
    session: { shop: SHOP.domain, scope: "read_themes,read_apps" },
    admin: MOCK_ADMIN,
  });

  mockGetShopByDomain.mockResolvedValue(SHOP);
  mockGetPlanFeatures.mockReturnValue({ permissionAuditEnabled: true });
  mockGetInstalledAppById.mockResolvedValue(INSTALLED_APP);
  mockFetchAllInstalledApps.mockResolvedValue([FETCHED_APP]);
  mockSyncInstalledApps.mockResolvedValue(undefined);
  mockEnrichApp.mockReturnValue(ENRICHMENT);
  mockScoreApp.mockReturnValue(APP_RISK_SCORE);
  mockGetUnexpectedScopes.mockReturnValue(["write_orders"]);
  mockGetScopeSensitivity.mockImplementation((scope: string) => {
    if (scope === "write_orders") return "CRITICAL";
    if (scope === "read_orders") return "HIGH";
    return "MEDIUM";
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.permissions.$appId loader", () => {
  describe("successful app detail", () => {
    it("returns app data with scores, enrichment, and scope details", async () => {
      const result = await loader(makeLoaderArgs("installed-1"));

      expect(result).toHaveProperty("app");
      expect(result).toHaveProperty("enrichment");
      expect(result).toHaveProperty("riskScore");
      expect(result).toHaveProperty("scopes");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = result as any;
      expect(data.app.id).toBe("installed-1");
      expect(data.app.appName).toBe("Test App");
      expect(data.app.appHandle).toBe("test-app");
      expect(data.app.presence).toBe("INSTALLED");

      expect(data.enrichment.categoryName).toBe("Marketing and conversion");
      expect(data.enrichment.rating).toBe(4.5);
      expect(data.enrichment.reviewCount).toBe(100);
      expect(data.enrichment.pricingModel).toBe("Subscription");

      expect(data.riskScore).toEqual(APP_RISK_SCORE);
    });

    it("returns scope details with sensitivity and expected/unexpected flags", async () => {
      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<{
          handle: string;
          description: string;
          sensitivity: string;
          isExpected: boolean;
        }>;
      };

      expect(result.scopes).toHaveLength(2);

      // write_orders should be unexpected (from mockGetUnexpectedScopes)
      const writeOrders = result.scopes.find((s) => s.handle === "write_orders");
      expect(writeOrders).toBeDefined();
      expect(writeOrders!.sensitivity).toBe("CRITICAL");
      expect(writeOrders!.isExpected).toBe(false);

      // read_orders should be expected
      const readOrders = result.scopes.find((s) => s.handle === "read_orders");
      expect(readOrders).toBeDefined();
      expect(readOrders!.sensitivity).toBe("HIGH");
      expect(readOrders!.isExpected).toBe(true);
    });

    it("sorts scopes with unexpected first, then by sensitivity descending", async () => {
      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<{
          handle: string;
          isExpected: boolean;
          sensitivity: string;
        }>;
      };

      // write_orders is unexpected+CRITICAL, should come first
      expect(result.scopes[0].handle).toBe("write_orders");
      expect(result.scopes[0].isExpected).toBe(false);

      // read_orders is expected+HIGH, should come second
      expect(result.scopes[1].handle).toBe("read_orders");
      expect(result.scopes[1].isExpected).toBe(true);
    });

    it("uses API description when available, falls back to default", async () => {
      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<{ handle: string; description: string }>;
      };

      // read_orders has an API description
      const readOrders = result.scopes.find((s) => s.handle === "read_orders");
      expect(readOrders!.description).toBe("Read orders");

      // write_orders has null API description, should use our default
      const writeOrders = result.scopes.find((s) => s.handle === "write_orders");
      expect(writeOrders!.description).toBe("Create, update, cancel, and refund orders");
    });

    it("calls scoreApp with correct scope handles and category slug", async () => {
      await loader(makeLoaderArgs("installed-1"));

      expect(mockScoreApp).toHaveBeenCalledWith(
        ["read_orders", "write_orders"],
        "marketing-and-conversion",
      );
    });

    it("calls getUnexpectedScopes with category slug and scope handles", async () => {
      await loader(makeLoaderArgs("installed-1"));

      expect(mockGetUnexpectedScopes).toHaveBeenCalledWith("marketing-and-conversion", [
        "read_orders",
        "write_orders",
      ]);
    });

    it("calls enrichApp with app handle", async () => {
      await loader(makeLoaderArgs("installed-1"));

      expect(mockEnrichApp).toHaveBeenCalledWith("test-app");
    });

    it("syncs installed apps when fetch returns results", async () => {
      await loader(makeLoaderArgs("installed-1"));

      expect(mockFetchAllInstalledApps).toHaveBeenCalledWith(MOCK_ADMIN);
      expect(mockSyncInstalledApps).toHaveBeenCalled();
    });

    it("does not sync when fetch returns empty", async () => {
      mockFetchAllInstalledApps.mockResolvedValue([]);

      await loader(makeLoaderArgs("installed-1"));

      expect(mockSyncInstalledApps).not.toHaveBeenCalled();
    });

    it("serializes dates as ISO strings", async () => {
      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        app: { firstSeenAt: string; lastSeenAt: string };
      };

      expect(result.app.firstSeenAt).toBe("2026-03-21T12:00:00.000Z");
      expect(result.app.lastSeenAt).toBe("2026-03-21T12:00:00.000Z");
    });
  });

  describe("error handling", () => {
    it("throws 400 when appId param is missing", async () => {
      const args = makeLoaderArgs("", { params: {} });

      await expect(loader(args)).rejects.toThrow();
      try {
        await loader(args);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(400);
      }
    });

    it("throws 404 for unknown app ID", async () => {
      mockGetInstalledAppById.mockResolvedValue(null);

      await expect(loader(makeLoaderArgs("nonexistent"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("nonexistent"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });

    it("throws 404 when shop is not found", async () => {
      mockGetShopByDomain.mockResolvedValue(null);

      await expect(loader(makeLoaderArgs("installed-1"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("installed-1"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });

    it("throws 404 when app belongs to a different shop", async () => {
      mockGetInstalledAppById.mockResolvedValue({
        ...INSTALLED_APP,
        shopId: "different-shop",
      });

      await expect(loader(makeLoaderArgs("installed-1"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("installed-1"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });
  });

  describe("null enrichment data", () => {
    it("handles app without enrichment data gracefully", async () => {
      mockEnrichApp.mockReturnValue(null);

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        enrichment: Record<string, unknown>;
        scopes: Array<{ isExpected: boolean }>;
      };

      // Falls back to publicCategory from InstalledApp
      expect(result.enrichment.categoryName).toBe("Marketing");
      expect(result.enrichment.rating).toBeNull();
      expect(result.enrichment.reviewCount).toBeNull();
      expect(result.enrichment.pricingModel).toBeNull();
    });

    it("passes null categorySlug to scoreApp when no enrichment", async () => {
      mockEnrichApp.mockReturnValue(null);

      await loader(makeLoaderArgs("installed-1"));

      expect(mockScoreApp).toHaveBeenCalledWith(["read_orders", "write_orders"], null);
    });

    it("does not call getUnexpectedScopes when category is null", async () => {
      mockEnrichApp.mockReturnValue(null);

      await loader(makeLoaderArgs("installed-1"));

      expect(mockGetUnexpectedScopes).not.toHaveBeenCalled();
    });

    it("marks all scopes as expected when category is unknown", async () => {
      mockEnrichApp.mockReturnValue(null);

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<{ handle: string; isExpected: boolean }>;
      };

      expect(result.scopes.every((s) => s.isExpected)).toBe(true);
    });

    it("shows 'Unknown category' when no enrichment and no publicCategory", async () => {
      mockEnrichApp.mockReturnValue(null);
      mockGetInstalledAppById.mockResolvedValue({
        ...INSTALLED_APP,
        publicCategory: null,
      });

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        enrichment: { categoryName: string | null };
      };

      expect(result.enrichment.categoryName).toBeNull();
    });
  });

  describe("REMOVED app", () => {
    it("returns data for a REMOVED app (still viewable)", async () => {
      const removedApp = {
        ...INSTALLED_APP,
        presence: "REMOVED",
        removedAt: new Date("2026-03-20T10:00:00Z"),
      };
      mockGetInstalledAppById.mockResolvedValue(removedApp);

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        app: { presence: string; appName: string };
      };

      expect(result.app.presence).toBe("REMOVED");
      expect(result.app.appName).toBe("Test App");
    });

    it("returns empty scopes when removed app is not in fetched apps", async () => {
      const removedApp = {
        ...INSTALLED_APP,
        presence: "REMOVED",
        shopifyAppId: "gid://shopify/App/999",
      };
      mockGetInstalledAppById.mockResolvedValue(removedApp);

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<unknown>;
      };

      expect(result.scopes).toHaveLength(0);
    });
  });

  describe("scope with unknown handle", () => {
    it("falls back to generated description for unknown scope handles", async () => {
      mockFetchAllInstalledApps.mockResolvedValue([
        {
          ...FETCHED_APP,
          accessScopes: [{ handle: "read_some_new_thing", description: null }],
        },
      ]);
      mockGetUnexpectedScopes.mockReturnValue([]);
      mockGetScopeSensitivity.mockReturnValue("MEDIUM");

      const result = (await loader(makeLoaderArgs("installed-1"))) as {
        scopes: Array<{ handle: string; description: string }>;
      };

      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0].description).toBe("Access to read some new thing");
    });
  });
});
