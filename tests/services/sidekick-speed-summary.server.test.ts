/**
 * Tests for app/services/sidekick-speed-summary.server.ts (Sidekick data
 * extension, gc-5nok). The speed-report and shop MODELS are mocked; the real
 * plan gate (readSpeedPageReport, the Store speed page's own read), the real
 * view builders and the real formatters run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/models/shop.server", () => ({ getShopMetadata: vi.fn() }));
vi.mock("../../app/models/speed-report.server", () => ({
  getRecentSpeedReports: vi.fn(),
  getSpeedReportRequestedAt: vi.fn(),
  getFreeSpeedTestUsedAt: vi.fn(),
  countFreeSpeedTestAttempts: vi.fn(),
}));
// The real plan matrix by default; one test narrows the free test away.
vi.mock("../../app/lib/billing.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/lib/billing.server")>();
  return { ...actual, getPlanFeatures: vi.fn(actual.getPlanFeatures) };
});

import * as billing from "../../app/lib/billing.server";
import {
  FREE_TEST_EXHAUSTED,
  FREE_TEST_NO_APP,
  FREE_TEST_PAUSED_TODAY,
  PASSWORD_PROTECTED_MESSAGE,
  SPEED_CAVEAT,
  type SpeedPageResult,
} from "../../app/lib/speed-report";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  countFreeSpeedTestAttempts,
  getFreeSpeedTestUsedAt,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
} from "../../app/models/speed-report.server";
import {
  FREE_SCOPE,
  FREE_TEST_NOT_RUN_MESSAGE,
  getSidekickSpeedSummary,
  MAX_SPEED_APPS,
  PRO_SCOPE,
  MONTHLY_SCOPE,
  speedNoMonthlyReportMessage,
  SPEED_NO_REPORT_MESSAGE,
  SPEED_NO_RESULT_MESSAGE,
  SPEED_NOT_LIVE_MESSAGE,
  SPEED_NOT_ON_PLAN_MESSAGE,
  SPEED_PAUSED_MESSAGE,
  SPEED_RUNNING_NOW_MESSAGE,
  SPEED_URL,
} from "../../app/services/sidekick-speed-summary.server";

const mockShop = vi.mocked(getShopMetadata);
const mockReports = vi.mocked(getRecentSpeedReports);
const mockRequestedAt = vi.mocked(getSpeedReportRequestedAt);
const mockUsedAt = vi.mocked(getFreeSpeedTestUsedAt);
const mockAttempts = vi.mocked(countFreeSpeedTestAttempts);
const mockFeatures = vi.mocked(billing.getPlanFeatures);

const DOMAIN = "a.myshopify.com";

function setPlan(plan: string) {
  mockShop.mockResolvedValue({ id: "shop_1", domain: DOMAIN, plan } as never);
}

const app = (
  name: string,
  mainThreadMs: number,
  transferBytes: number,
  unusedPct: number | null,
) => ({
  name,
  mainThreadMs,
  transferBytes,
  unusedPct,
  requestCount: 4,
});

const HOME: SpeedPageResult = {
  page: "home",
  status: "OK",
  url: "https://shop.example/",
  runsAttempted: 3,
  runsOk: 3,
  metrics: {
    score: 62,
    lcpMs: 4200,
    tbtMs: 900,
    cls: 0.01,
    fcpMs: 1800,
    speedIndexMs: 3900,
    totalBytes: 2_400_000,
    requestCount: 118,
  },
  apps: [
    app("Klaviyo", 4000, 621_000, 41),
    app("Judge.me", 1200, 300_000, null),
    app("Hotjar", 900, 150_000, 10),
    app("Privy", 700, 120_000, 5),
    app("Gorgias", 500, 80_000, 0),
    app("Tiny", 100, 2_000, 0),
    app("Idle", 0, 50_000, 0),
  ],
  otherThirdParty: [app("cdn.thirdparty.example", 999, 1, 1)],
  firstParty: { mainThreadMs: 2222, transferBytes: 333_333 },
};

const PRODUCT_FAILED: SpeedPageResult = {
  page: "product",
  status: "FAILED",
  url: "https://shop.example/products/mug",
  failureCode: "timeout",
  runsAttempted: 3,
  runsOk: 0,
};

function report(
  id: string,
  status: string,
  pages: SpeedPageResult[],
  createdAt = "2026-10-11T08:10:00.000Z",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    origin: "SCHEDULED",
    status,
    failureReason: null,
    pages,
    createdAt: new Date(createdAt),
    startedAt: new Date(createdAt),
    completedAt: new Date(createdAt),
    ...extra,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof import("../../app/lib/billing.server")>(
    "../../app/lib/billing.server",
  );
  mockFeatures.mockImplementation(actual.getPlanFeatures);
  process.env.SPEED_REPORT_LIVE_ENABLED = "true";
  setPlan("Professional");
  mockReports.mockResolvedValue([]);
  mockRequestedAt.mockResolvedValue(null);
  mockUsedAt.mockResolvedValue(null);
  mockAttempts.mockResolvedValue(0);
});

afterEach(() => {
  delete process.env.SPEED_REPORT_LIVE_ENABLED;
});

describe("getSidekickSpeedSummary: Professional", () => {
  it("returns the latest report with results: pages, metrics as the page shows them, top 5 apps", async () => {
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [HOME])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r).toEqual({
      status: "ok",
      reportDate: "2026-10-11T08:10:00.000Z",
      reportType: "speed_report",
      pages: [
        {
          page: "Homepage",
          path: "/",
          tested: true,
          speedScore: "62 / 100",
          timeToShowMainContent: "4.2 s",
          timeThePageIsFrozen: "0.9 s",
          pageSize: "2.4 MB",
          filesLoaded: "118",
          costliestApps: [
            {
              app: "Klaviyo",
              processingTime: "4.0 s",
              downloadSize: "621 KB",
              unusedCode: "41% unused",
            },
            {
              app: "Judge.me",
              processingTime: "1.2 s",
              downloadSize: "300 KB",
              unusedCode: "Not measured",
            },
            {
              app: "Hotjar",
              processingTime: "0.9 s",
              downloadSize: "150 KB",
              unusedCode: "10% unused",
            },
            {
              app: "Privy",
              processingTime: "0.7 s",
              downloadSize: "120 KB",
              unusedCode: "5% unused",
            },
            {
              app: "Gorgias",
              processingTime: "0.5 s",
              downloadSize: "80 KB",
              unusedCode: "0% unused",
            },
          ],
        },
      ],
      scope: PRO_SCOPE,
      latestRun: null,
      caveat: SPEED_CAVEAT,
      url: SPEED_URL,
    });
    // The full history is read (Professional), not only FREE_TEST reports.
    expect(mockReports).toHaveBeenCalledWith("shop_1");
  });

  it("caps apps at MAX_SPEED_APPS and never lists other third parties or first-party totals", async () => {
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [HOME])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    const json = JSON.stringify(r);
    expect(json).not.toContain("cdn.thirdparty.example");
    expect(json).not.toContain("Tiny");
    expect(json).not.toContain("Idle");
    if (r.status !== "ok" || !r.pages[0].tested) throw new Error("expected a tested page");
    expect(r.pages[0].costliestApps).toHaveLength(MAX_SPEED_APPS);
  });

  it("partial report: the tested page has numbers, the failed page a note (never zeros)", async () => {
    mockReports.mockResolvedValue([report("r1", "PARTIAL", [HOME, PRODUCT_FAILED])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.pages[1]).toEqual({
      page: "Product page",
      path: "/products/mug",
      tested: false,
      note: "This page wasn't tested this time. The speed test took too long to finish.",
    });
  });

  it("missing metrics read 'Not available', never 0", async () => {
    const sparse: SpeedPageResult = {
      ...HOME,
      metrics: {
        score: null,
        lcpMs: null,
        tbtMs: null,
        cls: null,
        fcpMs: null,
        speedIndexMs: null,
        totalBytes: null,
        requestCount: null,
      },
      apps: [],
    };
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [sparse])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.pages[0]).toMatchObject({
      speedScore: "Not available",
      timeToShowMainContent: "Not available",
      timeThePageIsFrozen: "Not available",
      pageSize: "Not available",
      filesLoaded: "Not available",
      costliestApps: [],
      appsNote: "No known app added measurable load to this page.",
    });
    expect(JSON.stringify(r.pages[0])).not.toMatch(/"0|: 0\b|"0 /);
  });

  it("a newer run without results is reported next to the last results", async () => {
    mockReports.mockResolvedValue([
      report("r2", "UNAVAILABLE_PASSWORD", [], "2026-10-18T08:10:00.000Z"),
      report("r1", "COMPLETED", [HOME]),
    ] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.reportDate).toBe("2026-10-11T08:10:00.000Z");
    expect(r.latestRun).toEqual({
      date: "2026-10-18T08:10:00.000Z",
      reason: "password_protected",
      message: PASSWORD_PROTECTED_MESSAGE,
    });
  });

  it("no report yet: no_data with the first-report message", async () => {
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason: "not_run",
      message: SPEED_NO_REPORT_MESSAGE,
      url: SPEED_URL,
    });
  });

  it("password-protected storefront (no results ever): says so", async () => {
    mockReports.mockResolvedValue([report("r1", "UNAVAILABLE_PASSWORD", [])] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason: "password_protected",
      message: PASSWORD_PROTECTED_MESSAGE,
      url: SPEED_URL,
    });
  });

  it.each([
    ["RUNNING", "running", SPEED_RUNNING_NOW_MESSAGE],
    ["SKIPPED_BUDGET", "paused", SPEED_PAUSED_MESSAGE],
    [
      "FAILED",
      "failed",
      "The speed test on 2026-10-11 did not finish. Google couldn't load this page of your store.",
    ],
  ])("first report %s: no_data (%s)", async (status, reason, message) => {
    mockReports.mockResolvedValue([
      report("r1", status, [], "2026-10-11T08:10:00.000Z", {
        failureReason: status === "FAILED" ? "document_failed" : null,
        // A RUNNING row started just now (not abandoned).
        ...(status === "RUNNING" ? { createdAt: new Date(), startedAt: new Date() } : {}),
      }),
    ] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason,
      message,
      url: SPEED_URL,
    });
  });
});

describe("getSidekickSpeedSummary: Free (the free speed test)", () => {
  const freeRow = (status: string, pages: SpeedPageResult[], extra: Record<string, unknown> = {}) =>
    report("f1", status, pages, "2026-10-12T15:00:00.000Z", { origin: "FREE_TEST", ...extra });

  it.each(["free"])(
    "%s: returns only the homepage score, timings and ONE costliest app",
    async (plan) => {
      setPlan(plan);
      mockUsedAt.mockResolvedValue(new Date("2026-10-12T15:05:00.000Z"));
      mockReports.mockResolvedValue([freeRow("COMPLETED", [HOME])] as never);
      const r = await getSidekickSpeedSummary(DOMAIN);
      expect(r).toEqual({
        status: "ok",
        reportDate: "2026-10-12T15:00:00.000Z",
        reportType: "free_test",
        pages: [
          {
            page: "Homepage",
            path: null,
            tested: true,
            speedScore: "62 / 100",
            timeToShowMainContent: "4.2 s",
            timeThePageIsFrozen: "0.9 s",
            pageSize: "2.4 MB",
            filesLoaded: "118",
            costliestApps: [{ app: "Klaviyo", processingTime: "4.0 s", downloadSize: "621 KB" }],
          },
        ],
        scope: FREE_SCOPE,
        latestRun: null,
        caveat: SPEED_CAVEAT,
        url: SPEED_URL,
      });
      // Gate exactly as the page: ONLY FREE_TEST reports are read.
      expect(mockReports).toHaveBeenCalledWith("shop_1", { origin: "FREE_TEST" });
      const json = JSON.stringify(r);
      for (const hidden of ["Judge.me", "Hotjar", "unusedCode", "cdn.thirdparty", "2222"]) {
        expect(json).not.toContain(hidden);
      }
    },
  );

  it("no costliest app: says so instead of listing a zero", async () => {
    setPlan("free");
    mockUsedAt.mockResolvedValue(new Date());
    mockReports.mockResolvedValue([freeRow("COMPLETED", [{ ...HOME, apps: [] }])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.pages[0]).toMatchObject({ costliestApps: [], appsNote: FREE_TEST_NO_APP });
  });

  it("used stamp without its report (should not happen): no_data, not a failure", async () => {
    setPlan("free");
    mockUsedAt.mockResolvedValue(new Date());
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      status: "no_data",
      reason: "free_test_unavailable",
    });
  });

  it("free test not run yet: no_data", async () => {
    setPlan("free");
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason: "free_test_not_used",
      message: FREE_TEST_NOT_RUN_MESSAGE,
      url: SPEED_URL,
    });
  });

  it("free test blocked by a password page: says the storefront is password protected", async () => {
    setPlan("free");
    mockReports.mockResolvedValue([freeRow("UNAVAILABLE_PASSWORD", [])] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      status: "no_data",
      reason: "password_protected",
      message: PASSWORD_PROTECTED_MESSAGE,
    });
  });

  it("free test paused for the day / failed / exhausted / running", async () => {
    setPlan("free");
    mockReports.mockResolvedValue([freeRow("SKIPPED_BUDGET", [])] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      reason: "paused",
      message: FREE_TEST_PAUSED_TODAY,
    });

    mockReports.mockResolvedValue([freeRow("FAILED", [], { failureReason: "timeout" })] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      reason: "failed",
      message:
        "The free speed test on 2026-10-12 did not finish. The speed test took too long to finish. It was not used up and can be run again from the Store speed page.",
    });

    mockAttempts.mockResolvedValue(5);
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      reason: "free_test_unavailable",
      message: FREE_TEST_EXHAUSTED,
    });

    mockReports.mockResolvedValue([
      freeRow("RUNNING", [], { createdAt: new Date(), startedAt: new Date() }),
    ] as never);
    expect(await getSidekickSpeedSummary(DOMAIN)).toMatchObject({
      reason: "running",
      message: SPEED_RUNNING_NOW_MESSAGE,
    });
  });

  it("a downgraded shop's Professional reports are never read", async () => {
    setPlan("free");
    await getSidekickSpeedSummary(DOMAIN);
    expect(mockReports).toHaveBeenCalledTimes(1);
    expect(mockReports).toHaveBeenCalledWith("shop_1", { origin: "FREE_TEST" });
  });
});

describe("getSidekickSpeedSummary: Standard (the monthly report, gc-d0ui)", () => {
  beforeEach(() => {
    setPlan("Standard");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the latest monthly report like Professional (top 5 apps, unused code), with the monthly scope", async () => {
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [HOME])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    if (r.status !== "ok" || !r.pages[0].tested) throw new Error("expected a tested page");
    expect(r.reportType).toBe("speed_report");
    expect(r.scope).toBe(MONTHLY_SCOPE);
    expect(r.scope).not.toBe(PRO_SCOPE);
    expect(r.pages[0].costliestApps).toHaveLength(MAX_SPEED_APPS);
    expect(r.pages[0].costliestApps[0]).toEqual({
      app: "Klaviyo",
      processingTime: "4.0 s",
      downloadSize: "621 KB",
      unusedCode: "41% unused",
    });
    // The same shared read as the page: the full history, not only FREE_TEST.
    expect(mockReports).toHaveBeenCalledWith("shop_1");
    expect(mockUsedAt).not.toHaveBeenCalled();
  });

  it("a FREE_TEST report from before the plan change still shows (no monthly report yet)", async () => {
    mockReports.mockResolvedValue([
      report("f1", "COMPLETED", [HOME], "2026-10-12T15:00:00.000Z", { origin: "FREE_TEST" }),
    ] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r).toMatchObject({
      status: "ok",
      reportDate: "2026-10-12T15:00:00.000Z",
      reportType: "speed_report",
      scope: MONTHLY_SCOPE,
    });
  });

  it("no report yet: the first monthly report's date, never 'weekly' or 'Sunday'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r).toEqual({
      status: "no_data",
      reason: "not_run",
      message: speedNoMonthlyReportMessage(new Date("2026-11-01T08:10:00Z")),
      url: SPEED_URL,
    });
    if (r.status !== "no_data") throw new Error("expected no_data");
    expect(r.message).toBe(
      "No speed report has run for this store yet. The first monthly report runs on 2026-11-01.",
    );
    expect(r.message).not.toMatch(/weekly|Sunday/);
  });

  it("no plan pitch anywhere in a Standard response", async () => {
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [HOME])] as never);
    const json = JSON.stringify(await getSidekickSpeedSummary(DOMAIN));
    expect(json).not.toMatch(/upgrade|Professional|Standard|unlock|trial|plan/i);
  });

  it("Professional keeps its own scope", async () => {
    setPlan("Professional");
    mockReports.mockResolvedValue([report("r1", "COMPLETED", [HOME])] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r).toMatchObject({ scope: PRO_SCOPE });
  });
});

describe("getSidekickSpeedSummary: gates", () => {
  it("a plan with neither the report nor the free test: not_available_on_plan, nothing read", async () => {
    const actual = await vi.importActual<typeof import("../../app/lib/billing.server")>(
      "../../app/lib/billing.server",
    );
    mockFeatures.mockImplementation((plan) => ({
      ...actual.getPlanFeatures(plan),
      freeSpeedTest: false,
    }));
    setPlan("free");
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r).toEqual({ status: "not_available_on_plan", message: SPEED_NOT_ON_PLAN_MESSAGE });
    expect(JSON.stringify(r)).not.toMatch(/upgrade|Professional|Standard|unlock|trial/i);
    expect(mockReports).not.toHaveBeenCalled();
  });

  it("dark (SPEED_REPORT_LIVE_ENABLED off): not available, no link to the 404 page, nothing read", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason: "not_available",
      message: SPEED_NOT_LIVE_MESSAGE,
    });
    expect(mockShop).not.toHaveBeenCalled();
  });

  it("shop row missing: no_data", async () => {
    mockShop.mockResolvedValue(null);
    expect(await getSidekickSpeedSummary(DOMAIN)).toEqual({
      status: "no_data",
      reason: "not_run",
      message: SPEED_NO_RESULT_MESSAGE,
      url: SPEED_URL,
    });
    expect(mockReports).not.toHaveBeenCalled();
  });
});

describe("getSidekickSpeedSummary: response size", () => {
  it("a two-page report with many apps stays far under 4,000 tokens", async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      app(`A very long application name number ${i}`, 5000 - i, 900_000, 50),
    );
    const product: SpeedPageResult = {
      ...HOME,
      page: "product",
      url: "https://shop.example/products/a-very-long-product-handle-for-testing",
      apps: many,
    };
    mockReports.mockResolvedValue([
      report("r2", "FAILED", [], "2026-10-18T08:10:00.000Z"),
      report("r1", "COMPLETED", [{ ...HOME, apps: many }, product]),
    ] as never);
    const json = JSON.stringify({ results: [await getSidekickSpeedSummary(DOMAIN)] });
    expect(Math.ceil(json.length / 4)).toBeLessThan(1500);
  });
});

// gc-3y89 item 9 is deferred to release 2 slice 6 (it owns the extension's
// instructions.md): until then the speed tool carries no Security risk data.
describe("getSidekickSpeedSummary: speed-test security risks stay out", () => {
  afterEach(() => {
    delete process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED;
  });

  it("adds no securityRisks key even when the speed test hit a malicious domain", async () => {
    process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED = "true";
    mockReports.mockResolvedValue([
      report("r1", "COMPLETED", [{ ...HOME, maliciousDomains: ["biliing.top"] }]),
    ] as never);
    const r = await getSidekickSpeedSummary(DOMAIN);
    expect(r.status).toBe("ok");
    expect(r).not.toHaveProperty("securityRisks");
    expect(JSON.stringify(r)).not.toContain("biliing.top");
  });
});
