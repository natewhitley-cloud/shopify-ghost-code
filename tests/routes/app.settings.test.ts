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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  setSummaryEmailsEnabled: vi.fn(),
  // gc-njwa #5: the guard email toggle's writes.
  enableGuardEmail: vi.fn(),
  turnOffGuardEmail: vi.fn(),
  getGuardEmailConsent: vi.fn(),
  claimGuardEmailNoticeShown: vi.fn(),
}));

vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopAlertEmail: vi.fn(),
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
import { BROKEN_LINKS_STANDARD_NOTE } from "../../app/lib/optional-scopes";
import { canReceiveAlerts } from "../../app/lib/plan-gating.server";
import { PLAN_LISTING_BULLETS, TRIAL_BULLET } from "../../app/lib/plan-tiles";
import { hasBillingHistory } from "../../app/models/billing-event.server";
import {
  enableGuardEmail,
  getGuardEmailConsent,
  setSummaryEmailsEnabled,
  turnOffGuardEmail,
} from "../../app/models/merchant-alert.server";
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
const mockSetAlertsEnabled = setSummaryEmailsEnabled as ReturnType<typeof vi.fn>;
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
  summaryNoticePendingAt: null as Date | null,
  summaryNoticeShownAt: null as Date | null,
  summaryOptedInAt: null as Date | null,
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
  speedInSummary: boolean;
};
const DARK_ALERTS: AlertsData = {
  configured: false,
  canReceive: false,
  cadence: "none",
  enabled: true,
  email: null,
  speedInSummary: false,
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
  it("passes whether the menu check runs, for the Permissions card (wave 3 U4)", async () => {
    const prev = process.env.MENU_INJECTION_LIVE_ENABLED;
    try {
      delete process.env.MENU_INJECTION_LIVE_ENABLED;
      expect(((await loader(makeLoaderArgs())) as { menuCheckLive: boolean }).menuCheckLive).toBe(
        false,
      );
      process.env.MENU_INJECTION_LIVE_ENABLED = "true";
      expect(((await loader(makeLoaderArgs())) as { menuCheckLive: boolean }).menuCheckLive).toBe(
        true,
      );
    } finally {
      if (prev === undefined) delete process.env.MENU_INJECTION_LIVE_ENABLED;
      else process.env.MENU_INJECTION_LIVE_ENABLED = prev;
    }
  });

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

  describe("freeSpeedTestTiles: from the plan matrix, only while the speed report is live", () => {
    afterEach(() => {
      delete process.env.SPEED_REPORT_LIVE_ENABLED;
    });

    it.each([
      ["live, Free has it", "true", true, { free: true }],
      ["live, Free narrowed out", "true", false, { free: false }],
      ["dark", undefined, true, { free: false }],
    ] as const)("%s", async (_label, flag, has, expected) => {
      if (flag === undefined) delete process.env.SPEED_REPORT_LIVE_ENABLED;
      else process.env.SPEED_REPORT_LIVE_ENABLED = flag;
      mockGetPlanFeatures.mockImplementation((plan: string) => ({
        ...FREE_FEATURES,
        freeSpeedTest: plan === "free" ? has : false,
      }));
      const result = (await loader(makeLoaderArgs())) as {
        freeSpeedTestTiles: { free: boolean };
      };
      expect(result.freeSpeedTestTiles).toEqual(expected);
    });
  });

  describe("speedReportTiles (gc-d0ui): Standard monthly, Professional weekly, only while live", () => {
    afterEach(() => {
      delete process.env.SPEED_REPORT_LIVE_ENABLED;
    });

    it.each([
      ["live", "true", { standard: true, professional: true }],
      ["dark", undefined, { standard: false, professional: false }],
    ] as const)("%s", async (_label, flag, expected) => {
      if (flag === undefined) delete process.env.SPEED_REPORT_LIVE_ENABLED;
      else process.env.SPEED_REPORT_LIVE_ENABLED = flag;
      mockGetPlanFeatures.mockImplementation((plan: string) => ({
        ...FREE_FEATURES,
        speedReportCadence:
          plan === "Standard" ? "monthly" : plan === "Professional" ? "weekly" : "none",
      }));
      const result = (await loader(makeLoaderArgs())) as {
        speedReportTiles: { standard: boolean; professional: boolean };
      };
      expect(result.speedReportTiles).toEqual(expected);
    });
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
// Plan section (gc-97k.8, gc-4wvb): PlanTiles, a CTA on every non-current tile
// ---------------------------------------------------------------------------

describe("Settings plan section", () => {
  type Tiles = { free: boolean; standard: boolean; professional: boolean };
  const LIVE: Tiles = { free: true, standard: true, professional: true };
  const DARK: Tiles = { free: false, standard: false, professional: false };

  /** Render the real Settings page with the given loader data. */
  function renderSettings(
    plan: string,
    trialEligible: boolean,
    alerts: Partial<AlertsData> = {},
    speed: Tiles = LIVE,
  ): string {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible,
      alerts: { ...DARK_ALERTS, ...alerts },
      freeSpeedTestTiles: { free: speed.free },
      speedReportTiles: { standard: speed.standard, professional: speed.professional },
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

  /** Every button on the page (label + variant), in page order. */
  function buttons(html: string): { label: string; variant: string }[] {
    return [...html.matchAll(/<s-button([^>]*)>([^<]*)<\/s-button>/g)].map((m) => ({
      label: m[2],
      variant: /variant="([^"]+)"/.exec(m[1])?.[1] ?? "",
    }));
  }

  /** Every plan-tile feature bullet, in page order. */
  function bullets(html: string): string[] {
    return [...html.matchAll(/<s-list-item[^>]*>([^<]*)<\/s-list-item>/g)].map((m) => m[1]);
  }

  const TRIAL = "Start 7-day free trial";

  it("never-paid Free shop: both paid tiles offer the 7-day trial (primary)", () => {
    // The Summary emails card adds its Free CTA last.
    expect(buttons(renderSettings("free", true))).toEqual([
      { label: TRIAL, variant: "primary" },
      { label: TRIAL, variant: "primary" },
      { label: TRIAL, variant: "primary" },
    ]);
  });

  it("previously-paid Free shop: plain upgrade labels, no trial promise on a button", () => {
    expect(buttons(renderSettings("free", false))).toEqual([
      { label: "Upgrade to Standard", variant: "primary" },
      { label: "Upgrade to Professional", variant: "primary" },
      { label: "Upgrade to Standard", variant: "primary" },
    ]);
  });

  it("Standard shop: secondary Downgrade to Free, primary Upgrade to Professional", () => {
    expect(buttons(renderSettings("Standard", false, { canReceive: true }))).toEqual([
      { label: "Downgrade to Free", variant: "secondary" },
      { label: "Upgrade to Professional", variant: "primary" },
    ]);
  });

  it("Professional shop: two secondary downgrades, no upgrade", () => {
    expect(buttons(renderSettings("Professional", false, { canReceive: true }))).toEqual([
      { label: "Downgrade to Free", variant: "secondary" },
      { label: "Downgrade to Standard", variant: "secondary" },
    ]);
  });

  it.each(["free", "Standard", "Professional"])(
    "%s: no Manage Subscription card; the one subdued billing line instead",
    (plan) => {
      const html = renderSettings(plan, false, { canReceive: plan !== "free" });
      expect(html).not.toMatch(/manage subscription/i);
      expect(html).toContain(
        "Plan changes and cancellations happen on Shopify&#x27;s pricing page, and GhostCode is billed on your Shopify invoice.",
      );
      expect(html).toContain(">Plan</h2>");
      expect(html.match(/Current plan/g)).toHaveLength(1);
    },
  );

  it.each([
    ["free", true, 3],
    ["Standard", false, 2],
    ["Professional", false, 2],
  ] as const)("%s: every CTA links top-level to the Managed Pricing page", (plan, eligible, n) => {
    const html = renderSettings(plan, eligible, { canReceive: plan !== "free" });
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    const pricing = anchors.filter((a) => a.includes("pricing_plans"));
    expect(pricing).toHaveLength(n);
    expect(pricing).toHaveLength(buttons(html).length);
    for (const a of pricing) {
      expect(a).toContain(`href="${PRICING_PLANS_URL}"`);
      expect(a).toContain('target="_top"');
    }
  });

  it("an unrecognised stored plan reads as Free: Free tile current, upgrades on both paid tiles", () => {
    const html = renderSettings("legacy", false);
    expect(html.match(/Current plan/g)).toHaveLength(1);
    expect(html.indexOf("Current plan")).toBeLessThan(html.indexOf(">Standard</h3>"));
    expect(buttons(html).map((b) => b.label)).toEqual([
      "Upgrade to Standard",
      "Upgrade to Professional",
      "Upgrade to Standard",
    ]);
  });

  it("the plan tiles have no inline stylesheet (PlanTile carries its own styles)", () => {
    expect(renderSettings("free", true)).not.toContain("<style");
  });

  it("all plans, speed live, not trial-eligible: the tiles show exactly the listing bullets", () => {
    expect(bullets(renderSettings("Standard", false))).toEqual([
      ...PLAN_LISTING_BULLETS.free,
      ...PLAN_LISTING_BULLETS.Standard,
      ...PLAN_LISTING_BULLETS.Professional,
    ]);
  });

  it("never-paid Free shop: both paid tiles add the trial bullet last, the Free tile none", () => {
    expect(bullets(renderSettings("free", true))).toEqual([
      ...PLAN_LISTING_BULLETS.free,
      ...PLAN_LISTING_BULLETS.Standard,
      TRIAL_BULLET,
      ...PLAN_LISTING_BULLETS.Professional,
      TRIAL_BULLET,
    ]);
  });

  it.each([
    ["free", "previously-paid Free shop"],
    ["Standard", "Standard shop"],
    ["Professional", "Professional shop"],
  ])("%s (%s): no trial bullet anywhere, matching the buttons", (plan) => {
    const html = renderSettings(plan, false);
    expect(bullets(html)).not.toContain(TRIAL_BULLET);
    expect(html).not.toMatch(/free trial/i);
  });

  const FREE_TEST_BULLET = "One-time homepage speed test";
  const MONTHLY_BULLET = "Monthly store speed report, cost per app";
  const WEEKLY_BULLET = "Weekly store speed report, cost per app";

  it("speed report dark: each tile drops only its speed bullet", () => {
    const all = bullets(renderSettings("free", false, {}, DARK));
    for (const b of [FREE_TEST_BULLET, MONTHLY_BULLET, WEEKLY_BULLET]) {
      expect(all).not.toContain(b);
    }
    expect(all).toHaveLength(
      PLAN_LISTING_BULLETS.free.length +
        PLAN_LISTING_BULLETS.Standard.length +
        PLAN_LISTING_BULLETS.Professional.length -
        3,
    );
  });

  it("speed bullets follow each plan's own flag", () => {
    const all = bullets(
      renderSettings("free", false, {}, { free: false, standard: true, professional: false }),
    );
    expect(all).not.toContain(FREE_TEST_BULLET);
    expect(all).toContain(MONTHLY_BULLET);
    expect(all).not.toContain(WEEKLY_BULLET);
  });

  it("never claims unlimited scans; Professional's cap is stated", () => {
    const all = bullets(renderSettings("free", false));
    expect(all.join(" ")).not.toMatch(/unlimited/i);
    expect(all).toContain("Up to 5 manual theme scans a day");
  });

  it("the About card is gone; a GhostCode 1.0.0 footer line instead", () => {
    const html = renderSettings("Professional", false);
    expect(html).not.toContain("About GhostCode");
    expect(html).toMatch(/text-align:center[^>]*>GhostCode 1\.0\.0<\/p>/);
  });
});

describe("plan listing bullets equal docs/pricing-and-plans.md 'App listing features'", () => {
  it("every plan's doc list equals the constants, in order", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../docs/pricing-and-plans.md", import.meta.url), "utf8");
    const marker = "**App listing features (max 40 chars each):**";
    const lists = doc
      .split(marker)
      .slice(1)
      .map((chunk) => {
        const out: string[] = [];
        for (const line of chunk.split("\n").slice(1)) {
          const m = /^\d+\. (.+)$/.exec(line);
          if (m) out.push(m[1]);
          else if (out.length > 0) break;
        }
        return out;
      });
    expect(lists).toEqual([
      PLAN_LISTING_BULLETS.free,
      PLAN_LISTING_BULLETS.Standard,
      PLAN_LISTING_BULLETS.Professional,
    ]);
  });

  it("every bullet fits the Managed Pricing 40-char limit, with no em or en dash", () => {
    for (const list of Object.values(PLAN_LISTING_BULLETS)) {
      for (const b of list) {
        expect(b.length).toBeLessThanOrEqual(40);
        expect(b).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Summary emails (gc-syz.6, gc-ol95)
// ---------------------------------------------------------------------------

describe("app.settings loader: alerts", () => {
  beforeEach(() => {
    mockGetPlanFeatures.mockReturnValue({ ...FREE_FEATURES, alertCadence: "weekly" });
    mockCanReceiveAlerts.mockReturnValue(true);
    mockAlertConfig.mockReturnValue({ configured: true });
  });

  it("returns alerts state for a paid, configured shop that was told", async () => {
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      summaryNoticeShownAt: new Date(),
    });

    const result = (await loader(makeLoaderArgs())) as { alerts: AlertsData };

    expect(mockCanReceiveAlerts).toHaveBeenCalledWith("Standard");
    expect(result.alerts).toEqual({
      configured: true,
      canReceive: true,
      cadence: "weekly",
      enabled: true,
      email: "owner@example.com",
      speedInSummary: false,
    });
  });

  describe("speedInSummary (gc-2wnf, gc-d0ui): a plan with the speed report AND the report live", () => {
    afterEach(() => {
      delete process.env.SPEED_REPORT_LIVE_ENABLED;
    });

    it.each([
      ["Professional, live", "Professional", true, "true", true],
      ["Professional, dark", "Professional", true, undefined, false],
      ["Professional, flag not exactly true", "Professional", true, "TRUE", false],
      ["Standard, live (monthly report, gc-d0ui)", "Standard", true, "true", true],
      ["Standard, dark", "Standard", true, undefined, false],
      ["free, live", "free", false, "true", false],
    ])("%s", async (_label, plan, speedReport, flag, expected) => {
      if (flag === undefined) delete process.env.SPEED_REPORT_LIVE_ENABLED;
      else process.env.SPEED_REPORT_LIVE_ENABLED = flag;
      mockGetPlanFeatures.mockReturnValue({
        ...FREE_FEATURES,
        alertCadence: "weekly",
        speedReport,
      });
      mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan });
      const result = (await loader(makeLoaderArgs())) as { alerts: AlertsData };
      expect(mockGetPlanFeatures).toHaveBeenCalledWith(plan);
      expect(result.alerts.speedInSummary).toBe(expected);
    });
  });

  it("a legacy paid shop (toggle default on, never told, never opted in) reads OFF", async () => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Professional", alertsEnabled: true });
    const result = (await loader(makeLoaderArgs())) as { alerts: AlertsData };
    expect(result.alerts.enabled).toBe(false);
  });

  it("a dark opt-in (notice pending, no summaryOptedInAt) reads ON, so the checkbox stays honest", async () => {
    mockAlertConfig.mockReturnValue({ configured: false, reason: "disabled" });
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      summaryNoticePendingAt: new Date(),
    });
    expect(((await loader(makeLoaderArgs())) as { alerts: AlertsData }).alerts.enabled).toBe(true);
  });

  it("an opted-in shop reads ON; toggled off reads OFF", async () => {
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      summaryOptedInAt: new Date(),
    });
    expect(((await loader(makeLoaderArgs())) as { alerts: AlertsData }).alerts.enabled).toBe(true);
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      alertsEnabled: false,
      summaryOptedInAt: new Date(),
    });
    expect(((await loader(makeLoaderArgs())) as { alerts: AlertsData }).alerts.enabled).toBe(false);
  });

  it("passes a null cached email through and reports an unconfigured env", async () => {
    mockAlertConfig.mockReturnValue({ configured: false, reason: "disabled" });
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
    mockAlertConfig.mockReturnValue({ configured: false, reason: "disabled" });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("enabled=%s writes %s for the SESSION shop only", async (value, expected) => {
    const result = await action(
      makeActionArgs({ intent: "set-alerts-enabled", enabled: value, shopId: "other-shop" }),
    );

    expect(mockGetShopMetadata).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mockSetAlertsEnabled).toHaveBeenCalledExactlyOnceWith("shop-1", expected, {
      sendingLive: false,
      noticeShown: false,
    });
    expect(result).toEqual({ alertsEnabled: expected });
  });

  it("opting in while sending is live is passed as a live opt-in (consent)", async () => {
    mockAlertConfig.mockReturnValue({ configured: true });
    await action(makeActionArgs({ intent: "set-alerts-enabled", enabled: "true" }));
    expect(mockSetAlertsEnabled).toHaveBeenCalledExactlyOnceWith("shop-1", true, {
      sendingLive: true,
      noticeShown: false,
    });
  });

  it("opting in while dark after the notice was already shown owes no second notice", async () => {
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      summaryNoticeShownAt: new Date(),
    });
    await action(makeActionArgs({ intent: "set-alerts-enabled", enabled: "true" }));
    expect(mockSetAlertsEnabled).toHaveBeenCalledExactlyOnceWith("shop-1", true, {
      sendingLive: false,
      noticeShown: true,
    });
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

    expect(result.error).toBe("Summary emails are not included in your plan.");
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

describe("the page is called Settings, matching the notice, email and policy (Nathan Q10=10A)", () => {
  it("page heading is Settings, never Billing", () => {
    const loaderData = {
      shop: { plan: "free", domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible: true,
      alerts: DARK_ALERTS,
      freeSpeedTestTiles: { free: false },
      speedReportTiles: { standard: false, professional: false },
    };
    const Stub = createRoutesStub([
      {
        id: "settings",
        path: "/app/settings",
        Component: Settings as never,
        loader: () => loaderData,
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/app/settings"],
        hydrationData: { loaderData: { settings: loaderData } },
      }),
    );
    expect(html).toMatch(/<s-page[^>]*heading="Settings"/);
    expect(html).not.toContain('heading="Billing"');
  });

  it("the app nav item for /app/settings reads Settings", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../app/routes/app.tsx", import.meta.url), "utf8");
    expect(src).toContain('<s-link href="/app/settings">Settings</s-link>');
    expect(src).not.toMatch(/>Billing</);
  });
});

describe("Settings Summary emails card (gc-ol95 copy)", () => {
  function renderSettings(plan: string, trialEligible: boolean, alerts: Partial<AlertsData>) {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: FREE_FEATURES,
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible,
      alerts: { ...DARK_ALERTS, ...alerts },
      freeSpeedTestTiles: { free: true },
      speedReportTiles: { standard: true, professional: true },
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
    enabled: true,
  };

  it("never says 'Monitoring emails' anywhere (renamed)", () => {
    for (const html of [
      renderSettings("Standard", false, PAID),
      renderSettings("Standard", false, { ...PAID, configured: false }),
      renderSettings("free", true, {}),
    ]) {
      expect(html).not.toContain("Monitoring emails");
      expect(html).toContain("Summary emails");
    }
  });

  it("dark (not configured): a usable toggle and the coming-soon copy, never 'we email'", () => {
    const html = renderSettings("Standard", false, { ...PAID, configured: false, enabled: false });

    expect(html).toContain("Summary emails");
    expect(html).toMatch(/<s-checkbox[^>]*label="Email me a summary after each weekly scan"/);
    expect(html).not.toMatch(/<s-checkbox[^>]*disabled/);
    expect(html).toContain(
      "Summary emails are coming soon. We&#x27;ll let you know before any are sent.",
    );
    expect(html).not.toContain("We email");
  });

  it("live, Professional: weekly label and the honest paragraph with the cached email", () => {
    const html = renderSettings("Professional", false, PAID);

    expect(html).toMatch(/<s-checkbox[^>]*label="Email me a summary after each weekly scan"/);
    expect(html).toMatch(/<s-checkbox[^>]*checked/);
    expect(html).toContain(
      "We email owner@example.com only when something changed: new or fixed findings, or an app that is no longer active.",
    );
    expect(html).not.toContain("coming soon");
  });

  it("live, Professional with the speed report live: the paragraph adds the speed change (gc-2wnf)", () => {
    const html = renderSettings("Professional", false, { ...PAID, speedInSummary: true });

    expect(html).toContain(
      "We email owner@example.com only when something changed: new or fixed findings, an app that is no longer active, or a noticeable change in your store speed.",
    );
    expect(html).not.toMatch(/[—–]/);
  });

  it("live, Professional with the speed report dark: the paragraph never mentions speed", () => {
    const html = renderSettings("Professional", false, { ...PAID, speedInSummary: false });

    expect(html).toContain(
      "We email owner@example.com only when something changed: new or fixed findings, or an app that is no longer active.",
    );
    expect(html).not.toContain("change in your store speed");
  });

  it("live, Standard: monthly label and the owner-email fallback when none is cached", () => {
    const html = renderSettings("Standard", false, {
      ...PAID,
      cadence: "monthly",
      email: null,
    });

    expect(html).toContain('label="Email me a summary after each monthly scan"');
    expect(html).toContain(
      "We email your store owner email only when something changed: new or fixed findings, or an app that is no longer active.",
    );
    expect(html).not.toContain("change in your store speed");
  });

  it("unchecked when not effectively on", () => {
    const html = renderSettings("Standard", false, { ...PAID, enabled: false });

    expect(html).toMatch(/<s-checkbox/);
    expect(html).not.toMatch(/<s-checkbox[^>]*checked/);
  });

  it("Free (dark or live): no checkbox; the plan sentence plus the trial CTA", () => {
    for (const configured of [false, true]) {
      const html = renderSettings("free", true, { configured });

      expect(html).not.toContain("<s-checkbox");
      expect(html).toContain(
        "Summary emails are included with Standard (monthly) and Professional (weekly).",
      );
      expect(html).not.toContain("coming soon");
      // Standard tile + Professional tile + card CTA.
      expect(html.match(/Start 7-day free trial/g)).toHaveLength(3);
    }
  });

  it("Free, trial used: the card CTA reads Upgrade to Standard", () => {
    const html = renderSettings("free", false, { configured: true });

    expect(html.match(/Upgrade to Standard/g)).toHaveLength(2);
    expect(html).not.toContain("Start 7-day");
  });

  it("card copy has no em or en dash", () => {
    const html =
      renderSettings("Standard", false, PAID) +
      renderSettings("Standard", false, { ...PAID, configured: false }) +
      renderSettings("free", true, {});
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });
});

// ---------------------------------------------------------------------------
// Permissions card on every plan (gc-4n0y)
// ---------------------------------------------------------------------------

describe("Settings Permissions card (gc-4n0y)", () => {
  function render(plan: string, canDetectDanglingReferences: boolean): string {
    const loaderData = {
      shop: { plan, domain: SHOP_DOMAIN },
      features: { ...FREE_FEATURES, canDetectDanglingReferences },
      pricingPlansUrl: PRICING_PLANS_URL,
      trialEligible: true,
      alerts: DARK_ALERTS,
      freeSpeedTestTiles: { free: false },
      speedReportTiles: { standard: false, professional: false },
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

  it("renders for a Free shop, with the Broken links plan note", () => {
    const html = render("free", false);
    expect(html).toContain(">Permissions</h2>");
    expect(html).toContain("need extra read-only");
    expect(html).toContain(BROKEN_LINKS_STANDARD_NOTE.replace(/'/g, "&#x27;"));
  });

  it.each(["Standard", "Professional"])("renders for %s without the plan note", (plan) => {
    const html = render(plan, true);
    expect(html).toContain(">Permissions</h2>");
    expect(html).not.toContain("Broken-link checks come with the Standard plan");
  });

  it("the plan note has no em or en dash", () => {
    expect(BROKEN_LINKS_STANDARD_NOTE).not.toMatch(/[–—]/);
  });
});

// ---------------------------------------------------------------------------
// Checkout guard emails card (gc-njwa #5)
// ---------------------------------------------------------------------------

describe("Settings: checkout guard emails (gc-njwa #5)", () => {
  const PAID_GUARD = { ...FREE_FEATURES, storefrontGuardEmail: true, alertCadence: "weekly" };
  const GUARD_SHOP = {
    ...SHOP,
    plan: "Standard",
    guardEmailNoticeShownAt: null as Date | null,
    guardEmailOffAt: new Date("2026-10-26T10:00:00Z") as Date | null,
  };
  const live = () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
  };
  const post = (fields: Record<string, string>) =>
    action({
      request: new Request(`https://${SHOP_DOMAIN}/app/settings`, {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs);
  type GuardData = { guardEmail: { email: string | null; on: boolean; mailOn: boolean } | null };

  beforeEach(() => {
    mockGetPlanFeatures.mockReturnValue(PAID_GUARD);
    mockAlertConfig.mockReturnValue({ configured: true });
    mockGetShopMetadata.mockResolvedValue(GUARD_SHOP);
  });
  afterEach(() => {
    delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
    delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
  });

  describe("loader", () => {
    it("a paid shop that turned it off: offered, off, naming the address", async () => {
      live();
      const result = (await loader(makeLoaderArgs())) as GuardData;
      expect(result.guardEmail).toEqual({ email: "owner@example.com", on: false, mailOn: true });
    });

    it("consented and not turned off reads on", async () => {
      live();
      mockGetShopMetadata.mockResolvedValue({
        ...GUARD_SHOP,
        guardEmailNoticeShownAt: new Date(),
        guardEmailOffAt: null,
      });
      expect(((await loader(makeLoaderArgs())) as GuardData).guardEmail?.on).toBe(true);
    });

    it("all mail off: offered with mailOn false", async () => {
      live();
      mockGetShopMetadata.mockResolvedValue({ ...GUARD_SHOP, alertsEnabled: false });
      expect(((await loader(makeLoaderArgs())) as GuardData).guardEmail?.mailOn).toBe(false);
    });

    it("not offered on Free, while guard email is dark, or without mail transport", async () => {
      live();
      mockGetPlanFeatures.mockReturnValue({ ...FREE_FEATURES, storefrontGuardEmail: false });
      expect(((await loader(makeLoaderArgs())) as GuardData).guardEmail).toBeNull();
      mockGetPlanFeatures.mockReturnValue(PAID_GUARD);
      mockAlertConfig.mockReturnValue({ configured: false, reason: "disabled" });
      expect(((await loader(makeLoaderArgs())) as GuardData).guardEmail).toBeNull();
      mockAlertConfig.mockReturnValue({ configured: true });
      delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
      expect(((await loader(makeLoaderArgs())) as GuardData).guardEmail).toBeNull();
    });
  });

  describe("action: set-guard-email", () => {
    // The stored consent the action reads back (wave 3 U5): the writes move it.
    let stored: {
      alertsEnabled: boolean;
      guardEmailNoticeShownAt: Date | null;
      guardEmailOffAt: Date | null;
    };
    beforeEach(() => {
      stored = { alertsEnabled: true, guardEmailNoticeShownAt: null, guardEmailOffAt: null };
      vi.mocked(enableGuardEmail).mockImplementation(async () => {
        stored = { ...stored, guardEmailNoticeShownAt: new Date(), guardEmailOffAt: null };
        return true;
      });
      vi.mocked(turnOffGuardEmail).mockImplementation(async () => {
        stored = { ...stored, guardEmailOffAt: new Date() };
      });
      vi.mocked(getGuardEmailConsent).mockImplementation(async () => stored as never);
    });

    it("answers with the REAL stored state, not the one asked for (wave 3 U5)", async () => {
      live();
      const on = { intent: "set-guard-email", enabled: "true", email: "owner@example.com" };
      // An unsubscribe lands between the gate read and the write: still off.
      vi.mocked(enableGuardEmail).mockImplementationOnce(async () => {
        stored = { ...stored, alertsEnabled: false };
        return false;
      });
      await expect(post(on)).resolves.toHaveProperty("guardEmailError");
      // A shop already on (enable changes nothing) still reads on.
      stored = { alertsEnabled: true, guardEmailNoticeShownAt: new Date(), guardEmailOffAt: null };
      vi.mocked(enableGuardEmail).mockResolvedValueOnce(false);
      await expect(post(on)).resolves.toEqual({ guardEmail: "on" });
    });
    it("on = consent for the SESSION shop, stamped with the hash of the address shown", async () => {
      live();
      const { guardConsentHash } =
        await import("../../app/services/storefront-guard-notice.server");
      await expect(
        post({
          intent: "set-guard-email",
          enabled: "true",
          email: "owner@example.com",
          shopId: "other-shop",
        }),
      ).resolves.toEqual({ guardEmail: "on" });
      expect(mockGetShopMetadata).toHaveBeenCalledWith(SHOP_DOMAIN);
      expect(enableGuardEmail).toHaveBeenCalledExactlyOnceWith(
        "shop-1",
        guardConsentHash("owner@example.com"),
      );
    });

    it("off = the notice's Turn off, always allowed", async () => {
      await expect(post({ intent: "set-guard-email", enabled: "false" })).resolves.toEqual({
        guardEmail: "off",
      });
      expect(turnOffGuardEmail).toHaveBeenCalledExactlyOnceWith("shop-1");
    });

    it("refuses on for a stale address, all mail off, Free, or dark; nothing written", async () => {
      live();
      const on = { intent: "set-guard-email", enabled: "true", email: "owner@example.com" };
      await expect(post({ ...on, email: "old@example.com" })).resolves.toHaveProperty(
        "guardEmailError",
      );
      mockGetShopMetadata.mockResolvedValueOnce({ ...GUARD_SHOP, alertsEnabled: false });
      await expect(post(on)).resolves.toHaveProperty("guardEmailError");
      mockGetPlanFeatures.mockReturnValue({ ...FREE_FEATURES, storefrontGuardEmail: false });
      await expect(post(on)).resolves.toHaveProperty("guardEmailError");
      mockGetPlanFeatures.mockReturnValue(PAID_GUARD);
      delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
      await expect(post(on)).resolves.toHaveProperty("guardEmailError");
      expect(enableGuardEmail).not.toHaveBeenCalled();
    });

    it("rejects an invalid value", async () => {
      await expect(post({ intent: "set-guard-email", enabled: "yes" })).resolves.toEqual({
        error: "Invalid value.",
      });
    });
  });

  describe("card", () => {
    function render(guardEmail: GuardData["guardEmail"]) {
      const loaderData = {
        shop: { plan: "Standard", domain: SHOP_DOMAIN },
        features: FREE_FEATURES,
        pricingPlansUrl: PRICING_PLANS_URL,
        trialEligible: false,
        alerts: DARK_ALERTS,
        guardEmail,
        freeSpeedTestTiles: { free: true },
        speedReportTiles: { standard: true, professional: true },
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

    it("shows the toggle and the address the consent covers", () => {
      const html = render({ email: "owner@example.com", on: false, mailOn: true });
      expect(html).toContain("Checkout guard emails");
      expect(html).toContain('label="Email me when the checkout guard finds a problem"');
      expect(html).toContain("We email owner@example.com only when");
      expect(html).not.toMatch(/hijack|hacked/i);
      expect(html).not.toMatch(/[\u2014\u2013]/);
    });

    it("checked when on; disabled with an explanation while all mail is off", () => {
      expect(render({ email: null, on: true, mailOn: true })).toMatch(
        /<s-checkbox[^>]*label="Email me when the checkout guard[^"]*"[^>]*checked/,
      );
      const off = render({ email: null, on: true, mailOn: false });
      expect(off).toMatch(/<s-checkbox[^>]*disabled/);
      expect(off).not.toMatch(
        /<s-checkbox[^>]*label="Email me when the checkout guard[^"]*"[^>]*checked/,
      );
      expect(off).toContain("Emails from GhostCode are off for this store");
    });

    it("no card when not offered (Free, dark)", () => {
      expect(render(null)).not.toContain("Checkout guard emails");
    });
  });
});
