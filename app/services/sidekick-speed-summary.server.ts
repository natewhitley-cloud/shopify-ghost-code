/**
 * Sidekick data extension (gc-5nok): the read-only store speed summary behind
 * GET /api/sidekick/speed (extensions/sidekick-tools).
 *
 * Rules this file keeps:
 *   - SAME GATE AS THE STORE SPEED PAGE. The plan-gated read is the page's
 *     own (readSpeedPageReport): Standard (monthly) and Professional (weekly)
 *     see their latest report with results (every tested page, the top apps
 *     by processing time; gc-d0ui); Free sees ONLY its one free homepage test
 *     (score, core timings and the ONE costliest app, as the page shows it);
 *     a plan with neither gets
 *     `not_available_on_plan`, with no plan pitch (App Store rules
 *     2.2.8 / 2.2.9). While SPEED_REPORT_LIVE_ENABLED is off (the page 404s)
 *     the tool says the speed report is not available.
 *   - NUMBERS AS THE PAGE SHOWS THEM: the page's own formatters ("4.2 s",
 *     "621 KB", "62 / 100"). A value the report does not have reads "Not
 *     available" / "Not measured", never 0.
 *   - HONEST EMPTY STATES: no report yet, a run in progress, a password page,
 *     a paused day or a failed run is `no_data` with the page's message and a
 *     `reason`, never zeros.
 *   - Read-only and side-effect free: no nudge telemetry, no run trigger.
 *   - SMALL: at most MAX_SPEED_APPS apps per page, no history, no other
 *     third parties, no first-party totals.
 *   - NO SPEED-TEST SECURITY RISKS YET: the Store speed page's "Security risk"
 *     banners are not in this output. gc-3y89 item 9 is deferred to release 2
 *     slice 6, which owns extensions/sidekick-tools/instructions.md and must
 *     add the "never say the store was hacked" guidance for them first.
 */
import { readSpeedPageReport } from "./speed-page-data.server";
import { isSpeedReportLive } from "./speed-report-config.server";
import {
  FREE_TEST_EXHAUSTED,
  FREE_TEST_NO_APP,
  FREE_TEST_PAUSED_TODAY,
  formatBytes,
  formatSeconds,
  NEEDS_PRODUCT_ACCESS_MESSAGE,
  NO_PRODUCT_MESSAGE,
  nextMonthlySpeedReportAt,
  PASSWORD_PROTECTED_MESSAGE,
  SPEED_CAVEAT,
  SPEED_PAGE_LABELS,
  SPEED_REPORT_STATUS,
  speedFailureMessage,
  topCostlyApps,
} from "../lib/speed-report";
import type {
  FreeSpeedTestResult,
  SpeedPageResult,
  SpeedReportSummaryView,
} from "../lib/speed-report";
import { getShopMetadata } from "../models/shop.server";

/** Apps listed per tested page, costliest first. */
export const MAX_SPEED_APPS = 5;

export const SPEED_URL = "app://app/speed";

export type SpeedNoDataReason =
  | "not_available"
  | "not_run"
  | "running"
  | "password_protected"
  | "paused"
  | "failed"
  | "free_test_not_used"
  | "free_test_unavailable";

export type SidekickSpeedApp = {
  app: string;
  processingTime: string;
  downloadSize: string;
  /** Full report only (Standard / Professional), as the page's table shows it. */
  unusedCode?: string;
};

export type SidekickSpeedPage =
  | {
      page: string;
      path: string | null;
      tested: true;
      speedScore: string;
      timeToShowMainContent: string;
      timeThePageIsFrozen: string;
      pageSize: string;
      filesLoaded: string;
      /** Costliest apps by processing time, at most MAX_SPEED_APPS. */
      costliestApps: SidekickSpeedApp[];
      /** Set when no app is listed. */
      appsNote?: string;
    }
  | { page: string; path: string | null; tested: false; note: string };

export type SidekickSpeedSummary =
  | { status: "not_available_on_plan"; message: string }
  | { status: "no_data"; reason: SpeedNoDataReason; message: string; url?: string }
  | {
      status: "ok";
      reportDate: string;
      /** "speed_report" (the weekly or monthly report, or Run now) or "free_test" (the one free homepage test). */
      reportType: "speed_report" | "free_test";
      pages: SidekickSpeedPage[];
      /** What the result covers on this plan. */
      scope: string;
      /** A newer run with no results yet (running, failed, password page). */
      latestRun: { date: string; reason: SpeedNoDataReason; message: string } | null;
      caveat: string;
      url: string;
    };

export const SPEED_NOT_LIVE_MESSAGE =
  "The GhostCode store speed report is not available right now.";
export const SPEED_NOT_ON_PLAN_MESSAGE =
  "The store speed report is not included in the current plan.";
export const SPEED_NO_RESULT_MESSAGE = "GhostCode has no speed result for this store yet.";
export const SPEED_NO_REPORT_MESSAGE =
  "No speed report has run for this store yet. The first weekly report runs on Sunday.";
/** Monthly cadence (gc-d0ui): the date is the next first-Sunday run, YYYY-MM-DD. */
export function speedNoMonthlyReportMessage(nextRun: Date): string {
  return `No speed report has run for this store yet. The first monthly report runs on ${nextRun.toISOString().slice(0, 10)}.`;
}
export const SPEED_RUNNING_NOW_MESSAGE =
  "A speed test is running now. Results appear in GhostCode in a few minutes.";
export const SPEED_PAUSED_MESSAGE =
  "Speed tests are paused for today. The next report runs on schedule.";
export const FREE_TEST_NOT_RUN_MESSAGE =
  "The free homepage speed test has not been run yet. It can be run once from the Store speed page in GhostCode.";
export const FREE_TEST_RESULT_MISSING_MESSAGE = "The free speed test result is not available.";
export const PRO_SCOPE =
  "The latest speed report with results: each tested page with the apps that cost it the most processing time.";
export const MONTHLY_SCOPE =
  "The latest monthly speed report with results: each tested page with the apps that cost it the most processing time.";
export const FREE_SCOPE =
  "The store's one free homepage speed test: the homepage score, core timings and the one app that cost the most processing time.";

function noData(reason: SpeedNoDataReason, message: string): SidekickSpeedSummary {
  return { status: "no_data", reason, message, url: SPEED_URL };
}

/** The calendar day (YYYY-MM-DD) of an ISO timestamp, for message text. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Why a full report (Standard / Professional) has no results, in the page's words. */
function runWithoutResults(latest: SpeedReportSummaryView): {
  reason: SpeedNoDataReason;
  message: string;
} {
  switch (latest.status) {
    case SPEED_REPORT_STATUS.RUNNING:
      return { reason: "running", message: SPEED_RUNNING_NOW_MESSAGE };
    case SPEED_REPORT_STATUS.UNAVAILABLE_PASSWORD:
      return { reason: "password_protected", message: PASSWORD_PROTECTED_MESSAGE };
    case SPEED_REPORT_STATUS.SKIPPED_BUDGET:
      return { reason: "paused", message: SPEED_PAUSED_MESSAGE };
    default:
      return {
        reason: "failed",
        message: `The speed test on ${day(latest.createdAt)} did not finish. ${speedFailureMessage(latest.failureReason)}`,
      };
  }
}

function pageLabel(page: SpeedPageResult["page"]): string {
  return SPEED_PAGE_LABELS[page];
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** One page of a full report, as SpeedPageSection shows it. */
function proPage(page: SpeedPageResult): SidekickSpeedPage {
  const base = { page: pageLabel(page.page), path: pathOf(page.url) };
  if (page.status !== "OK" || !page.metrics) {
    const note =
      page.status === "NO_PRODUCT"
        ? NO_PRODUCT_MESSAGE
        : page.status === "NEEDS_PRODUCT_ACCESS"
          ? NEEDS_PRODUCT_ACCESS_MESSAGE
          : page.status === "PASSWORD"
            ? PASSWORD_PROTECTED_MESSAGE
            : `This page wasn't tested this time. ${speedFailureMessage(page.failureCode)}`;
    return { ...base, tested: false, note };
  }
  const m = page.metrics;
  const apps = topCostlyApps(page.apps ?? [], MAX_SPEED_APPS).map((a) => ({
    app: a.name,
    processingTime: formatSeconds(a.mainThreadMs),
    downloadSize: formatBytes(a.transferBytes),
    unusedCode: a.unusedPct === null ? "Not measured" : `${a.unusedPct}% unused`,
  }));
  return {
    ...base,
    tested: true,
    speedScore: m.score === null ? "Not available" : `${m.score} / 100`,
    timeToShowMainContent: formatSeconds(m.lcpMs),
    timeThePageIsFrozen: formatSeconds(m.tbtMs),
    pageSize: formatBytes(m.totalBytes),
    filesLoaded: m.requestCount === null ? "Not available" : String(m.requestCount),
    costliestApps: apps,
    ...(apps.length === 0 ? { appsNote: "No known app added measurable load to this page." } : {}),
  };
}

/** The free test's homepage, as FreeTestResult shows it (one app at most). */
function freePage(result: FreeSpeedTestResult): SidekickSpeedPage {
  const m = result.metrics;
  const app = result.costliestApp;
  return {
    page: pageLabel("home"),
    path: null,
    tested: true,
    speedScore: `${m.score} / 100`,
    timeToShowMainContent: formatSeconds(m.lcpMs),
    timeThePageIsFrozen: formatSeconds(m.tbtMs),
    pageSize: formatBytes(m.totalBytes),
    filesLoaded: m.requestCount === null ? "Not available" : String(m.requestCount),
    costliestApps: app
      ? [
          {
            app: app.name,
            processingTime: formatSeconds(app.mainThreadMs),
            downloadSize: formatBytes(app.transferBytes),
          },
        ]
      : [],
    ...(app ? {} : { appsNote: FREE_TEST_NO_APP }),
  };
}

export async function getSidekickSpeedSummary(shopDomain: string): Promise<SidekickSpeedSummary> {
  // While the page 404s (dark flag) there is nothing to link to: no url.
  if (!isSpeedReportLive()) {
    return { status: "no_data", reason: "not_available", message: SPEED_NOT_LIVE_MESSAGE };
  }
  const shop = await getShopMetadata(shopDomain);
  if (!shop) return noData("not_run", SPEED_NO_RESULT_MESSAGE);

  const now = new Date();
  const report = await readSpeedPageReport(shop, now);

  if (report.access === "locked") {
    return { status: "not_available_on_plan", message: SPEED_NOT_ON_PLAN_MESSAGE };
  }

  if (report.access === "free") {
    const { freeTest } = report;
    switch (freeTest.state) {
      case "used":
        // A used stamp without its report should not happen; the page shows nothing.
        if (!freeTest.result) {
          return noData("free_test_unavailable", FREE_TEST_RESULT_MISSING_MESSAGE);
        }
        return {
          status: "ok",
          reportDate: freeTest.result.createdAt,
          reportType: "free_test",
          pages: [freePage(freeTest.result)],
          scope: FREE_SCOPE,
          latestRun: null,
          caveat: SPEED_CAVEAT,
          url: SPEED_URL,
        };
      case "running":
        return noData("running", SPEED_RUNNING_NOW_MESSAGE);
      case "exhausted":
        return noData("free_test_unavailable", FREE_TEST_EXHAUSTED);
      case "available": {
        const attempt = freeTest.lastAttempt;
        if (!attempt) return noData("free_test_not_used", FREE_TEST_NOT_RUN_MESSAGE);
        if (attempt.status === SPEED_REPORT_STATUS.UNAVAILABLE_PASSWORD) {
          return noData("password_protected", PASSWORD_PROTECTED_MESSAGE);
        }
        if (attempt.status === SPEED_REPORT_STATUS.SKIPPED_BUDGET) {
          return noData("paused", FREE_TEST_PAUSED_TODAY);
        }
        return noData(
          "failed",
          `The free speed test on ${day(attempt.createdAt)} did not finish. ${speedFailureMessage(attempt.failureReason)} It was not used up and can be run again from the Store speed page.`,
        );
      }
    }
  }

  const monthly = report.cadence === "monthly";
  const { latest, lastResults } = report.view;
  if (!latest) {
    return noData(
      "not_run",
      monthly
        ? speedNoMonthlyReportMessage(nextMonthlySpeedReportAt(now))
        : SPEED_NO_REPORT_MESSAGE,
    );
  }
  if (!lastResults) {
    const why = runWithoutResults(latest);
    return noData(why.reason, why.message);
  }
  const newer = latest.id !== lastResults.id ? runWithoutResults(latest) : null;
  return {
    status: "ok",
    reportDate: lastResults.createdAt,
    reportType: "speed_report",
    pages: lastResults.pages.map(proPage),
    scope: monthly ? MONTHLY_SCOPE : PRO_SCOPE,
    latestRun: newer ? { date: latest.createdAt, ...newer } : null,
    caveat: SPEED_CAVEAT,
    url: SPEED_URL,
  };
}
