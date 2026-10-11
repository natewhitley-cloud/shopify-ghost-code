/**
 * Tests for app/services/summary-speed.server.ts (gc-2wnf): when the weekly
 * summary email carries a store speed section, and its copy.
 *
 * Mocked at the boundaries: the speed-report model (no database) and the
 * logger. The flag is the real env read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockModel = vi.hoisted(() => ({ getRecentSpeedReports: vi.fn() }));
vi.mock("../../app/models/speed-report.server", () => mockModel);
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { SpeedCostRow, SpeedPageResult, SpeedReportRowLike } from "../../app/lib/speed-report";
import {
  isMaterialSpeedChange,
  loadSummarySpeed,
  pickSummarySpeed,
  SUMMARY_SPEED_MAX_AGE_MS,
  summarySpeedLines,
} from "../../app/services/summary-speed.server";
import type { SummarySpeed } from "../../app/services/summary-speed.server";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-18T07:00:00Z"); // Sunday, after the 06:40 scan
const LAST_WEEK = new Date("2026-10-11T08:12:00Z"); // last Sunday's 08:10 run
const TWO_WEEKS = new Date("2026-10-04T08:12:00Z");
const HOME_URL = "https://paw-naturals.example/";

const appRow = (name: string, mainThreadMs: number, transferBytes = 100_000): SpeedCostRow => ({
  name,
  mainThreadMs,
  transferBytes,
  unusedPct: null,
  requestCount: 1,
});

function home(score: number | null, apps: SpeedCostRow[] = [], url = HOME_URL): SpeedPageResult {
  return {
    page: "home",
    status: "OK",
    url,
    runsAttempted: 3,
    runsOk: 3,
    metrics: {
      score,
      lcpMs: 4000,
      tbtMs: 900,
      cls: 0,
      fcpMs: 1000,
      speedIndexMs: 3000,
      totalBytes: 2_000_000,
      requestCount: 80,
    },
    apps,
    otherThirdParty: [],
  };
}

function row(
  id: string,
  createdAt: Date,
  pages: SpeedPageResult[],
  status = "COMPLETED",
): SpeedReportRowLike {
  return {
    id,
    origin: "SCHEDULED",
    status,
    failureReason: null,
    pages,
    createdAt,
    completedAt: createdAt,
  };
}

const KLAVIYO = appRow("Klaviyo", 4000, 621_000);
const RECHARGE = appRow("Recharge", 900);
const JUDGEME = appRow("Judge.me", 300);
const PUSHOWL = appRow("PushOwl", 200);

const pick = (rows: SpeedReportRowLike[], lastSummarySentAt: Date | null = null) =>
  pickSummarySpeed(rows, { now: NOW, lastSummarySentAt });

// ---------------------------------------------------------------------------
// Inclusion rules
// ---------------------------------------------------------------------------

describe("pickSummarySpeed", () => {
  it("first completed report: included, no change clause", () => {
    expect(pick([row("r1", LAST_WEEK, [home(62, [KLAVIYO, RECHARGE])])])).toEqual<SummarySpeed>({
      reportId: "r1",
      testedAt: LAST_WEEK,
      score: 62,
      scoreDelta: null,
      topApp: KLAVIYO,
    });
  });

  it("an earlier report without a homepage result still makes this the first", () => {
    const failedHome = { ...home(null), status: "FAILED" as const, metrics: undefined };
    const r = pick([
      row("r2", LAST_WEEK, [home(62, [KLAVIYO])]),
      row("r1", TWO_WEEKS, [failedHome], "PARTIAL"),
    ]);
    expect(r).toMatchObject({ reportId: "r2", scoreDelta: null });
  });

  it.each([
    ["up 5", 55, 60, 5],
    ["down 5", 65, 60, -5],
    ["up 12", 48, 60, 12],
  ])("score moved %s: included with the change", (_l, before, after, delta) => {
    const r = pick([
      row("r2", LAST_WEEK, [home(after, [KLAVIYO, RECHARGE])]),
      row("r1", TWO_WEEKS, [home(before, [KLAVIYO, RECHARGE])]),
    ]);
    expect(r).toMatchObject({ reportId: "r2", score: after, scoreDelta: delta });
  });

  it("immaterial: score moved 4, same top app, same top 3 => no section", () => {
    expect(
      pick([
        row("r2", LAST_WEEK, [home(64, [KLAVIYO, RECHARGE, JUDGEME])]),
        row("r1", TWO_WEEKS, [home(60, [KLAVIYO, JUDGEME, RECHARGE])]),
      ]),
    ).toBeNull();
  });

  it("the top costly app changed: included even with the same score", () => {
    const r = pick([
      row("r2", LAST_WEEK, [home(60, [appRow("Recharge", 5000), KLAVIYO])]),
      row("r1", TWO_WEEKS, [home(60, [KLAVIYO, RECHARGE])]),
    ]);
    expect(r).toMatchObject({ scoreDelta: 0, topApp: { name: "Recharge" } });
  });

  it("a new app entered the top 3: included", () => {
    const r = pick([
      row("r2", LAST_WEEK, [home(60, [KLAVIYO, RECHARGE, PUSHOWL])]),
      row("r1", TWO_WEEKS, [home(60, [KLAVIYO, RECHARGE, JUDGEME, appRow("Tiny", 50)])]),
    ]);
    expect(r).toMatchObject({ reportId: "r2" });
  });

  it("an app that dropped out of the top 3 alone is not material", () => {
    expect(
      pick([
        row("r2", LAST_WEEK, [home(60, [KLAVIYO, RECHARGE])]),
        row("r1", TWO_WEEKS, [home(60, [KLAVIYO, RECHARGE, JUDGEME])]),
      ]),
    ).toBeNull();
  });

  it("a different homepage URL: the score is not compared, apps still are", () => {
    expect(
      pick([
        row("r2", LAST_WEEK, [home(90, [KLAVIYO], "https://new-domain.example/")]),
        row("r1", TWO_WEEKS, [home(40, [KLAVIYO])]),
      ]),
    ).toBeNull();
  });

  it("compares against the newest earlier report WITH a homepage result (skips FAILED)", () => {
    const r = pick([
      row("r3", LAST_WEEK, [home(70, [KLAVIYO])]),
      row("r2", new Date(LAST_WEEK.getTime() - DAY), [], "FAILED"),
      row("r1", TWO_WEEKS, [home(60, [KLAVIYO])], "PARTIAL"),
    ]);
    expect(r).toMatchObject({ reportId: "r3", scoreDelta: 10 });
  });

  it("skips a newer report whose status has no results (RUNNING / FAILED / password / budget)", () => {
    for (const status of ["RUNNING", "FAILED", "UNAVAILABLE_PASSWORD", "SKIPPED_BUDGET"]) {
      const r = pick([
        row("latest", new Date(NOW.getTime() - DAY), [home(99, [RECHARGE])], status),
        row("r1", LAST_WEEK, [home(62, [KLAVIYO])]),
      ]);
      expect(r?.reportId).toBe("r1");
    }
  });

  it("MED-5: a newer PARTIAL report with a homepage result beats an older COMPLETED one", () => {
    const r = pick([
      row("partial", new Date(NOW.getTime() - DAY), [home(70, [KLAVIYO])], "PARTIAL"),
      row("r1", LAST_WEEK, [home(60, [KLAVIYO])]),
    ]);
    expect(r).toMatchObject({ reportId: "partial", score: 70, scoreDelta: 10 });
  });

  it("MED-5: a newer report (PARTIAL or COMPLETED) WITHOUT a homepage result is skipped", () => {
    const productOnly = { ...home(80, [RECHARGE]), page: "product" as const };
    const failedHome = { ...home(null), status: "FAILED" as const, metrics: undefined };
    for (const status of ["PARTIAL", "COMPLETED"]) {
      const r = pick([
        row("newer", new Date(NOW.getTime() - DAY), [failedHome, productOnly], status),
        row("r1", LAST_WEEK, [home(62, [KLAVIYO])]),
      ]);
      expect(r).toMatchObject({ reportId: "r1", score: 62 });
    }
  });

  it("no report with results and a homepage => no section", () => {
    expect(pick([])).toBeNull();
    expect(pick([row("r1", LAST_WEEK, [], "PARTIAL")])).toBeNull();
    expect(pick([row("r1", LAST_WEEK, [], "FAILED")])).toBeNull();
  });

  it("stale: older than 8 days => no section (exactly 8 days is still fresh)", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(pick([row("r1", at(SUMMARY_SPEED_MAX_AGE_MS + 1), [home(62)])])).toBeNull();
    expect(pick([row("r1", at(SUMMARY_SPEED_MAX_AGE_MS), [home(62)])])?.reportId).toBe("r1");
  });

  it("already had its chance: a report not newer than the last summary is never sent", () => {
    const rows = [row("r1", LAST_WEEK, [home(62)])];
    expect(pick(rows, new Date(LAST_WEEK.getTime() + 1))).toBeNull();
    expect(pick(rows, LAST_WEEK)).toBeNull();
    expect(pick(rows, new Date(LAST_WEEK.getTime() - 1))?.reportId).toBe("r1");
  });

  it("COMPLETED but no usable homepage score => no section", () => {
    expect(pick([row("r1", LAST_WEEK, [home(null)])])).toBeNull();
    expect(pick([row("r1", LAST_WEEK, [{ ...home(62), page: "product" }])])).toBeNull();
    expect(pick([row("r1", LAST_WEEK, "garbage" as never)])).toBeNull();
  });

  it("no app with measurable processing time: topApp null", () => {
    expect(pick([row("r1", LAST_WEEK, [home(62, [appRow("Zero", 0)])])])?.topApp).toBeNull();
  });
});

describe("isMaterialSpeedChange", () => {
  it("costliest app gone (none now) is a change", () => {
    expect(isMaterialSpeedChange(home(60, []), home(60, [KLAVIYO]))).toBe(true);
  });

  it("no apps either time and the same score is not", () => {
    expect(isMaterialSpeedChange(home(60, []), home(60, []))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loader gates
// ---------------------------------------------------------------------------

describe("loadSummarySpeed", () => {
  const PRO = { id: "shop-1", plan: "Professional" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SPEED_REPORT_LIVE_ENABLED = "true";
    mockModel.getRecentSpeedReports.mockResolvedValue([row("r1", LAST_WEEK, [home(62)])]);
  });

  afterEach(() => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
  });

  it("live + Professional: reads the shop's reports and picks", async () => {
    expect(await loadSummarySpeed(PRO, null, NOW)).toMatchObject({ reportId: "r1" });
    expect(mockModel.getRecentSpeedReports).toHaveBeenCalledWith("shop-1");
  });

  it("flag off: nothing, and no database read", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    expect(await loadSummarySpeed(PRO, null, NOW)).toBeNull();
    expect(mockModel.getRecentSpeedReports).not.toHaveBeenCalled();
  });

  it.each(["Standard", "free"])("plan %s: nothing, and no database read", async (plan) => {
    expect(await loadSummarySpeed({ ...PRO, plan }, null, NOW)).toBeNull();
    expect(mockModel.getRecentSpeedReports).not.toHaveBeenCalled();
  });

  it("passes the last summary time through (a report already covered is skipped)", async () => {
    expect(await loadSummarySpeed(PRO, NOW, NOW)).toBeNull();
  });

  it("a database error means no section, never a throw", async () => {
    mockModel.getRecentSpeedReports.mockRejectedValue(new Error("db down"));
    await expect(loadSummarySpeed(PRO, null, NOW)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("summarySpeedLines", () => {
  const speed = (over: Partial<SummarySpeed> = {}): SummarySpeed => ({
    reportId: "r1",
    testedAt: LAST_WEEK,
    score: 62,
    scoreDelta: 5,
    topApp: KLAVIYO,
    ...over,
  });

  it("score with change, then the costliest app", () => {
    expect(summarySpeedLines(speed())).toEqual([
      "Last speed test (Oct 11, 2026): your homepage scored 62 / 100, up 5 from the test before.",
      "Klaviyo used 4.0 s of processing time and 621 KB on your homepage.",
    ]);
  });

  it("down, no change, and first report wording", () => {
    expect(summarySpeedLines(speed({ scoreDelta: -7 }))[0]).toBe(
      "Last speed test (Oct 11, 2026): your homepage scored 62 / 100, down 7 from the test before.",
    );
    expect(summarySpeedLines(speed({ scoreDelta: 0 }))[0]).toBe(
      "Last speed test (Oct 11, 2026): your homepage scored 62 / 100, no change from the test before.",
    );
    expect(summarySpeedLines(speed({ scoreDelta: null }))[0]).toBe(
      "Last speed test (Oct 11, 2026): your homepage scored 62 / 100.",
    );
  });

  describe("app name hygiene (security LOW-3)", () => {
    const withName = (name: string) =>
      summarySpeedLines(speed({ topApp: { ...KLAVIYO, name } }))[1];
    const nameIn = (line: string) => line.slice(0, line.indexOf(" used 4.0 s"));

    it("truncates the app name to 80 characters", () => {
      const line = withName("A".repeat(200));
      expect(nameIn(line)).toBe("A".repeat(80));
      expect(withName("B".repeat(80))).toBe(
        `${"B".repeat(80)} used 4.0 s of processing time and 621 KB on your homepage.`,
      );
    });

    it("removes CR, LF and other control characters (no injected lines)", () => {
      const line = withName("Evil\r\nBcc: x@example.com\u0000\u0007\t\u007f\u0085App");
      const control = [...line].filter((ch) => {
        const code = ch.charCodeAt(0);
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      });
      expect(control).toEqual([]);
      expect(nameIn(line)).toBe("Evil Bcc: x@example.com App");
    });

    it("control characters around the name leave no stray spaces", () => {
      expect(withName("\r\n Klaviyo \n")).toBe(
        "Klaviyo used 4.0 s of processing time and 621 KB on your homepage.",
      );
    });
  });

  it("no app line when no app added processing time", () => {
    expect(summarySpeedLines(speed({ topApp: null }))).toHaveLength(1);
  });

  it("dates in UTC (a late-evening run does not shift a day)", () => {
    expect(summarySpeedLines(speed({ testedAt: new Date("2026-10-11T23:59:00Z") }))[0]).toContain(
      "(Oct 11, 2026)",
    );
  });

  it("no em or en dash", () => {
    for (const l of [
      ...summarySpeedLines(speed()),
      ...summarySpeedLines(speed({ scoreDelta: -3 })),
    ]) {
      expect(l).not.toMatch(/[—–]/);
    }
  });
});
