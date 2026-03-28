/**
 * Tests for app/routes/app.settings.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session context.
 *   - Mock getShopByDomain and getPlanFeatures.
 *   - Verify loader returns correct plan and feature info.
 *   - No action tests — billing is handled via Managed Pricing in the
 *     Partner Dashboard, so the settings route has no action export.
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
  getShopByDomain: vi.fn(),
}));

vi.mock("../../app/lib/billing.server", () => ({
  getPlanFeatures: vi.fn(),
}));

vi.mock("../../app/lib/plans", () => ({
  PLANS: { FREE: "Free", STANDARD: "Standard", PROFESSIONAL: "Professional" },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getPlanFeatures } from "../../app/lib/billing.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.settings";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Free",
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
    request: new Request("https://test-shop.myshopify.com/app/settings"),
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
    session: { shop: SHOP.domain },
  });

  mockGetShopByDomain.mockResolvedValue(SHOP);
  mockGetPlanFeatures.mockReturnValue(FREE_FEATURES);
});

// ---------------------------------------------------------------------------
// Loader Tests
// ---------------------------------------------------------------------------

describe("app.settings loader", () => {
  it("returns current plan and feature info", async () => {
    const result = (await loader(makeLoaderArgs())) as {
      shop: { plan: string; domain: string };
      features: typeof FREE_FEATURES;
    };

    expect(result.shop.plan).toBe("Free");
    expect(result.shop.domain).toBe("test-shop.myshopify.com");
    expect(result.features).toEqual(FREE_FEATURES);
  });

  it("throws 404 when shop not found", async () => {
    mockGetShopByDomain.mockResolvedValue(null);

    await expect(loader(makeLoaderArgs())).rejects.toThrow();
    try {
      await loader(makeLoaderArgs());
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});
