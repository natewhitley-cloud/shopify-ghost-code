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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
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

// gc-97k.8: BillingEvent history behind trial eligibility, mocked at the model
// boundary so the REAL trial-eligibility service runs.
vi.mock("../../app/models/billing-event.server", () => ({
  hasBillingHistory: vi.fn(),
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
import { hasBillingHistory } from "../../app/models/billing-event.server";
import { getShopMetadata } from "../../app/models/shop.server";
import Settings, { loader, scopeBadge } from "../../app/routes/app.settings";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;
const mockBuildPricingPlansUrl = buildPricingPlansUrl as ReturnType<typeof vi.fn>;
const mockHasBillingHistory = hasBillingHistory as ReturnType<typeof vi.fn>;

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
  // gc-97k.8: never seen on a paid plan.
  everPaidAt: null as Date | null,
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
  mockHasBillingHistory.mockResolvedValue(false);
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

  it("never-paid Free shop: trialEligible", async () => {
    const result = (await loader(makeLoaderArgs())) as { trialEligible: boolean };

    expect(result.trialEligible).toBe(true);
    expect(mockHasBillingHistory).toHaveBeenCalledWith("shop-1");
  });

  it("Free shop with everPaidAt set (backstop-only paid, no BillingEvent): not trialEligible, no history read", async () => {
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      everPaidAt: new Date("2026-05-01T00:00:00Z"),
    });

    const result = (await loader(makeLoaderArgs())) as { trialEligible: boolean };

    expect(result.trialEligible).toBe(false);
    expect(mockHasBillingHistory).not.toHaveBeenCalled();
  });

  it("previously-paid Free shop (has a BillingEvent): not trialEligible", async () => {
    mockHasBillingHistory.mockResolvedValue(true);

    const result = (await loader(makeLoaderArgs())) as { trialEligible: boolean };

    expect(result.trialEligible).toBe(false);
  });

  it("paid shop: not trialEligible, and no billing-history read", async () => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Standard" });

    const result = (await loader(makeLoaderArgs())) as { trialEligible: boolean };

    expect(result.trialEligible).toBe(false);
    expect(mockHasBillingHistory).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Permissions card badge state
// ---------------------------------------------------------------------------

describe("scopeBadge (PermissionsCard)", () => {
  it("marks a granted scope as Granted (success)", () => {
    expect(scopeBadge(["read_products", "read_content"], "read_products")).toEqual({
      tone: "success",
      text: "Granted",
    });
  });

  it("marks a scope absent from a successful query as Not granted (warning)", () => {
    expect(scopeBadge(["read_content"], "read_products")).toEqual({
      tone: "warning",
      text: "Not granted",
    });
  });

  it("marks an empty-but-successful query as Not granted, not unavailable", () => {
    expect(scopeBadge([], "read_products")).toEqual({ tone: "warning", text: "Not granted" });
  });

  it("shows Status unavailable (neutral) when the query failed (granted === null)", () => {
    // Regression: a rejected scopes.query() must not render every scope as a
    // false "Not granted" — the grant state is unknown, not denied.
    expect(scopeBadge(null, "read_products")).toEqual({
      tone: "neutral",
      text: "Status unavailable",
    });
  });
});

// ---------------------------------------------------------------------------
// Plan tile buttons (gc-97k.8): trial vs previously-paid copy
// ---------------------------------------------------------------------------

describe("Settings plan tile buttons", () => {
  /** Render the real Settings page with the given loader data. */
  function renderSettings(plan: string, trialEligible: boolean): string {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible,
    };
    const Stub = createRoutesStub([
      {
        id: "settings",
        path: "/app/settings",
        Component: Settings as never,
        loader: () => loaderData,
      },
    ]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/app/settings"],
        hydrationData: { loaderData: { settings: loaderData } },
      }),
    );
  }

  /** Every plan-tile / manage button label, in page order. */
  function buttonLabels(html: string): string[] {
    return [...html.matchAll(/<s-button[^>]*>([^<]*)<\/s-button>/g)].map((m) => m[1]);
  }

  it("never-paid Free shop: both paid tiles offer the 7-day trial", () => {
    expect(buttonLabels(renderSettings("free", true))).toEqual([
      "Start 7-day free trial",
      "Start 7-day free trial",
      "Manage subscription in Shopify",
    ]);
  });

  it("previously-paid Free shop: plain upgrade labels, no trial promise on a button", () => {
    expect(buttonLabels(renderSettings("free", false))).toEqual([
      "Upgrade to Standard",
      "Upgrade to Professional",
      "Manage subscription in Shopify",
    ]);
  });

  it("Standard shop: unchanged (Upgrade to Professional)", () => {
    expect(buttonLabels(renderSettings("Standard", false))).toEqual([
      "Upgrade to Professional",
      "Manage subscription in Shopify",
    ]);
  });

  it("Professional shop: unchanged (Downgrade to Standard)", () => {
    expect(buttonLabels(renderSettings("Professional", false))).toEqual([
      "Downgrade to Standard",
      "Manage subscription in Shopify",
    ]);
  });

  /** Every plan-tile feature bullet, in page order. */
  function bullets(html: string): string[] {
    return [...html.matchAll(/<s-list-item[^>]*>([^<]*)<\/s-list-item>/g)].map((m) => m[1]);
  }
  const TRIAL_BULLET = "7-day free trial";

  it("never-paid Free shop: both paid tiles list the 7-day free trial bullet", () => {
    expect(bullets(renderSettings("free", true)).filter((b) => b === TRIAL_BULLET)).toHaveLength(2);
  });

  it.each([
    ["free", "previously-paid Free shop"],
    ["Standard", "Standard shop"],
    ["Professional", "Professional shop"],
  ])("%s (%s): no trial bullet anywhere, matching the buttons", (plan) => {
    const html = renderSettings(plan, false);

    expect(bullets(html)).not.toContain(TRIAL_BULLET);
    expect(html).not.toMatch(/free trial/i);
    // The other feature bullets are untouched.
    expect(bullets(html)).toContain("Full finding details with code");
    expect(bullets(html)).toContain("Scan diffing (New/Resolved)");
  });

  it("the Free tile lists the owner-approved bullets, identical to the doc's App listing features", async () => {
    const freeTile = bullets(renderSettings("free", true)).slice(0, 5);
    expect(freeTile).toEqual([
      "First scan always free",
      "1 scan per month after first",
      "Findings grouped by impact, with counts",
      "Up to 5 findings shown in full",
      "Single theme scanning",
    ]);
    expect(freeTile).not.toContain("Preview of top finding in full");
    for (const b of freeTile) {
      expect(b.length).toBeLessThanOrEqual(40); // Managed Pricing card limit
      expect(b).not.toMatch(/[\u2013\u2014]/);
    }

    // Kept in sync with docs/pricing-and-plans.md, which the owner pastes into
    // the Managed Pricing Free plan card.
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../docs/pricing-and-plans.md", import.meta.url), "utf8");
    const listing = doc.slice(doc.indexOf("**App listing features (max 40 chars each):**"));
    const docBullets = [...listing.matchAll(/^\d\. (.+)$/gm)].slice(0, 5).map((m) => m[1]);
    expect(docBullets).toEqual(freeTile);
  });

  it("every plan button links top-level to the Managed Pricing page", () => {
    const html = renderSettings("free", true);
    const pricingAnchors = (html.match(/<a [^>]*>/g) ?? []).filter((a) =>
      a.includes("pricing_plans"),
    );
    // Standard tile, Professional tile, Manage subscription.
    expect(pricingAnchors).toHaveLength(3);
    for (const a of pricingAnchors) {
      expect(a).toContain(`href="${PRICING_PLANS_URL}"`);
      expect(a).toContain('target="_top"');
    }
  });
});
