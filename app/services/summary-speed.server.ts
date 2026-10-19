/**
 * Store speed headline in the summary email (gc-2wnf; Standard's monthly
 * email too since gc-d0ui).
 *
 * The summary email carries a short speed section ONLY when:
 *   - the speed feature is live (SPEED_REPORT_LIVE_ENABLED), checked first so
 *     a dark feature reads nothing;
 *   - the shop's plan includes the speed report (Standard or Professional);
 *   - the newest report with results (COMPLETED or PARTIAL) and a homepage
 *     result is recent enough for the plan's cadence: 8 days for weekly
 *     (SUMMARY_SPEED_MAX_AGE_MS), 35 days for monthly
 *     (SUMMARY_SPEED_MONTHLY_MAX_AGE_MS);
 *   - that report is newer than the last summary sent, so one report is never
 *     emailed twice (e.g. a week whose speed run failed would otherwise repeat
 *     last week's report, which is still inside the 8-day window);
 *   - and it is the shop's FIRST report with a homepage result, or it changed
 *     materially vs the previous one (isMaterialSpeedChange), or (weekly
 *     cadence only, gc-vgqc) it names an app that is new or costlier
 *     (speedAppRegressions).
 * A material change (a named app included) is on its own a reason to send
 * (hasSummaryChanges).
 *
 * Timing: the email follows the Sunday 06:40 UTC scan and the speed cron runs
 * at 08:10 UTC, so the email usually carries LAST week's report; the copy
 * says "Last speed test (<date>)" for that reason. Standard's email follows
 * the scan on the 1st (07:20 UTC) and its report runs on the first Sunday of
 * the month, so it carries the report from earlier in the previous month
 * (21 to 31 days old, inside the 35-day window).
 *
 * Content: the homepage score (and its change), the costliest app by
 * processing time with its download size, then (Professional's weekly report
 * only, gc-vgqc) up to 3 apps that are new or whose cost jumped, each with its
 * delta, plus the "some apps skip loading" caveat, and a link to the Store
 * speed page. Standard's monthly email keeps the section without naming.
 * App names and numbers only; never a URL tested, a file or code.
 */

import { isSpeedReportLive } from "./speed-report-config.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  costliestAppLine,
  isSpeedReportWithResults,
  readSpeedPages,
  type SpeedCostRow,
  SPEED_CAVEAT,
  speedAppRegressions,
  type SpeedAppRegression,
  type SpeedPageResult,
  speedPageDelta,
  speedRegressionLine,
  type SpeedReportRowLike,
  topCostlyApps,
} from "../lib/speed-report";
import { getRecentSpeedReports } from "../models/speed-report.server";

/** A report older than this is not emailed (weekly cadence). */
export const SUMMARY_SPEED_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Monthly cadence (Standard, gc-d0ui): the email on the 1st carries the report
 * from the previous month's first Sunday, 21 to 31 days earlier; 35 days
 * leaves margin without ever reaching back two months (the next first Sunday
 * is at most 35 days after the last one, and "newer than the last summary"
 * dedupes).
 */
export const SUMMARY_SPEED_MONTHLY_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;

/** A homepage score move of at least this many points is material. */
export const SUMMARY_SPEED_SCORE_MOVE = 5;

/** How many of the costliest apps are compared for "a new app entered the top". */
export const SUMMARY_SPEED_TOP_APPS = 3;

export type SummarySpeed = {
  reportId: string;
  /** When the reported test ran (the report's createdAt). */
  testedAt: Date;
  /** Homepage speed score, 0-100. */
  score: number;
  /** Change vs the previous report's homepage; null = first or not comparable. */
  scoreDelta: number | null;
  /** The costliest app on the homepage by processing time (null = none). */
  topApp: SpeedCostRow | null;
  /**
   * gc-vgqc: homepage apps new or costlier vs the previous comparable report
   * (speedAppRegressions, at most 3). Always empty on the monthly cadence.
   */
  regressions: SpeedAppRegression[];
};

function homeOf(pages: SpeedPageResult[]): SpeedPageResult | null {
  const home = pages.find((p) => p.page === "home");
  return home && home.status === "OK" && home.metrics ? home : null;
}

/**
 * Material change between two homepage results: the score moved by at least
 * SUMMARY_SPEED_SCORE_MOVE points (only when the same URL was tested), the
 * costliest app changed, or an app entered the top SUMMARY_SPEED_TOP_APPS.
 */
export function isMaterialSpeedChange(
  current: SpeedPageResult,
  previous: SpeedPageResult,
): boolean {
  const scoreDelta = speedPageDelta(current, previous)?.score ?? null;
  if (scoreDelta !== null && Math.abs(scoreDelta) >= SUMMARY_SPEED_SCORE_MOVE) return true;

  const top = (p: SpeedPageResult) =>
    topCostlyApps(p.apps ?? [], SUMMARY_SPEED_TOP_APPS).map((a) => a.name);
  const now = top(current);
  const before = top(previous);
  if ((now[0] ?? null) !== (before[0] ?? null)) return true;
  return now.some((name) => !before.includes(name));
}

/**
 * The speed section to email, or null. `rows` are the shop's recent reports,
 * newest first (getRecentSpeedReports). `lastSummarySentAt` is when the last
 * summary went out (null = never). Pure.
 */
export function pickSummarySpeed(
  rows: readonly SpeedReportRowLike[],
  opts: {
    now: Date;
    lastSummarySentAt: Date | null;
    maxAgeMs?: number;
    /** Name new / costlier apps (weekly cadence only, gc-vgqc). Default false. */
    nameRegressions?: boolean;
  },
): SummarySpeed | null {
  // The newest report with results (COMPLETED or PARTIAL) AND a homepage
  // result (audit MED-5: a newer PARTIAL one is not skipped for an older
  // COMPLETED one).
  let index = -1;
  let home: SpeedPageResult | null = null;
  for (const [i, row] of rows.entries()) {
    if (!isSpeedReportWithResults(row.status)) continue;
    home = homeOf(readSpeedPages(row.pages));
    if (home) {
      index = i;
      break;
    }
  }
  if (index === -1 || !home) return null;
  const report = rows[index];
  const maxAgeMs = opts.maxAgeMs ?? SUMMARY_SPEED_MAX_AGE_MS;
  if (opts.now.getTime() - report.createdAt.getTime() > maxAgeMs) return null;
  if (opts.lastSummarySentAt && report.createdAt.getTime() <= opts.lastSummarySentAt.getTime()) {
    return null;
  }
  if (home.metrics!.score === null) return null;

  // The baseline: the newest EARLIER report with a homepage result.
  let previous: SpeedPageResult | null = null;
  for (const row of rows.slice(index + 1)) {
    if (!isSpeedReportWithResults(row.status)) continue;
    previous = homeOf(readSpeedPages(row.pages));
    if (previous) break;
  }
  const regressions = opts.nameRegressions ? speedAppRegressions(home, previous) : [];
  if (previous && regressions.length === 0 && !isMaterialSpeedChange(home, previous)) return null;

  return {
    reportId: report.id,
    testedAt: report.createdAt,
    score: home.metrics!.score,
    scoreDelta: previous ? (speedPageDelta(home, previous)?.score ?? null) : null,
    topApp: topCostlyApps(home.apps ?? [], 1)[0] ?? null,
    regressions,
  };
}

/**
 * Load the speed section for a summary. Flag first (a dark feature reads
 * nothing), then the plan, then the reports. NEVER THROWS: any error means
 * no speed section, never a failed summary.
 */
export async function loadSummarySpeed(
  shop: { id: string; plan: string },
  lastSummarySentAt: Date | null,
  now: Date = new Date(),
): Promise<SummarySpeed | null> {
  if (!isSpeedReportLive()) return null;
  const features = getPlanFeatures(shop.plan);
  if (!features.speedReport || features.speedReportCadence === "none") return null;
  const maxAgeMs =
    features.speedReportCadence === "monthly"
      ? SUMMARY_SPEED_MONTHLY_MAX_AGE_MS
      : SUMMARY_SPEED_MAX_AGE_MS;
  try {
    const rows = await getRecentSpeedReports(shop.id);
    return pickSummarySpeed(rows, {
      now,
      lastSummarySentAt,
      maxAgeMs,
      // Naming is Professional's weekly report only (gc-vgqc); Standard's
      // monthly section stays as it was (gc-d0ui).
      nameRegressions: features.speedReportCadence === "weekly",
    });
  } catch (error) {
    logger.warn("summary speed section unavailable", {
      context: "summary-speed",
      shopId: shop.id,
      ...safeErrorFields(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Copy (plain strings; the HTML builder escapes them)
// ---------------------------------------------------------------------------

/** Label of the Store speed link (text: "{label}:" then the URL; HTML: the link text). */
export const SPEED_LINK_LABEL = "See your store speed in GhostCode";

/** "Oct 4, 2026" (UTC, the day the test ran). */
function formatTestDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Longest app name the email shows (security LOW-3). */
export const SUMMARY_SPEED_APP_NAME_MAX = 80;

/**
 * An app name as the email shows it (security LOW-3): every run of control
 * characters (C0 incl. CR/LF/tab, DEL, C1) becomes one space, so a name can
 * never start a new line in either part, then it is trimmed and cut to
 * SUMMARY_SPEED_APP_NAME_MAX characters.
 */
function emailAppName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return clean.slice(0, SUMMARY_SPEED_APP_NAME_MAX).trimEnd();
}

/**
 * The section's lines:
 *   "Last speed test (Oct 4, 2026): your homepage scored 62 / 100, up 5 from the test before."
 *   "Klaviyo used 4.0 s of processing time and 621 KB on your homepage."
 *   then one line per named app (gc-vgqc), e.g.
 *   "Judge.me's processing time on your homepage rose from 0.4 s to 0.9 s.",
 *   and after them the "some apps skip loading" caveat (SPEED_CAVEAT).
 * The change clause is left out for a first report (or a non-comparable one);
 * the app line is left out when no app added measurable processing time.
 */
export function summarySpeedLines(speed: SummarySpeed): string[] {
  let change = "";
  if (speed.scoreDelta !== null) {
    change =
      speed.scoreDelta === 0
        ? ", no change from the test before"
        : `, ${speed.scoreDelta > 0 ? "up" : "down"} ${Math.abs(speed.scoreDelta)} from the test before`;
  }
  const lines = [
    `Last speed test (${formatTestDate(speed.testedAt)}): your homepage scored ${speed.score} / 100${change}.`,
  ];
  if (speed.topApp) {
    lines.push(costliestAppLine({ ...speed.topApp, name: emailAppName(speed.topApp.name) }));
  }
  if (speed.regressions.length > 0) {
    for (const r of speed.regressions) lines.push(speedRegressionLine(r, emailAppName(r.name)));
    lines.push(SPEED_CAVEAT);
  }
  return lines;
}
