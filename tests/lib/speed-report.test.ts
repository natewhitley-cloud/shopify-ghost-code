/**
 * Tests for app/lib/speed-report.ts (gc-wt3y): run-now window, status roll-up,
 * stored-page parsing, week-over-week change, view model and merchant copy.
 */
import { describe, it, expect } from "vitest";

import * as speed from "../../app/lib/speed-report";
import {
  appCostHeadline,
  buildSpeedReportView,
  computeSpeedReportStatus,
  effectiveSpeedReportStatus,
  formatBytes,
  formatSeconds,
  formatSpeedDelta,
  readSpeedPages,
  RUN_NOW_COOLDOWN_MS,
  runNowAvailableAt,
  SPEED_REPORT_STATUS,
  SPEED_REPORT_QUEUED_STUCK_MS,
  SPEED_REPORT_STUCK_MS,
  speedFailureMessage,
  speedPageDelta,
  speedScoreTone,
  type SpeedCostRow,
  type SpeedFailureCode,
  type SpeedPageResult,
} from "../../app/lib/speed-report";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function okPage(overrides: Partial<SpeedPageResult> = {}): SpeedPageResult {
  return {
    page: "home",
    status: "OK",
    url: "https://shop.example/",
    runsAttempted: 3,
    runsOk: 3,
    metrics: {
      score: 28,
      lcpMs: 14000,
      tbtMs: 9000,
      cls: 0.1,
      fcpMs: 4000,
      speedIndexMs: 11000,
      totalBytes: 8_000_000,
      requestCount: 660,
    },
    apps: [],
    otherThirdParty: [],
    ...overrides,
  };
}

describe("runNowAvailableAt (24h per shop)", () => {
  it("is available when never pressed", () => {
    expect(runNowAvailableAt(null, NOW)).toBeNull();
  });

  it("is available at EXACTLY 24h after the last press", () => {
    expect(runNowAvailableAt(new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS), NOW)).toBeNull();
  });

  it("is blocked 1 ms before 24h, until last press + 24h", () => {
    const last = new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS + 1);
    expect(runNowAvailableAt(last, NOW)).toEqual(new Date(last.getTime() + RUN_NOW_COOLDOWN_MS));
  });

  it("uses a 24 hour window", () => {
    expect(RUN_NOW_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("effectiveSpeedReportStatus", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it("keeps a RUNNING row running until the worker has run SPEED_REPORT_STUCK_MS", () => {
    const report = {
      status: "RUNNING",
      createdAt: ago(3 * 3_600_000),
      startedAt: ago(SPEED_REPORT_STUCK_MS),
    };
    expect(effectiveSpeedReportStatus(report, NOW)).toEqual({
      status: "RUNNING",
      failureReason: null,
    });
  });

  it("treats a row the worker started more than SPEED_REPORT_STUCK_MS ago as FAILED/stuck", () => {
    const report = {
      status: "RUNNING",
      createdAt: ago(SPEED_REPORT_STUCK_MS + 1),
      startedAt: ago(SPEED_REPORT_STUCK_MS + 1),
    };
    expect(effectiveSpeedReportStatus(report, NOW)).toEqual({
      status: "FAILED",
      failureReason: "stuck",
    });
  });

  it("a queued run (never started) is still RUNNING hours after the click (gc-wt3y #3)", () => {
    // Sunday batch at concurrency 1: a manual click can wait well past an hour.
    const report = { status: "RUNNING", createdAt: ago(3 * 3_600_000), startedAt: null };
    expect(effectiveSpeedReportStatus(report, NOW).status).toBe("RUNNING");
    expect(
      effectiveSpeedReportStatus({ ...report, createdAt: ago(SPEED_REPORT_QUEUED_STUCK_MS) }, NOW)
        .status,
    ).toBe("RUNNING");
  });

  it("a run never started after SPEED_REPORT_QUEUED_STUCK_MS reads as FAILED/stuck", () => {
    const report = {
      status: "RUNNING",
      createdAt: ago(SPEED_REPORT_QUEUED_STUCK_MS + 1),
      startedAt: null,
    };
    expect(effectiveSpeedReportStatus(report, NOW)).toEqual({
      status: "FAILED",
      failureReason: "stuck",
    });
  });

  it("the queued threshold outlasts the worker's 6 h start timeout, the running one its 45 m finish timeout", () => {
    expect(SPEED_REPORT_QUEUED_STUCK_MS).toBeGreaterThan(6 * 3_600_000);
    expect(SPEED_REPORT_STUCK_MS).toBeGreaterThan(45 * 60_000);
  });

  it("never rewrites a finished status", () => {
    const createdAt = new Date(0);
    expect(effectiveSpeedReportStatus({ status: "COMPLETED", createdAt }, NOW).status).toBe(
      "COMPLETED",
    );
  });
});

describe("computeSpeedReportStatus", () => {
  const fail = (page: "home" | "product", status: SpeedPageResult["status"]): SpeedPageResult => ({
    page,
    status,
    url: null,
    runsAttempted: 0,
    runsOk: 0,
  });

  it("COMPLETED when every testable page is OK", () => {
    expect(
      computeSpeedReportStatus([okPage(), okPage({ page: "product" })], { budgetExhausted: false }),
    ).toBe("COMPLETED");
  });

  it("COMPLETED when the product page had nothing to test", () => {
    for (const s of ["NO_PRODUCT", "NEEDS_PRODUCT_ACCESS"] as const) {
      expect(
        computeSpeedReportStatus([okPage(), fail("product", s)], { budgetExhausted: false }),
      ).toBe("COMPLETED");
    }
  });

  it("PARTIAL when one page is OK and another FAILED or NOT_RUN", () => {
    expect(
      computeSpeedReportStatus([okPage(), fail("product", "FAILED")], { budgetExhausted: false }),
    ).toBe("PARTIAL");
    expect(
      computeSpeedReportStatus([okPage(), fail("product", "NOT_RUN")], { budgetExhausted: true }),
    ).toBe("PARTIAL");
  });

  it("UNAVAILABLE_PASSWORD wins over everything", () => {
    expect(
      computeSpeedReportStatus([fail("home", "PASSWORD"), okPage({ page: "product" })], {
        budgetExhausted: true,
      }),
    ).toBe("UNAVAILABLE_PASSWORD");
  });

  it("SKIPPED_BUDGET when nothing is OK and the budget ran out, else FAILED", () => {
    const pages = [fail("home", "NOT_RUN"), fail("product", "NOT_RUN")];
    expect(computeSpeedReportStatus(pages, { budgetExhausted: true })).toBe("SKIPPED_BUDGET");
    expect(computeSpeedReportStatus(pages, { budgetExhausted: false })).toBe("FAILED");
    expect(computeSpeedReportStatus([], { budgetExhausted: false })).toBe("FAILED");
  });
});

describe("readSpeedPages", () => {
  it("round-trips a stored page", () => {
    const page = okPage({
      apps: [
        {
          name: "Klaviyo",
          mainThreadMs: 4000,
          blockingMs: 2000,
          transferBytes: 621000,
          unusedPct: 50,
          requestCount: 3,
        },
      ],
      firstParty: { mainThreadMs: 2200, transferBytes: 250000 },
    });
    const parsed = readSpeedPages(JSON.parse(JSON.stringify([page])));
    expect(parsed).toEqual([page]);
  });

  it("drops malformed entries and fills malformed numbers safely", () => {
    const parsed = readSpeedPages([
      null,
      "x",
      { page: "cart", status: "OK" },
      { page: "home", status: "WEIRD" },
      {
        page: "product",
        status: "FAILED",
        url: 5,
        failureCode: "timeout",
        apps: [{ name: "A", mainThreadMs: "9" }, { mainThreadMs: 1 }],
      },
    ]);
    expect(parsed).toEqual([
      {
        page: "product",
        status: "FAILED",
        url: null,
        failureCode: "timeout",
        runsAttempted: 0,
        runsOk: 0,
        apps: [
          {
            name: "A",
            mainThreadMs: 0,
            blockingMs: 0,
            transferBytes: 0,
            unusedPct: null,
            requestCount: 0,
          },
        ],
        otherThirdParty: [],
      },
    ]);
  });

  it("returns [] for a non-array", () => {
    expect(readSpeedPages(null)).toEqual([]);
    expect(readSpeedPages({ page: "home" })).toEqual([]);
  });
});

describe("speedPageDelta", () => {
  it("is current minus previous for the headline metrics", () => {
    const prev = okPage();
    const cur = okPage({
      metrics: { ...prev.metrics!, score: 35, lcpMs: 12000, tbtMs: 9500, totalBytes: 7_000_000 },
    });
    expect(speedPageDelta(cur, prev)).toEqual({
      score: 7,
      lcpMs: -2000,
      tbtMs: 500,
      totalBytes: -1_000_000,
    });
  });

  it("is null without a baseline, when either side failed, or when the URL changed", () => {
    expect(speedPageDelta(okPage(), undefined)).toBeNull();
    expect(speedPageDelta(okPage(), { ...okPage(), status: "FAILED" })).toBeNull();
    expect(speedPageDelta(okPage({ url: "https://shop.example/products/b" }), okPage())).toBeNull();
  });

  it("keeps per-metric nulls", () => {
    const prev = okPage({ metrics: { ...okPage().metrics!, score: null } });
    expect(speedPageDelta(okPage(), prev)!.score).toBeNull();
  });
});

describe("formatting", () => {
  it("formatSeconds", () => {
    expect(formatSeconds(4212)).toBe("4.2 s");
    expect(formatSeconds(0)).toBe("0.0 s");
    expect(formatSeconds(14212)).toBe("14 s");
    expect(formatSeconds(null)).toBe("Not available");
  });

  it("formatBytes", () => {
    expect(formatBytes(621000)).toBe("621 KB");
    expect(formatBytes(1_200_000)).toBe("1.2 MB");
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(null)).toBe("Not available");
  });

  it("formatSpeedDelta", () => {
    expect(formatSpeedDelta("score", 5)).toBe("Up 5 from last week");
    expect(formatSpeedDelta("score", -3)).toBe("Down 3 from last week");
    expect(formatSpeedDelta("score", 0)).toBe("No change from last week");
    expect(formatSpeedDelta("time", -800)).toBe("0.8 s faster than last week");
    expect(formatSpeedDelta("time", 1100)).toBe("1.1 s slower than last week");
    expect(formatSpeedDelta("time", 50)).toBe("About the same as last week");
    expect(formatSpeedDelta("bytes", -120_000)).toBe("120 KB smaller than last week");
    expect(formatSpeedDelta("bytes", 2_500_000)).toBe("2.5 MB larger than last week");
    expect(formatSpeedDelta("bytes", 10)).toBe("About the same as last week");
    expect(formatSpeedDelta("score", null)).toBeNull();
  });

  it("speedScoreTone uses Lighthouse's bands", () => {
    expect(speedScoreTone(90)).toBe("success");
    expect(speedScoreTone(89)).toBe("warning");
    expect(speedScoreTone(50)).toBe("warning");
    expect(speedScoreTone(49)).toBe("critical");
    expect(speedScoreTone(null)).toBeNull();
  });
});

describe("appCostHeadline", () => {
  const row = (name: string, mainThreadMs: number): SpeedCostRow => ({
    name,
    mainThreadMs,
    blockingMs: 0,
    transferBytes: 0,
    unusedPct: null,
    requestCount: 1,
  });

  it("sums the top 3 apps by main-thread time", () => {
    expect(
      appCostHeadline(
        [row("A", 100), row("Klaviyo", 2800), row("Nitro", 1600), row("Recharge", 600)],
        "home",
      ),
    ).toBe("These 3 apps cost your homepage 5.0 s of processing time.");
  });

  it("uses singular copy for one app and names the product page", () => {
    expect(appCostHeadline([row("Klaviyo", 2800)], "product")).toBe(
      "This app costs your product page 2.8 s of processing time.",
    );
  });

  it("is null when no app has any main-thread time", () => {
    expect(appCostHeadline([row("Fonts", 0)], "home")).toBeNull();
    expect(appCostHeadline([], "home")).toBeNull();
  });

  it("does not reorder the caller's array", () => {
    const apps = [row("B", 1), row("A", 2)];
    appCostHeadline(apps, "home");
    expect(apps.map((a) => a.name)).toEqual(["B", "A"]);
  });
});

describe("buildSpeedReportView", () => {
  const row = (id: string, status: string, minutesAgo: number) => ({
    id,
    origin: "SCHEDULED",
    status,
    failureReason: status === "FAILED" ? "timeout" : null,
    pages: [okPage()],
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    completedAt: null,
  });

  it("latest is the newest of any status; results and baseline skip non-result rows", () => {
    const view = buildSpeedReportView(
      [
        row("r4", "FAILED", 10),
        row("r3", "COMPLETED", 60 * 24 * 7),
        row("r2", "UNAVAILABLE_PASSWORD", 60 * 24 * 10),
        row("r1", "PARTIAL", 60 * 24 * 14),
      ],
      NOW,
    );
    expect(view.latest!.id).toBe("r4");
    expect(view.latest!.failureReason).toBe("timeout");
    expect(view.lastResults!.id).toBe("r3");
    expect(view.previousResults!.id).toBe("r1");
    expect(view.latest!.createdAt).toBe(new Date(NOW.getTime() - 10 * 60_000).toISOString());
  });

  it("an abandoned RUNNING row reads as FAILED/stuck", () => {
    const view = buildSpeedReportView(
      [{ ...row("r1", "RUNNING", 61), startedAt: new Date(NOW.getTime() - 61 * 60_000) }],
      NOW,
    );
    expect(view.latest).toMatchObject({ status: "FAILED", failureReason: "stuck" });
  });

  it("empty history", () => {
    expect(buildSpeedReportView([], NOW)).toEqual({
      latest: null,
      lastResults: null,
      previousResults: null,
    });
  });
});

describe("merchant copy", () => {
  const codes: SpeedFailureCode[] = [
    "timeout",
    "rate_limited",
    "http_error",
    "server_error",
    "document_failed",
    "network",
    "bad_response",
    "not_configured",
    "budget",
    "no_domain",
    "not_eligible",
    "dispatch_failed",
    "stuck",
  ];

  it("every failure code maps to a plain sentence", () => {
    for (const code of codes) {
      const msg = speedFailureMessage(code);
      expect(msg).toMatch(/^[A-Z].*\.$/);
    }
    expect(speedFailureMessage(null)).toBe("The speed test didn't finish.");
  });

  it("no copy string uses an em dash or raw jargon like TBT/LCP", () => {
    const strings = [
      ...(Object.values(speed) as unknown[]).filter((v): v is string => typeof v === "string"),
      ...Object.values(speed.SPEED_METRIC_LABELS),
      ...Object.values(speed.SPEED_PAGE_LABELS),
      ...codes.map(speedFailureMessage),
    ];
    for (const s of strings) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\b(TBT|LCP|CLS|FCP)\b/);
    }
  });

  it("states the PageSpeed caveat in plain words", () => {
    expect(speed.SPEED_CAVEAT).toBe(
      "Some apps skip loading during speed tests, so their real cost can be higher.",
    );
    expect(SPEED_REPORT_STATUS.UNAVAILABLE_PASSWORD).toBe("UNAVAILABLE_PASSWORD");
  });
});
