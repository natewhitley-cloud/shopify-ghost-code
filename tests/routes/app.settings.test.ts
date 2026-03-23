/**
 * Tests for app/routes/app.settings.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session and billing context.
 *   - Mock getShopByDomain and getPlanFeatures.
 *   - Verify loader returns correct plan and feature info.
 *   - Verify action calls billing.request with correct amounts per intent.
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
import { loader, action } from "../../app/routes/app.settings";
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

const mockBillingRequest = vi.fn();

function makeLoaderArgs(overrides?: Partial<LoaderFunctionArgs>): LoaderFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/app/settings"),
    params: {},
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

function makeActionArgs(
  intent: string,
  overrides?: Partial<ActionFunctionArgs>,
): ActionFunctionArgs {
  const formData = new URLSearchParams();
  formData.set("intent", intent);

  return {
    request: new Request("https://test-shop.myshopify.com/app/settings", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
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
    billing: { request: mockBillingRequest },
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

// ---------------------------------------------------------------------------
// Action Tests
// ---------------------------------------------------------------------------

describe("app.settings action", () => {
  it("calls billing.request with Standard plan for subscribe-standard intent", async () => {
    // billing.request throws a redirect response (never returns normally)
    mockBillingRequest.mockRejectedValue(new Response(null, { status: 302 }));

    await expect(action(makeActionArgs("subscribe-standard"))).rejects.toThrow();

    expect(mockBillingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: "Standard",
      }),
    );
  });

  it("calls billing.request with Professional plan for subscribe-professional intent", async () => {
    mockBillingRequest.mockRejectedValue(new Response(null, { status: 302 }));

    await expect(action(makeActionArgs("subscribe-professional"))).rejects.toThrow();

    expect(mockBillingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: "Professional",
      }),
    );
  });

  it("returns error for unknown intent", async () => {
    const result = (await action(makeActionArgs("unknown-intent"))) as {
      error: string;
    };

    expect(result.error).toBe("Unknown intent");
    expect(mockBillingRequest).not.toHaveBeenCalled();
  });

  it("returns error for missing intent (empty form)", async () => {
    const args: ActionFunctionArgs = {
      request: new Request("https://test-shop.myshopify.com/app/settings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs;

    const result = (await action(args)) as { error: string };

    expect(result.error).toBe("Unknown intent");
    expect(mockBillingRequest).not.toHaveBeenCalled();
  });
});
