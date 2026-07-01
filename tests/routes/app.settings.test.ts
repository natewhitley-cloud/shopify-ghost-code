/**
 * Tests for app/routes/app.settings.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session context.
 *   - Mock getShopMetadata, getPlanFeatures, and buildPricingPlansUrl.
 *   - Verify loader returns correct plan, feature info, and the managed
 *     pricing URL built from the session shop domain.
 *   - No action tests — billing uses Shopify Managed Pricing; plan changes
 *     happen on Shopify's native pricing_plans page, not via an in-app action.
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
  PLAN_STANDARD: "Standard",
  PLAN_PROFESSIONAL: "Professional",
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/lib/billing.server", () => ({
  getPlanFeatures: vi.fn(),
  buildPricingPlansUrl: vi.fn(),
}));

vi.mock("../../app/lib/plans", () => ({
  PLANS: { FREE: "free", STANDARD: "Standard", PROFESSIONAL: "Professional" },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { buildPricingPlansUrl, getPlanFeatures } from "../../app/lib/billing.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.settings";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;
const mockBuildPricingPlansUrl = buildPricingPlansUrl as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const PRICING_PLANS_URL =
  "https://admin.shopify.com/store/test-shop/charges/ghost-code/pricing_plans";

const SHOP = {
  id: "shop-1",
  domain: SHOP_DOMAIN,
  plan: "free",
};

const FREE_FEATURES = {
  maxScansPerMonth: 1,
  maxScansPerWeek: Infinity,
  showFindingDetails: false,
  maxThemes: 1,
  autoRescan: false,
  scanDiffing: false,
  scheduledScan: false,
};

function makeLoaderArgs(overrides?: Partial<LoaderFunctionArgs>): LoaderFunctionArgs {
  return {
    request: new Request(`https://${SHOP_DOMAIN}/app/settings`),
    params: {},
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP_DOMAIN },
  });

  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockGetPlanFeatures.mockReturnValue(FREE_FEATURES);
  mockBuildPricingPlansUrl.mockReturnValue(PRICING_PLANS_URL);
});

// ---------------------------------------------------------------------------
// Loader Tests
// ---------------------------------------------------------------------------

describe("app.settings loader", () => {
  it("returns current plan, feature info, and the managed pricing URL", async () => {
    const result = (await loader(makeLoaderArgs())) as {
      shop: { plan: string; domain: string };
      features: typeof FREE_FEATURES;
      pricingPlansUrl: string;
    };

    expect(result.shop.plan).toBe("free");
    expect(result.shop.domain).toBe(SHOP_DOMAIN);
    expect(result.pricingPlansUrl).toBe(PRICING_PLANS_URL);
    expect(mockBuildPricingPlansUrl).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(result.features).toEqual(FREE_FEATURES);
  });

  it("throws 404 when shop not found", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(loader(makeLoaderArgs())).rejects.toThrow();
    try {
      await loader(makeLoaderArgs());
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});
