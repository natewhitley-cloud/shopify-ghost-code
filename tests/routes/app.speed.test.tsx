/**
 * Tests for app/routes/app.speed.tsx (gc-wt3y Store speed page).
 *
 *   - DARK: loader and action 404 while SPEED_REPORT_LIVE_ENABLED is off.
 *   - Free / Standard: a locked teaser with the plan upgrade button; no report
 *     data is read.
 *   - Professional: the report view + Run-now availability.
 *   - Action: delegates to requestSpeedReportRunNow for the SESSION shop.
 *   - Rendering of every status state with the exact merchant copy.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/shop.server", () => ({ getShopMetadata: vi.fn() }));
vi.mock("../../app/models/speed-report.server", () => ({
  getRecentSpeedReports: vi.fn(),
  getSpeedReportRequestedAt: vi.fn(),
}));
vi.mock("../../app/services/speed-report.server", () => ({
  requestSpeedReportRunNow: vi.fn(),
}));
vi.mock("../../app/services/trial-eligibility.server", () => ({
  getTrialEligibility: vi.fn(),
}));
vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

import type { SpeedPageResult } from "../../app/lib/speed-report";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
} from "../../app/models/speed-report.server";
import StoreSpeed, { action, LockedTeaser, loader } from "../../app/routes/app.speed";
import type { SpeedLoaderData } from "../../app/routes/app.speed";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { requestSpeedReportRunNow } from "../../app/services/speed-report.server";
import { getTrialEligibility } from "../../app/services/trial-eligibility.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockReports = getRecentSpeedReports as ReturnType<typeof vi.fn>;
const mockRequestedAt = getSpeedReportRequestedAt as ReturnType<typeof vi.fn>;
const mockRunNow = requestSpeedReportRunNow as ReturnType<typeof vi.fn>;
const mockTrial = getTrialEligibility as ReturnType<typeof vi.fn>;
const mockNudge = recordNudgeStageOnce as ReturnType<typeof vi.fn>;

const DOMAIN = "paw-naturals.myshopify.com";
const PRO = {
  id: "shop-1",
  domain: DOMAIN,
  plan: "Professional",
  everPaidAt: null,
  speedTeaserShownAt: null,
};

function loaderArgs(): LoaderFunctionArgs {
  return {
    request: new Request(`https://${DOMAIN}/app/speed`),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

function actionArgs(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request(`https://${DOMAIN}/app/speed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    params: {},
    context: {},
  } as unknown as ActionFunctionArgs;
}

async function expect404(p: Promise<unknown>) {
  const thrown = await p.then(
    () => null,
    (e) => e,
  );
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(404);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SPEED_REPORT_LIVE_ENABLED = "true";
  mockAuth.mockResolvedValue({ session: { shop: DOMAIN } });
  mockShop.mockResolvedValue(PRO);
  mockReports.mockResolvedValue([]);
  mockRequestedAt.mockResolvedValue(null);
  mockTrial.mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.SPEED_REPORT_LIVE_ENABLED;
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("loader", () => {
  it("404s while the feature is dark (after auth), reading nothing", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    await expect404(loader(loaderArgs()));
    expect(mockShop).not.toHaveBeenCalled();
    expect(mockReports).not.toHaveBeenCalled();
  });

  it.each(["free", "Standard"])("plan %s: locked teaser, no report data read", async (plan) => {
    mockShop.mockResolvedValue({ ...PRO, plan });
    mockTrial.mockResolvedValue(plan === "free");
    const data = await loader(loaderArgs());
    expect(data).toEqual({
      access: "locked",
      pricingPlansUrl:
        "https://admin.shopify.com/store/paw-naturals/charges/ghost-code/pricing_plans",
      trialEligible: plan === "free",
    });
    expect(mockReports).not.toHaveBeenCalled();
    expect(mockRequestedAt).not.toHaveBeenCalled();
  });

  it("Professional: report view + run-now availability", async () => {
    const created = new Date(Date.now() - 60_000);
    mockReports.mockResolvedValue([
      {
        id: "r1",
        origin: "SCHEDULED",
        status: "COMPLETED",
        failureReason: null,
        pages: [],
        createdAt: created,
        completedAt: created,
      },
    ]);
    const last = new Date(Date.now() - 60 * 60_000);
    mockRequestedAt.mockResolvedValue(last);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "pro" }>;
    expect(data.access).toBe("pro");
    expect(data.latest!.id).toBe("r1");
    expect(data.lastResults!.id).toBe("r1");
    expect(data.previousResults).toBeNull();
    expect(data.runNowAvailableAt).toBe(new Date(last.getTime() + 24 * 3600_000).toISOString());
    expect(mockReports).toHaveBeenCalledWith("shop-1");
  });

  it("404s for an unknown shop", async () => {
    mockShop.mockResolvedValue(null);
    await expect404(loader(loaderArgs()));
  });
});

// ---------------------------------------------------------------------------
// Teaser nudge telemetry (gc-iirv): speed_teaser shown, once per merchant
// ---------------------------------------------------------------------------

describe("loader: speed_teaser nudge", () => {
  it.each(["free", "Standard"])(
    "plan %s, never shown: records `shown` for the unmodified session shop",
    async (plan) => {
      mockShop.mockResolvedValue({ ...PRO, plan });
      await loader(loaderArgs());
      expect(mockNudge).toHaveBeenCalledTimes(1);
      expect(mockNudge).toHaveBeenCalledWith("speed_teaser", "shown", DOMAIN);
    },
  );

  it("already shown: no claim query on later loads", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free", speedTeaserShownAt: new Date() });
    await loader(loaderArgs());
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it("Professional sees no teaser, so nothing is recorded", async () => {
    await loader(loaderArgs());
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it("dark: nothing is recorded", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    await expect404(loader(loaderArgs()));
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it("a failed claim still renders the teaser (recordNudgeStageOnce never throws; false)", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    mockNudge.mockResolvedValue(false);
    const data = await loader(loaderArgs());
    expect(data.access).toBe("locked");
  });
});

describe("LockedTeaser: click ping (gc-iirv)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
  function findAnchor(node: unknown): El | null {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findAnchor(child);
        if (hit) return hit;
      }
      return null;
    }
    const el = node as El;
    if (el.type === "a") return el;
    return findAnchor(el.props?.children);
  }

  it("the upgrade link POSTs src=speed_teaser and keeps its plain top-level href", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const anchor = findAnchor(
      LockedTeaser({ pricingPlansUrl: "https://x/plans", trialEligible: false }),
    );

    expect(anchor!.props.href).toBe("https://x/plans");
    expect(anchor!.props.target).toBe("_top");
    (anchor!.props.onClick as () => void)();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/app/upgrade");
    expect(init.keepalive).toBe(true);
    expect(String(init.body)).toBe("src=speed_teaser");
  });
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

describe("action", () => {
  it("404s while dark and starts nothing", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    await expect404(action(actionArgs({ intent: "run-now" })));
    expect(mockRunNow).not.toHaveBeenCalled();
  });

  it("runs for the session shop", async () => {
    mockRunNow.mockResolvedValue({ ok: true, reportId: "r9" });
    await expect(
      action(actionArgs({ intent: "run-now", shopId: "someone-else" })),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mockRunNow).toHaveBeenCalledWith(PRO, expect.any(Date));
  });

  it("passes the refusal and next available time through", async () => {
    mockRunNow.mockResolvedValue({
      ok: false,
      error: "You can run the speed test once a day.",
      nextAvailableAt: "2026-10-12T10:00:00.000Z",
    });
    await expect(action(actionArgs({ intent: "run-now" }))).resolves.toEqual({
      ok: false,
      error: "You can run the speed test once a day.",
      nextAvailableAt: "2026-10-12T10:00:00.000Z",
    });
  });

  it("rejects unknown intents and a missing shop", async () => {
    await expect(action(actionArgs({ intent: "delete" }))).resolves.toEqual({
      ok: false,
      error: "Unknown request.",
    });
    mockShop.mockResolvedValue(null);
    await expect(action(actionArgs({ intent: "run-now" }))).resolves.toMatchObject({ ok: false });
    expect(mockRunNow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(data: SpeedLoaderData): string {
  const Stub = createRoutesStub([
    { id: "speed", path: "/app/speed", Component: StoreSpeed as never, loader: () => data },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/speed"],
      hydrationData: { loaderData: { speed: data } },
    }),
  );
}

const HOME_PAGE: SpeedPageResult = {
  page: "home",
  status: "OK",
  url: "https://paw-naturals.example/",
  runsAttempted: 3,
  runsOk: 3,
  metrics: {
    score: 28,
    lcpMs: 14212,
    tbtMs: 9034,
    cls: 0.11,
    fcpMs: 4022,
    speedIndexMs: 11890,
    totalBytes: 8123456,
    requestCount: 661,
  },
  apps: [
    {
      name: "Klaviyo",
      mainThreadMs: 4123,
      blockingMs: 2050,
      transferBytes: 1851000,
      unusedPct: 50,
      requestCount: 3,
    },
    {
      name: "Recharge",
      mainThreadMs: 640,
      blockingMs: 310,
      transferBytes: 169000,
      unusedPct: 80,
      requestCount: 1,
    },
  ],
  otherThirdParty: [
    {
      name: "fonts.gstatic.com",
      mainThreadMs: 0,
      blockingMs: 0,
      transferBytes: 48000,
      unusedPct: null,
      requestCount: 1,
    },
  ],
  firstParty: { mainThreadMs: 2200, transferBytes: 252000 },
};

function report(status: string, pages: SpeedPageResult[] = [], extra: object = {}) {
  return {
    id: `rep-${status}`,
    origin: "SCHEDULED",
    status,
    failureReason: null,
    createdAt: "2026-10-11T08:12:00.000Z",
    pages,
    ...extra,
  };
}

function pro(over: Partial<Extract<SpeedLoaderData, { access: "pro" }>> = {}): SpeedLoaderData {
  return {
    access: "pro",
    latest: null,
    lastResults: null,
    previousResults: null,
    runNowAvailableAt: null,
    ...over,
  };
}

describe("rendering", () => {
  it("locked teaser: heading, value copy and the Professional upgrade link", () => {
    const html = render({
      access: "locked",
      pricingPlansUrl: "https://admin.shopify.com/store/x/charges/ghost-code/pricing_plans",
      trialEligible: true,
    });
    expect(html).toContain("See which apps slow your store");
    expect(html).toContain("weekly speed report for your homepage and a product page");
    expect(html).toContain(
      'href="https://admin.shopify.com/store/x/charges/ghost-code/pricing_plans"',
    );
    expect(html).toContain('target="_top"');
    expect(html).toContain("Start 7-day free trial");
    expect(html).not.toContain("Run speed test now");
  });

  it("locked teaser without trial says Upgrade to Professional", () => {
    const html = render({ access: "locked", pricingPlansUrl: "https://x", trialEligible: false });
    expect(html).toContain("Upgrade to Professional");
  });

  it("not run yet", () => {
    const html = render(pro());
    expect(html).toContain("Your first speed report runs on Sunday. You can also run it now.");
    expect(html).toContain("Run speed test now");
    expect(html).not.toContain("disabled");
  });

  it("running", () => {
    const html = render(pro({ latest: report("RUNNING") }));
    expect(html).toContain("Speed test running. It takes a few minutes");
  });

  it("password protected", () => {
    const html = render(pro({ latest: report("UNAVAILABLE_PASSWORD") }));
    expect(html).toContain(
      "Your storefront is password protected, so it can&#x27;t be tested. Remove the password in Online Store &gt; Preferences, then run the test again.",
    );
  });

  it("failed, with the merchant-safe reason", () => {
    const html = render(
      pro({ latest: report("FAILED", [], { failureReason: "document_failed" }) }),
    );
    expect(html).toContain("We couldn&#x27;t test your store on");
    expect(html).toContain("Google couldn&#x27;t load this page of your store.");
    expect(html).toContain("try again next week, or you");
  });

  it("budget skipped", () => {
    const html = render(pro({ latest: report("SKIPPED_BUDGET") }));
    expect(html).toContain("Speed tests are paused for today. Your next report runs on schedule.");
  });

  it("within 24h: Run now disabled with the next available time", () => {
    const html = render(pro({ runNowAvailableAt: "2026-10-12T10:00:00.000Z" }));
    expect(html).toMatch(/<s-button[^>]*disabled/);
    expect(html).toContain("Next test available");
  });

  it("results: metrics with plain labels, change vs last week, apps table, other third party, caveat", () => {
    const previous = {
      ...HOME_PAGE,
      metrics: { ...HOME_PAGE.metrics!, score: 24, lcpMs: 15012, totalBytes: 8243456 },
    };
    const latest = report("COMPLETED", [
      HOME_PAGE,
      { page: "product", status: "NEEDS_PRODUCT_ACCESS", url: null, runsAttempted: 0, runsOk: 0 },
    ]);
    const html = render(
      pro({ latest, lastResults: latest, previousResults: report("COMPLETED", [previous]) }),
    );
    expect(html).toContain("Homepage");
    expect(html).toContain("28 / 100");
    expect(html).toContain("Up 4 from last week");
    expect(html).toContain("Time to show the main content");
    expect(html).toContain("14 s");
    expect(html).toContain("0.8 s faster than last week");
    expect(html).toContain("Time the page is frozen");
    expect(html).toContain("9.0 s");
    expect(html).toContain("8.1 MB");
    expect(html).toContain("120 KB smaller than last week");
    expect(html).toContain("661");
    expect(html).toContain("Apps slowing your store");
    expect(html).toContain("These 2 apps cost your homepage 4.8 s of processing time.");
    expect(html.indexOf("Klaviyo")).toBeLessThan(html.indexOf("Recharge"));
    expect(html).toContain("80% unused");
    expect(html).toContain("Other third-party code");
    expect(html).toContain("fonts.gstatic.com");
    expect(html).toContain("Not measured");
    expect(html).toContain("To test a product page too, allow Products access in Settings.");
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain(
      "Some apps skip loading during speed tests, so their real cost can be higher.",
    );
    expect(html).not.toContain("TBT");
    expect(html).not.toContain("LCP");
    expect(html).not.toContain("—");
  });

  it("a failed latest run still shows the last good results under the failure banner", () => {
    const good = report("COMPLETED", [HOME_PAGE]);
    const html = render(
      pro({ latest: report("FAILED", [], { failureReason: "timeout" }), lastResults: good }),
    );
    expect(html).toContain("The speed test took too long to finish.");
    expect(html).toContain("Apps slowing your store");
  });

  it("a page that failed and a store with no product", () => {
    const latest = report("PARTIAL", [
      HOME_PAGE,
      {
        page: "product",
        status: "FAILED",
        url: null,
        runsAttempted: 3,
        runsOk: 0,
        failureCode: "timeout",
      },
    ]);
    let html = render(pro({ latest, lastResults: latest }));
    expect(html).toContain(
      "This page wasn&#x27;t tested this time. The speed test took too long to finish.",
    );
    const noProduct = report("COMPLETED", [
      HOME_PAGE,
      { page: "product", status: "NO_PRODUCT", url: null, runsAttempted: 0, runsOk: 0 },
    ]);
    html = render(pro({ latest: noProduct, lastResults: noProduct }));
    expect(html).toContain(
      "No product is published to your online store, so only the homepage was tested.",
    );
  });

  it("no app with measurable load", () => {
    const latest = report("COMPLETED", [{ ...HOME_PAGE, apps: [], otherThirdParty: [] }]);
    const html = render(pro({ latest, lastResults: latest }));
    expect(html).toContain("No known app added measurable load to this page.");
    expect(html).not.toContain("Other third-party code");
  });
});
