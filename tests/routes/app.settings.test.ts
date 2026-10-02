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
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
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

// gc-syz.6: monitoring-emails card collaborators, mocked at their boundaries.
vi.mock("../../app/models/merchant-alert.server", () => ({
  setShopAlertsEnabled: vi.fn(),
}));

vi.mock("../../app/services/merchant-alert.server", () => ({
  getMerchantAlertConfigStatus: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canReceiveAlerts: vi.fn(),
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
import { canReceiveAlerts } from "../../app/lib/plan-gating.server";
import { hasBillingHistory } from "../../app/models/billing-event.server";
import { setShopAlertsEnabled } from "../../app/models/merchant-alert.server";
import { getShopMetadata } from "../../app/models/shop.server";
import Settings, { action, loader, scopeBadge } from "../../app/routes/app.settings";
import { getMerchantAlertConfigStatus } from "../../app/services/merchant-alert.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetPlanFeatures = getPlanFeatures as ReturnType<typeof vi.fn>;
const mockBuildPricingPlansUrl = buildPricingPlansUrl as ReturnType<typeof vi.fn>;
const mockHasBillingHistory = hasBillingHistory as ReturnType<typeof vi.fn>;
const mockCanReceiveAlerts = canReceiveAlerts as ReturnType<typeof vi.fn>;
const mockSetAlertsEnabled = setShopAlertsEnabled as ReturnType<typeof vi.fn>;
const mockAlertConfig = getMerchantAlertConfigStatus as ReturnType<typeof vi.fn>;

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
  alertsEnabled: true,
  alertEmail: "owner@example.com" as string | null,
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

type AlertsData = {
  configured: boolean;
  canReceive: boolean;
  cadence: string;
  enabled: boolean;
  email: string | null;
};
const DARK_ALERTS: AlertsData = {
  configured: false,
  canReceive: false,
  cadence: "none",
  enabled: true,
  email: null,
};

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
  mockCanReceiveAlerts.mockReturnValue(false);
  mockAlertConfig.mockReturnValue({ configured: false, reason: "disabled" });
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
  function renderSettings(
    plan: string,
    trialEligible: boolean,
    alerts: Partial<AlertsData> = {},
  ): string {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible,
      alerts: { ...DARK_ALERTS, ...alerts },
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

// ---------------------------------------------------------------------------
// Monitoring emails (gc-syz.6)
// ---------------------------------------------------------------------------

describe("app.settings loader: alerts", () => {
  it("returns alerts state for a paid, configured shop", async () => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Standard" });
    mockGetPlanFeatures.mockReturnValue({ ...FREE_FEATURES, alertCadence: "weekly" });
    mockCanReceiveAlerts.mockReturnValue(true);
    mockAlertConfig.mockReturnValue({ configured: true });

    const result = (await loader(makeLoaderArgs())) as { alerts: AlertsData };

    expect(mockCanReceiveAlerts).toHaveBeenCalledWith("Standard");
    expect(result.alerts).toEqual({
      configured: true,
      canReceive: true,
      cadence: "weekly",
      enabled: true,
      email: "owner@example.com",
    });
  });

  it("passes a null cached email through and reports an unconfigured env", async () => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, alertEmail: null, alertsEnabled: false });

    const result = (await loader(makeLoaderArgs())) as { alerts: AlertsData };

    expect(result.alerts.configured).toBe(false);
    expect(result.alerts.email).toBeNull();
    expect(result.alerts.enabled).toBe(false);
  });
});

describe("app.settings action: set-alerts-enabled", () => {
  function makeActionArgs(fields: Record<string, string>): ActionFunctionArgs {
    return {
      request: new Request(`https://${SHOP_DOMAIN}/app/settings`, {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs;
  }

  beforeEach(() => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Standard" });
    mockCanReceiveAlerts.mockReturnValue(true);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("enabled=%s writes %s for the SESSION shop only", async (value, expected) => {
    const result = await action(
      makeActionArgs({ intent: "set-alerts-enabled", enabled: value, shopId: "other-shop" }),
    );

    expect(mockGetShopMetadata).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mockSetAlertsEnabled).toHaveBeenCalledExactlyOnceWith("shop-1", expected);
    expect(result).toEqual({ alertsEnabled: expected });
  });

  it.each([
    ["missing enabled", { intent: "set-alerts-enabled" }],
    ["non-boolean enabled", { intent: "set-alerts-enabled", enabled: "yes" }],
    ["empty enabled", { intent: "set-alerts-enabled", enabled: "" }],
    ["unknown intent", { intent: "other", enabled: "true" }],
    ["no intent", { enabled: "true" }],
  ])("rejects %s without writing", async (_l, fields) => {
    const result = (await action(makeActionArgs(fields))) as { error?: string };

    expect(result.error).toBeTruthy();
    expect(mockSetAlertsEnabled).not.toHaveBeenCalled();
  });

  it("rejects a Free shop (no alerts on that plan) without writing", async () => {
    mockCanReceiveAlerts.mockReturnValue(false);

    const result = (await action(
      makeActionArgs({ intent: "set-alerts-enabled", enabled: "true" }),
    )) as { error?: string };

    expect(result.error).toMatch(/not included/);
    expect(mockSetAlertsEnabled).not.toHaveBeenCalled();
  });

  it("returns an error when the shop row is missing", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = (await action(
      makeActionArgs({ intent: "set-alerts-enabled", enabled: "true" }),
    )) as { error?: string };

    expect(result.error).toBeTruthy();
    expect(mockSetAlertsEnabled).not.toHaveBeenCalled();
  });
});

describe("Settings Monitoring emails card", () => {
  function renderSettings(plan: string, trialEligible: boolean, alerts: Partial<AlertsData>) {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible,
      alerts: { ...DARK_ALERTS, ...alerts },
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

  const PAID: Partial<AlertsData> = {
    configured: true,
    canReceive: true,
    cadence: "weekly",
    email: "owner@example.com",
  };

  it("is hidden while merchant alerts are not configured (dark by default)", () => {
    const html = renderSettings("Standard", false, { ...PAID, configured: false });

    expect(html).not.toContain("Monitoring emails");
    expect(html).not.toContain("s-checkbox");
  });

  it("hidden for Free too when not configured", () => {
    expect(renderSettings("free", true, { configured: false })).not.toContain("Monitoring emails");
  });

  it("paid: shows a checkbox bound to alertsEnabled and the weekly copy with the cached email", () => {
    const html = renderSettings("Standard", false, PAID);

    expect(html).toContain("Monitoring emails");
    expect(html).toMatch(/<s-checkbox[^>]*checked/);
    expect(html).toContain(
      "We email owner@example.com when a weekly rescan finds new leftover code.",
    );
  });

  it("paid: unchecked when alertsEnabled is false", () => {
    const html = renderSettings("Standard", false, { ...PAID, enabled: false });

    expect(html).toMatch(/<s-checkbox/);
    expect(html).not.toMatch(/<s-checkbox[^>]*checked/);
  });

  it("paid: daily cadence and the store-owner fallback when no email is cached", () => {
    const html = renderSettings("Professional", false, {
      ...PAID,
      cadence: "daily",
      email: null,
    });

    expect(html).toContain("We email the store owner when a daily rescan finds new leftover code.");
  });

  it("Free: no checkbox; plan copy plus the trial CTA to the pricing page", () => {
    const html = renderSettings("free", true, { configured: true });

    expect(html).toContain("Monitoring emails");
    expect(html).not.toContain("<s-checkbox");
    expect(html).toContain(
      "Monitoring emails are included with Standard (weekly rescans) and Professional (daily rescans).",
    );
    // Standard tile + Professional tile + card CTA + Manage subscription.
    expect(html.match(/Start 7-day free trial/g)).toHaveLength(3);
  });

  it("Free, trial used: the card CTA reads Upgrade to Standard", () => {
    const html = renderSettings("free", false, { configured: true });

    expect(html.match(/Upgrade to Standard/g)).toHaveLength(2);
    expect(html).not.toContain("Start 7-day");
  });
});
