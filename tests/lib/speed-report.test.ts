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

// ---------------------------------------------------------------------------
// Free speed test (pure helpers)
// ---------------------------------------------------------------------------

describe("free speed test helpers", () => {
  const APPS: SpeedCostRow[] = [
    { name: "Recharge", mainThreadMs: 640, transferBytes: 169000, unusedPct: 80, requestCount: 1 },
    { name: "Klaviyo", mainThreadMs: 4123, transferBytes: 1851000, unusedPct: 50, requestCount: 3 },
  ];

  function freeRow(
    status: string,
    pages: SpeedPageResult[] | null,
    extra: Partial<{ id: string; createdAt: Date; startedAt: Date | null }> = {},
  ) {
    const createdAt = extra.createdAt ?? new Date(NOW.getTime() - 3600_000);
    return {
      id: extra.id ?? `r-${status}`,
      origin: "FREE_TEST",
      status,
      failureReason: null,
      pages,
      createdAt,
      startedAt: extra.startedAt === undefined ? createdAt : extra.startedAt,
      completedAt: createdAt,
    };
  }

  it("FREE_TEST is a known origin; junk is not", () => {
    expect(speed.SPEED_REPORT_ORIGIN.FREE_TEST).toBe("FREE_TEST");
    for (const o of ["SCHEDULED", "MANUAL", "FREE_TEST"])
      expect(speed.isSpeedReportOrigin(o)).toBe(true);
    for (const o of ["free_test", "", null, undefined, 1])
      expect(speed.isSpeedReportOrigin(o)).toBe(false);
  });

  it("costliestAppLine is the summary email's sentence", () => {
    expect(speed.costliestAppLine(APPS[1])).toBe(
      "Klaviyo used 4.1 s of processing time and 1.9 MB on your homepage.",
    );
  });

  it.each([
    ["COMPLETED", [okPage()], true],
    ["COMPLETED", [okPage({ metrics: { ...okPage().metrics!, score: null } })], false],
    ["COMPLETED", [], false],
    ["COMPLETED", null, false],
    ["COMPLETED", [okPage({ page: "product" })], false],
    ["PARTIAL", [okPage()], false],
    ["FAILED", [okPage()], false],
    ["UNAVAILABLE_PASSWORD", [okPage({ status: "PASSWORD", metrics: undefined })], false],
    ["SKIPPED_BUDGET", [okPage({ status: "NOT_RUN", metrics: undefined })], false],
    ["RUNNING", null, false],
  ] as const)("freeSpeedTestConsumed(%s, ...) -> %s", (status, pages, expected) => {
    expect(speed.freeSpeedTestConsumed(status, pages as unknown as SpeedPageResult[] | null)).toBe(
      expected,
    );
  });

  it("the result keeps ONLY the homepage score, timings and the costliest app", () => {
    const pages = [
      okPage({
        apps: APPS,
        otherThirdParty: APPS,
        firstParty: { mainThreadMs: 1, transferBytes: 2 },
      }),
      okPage({ page: "product", url: "https://shop.example/products/a" }),
    ];
    const r = speed.freeSpeedTestResultOf(freeRow("COMPLETED", pages));
    expect(r).toEqual({
      reportId: "r-COMPLETED",
      createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      metrics: {
        score: 28,
        lcpMs: okPage().metrics!.lcpMs,
        tbtMs: okPage().metrics!.tbtMs,
        totalBytes: okPage().metrics!.totalBytes,
        requestCount: okPage().metrics!.requestCount,
      },
      costliestApp: { name: "Klaviyo", mainThreadMs: 4123, transferBytes: 1851000 },
    });
    expect(JSON.stringify(r)).not.toMatch(/Recharge|unusedPct|firstParty|products/);
  });

  it("no app with processing time: no costliest app", () => {
    const r = speed.freeSpeedTestResultOf(
      freeRow("COMPLETED", [okPage({ apps: [{ ...APPS[0], mainThreadMs: 0 }] })]),
    );
    expect(r!.costliestApp).toBeNull();
  });

  it("view: used shows the report that used it up, even behind newer failed rows", () => {
    const v = speed.buildFreeSpeedTestView(
      [
        freeRow("FAILED", null, { id: "newer" }),
        freeRow("COMPLETED", [okPage({ apps: APPS })], { id: "used" }),
      ],
      new Date(),
      NOW,
      2,
    );
    expect(v.state).toBe("used");
    expect(v.result!.reportId).toBe("used");
    expect(v.lastAttempt).toBeNull();
  });

  it("view: used stamp but no matching report: used, no result (never offers a run)", () => {
    expect(speed.buildFreeSpeedTestView([], new Date(), NOW, 1)).toEqual({
      state: "used",
      result: null,
      lastAttempt: null,
    });
  });

  it("view: unused and nothing run: available", () => {
    expect(speed.buildFreeSpeedTestView([], null, NOW, 0)).toEqual({
      state: "available",
      result: null,
      lastAttempt: null,
    });
  });

  it("view: a RUNNING row is running; an abandoned one reads as a failed try (stuck)", () => {
    const fresh = freeRow("RUNNING", null, { createdAt: new Date(NOW.getTime() - 60_000) });
    expect(speed.buildFreeSpeedTestView([fresh], null, NOW, 1).state).toBe("running");
    const stale = freeRow("RUNNING", null, {
      createdAt: new Date(NOW.getTime() - SPEED_REPORT_STUCK_MS - 60_000),
    });
    const v = speed.buildFreeSpeedTestView([stale], null, NOW, 1);
    expect(v.state).toBe("available");
    expect(v.lastAttempt).toMatchObject({ status: "FAILED", failureReason: "stuck" });
  });

  it("view: a COMPLETED row without the used stamp never shows a result (the stamp is the truth)", () => {
    const v = speed.buildFreeSpeedTestView([freeRow("COMPLETED", [okPage()])], null, NOW, 1);
    expect(v.state).toBe("available");
    expect(v.result).toBeNull();
  });

  describe("retry cap (FREE_SPEED_TEST_MAX_ATTEMPTS)", () => {
    const failed = () => freeRow("FAILED", null);

    it("is 5", () => {
      expect(speed.FREE_SPEED_TEST_MAX_ATTEMPTS).toBe(5);
    });

    it("one under the cap: still available, with the last try explained", () => {
      const v = speed.buildFreeSpeedTestView([failed()], null, NOW, 4);
      expect(v.state).toBe("available");
      expect(v.lastAttempt).not.toBeNull();
    });

    it("at the cap with no result: exhausted, no run offered and no attempt detail", () => {
      expect(speed.buildFreeSpeedTestView([failed()], null, NOW, 5)).toEqual({
        state: "exhausted",
        result: null,
        lastAttempt: null,
      });
      expect(speed.buildFreeSpeedTestView([failed()], null, NOW, 9).state).toBe("exhausted");
    });

    it("at the cap but the last run used the test up: used (a COMPLETED 5th run still counts)", () => {
      const v = speed.buildFreeSpeedTestView(
        [freeRow("COMPLETED", [okPage({ apps: APPS })], { id: "fifth" })],
        new Date(),
        NOW,
        5,
      );
      expect(v.state).toBe("used");
      expect(v.result!.reportId).toBe("fifth");
    });

    it("at the cap while the 5th run is still RUNNING: running, not exhausted", () => {
      const fresh = freeRow("RUNNING", null, { createdAt: new Date(NOW.getTime() - 60_000) });
      expect(speed.buildFreeSpeedTestView([fresh], null, NOW, 5).state).toBe("running");
    });

    it("the exhausted copy is true for what counts: a timeout or a page Google could not load", () => {
      expect(speed.FREE_TEST_EXHAUSTED).toBe(
        "The free speed test couldn't complete for this store after 5 tries, so it can't be run again. Each time, the test timed out or couldn't load your homepage.",
      );
      // A password page never reaches Google, so it never counts and is not blamed.
      expect(speed.FREE_TEST_EXHAUSTED).not.toMatch(/password/);
      expect(speed.FREE_TEST_EXHAUSTED).not.toMatch(/\u2014/);
    });

    it("the free daily ceiling is 600 calls, and its copy says the try does not count", () => {
      expect(speed.FREE_SPEED_TEST_DAILY_CALL_CEILING).toBe(600);
      expect(speed.FREE_TEST_PAUSED_TODAY).toBe(
        "Free speed tests are paused for today. Your free test wasn't used and this try doesn't count. You can run it again tomorrow.",
      );
    });
  });
});

describe("monthly speed schedule (gc-d0ui)", () => {
  it("the monthly day is a Sunday within the first 7 days of the month (UTC)", () => {
    expect(speed.isMonthlySpeedReportDay(new Date("2026-11-01T08:10:00Z"))).toBe(true); // Sun 1st
    expect(speed.isMonthlySpeedReportDay(new Date("2027-02-07T08:10:00Z"))).toBe(true); // Sun 7th
    expect(speed.isMonthlySpeedReportDay(new Date("2026-11-08T08:10:00Z"))).toBe(false); // Sun 8th
    expect(speed.isMonthlySpeedReportDay(new Date("2026-10-05T08:10:00Z"))).toBe(false); // Mon 5th
  });

  it.each([
    ["2026-10-19T12:00:00Z", "2026-11-01T08:10:00.000Z"], // after October's first Sunday
    ["2026-10-01T00:00:00Z", "2026-10-04T08:10:00.000Z"], // before this month's
    ["2026-10-04T08:09:59Z", "2026-10-04T08:10:00.000Z"], // a second before the run
    ["2026-10-04T08:10:00Z", "2026-11-01T08:10:00.000Z"], // at the run: the next month
    ["2026-12-20T00:00:00Z", "2027-01-03T08:10:00.000Z"], // across the year
  ])("next monthly run after %s is %s", (now, expected) => {
    expect(speed.nextMonthlySpeedReportAt(new Date(now)).toISOString()).toBe(expected);
  });

  it("every next monthly run is itself a monthly day at the cron time", () => {
    for (let d = 0; d < 400; d += 3) {
      const next = speed.nextMonthlySpeedReportAt(new Date(Date.UTC(2026, 0, 1 + d, 9)));
      expect(speed.isMonthlySpeedReportDay(next)).toBe(true);
      expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([8, 10]);
    }
  });

  it("plan bullets are the owner's exact strings and fit the 40-char card", () => {
    expect(speed.FREE_SPEED_TEST_BULLET).toBe("One-time homepage speed test");
    expect(speed.MONTHLY_SPEED_REPORT_BULLET).toBe("Monthly store speed report, cost per app");
    expect(speed.WEEKLY_SPEED_REPORT_BULLET).toBe("Weekly store speed report, cost per app");
    for (const b of [
      speed.FREE_SPEED_TEST_BULLET,
      speed.MONTHLY_SPEED_REPORT_BULLET,
      speed.WEEKLY_SPEED_REPORT_BULLET,
    ]) {
      expect(b.length).toBeLessThanOrEqual(40);
      expect(b).not.toMatch(/[–—]/);
    }
  });
});
