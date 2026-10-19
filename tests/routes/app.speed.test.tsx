/**
 * Tests for app/routes/app.speed.tsx (gc-wt3y Store speed page).
 *
 *   - DARK: loader and action 404 while SPEED_REPORT_LIVE_ENABLED is off.
 *   - Free: the free speed test (homepage score + costliest app, once ever)
 *     plus one upgrade ask; the loader strips every full-report field.
 *   - A plan with neither (freeSpeedTest narrowed off): the locked teaser; no
 *     report data is read.
 *   - Professional: the report view + Run-now availability.
 *   - Standard (gc-d0ui): the same report view, monthly, no Run now, the next
 *     monthly date; no upgrade ask.
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
  getFreeSpeedTestUsedAt: vi.fn(),
  countFreeSpeedTestAttempts: vi.fn(),
}));
vi.mock("../../app/services/speed-report.server", () => ({
  requestSpeedReportRunNow: vi.fn(),
  requestFreeSpeedTest: vi.fn(),
}));
// The real plan matrix by default; one test narrows the free test to Free.
vi.mock("../../app/lib/billing.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/lib/billing.server")>();
  return { ...actual, getPlanFeatures: vi.fn(actual.getPlanFeatures) };
});
vi.mock("../../app/services/trial-eligibility.server", () => ({
  getTrialEligibility: vi.fn(),
}));
vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

import * as billing from "../../app/lib/billing.server";
import type { SpeedPageResult } from "../../app/lib/speed-report";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  countFreeSpeedTestAttempts,
  getFreeSpeedTestUsedAt,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
} from "../../app/models/speed-report.server";
import StoreSpeed, { action, LockedTeaser, loader, StatusBanner } from "../../app/routes/app.speed";
import type { SpeedLoaderData } from "../../app/routes/app.speed";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import {
  requestFreeSpeedTest,
  requestSpeedReportRunNow,
} from "../../app/services/speed-report.server";
import { getTrialEligibility } from "../../app/services/trial-eligibility.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockReports = getRecentSpeedReports as ReturnType<typeof vi.fn>;
const mockRequestedAt = getSpeedReportRequestedAt as ReturnType<typeof vi.fn>;
const mockRunNow = requestSpeedReportRunNow as ReturnType<typeof vi.fn>;
const mockFreeTest = requestFreeSpeedTest as ReturnType<typeof vi.fn>;
const mockUsedAt = getFreeSpeedTestUsedAt as ReturnType<typeof vi.fn>;
const mockRunCount = countFreeSpeedTestAttempts as ReturnType<typeof vi.fn>;
const mockFeatures = billing.getPlanFeatures as ReturnType<typeof vi.fn>;
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

beforeEach(async () => {
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof import("../../app/lib/billing.server")>(
    "../../app/lib/billing.server",
  );
  mockFeatures.mockImplementation(actual.getPlanFeatures);
  mockUsedAt.mockResolvedValue(null);
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

  it("a plan with neither the report nor the free test (free test narrowed off): locked teaser, no report data read", async () => {
    const plan = "free";
    const actual = await vi.importActual<typeof import("../../app/lib/billing.server")>(
      "../../app/lib/billing.server",
    );
    // The one-line narrowing: Free's freeSpeedTest set to false.
    mockFeatures.mockImplementation((p: string) =>
      p === "free"
        ? { ...actual.getPlanFeatures(p), freeSpeedTest: false }
        : actual.getPlanFeatures(p),
    );
    mockShop.mockResolvedValue({ ...PRO, plan });
    mockTrial.mockResolvedValue(false);
    const data = await loader(loaderArgs());
    expect(data).toEqual({
      access: "locked",
      pricingPlansUrl:
        "https://admin.shopify.com/store/paw-naturals/charges/ghost-code/pricing_plans",
      trialEligible: false,
    });
    expect(mockReports).not.toHaveBeenCalled();
    expect(mockRequestedAt).not.toHaveBeenCalled();
    expect(mockUsedAt).not.toHaveBeenCalled();
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
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "report" }>;
    expect(data.access).toBe("report");
    expect(data.latest!.id).toBe("r1");
    expect(data.lastResults!.id).toBe("r1");
    expect(data.previousResults).toBeNull();
    expect(data.runNowAvailableAt).toBe(new Date(last.getTime() + 24 * 3600_000).toISOString());
    expect(data.cadence).toBe("weekly");
    expect(data.runNow).toBe(true);
    expect(data.nextMonthlyAt).toBeNull();
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
  it.each(["free"])(
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

  it("Standard (monthly report, gc-d0ui) sees no teaser, so nothing is recorded", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "Standard" });
    await loader(loaderArgs());
    expect(mockNudge).not.toHaveBeenCalled();
    expect(mockTrial).not.toHaveBeenCalled();
  });

  it("dark: nothing is recorded", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    await expect404(loader(loaderArgs()));
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it("a failed claim still renders the free test and its ask (recordNudgeStageOnce never throws; false)", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    mockNudge.mockResolvedValue(false);
    mockReports.mockResolvedValue([]);
    const data = await loader(loaderArgs());
    expect(data.access).toBe("free");
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
      transferBytes: 1851000,
      unusedPct: 50,
      requestCount: 3,
    },
    {
      name: "Recharge",
      mainThreadMs: 640,
      transferBytes: 169000,
      unusedPct: 80,
      requestCount: 1,
    },
  ],
  otherThirdParty: [
    {
      name: "fonts.gstatic.com",
      mainThreadMs: 0,
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

function pro(over: Partial<Extract<SpeedLoaderData, { access: "report" }>> = {}): SpeedLoaderData {
  return {
    access: "report",
    cadence: "weekly",
    runNow: true,
    nextMonthlyAt: null,
    latest: null,
    lastResults: null,
    previousResults: null,
    runNowAvailableAt: null,
    ...over,
  };
}

/** Standard's view (gc-d0ui): monthly, no Run now, the next monthly date. */
function standard(
  over: Partial<Extract<SpeedLoaderData, { access: "report" }>> = {},
): SpeedLoaderData {
  return pro({
    cadence: "monthly",
    runNow: false,
    nextMonthlyAt: "2026-11-01T08:10:00.000Z",
    ...over,
  });
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

  it("failed while Run now is in cooldown: no 'run it now' offer (gc-wt3y #11)", () => {
    const html = render(
      pro({
        latest: report("FAILED", [], { failureReason: "timeout" }),
        runNowAvailableAt: "2026-10-12T10:00:00.000Z",
      }),
    );
    expect(html).toContain("We&#x27;ll try again next week.");
    expect(html).not.toContain("run it now");
  });

  it("Admin API failure is not reported as a missing web address (gc-wt3y #12)", () => {
    const html = render(
      pro({ latest: report("FAILED", [], { failureReason: "admin_unavailable" }) }),
    );
    expect(html).toContain(
      "We couldn&#x27;t reach your store&#x27;s settings. We&#x27;ll try again next week",
    );
    expect(html).not.toContain("web address");
  });

  it("running past the polling cap: tells the merchant to refresh (gc-wt3y #11)", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBanner, {
        latest: report("RUNNING") as never,
        canRunNow: false,
        pollingTimedOut: true,
      }),
    );
    expect(html).toContain("Still running. Refresh the page in a few minutes to see the results.");
    const fresh = renderToStaticMarkup(
      createElement(StatusBanner, {
        latest: report("RUNNING") as never,
        canRunNow: false,
        pollingTimedOut: false,
      }),
    );
    expect(fresh).toContain("Speed test running. It takes a few minutes");
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

  describe("regression badges (gc-vgqc)", () => {
    // Previous: Klaviyo 4,123 ms / 1,851 KB, Recharge 140 ms / 169 KB (so
    // Recharge's 640 ms now is +500 ms). Current adds PushOwl (new).
    const previousHome: SpeedPageResult = {
      ...HOME_PAGE,
      apps: [HOME_PAGE.apps![0], { ...HOME_PAGE.apps![1], mainThreadMs: 140 }],
    };
    const currentHome: SpeedPageResult = {
      ...HOME_PAGE,
      apps: [
        ...HOME_PAGE.apps!,
        {
          name: "PushOwl",
          mainThreadMs: 300,
          transferBytes: 140_000,
          unusedPct: null,
          requestCount: 1,
        },
      ],
    };
    const latest = report("COMPLETED", [currentHome]);
    const badgeOf = (html: string, name: string) => {
      const cell = html.match(new RegExp(`<td>${name}(.*?)</td>`))?.[1] ?? "";
      return [...cell.matchAll(/<s-badge tone="warning">([^<]+)<\/s-badge>/g)].map((m) => m[1]);
    };

    it("Professional: New / Up badges next to the same apps the email names", () => {
      const html = render(
        pro({ latest, lastResults: latest, previousResults: report("COMPLETED", [previousHome]) }),
      );
      expect(badgeOf(html, "PushOwl")).toEqual(["New"]);
      expect(badgeOf(html, "Recharge")).toEqual(["Up 0.5 s"]);
      expect(badgeOf(html, "Klaviyo")).toEqual([]);
      // Unmatched hosts never get a badge.
      expect(badgeOf(html, "fonts.gstatic.com")).toEqual([]);
    });

    it("no baseline, or a different URL tested: no badges", () => {
      const first = render(pro({ latest, lastResults: latest, previousResults: null }));
      expect(first).not.toContain("<s-badge");
      const moved = render(
        pro({
          latest,
          lastResults: latest,
          previousResults: report("COMPLETED", [{ ...previousHome, url: "https://x.example/" }]),
        }),
      );
      expect(moved).not.toContain("<s-badge");
    });

    it("previous homepage failed: no badges (never 'New' because a page failed)", () => {
      const failed: SpeedPageResult = {
        page: "home",
        status: "FAILED",
        url: HOME_PAGE.url,
        failureCode: "timeout",
        runsAttempted: 3,
        runsOk: 0,
        apps: [],
      };
      const html = render(
        pro({ latest, lastResults: latest, previousResults: report("PARTIAL", [failed]) }),
      );
      expect(html).not.toContain("<s-badge");
    });

    it("Standard (monthly): no badges for the same reports", () => {
      const html = render(
        standard({
          latest,
          lastResults: latest,
          previousResults: report("COMPLETED", [previousHome]),
        }),
      );
      expect(html).toContain("PushOwl");
      expect(html).not.toContain("<s-badge");
    });
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

  it("Products access prompt only when neither path found a product (gc-9mbw)", () => {
    const needs = report("COMPLETED", [
      HOME_PAGE,
      { page: "product", status: "NEEDS_PRODUCT_ACCESS", url: null, runsAttempted: 0, runsOk: 0 },
    ]);
    let html = render(pro({ latest: needs, lastResults: needs }));
    expect(html).toContain("To test a product page too, allow Products access in Settings.");
    expect(html).toContain('href="/app/settings"');

    // Product chosen from the public storefront (no read_products): tested, no prompt.
    const fromStorefront = report("COMPLETED", [
      HOME_PAGE,
      { ...HOME_PAGE, page: "product", url: "https://paw-naturals.example/products/duck-treats" },
    ]);
    html = render(pro({ latest: fromStorefront, lastResults: fromStorefront }));
    expect(html).toContain("/products/duck-treats");
    expect(html).not.toContain("allow Products access");
    expect(html).not.toContain("Open Settings");
  });

  it("no app with measurable load", () => {
    const latest = report("COMPLETED", [{ ...HOME_PAGE, apps: [], otherThirdParty: [] }]);
    const html = render(pro({ latest, lastResults: latest }));
    expect(html).toContain("No known app added measurable load to this page.");
    expect(html).not.toContain("Other third-party code");
  });
});

// ---------------------------------------------------------------------------
// Free speed test (Free and Standard): loader, action, rendering
// ---------------------------------------------------------------------------

/** A stored report row (Date fields, as Prisma returns them). */
function row(
  origin: string,
  status: string,
  pages: SpeedPageResult[] | null,
  extra: Partial<{
    id: string;
    createdAt: Date;
    startedAt: Date | null;
    failureReason: string;
  }> = {},
) {
  const createdAt = extra.createdAt ?? new Date("2026-10-11T08:12:00.000Z");
  return {
    id: extra.id ?? `${origin}-${status}`,
    origin,
    status,
    failureReason: extra.failureReason ?? null,
    pages,
    createdAt,
    startedAt: extra.startedAt === undefined ? createdAt : extra.startedAt,
    completedAt: status === "RUNNING" ? null : createdAt,
  };
}

const PRODUCT_PAGE: SpeedPageResult = {
  ...HOME_PAGE,
  page: "product",
  url: "https://paw-naturals.example/products/duck-treats",
};

/** Every Pro-only field and value that must never reach a non-Pro client. */
const PRO_ONLY = [
  "apps",
  "otherThirdParty",
  "firstParty",
  "unusedPct",
  "pages",
  "latest",
  "lastResults",
  "previousResults",
  "runNowAvailableAt",
  "Recharge",
  "fonts.gstatic.com",
  "duck-treats",
  "product",
  "paw-naturals.example",
  "SCHEDULED",
  "MANUAL",
];

describe("loader: free speed test", () => {
  beforeEach(() => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
  });

  it.each(["free"])(
    "%s, unused, nothing run yet: available, reading only FREE_TEST reports",
    async (plan) => {
      mockShop.mockResolvedValue({ ...PRO, plan });
      mockTrial.mockResolvedValue(plan === "free");
      const data = await loader(loaderArgs());
      expect(data).toEqual({
        access: "free",
        freeTest: { state: "available", result: null, lastAttempt: null },
        runAvailableAt: null,
        pricingPlansUrl:
          "https://admin.shopify.com/store/paw-naturals/charges/ghost-code/pricing_plans",
        trialEligible: plan === "free",
      });
      expect(mockReports).toHaveBeenCalledWith("shop-1", { origin: "FREE_TEST" });
      expect(mockUsedAt).toHaveBeenCalledWith("shop-1");
    },
  );

  it("used: the stripped result only; no Pro field or value is in the loader data", async () => {
    mockUsedAt.mockResolvedValue(new Date("2026-10-11T08:20:00.000Z"));
    // The stored report carries everything a Pro report would (and a product
    // page that should never be there): the loader must strip it all.
    mockReports.mockResolvedValue([row("FREE_TEST", "COMPLETED", [HOME_PAGE, PRODUCT_PAGE])]);
    const data = await loader(loaderArgs());
    expect(data).toEqual({
      access: "free",
      freeTest: {
        state: "used",
        result: {
          reportId: "FREE_TEST-COMPLETED",
          createdAt: "2026-10-11T08:12:00.000Z",
          metrics: {
            score: 28,
            lcpMs: 14212,
            tbtMs: 9034,
            totalBytes: 8123456,
            requestCount: 661,
          },
          costliestApp: { name: "Klaviyo", mainThreadMs: 4123, transferBytes: 1851000 },
        },
        lastAttempt: null,
      },
      runAvailableAt: null,
      pricingPlansUrl:
        "https://admin.shopify.com/store/paw-naturals/charges/ghost-code/pricing_plans",
      trialEligible: false,
    });
    const json = JSON.stringify(data);
    for (const leak of PRO_ONLY) expect(json).not.toContain(leak);
  });

  it("a downgraded shop's Professional history is never read or sent", async () => {
    // Simulates the DB: the loader asks for FREE_TEST only.
    const all = [
      row("MANUAL", "COMPLETED", [HOME_PAGE, PRODUCT_PAGE], { id: "pro-1" }),
      row("SCHEDULED", "COMPLETED", [HOME_PAGE], { id: "pro-2" }),
    ];
    mockReports.mockImplementation(async (_id: string, opts?: { origin?: string }) =>
      opts?.origin ? all.filter((r) => r.origin === opts.origin) : all,
    );
    const data = await loader(loaderArgs());
    expect(data).toMatchObject({ access: "free", freeTest: { state: "available", result: null } });
    const json = JSON.stringify(data);
    expect(json).not.toContain("pro-1");
    expect(json).not.toContain("pro-2");
    for (const leak of PRO_ONLY) expect(json).not.toContain(leak);
  });

  it("a run in flight: running (and no failure banner data)", async () => {
    mockReports.mockResolvedValue([
      row("FREE_TEST", "RUNNING", null, { createdAt: new Date(Date.now() - 60_000) }),
    ]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "free" }>;
    expect(data.freeTest).toEqual({ state: "running", result: null, lastAttempt: null });
  });

  it("a failed try leaves it available, with the latest attempt and the 24h wait", async () => {
    const tried = new Date(Date.now() - 2 * 3600_000);
    mockRequestedAt.mockResolvedValue(tried);
    mockReports.mockResolvedValue([
      row("FREE_TEST", "FAILED", null, { failureReason: "timeout", createdAt: tried }),
    ]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "free" }>;
    expect(data.freeTest).toEqual({
      state: "available",
      result: null,
      lastAttempt: { status: "FAILED", failureReason: "timeout", createdAt: tried.toISOString() },
    });
    expect(data.runAvailableAt).toBe(new Date(tried.getTime() + 24 * 3600_000).toISOString());
  });

  it("5 failed runs and no result: exhausted (the run count is read per shop)", async () => {
    mockRunCount.mockResolvedValue(5);
    mockReports.mockResolvedValue([row("FREE_TEST", "UNAVAILABLE_PASSWORD", null)]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "free" }>;
    expect(mockRunCount).toHaveBeenCalledWith("shop-1");
    expect(data.freeTest).toEqual({ state: "exhausted", result: null, lastAttempt: null });
  });

  it("4 failed runs: still available", async () => {
    mockRunCount.mockResolvedValue(4);
    mockReports.mockResolvedValue([row("FREE_TEST", "FAILED", null)]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "free" }>;
    expect(data.freeTest.state).toBe("available");
  });

  it("records the upgrade ask's `shown` (speed_teaser funnel) once per merchant", async () => {
    await loader(loaderArgs());
    expect(mockNudge).toHaveBeenCalledWith("speed_teaser", "shown", DOMAIN);
  });
});

describe("loader: upgrade after the free test", () => {
  it("Professional: the free report is in the normal history like any other report", async () => {
    const older = new Date(Date.now() - 8 * 24 * 3600_000);
    const newer = new Date(Date.now() - 60_000);
    mockReports.mockResolvedValue([
      row("SCHEDULED", "COMPLETED", [HOME_PAGE, PRODUCT_PAGE], { id: "weekly", createdAt: newer }),
      row("FREE_TEST", "COMPLETED", [HOME_PAGE], { id: "free-1", createdAt: older }),
    ]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "report" }>;
    expect(data.access).toBe("report");
    // Pro reads every origin (no filter).
    expect(mockReports).toHaveBeenCalledWith("shop-1");
    expect(data.lastResults!.id).toBe("weekly");
    expect(data.previousResults).toMatchObject({ id: "free-1", origin: "FREE_TEST" });
    expect(mockUsedAt).not.toHaveBeenCalled();
  });
});

describe("Standard: the monthly report (gc-d0ui)", () => {
  beforeEach(() => {
    mockShop.mockResolvedValue({ ...PRO, plan: "Standard" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loader: the full report view, monthly, no Run now, the next monthly date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const created = new Date("2026-10-04T08:12:00Z");
    mockReports.mockResolvedValue([
      row("SCHEDULED", "COMPLETED", [HOME_PAGE, PRODUCT_PAGE], { id: "oct", createdAt: created }),
    ]);
    // A stale Run-now stamp (e.g. from a Professional past) never offers Run now.
    mockRequestedAt.mockResolvedValue(new Date("2026-10-19T11:00:00Z"));
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "report" }>;
    expect(data.access).toBe("report");
    expect(data.cadence).toBe("monthly");
    expect(data.runNow).toBe(false);
    expect(data.runNowAvailableAt).toBeNull();
    expect(data.nextMonthlyAt).toBe("2026-11-01T08:10:00.000Z");
    expect(data.lastResults!.id).toBe("oct");
    expect(data.lastResults!.pages.map((p) => p.page)).toEqual(["home", "product"]);
    // The full history (every origin), not only FREE_TEST; no free test reads.
    expect(mockReports).toHaveBeenCalledWith("shop-1");
    expect(mockUsedAt).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).not.toContain("pricing_plans");
  });

  it("loader: the free test is no longer offered; an old FREE_TEST report is still shown", async () => {
    mockReports.mockResolvedValue([
      row("FREE_TEST", "COMPLETED", [HOME_PAGE], { id: "free-1", createdAt: new Date() }),
    ]);
    const data = (await loader(loaderArgs())) as Extract<SpeedLoaderData, { access: "report" }>;
    expect(data.access).toBe("report");
    expect(data.lastResults).toMatchObject({ id: "free-1", origin: "FREE_TEST" });
    expect(data).not.toHaveProperty("freeTest");
    const html = render(data);
    expect(html).toContain("Results from");
    expect(html).not.toContain("Run your free speed test");
    expect(html).not.toContain("Run speed test now");
  });

  it("render, no report yet: the first monthly test's date, no Run now, no locked teaser or upsell", () => {
    const html = render(standard());
    expect(html).toContain("Tested once a month with Google PageSpeed Insights.");
    expect(html).toMatch(
      /Your first monthly speed test runs on <time[^>]*dateTime="2026-11-01T08:10:00.000Z"/,
    );
    expect(html).not.toContain("Run speed test now");
    expect(html).not.toContain("run it now");
    expect(html).not.toContain("Sunday");
    expect(html).not.toContain("See which apps slow your store");
    expect(html).not.toMatch(/upgrade|free trial|pricing_plans/i);
  });

  it("render, with results: the report and the next monthly date, never Run now", () => {
    const lastResults = report("COMPLETED", [HOME_PAGE]);
    const html = render(standard({ latest: lastResults, lastResults }));
    expect(html).toContain("Apps slowing your store");
    expect(html).toMatch(/Next monthly test: <time[^>]*dateTime="2026-11-01T08:10:00.000Z"/);
    expect(html).not.toContain("Run speed test now");
    expect(html).not.toContain("Tested every week");
  });

  it("render, failed: tries again next month, never 'next week' or 'run it now'", () => {
    const html = render(standard({ latest: report("FAILED", [], { failureReason: "timeout" }) }));
    expect(html).toContain("We&#x27;ll try again next month.");
    expect(html).not.toContain("next week");
    expect(html).not.toContain("run it now");
  });

  it("action: a forged Run-now POST goes to the Professional-only service, whose refusal passes through", async () => {
    mockRunNow.mockResolvedValue({
      ok: false,
      error: "Running a speed test now is part of the Professional plan.",
    });
    await expect(action(actionArgs({ intent: "run-now" }))).resolves.toEqual({
      ok: false,
      error: "Running a speed test now is part of the Professional plan.",
    });
    expect(mockRunNow).toHaveBeenCalledWith({ ...PRO, plan: "Standard" }, expect.any(Date));
    expect(mockFreeTest).not.toHaveBeenCalled();
  });
});

describe("action: free speed test", () => {
  it("intent free-test starts the free test for the session shop (never Run now)", async () => {
    const shop = { ...PRO, plan: "free" };
    mockShop.mockResolvedValue(shop);
    mockFreeTest.mockResolvedValue({ ok: true, reportId: "rep-f" });
    await expect(
      action(actionArgs({ intent: "free-test", shopId: "someone-else", page: "product" })),
    ).resolves.toEqual({ ok: true });
    expect(mockFreeTest).toHaveBeenCalledWith(shop, expect.any(Date));
    expect(mockRunNow).not.toHaveBeenCalled();
  });

  it("passes the free test's refusal through", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    mockFreeTest.mockResolvedValue({
      ok: false,
      error: "You've already used your free speed test.",
    });
    await expect(action(actionArgs({ intent: "free-test" }))).resolves.toEqual({
      ok: false,
      error: "You've already used your free speed test.",
    });
  });

  it("a forged run-now POST from a Free shop goes to the Professional-only service (which refuses)", async () => {
    mockShop.mockResolvedValue({ ...PRO, plan: "free" });
    mockRunNow.mockResolvedValue({
      ok: false,
      error: "Running a speed test now is part of the Professional plan.",
    });
    await expect(action(actionArgs({ intent: "run-now" }))).resolves.toEqual({
      ok: false,
      error: "Running a speed test now is part of the Professional plan.",
    });
    expect(mockFreeTest).not.toHaveBeenCalled();
  });

  it("404s while dark", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    await expect404(action(actionArgs({ intent: "free-test" })));
    expect(mockFreeTest).not.toHaveBeenCalled();
  });
});

describe("rendering: free speed test", () => {
  const ASK = {
    pricingPlansUrl: "https://admin.shopify.com/store/x/charges/ghost-code/pricing_plans",
    trialEligible: false,
  };

  function free(
    freeTest: Extract<SpeedLoaderData, { access: "free" }>["freeTest"],
    runAvailableAt: string | null = null,
  ): SpeedLoaderData {
    return { access: "free", freeTest, runAvailableAt, ...ASK };
  }

  const RESULT = {
    reportId: "rep-f",
    createdAt: "2026-10-11T08:12:00.000Z",
    metrics: { score: 28, lcpMs: 14212, tbtMs: 9034, totalBytes: 8123456, requestCount: 661 },
    costliestApp: { name: "Klaviyo", mainThreadMs: 4123, transferBytes: 1851000 },
  };

  function upgradeLinks(html: string): number {
    return (html.match(/<a [^>]*pricing_plans[^>]*>/g) ?? []).length;
  }

  it("available: the free test action, its intro, and ONE upgrade ask to Professional", () => {
    const html = render(free({ state: "available", result: null, lastAttempt: null }));
    expect(html).toContain("Run your free speed test");
    expect(html).toContain('name="intent" value="free-test"');
    expect(html).toContain("which app slows it down the most");
    expect(html).toContain("Test every week and see the cost of every app");
    expect(html).toContain("weekly speed report for your homepage and a product page");
    expect(html).toContain("Upgrade to Professional");
    expect(upgradeLinks(html)).toBe(1);
    expect(html).not.toContain("Run speed test now");
    expect(html).not.toContain('value="run-now"');
    expect(html).not.toMatch(/<s-button[^>]*disabled/);
    expect(html).not.toContain("—");
  });

  it("available within 24h of a try: the button is disabled with the next time", () => {
    const html = render(
      free({ state: "available", result: null, lastAttempt: null }, "2026-10-12T10:00:00.000Z"),
    );
    expect(html).toMatch(/<s-button[^>]*disabled/);
    expect(html).toContain("Next test available");
  });

  it("exhausted: says the test couldn't complete, offers support and the upgrade, no run control", () => {
    const html = render(free({ state: "exhausted", result: null, lastAttempt: null }));
    expect(html).toContain("couldn&#x27;t complete for this store after 5 tries");
    expect(html).toContain("timed out or couldn&#x27;t load your homepage");
    expect(html).not.toContain("password");
    expect(html).toContain('href="mailto:support@alpenglowsoftware.com"');
    expect(html).not.toContain("Run your free speed test");
    expect(html).not.toContain('value="free-test"');
    expect(upgradeLinks(html)).toBe(1);
    expect(html).not.toContain("—");
  });

  it("running", () => {
    const html = render(free({ state: "running", result: null, lastAttempt: null }));
    expect(html).toContain("Speed test running. It takes a few minutes");
    expect(upgradeLinks(html)).toBe(1);
  });

  it("a failed try: says it was not used up and can be run again", () => {
    const html = render(
      free({
        state: "available",
        result: null,
        lastAttempt: { status: "FAILED", failureReason: "timeout", createdAt: RESULT.createdAt },
      }),
    );
    expect(html).toContain("We couldn&#x27;t test your store on");
    expect(html).toContain("The speed test took too long to finish.");
    expect(html).toContain("Your free test wasn&#x27;t used, so you can run it again.");
    expect(html).toContain("Run your free speed test");
  });

  it("a budget skip and a password page read as such", () => {
    let html = render(
      free({
        state: "available",
        result: null,
        lastAttempt: {
          status: "SKIPPED_BUDGET",
          failureReason: "budget",
          createdAt: RESULT.createdAt,
        },
      }),
    );
    // The free daily ceiling: paused for everyone, and this try is not counted.
    expect(html).toContain(
      "Free speed tests are paused for today. Your free test wasn&#x27;t used and this try doesn&#x27;t count. You can run it again tomorrow.",
    );
    expect(html).not.toContain("We couldn&#x27;t test your store on");
    expect(html).toContain("Run your free speed test");
    html = render(
      free({
        state: "available",
        result: null,
        lastAttempt: {
          status: "UNAVAILABLE_PASSWORD",
          failureReason: null,
          createdAt: RESULT.createdAt,
        },
      }),
    );
    expect(html).toContain("Your storefront is password protected");
  });

  it("used: score, core timings and ONE costliest-app line (the email's wording), read-only, dated", () => {
    const html = render(free({ state: "used", result: RESULT, lastAttempt: null }));
    expect(html).toContain("Your free speed test");
    expect(html).toContain("Homepage, tested");
    expect(html).toContain("28 / 100");
    expect(html).toContain("Time to show the main content");
    expect(html).toContain("14 s");
    expect(html).toContain("9.0 s");
    expect(html).toContain("8.1 MB");
    expect(html).toContain("661");
    expect(html).toContain("Klaviyo used 4.1 s of processing time and 1.9 MB on your homepage.");
    // Not the Pro view.
    expect(html).not.toContain("Apps slowing your store");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Other third-party code");
    expect(html).not.toContain("Product page");
    expect(html).not.toContain("last week");
    // No further runs.
    expect(html).not.toContain("Run your free speed test");
    expect(html).not.toContain("Run speed test now");
    expect(html).not.toContain('name="intent"');
    expect(upgradeLinks(html)).toBe(1);
  });

  it("used, no app with measurable load", () => {
    const html = render(
      free({ state: "used", result: { ...RESULT, costliestApp: null }, lastAttempt: null }),
    );
    expect(html).toContain("No known app added measurable load to your homepage.");
  });

  it("the free page's upgrade link records the speed_teaser click", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const el = LockedTeaser({
        ...ASK,
        heading: "Test every week and see the cost of every app",
        body: "x",
      });
      const html = renderToStaticMarkup(el);
      expect(html).toContain("Test every week and see the cost of every app");
      type El = { type: unknown; props: { onClick?: () => void; children?: unknown } };
      const find = (n: unknown): El | null => {
        if (!n || typeof n !== "object") return null;
        if (Array.isArray(n)) {
          for (const c of n) {
            const hit = find(c);
            if (hit) return hit;
          }
          return null;
        }
        const e = n as El;
        return e.type === "a" ? e : find(e.props?.children);
      };
      find(el)!.props.onClick!();
      expect(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).toBe(
        "src=speed_teaser",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
