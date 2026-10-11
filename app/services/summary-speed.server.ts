/**
 * Store speed headline in the weekly summary email (gc-2wnf).
 *
 * The Professional summary email carries a short speed section ONLY when:
 *   - the speed feature is live (SPEED_REPORT_LIVE_ENABLED), checked first so
 *     a dark feature reads nothing;
 *   - the shop's plan includes the speed report (Professional);
 *   - a COMPLETED report exists from the last SUMMARY_SPEED_MAX_AGE_MS (8 days);
 *   - that report is newer than the last summary sent, so one report is never
 *     emailed twice (e.g. a week whose speed run failed would otherwise repeat
 *     last week's report, which is still inside the 8-day window);
 *   - and it is the shop's FIRST report with a homepage result, or it changed
 *     materially vs the previous one (isMaterialSpeedChange).
 * A material change is on its own a reason to send (hasSummaryChanges).
 *
 * Timing: the email follows the Sunday 06:40 UTC scan and the speed cron runs
 * at 08:10 UTC, so the email usually carries LAST week's report; the copy
 * says "Last speed test (<date>)" for that reason.
 *
 * Content: the homepage score (and its change), the costliest app by
 * processing time with its download size, and a link to the Store speed page.
 * App names and numbers only; never a URL tested, a file or code.
 */

import { isSpeedReportLive } from "./speed-report-config.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  formatBytes,
  formatSeconds,
  isSpeedReportWithResults,
  readSpeedPages,
  SPEED_REPORT_STATUS,
  type SpeedCostRow,
  type SpeedPageResult,
  speedPageDelta,
  type SpeedReportRowLike,
  topCostlyApps,
} from "../lib/speed-report";
import { getRecentSpeedReports } from "../models/speed-report.server";

/** A report older than this is not emailed. */
export const SUMMARY_SPEED_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

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
  opts: { now: Date; lastSummarySentAt: Date | null },
): SummarySpeed | null {
  const index = rows.findIndex((r) => r.status === SPEED_REPORT_STATUS.COMPLETED);
  if (index === -1) return null;
  const report = rows[index];
  if (opts.now.getTime() - report.createdAt.getTime() > SUMMARY_SPEED_MAX_AGE_MS) return null;
  if (opts.lastSummarySentAt && report.createdAt.getTime() <= opts.lastSummarySentAt.getTime()) {
    return null;
  }
  const home = homeOf(readSpeedPages(report.pages));
  if (!home || home.metrics!.score === null) return null;

  // The baseline: the newest EARLIER report with a homepage result.
  let previous: SpeedPageResult | null = null;
  for (const row of rows.slice(index + 1)) {
    if (!isSpeedReportWithResults(row.status)) continue;
    previous = homeOf(readSpeedPages(row.pages));
    if (previous) break;
  }
  if (previous && !isMaterialSpeedChange(home, previous)) return null;

  return {
    reportId: report.id,
    testedAt: report.createdAt,
    score: home.metrics!.score,
    scoreDelta: previous ? (speedPageDelta(home, previous)?.score ?? null) : null,
    topApp: topCostlyApps(home.apps ?? [], 1)[0] ?? null,
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
  if (!getPlanFeatures(shop.plan).speedReport) return null;
  try {
    const rows = await getRecentSpeedReports(shop.id);
    return pickSummarySpeed(rows, { now, lastSummarySentAt });
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

/**
 * The section's lines:
 *   "Last speed test (Oct 4, 2026): your homepage scored 62 / 100, up 5 from the test before."
 *   "Klaviyo used 4.0 s of processing time and 621 KB on your homepage."
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
    lines.push(
      `${speed.topApp.name} used ${formatSeconds(speed.topApp.mainThreadMs)} of processing time and ${formatBytes(speed.topApp.transferBytes)} on your homepage.`,
    );
  }
  return lines;
}
