/**
 * Store speed report (gc-wt3y): shared, client-safe types, status values,
 * merchant copy and pure helpers. Used by the worker (to build and store a
 * report), the Store speed route loader/component and the tests.
 *
 * Client-safe: no `.server` imports and no Prisma enum VALUES (SpeedReport
 * stores origin/status as plain strings for exactly this reason).
 */

// ---------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------

export const SPEED_REPORT_ORIGIN = {
  SCHEDULED: "SCHEDULED",
  MANUAL: "MANUAL",
  /**
   * The one free homepage-only test of a plan without the full report
   * (PlanFeatures.freeSpeedTest). Never tests the product page.
   */
  FREE_TEST: "FREE_TEST",
} as const;
export type SpeedReportOrigin = (typeof SPEED_REPORT_ORIGIN)[keyof typeof SPEED_REPORT_ORIGIN];

const ORIGINS: ReadonlySet<unknown> = new Set(Object.values(SPEED_REPORT_ORIGIN));

/** Whether a value (e.g. from an Inngest event) is a known origin. */
export function isSpeedReportOrigin(value: unknown): value is SpeedReportOrigin {
  return ORIGINS.has(value);
}

export const SPEED_REPORT_STATUS = {
  RUNNING: "RUNNING",
  /** Every testable page produced a result. */
  COMPLETED: "COMPLETED",
  /** At least one page produced a result and at least one failed. */
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  /** The storefront is password protected, so nothing could be tested. */
  UNAVAILABLE_PASSWORD: "UNAVAILABLE_PASSWORD",
  /** The global daily PageSpeed budget ran out before any result. */
  SKIPPED_BUDGET: "SKIPPED_BUDGET",
} as const;
export type SpeedReportStatus = (typeof SPEED_REPORT_STATUS)[keyof typeof SPEED_REPORT_STATUS];

/** Statuses that carry results worth showing (and comparing week over week). */
export function isSpeedReportWithResults(status: string): boolean {
  return status === SPEED_REPORT_STATUS.COMPLETED || status === SPEED_REPORT_STATUS.PARTIAL;
}

export type SpeedPageKey = "home" | "product";

export const SPEED_PAGE_LABELS: Record<SpeedPageKey, string> = {
  home: "Homepage",
  product: "Product page",
};

/**
 * Short machine codes for why a run or page has no result. Never free text
 * from Google; speedFailureMessage maps each to merchant copy.
 */
export type SpeedFailureCode =
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "server_error"
  | "document_failed"
  | "network"
  | "bad_response"
  | "not_configured"
  | "budget"
  | "no_domain"
  /** The Admin API (offline token, throttling, outage) could not be read. */
  | "admin_unavailable"
  | "not_eligible"
  | "dispatch_failed"
  | "stuck"
  /** The worker died (retries exhausted); closed by its failure handler. */
  | "worker_failed";

export type SpeedPageStatus =
  | "OK"
  | "FAILED"
  | "PASSWORD"
  /** The run stopped before this page was tested (budget, password, 429). */
  | "NOT_RUN"
  /** The store has no product published to the online store. */
  | "NO_PRODUCT"
  /**
   * The optional read_products scope is not granted AND the public
   * /products.json fallback (gc-9mbw) found no usable product.
   */
  | "NEEDS_PRODUCT_ACCESS";

export type SpeedMetrics = {
  /** Lighthouse performance score, 0-100. */
  score: number | null;
  lcpMs: number | null;
  tbtMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  totalBytes: number | null;
  requestCount: number | null;
};

/** One app's (or one unmatched host's) cost on a page. */
export type SpeedCostRow = {
  name: string;
  /** Main-thread (processing) time, ms. */
  mainThreadMs: number;
  transferBytes: number;
  /** Share of its JavaScript that went unused, 0-100; null = not reported. */
  unusedPct: number | null;
  requestCount: number;
};

export type SpeedPageResult = {
  page: SpeedPageKey;
  status: SpeedPageStatus;
  /** The public storefront URL tested (null when none could be chosen). */
  url: string | null;
  failureCode?: SpeedFailureCode;
  runsAttempted: number;
  runsOk: number;
  metrics?: SpeedMetrics;
  apps?: SpeedCostRow[];
  otherThirdParty?: SpeedCostRow[];
  firstParty?: { mainThreadMs: number; transferBytes: number };
  /**
   * Known-malicious list domains the test's browser requested on this page
   * (gc-0htk), from any OK run. Absent = not checked (the runtime check was
   * off); [] = checked, none.
   */
  maliciousDomains?: string[];
};

// ---------------------------------------------------------------------------
// Run cadence and limits
// ---------------------------------------------------------------------------

/** PageSpeed runs per page; the MEDIAN run (by score) is reported. */
export const SPEED_RUNS_PER_PAGE = 3;

/** "Run speed test now" is available once per this window per shop. */
export const RUN_NOW_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * A RUNNING report whose worker STARTED (startedAt) longer ago than this is
 * shown (and treated) as failed: the worker's finish timeout (55 m) is
 * shorter, so a started row this old was abandoned.
 */
export const SPEED_REPORT_STUCK_MS = 60 * 60 * 1000;

/**
 * A RUNNING report the worker never started, created longer ago than this,
 * is shown (and treated) as failed. Generous on purpose: a manual click can
 * wait behind the Sunday batch (concurrency 1). Longer than the worker's
 * 6 h start timeout, whose cancel handler closes the row first; this is the
 * fallback if that handler never ran.
 */
export const SPEED_REPORT_QUEUED_STUCK_MS = 7 * 60 * 60 * 1000;

/**
 * The speed cron's time of day, UTC (Sunday 08:10, inngest/functions/
 * speed-report.ts SPEED_REPORT_CRON). Professional is tested every Sunday;
 * Standard on the FIRST Sunday of each month (gc-d0ui), from the same cron.
 */
export const SPEED_REPORT_CRON_UTC = { hour: 8, minute: 10 } as const;

/**
 * Whether `date` (a cron firing) is the monthly speed day: a Sunday that is one
 * of the first 7 days of its month, UTC (gc-d0ui).
 */
export function isMonthlySpeedReportDay(date: Date): boolean {
  return date.getUTCDay() === 0 && date.getUTCDate() <= 7;
}

/** The first Sunday of the month containing `year`/`month`, at the cron time (UTC). */
function firstSundayRun(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const day = 1 + ((7 - first.getUTCDay()) % 7);
  return new Date(
    Date.UTC(year, month, day, SPEED_REPORT_CRON_UTC.hour, SPEED_REPORT_CRON_UTC.minute),
  );
}

/**
 * When the next monthly speed test runs (gc-d0ui): the first Sunday of this
 * month at 08:10 UTC if that is still ahead of `now`, else the first Sunday of
 * next month.
 */
export function nextMonthlySpeedReportAt(now: Date): Date {
  const thisMonth = firstSundayRun(now.getUTCFullYear(), now.getUTCMonth());
  if (thisMonth.getTime() > now.getTime()) return thisMonth;
  return firstSundayRun(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** When the shop may next press "Run speed test now" (null = now). */
export function runNowAvailableAt(lastRequestedAt: Date | null, now: Date): Date | null {
  if (!lastRequestedAt) return null;
  const next = new Date(lastRequestedAt.getTime() + RUN_NOW_COOLDOWN_MS);
  return next.getTime() <= now.getTime() ? null : next;
}

/**
 * The status to show and act on: an abandoned RUNNING row reads as FAILED.
 * The clock starts when the worker started the run (`startedAt`), not at the
 * click; a run still queued (`startedAt` null/absent) gets the longer
 * SPEED_REPORT_QUEUED_STUCK_MS from `createdAt`.
 */
export function effectiveSpeedReportStatus(
  report: { status: string; createdAt: Date; startedAt?: Date | null },
  now: Date,
): { status: string; failureReason: SpeedFailureCode | null } {
  if (report.status !== SPEED_REPORT_STATUS.RUNNING) {
    return { status: report.status, failureReason: null };
  }
  const abandoned = report.startedAt
    ? now.getTime() - report.startedAt.getTime() > SPEED_REPORT_STUCK_MS
    : now.getTime() - report.createdAt.getTime() > SPEED_REPORT_QUEUED_STUCK_MS;
  return abandoned
    ? { status: SPEED_REPORT_STATUS.FAILED, failureReason: "stuck" }
    : { status: report.status, failureReason: null };
}

// ---------------------------------------------------------------------------
// Report status from page results (pure; used by the worker)
// ---------------------------------------------------------------------------

/**
 * Roll page results into the report status:
 *   - any page PASSWORD                     -> UNAVAILABLE_PASSWORD
 *   - no OK page and the budget ran out     -> SKIPPED_BUDGET
 *   - no OK page                            -> FAILED
 *   - an OK page and a FAILED / NOT_RUN one -> PARTIAL
 *   - otherwise                             -> COMPLETED
 * NO_PRODUCT / NEEDS_PRODUCT_ACCESS are "nothing to test", not failures.
 */
export function computeSpeedReportStatus(
  pages: SpeedPageResult[],
  opts: { budgetExhausted: boolean },
): SpeedReportStatus {
  if (pages.some((p) => p.status === "PASSWORD")) return SPEED_REPORT_STATUS.UNAVAILABLE_PASSWORD;
  const ok = pages.filter((p) => p.status === "OK").length;
  if (ok === 0) {
    return opts.budgetExhausted ? SPEED_REPORT_STATUS.SKIPPED_BUDGET : SPEED_REPORT_STATUS.FAILED;
  }
  const incomplete = pages.some((p) => p.status === "FAILED" || p.status === "NOT_RUN");
  return incomplete ? SPEED_REPORT_STATUS.PARTIAL : SPEED_REPORT_STATUS.COMPLETED;
}

// ---------------------------------------------------------------------------
// Reading stored pages (defensive: the column is Json)
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function numOrNull(v: unknown): number | null {
  return isNum(v) ? v : null;
}

function readCostRows(v: unknown): SpeedCostRow[] {
  if (!Array.isArray(v)) return [];
  const rows: SpeedCostRow[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    rows.push({
      name: o.name,
      mainThreadMs: isNum(o.mainThreadMs) ? o.mainThreadMs : 0,
      transferBytes: isNum(o.transferBytes) ? o.transferBytes : 0,
      unusedPct: numOrNull(o.unusedPct),
      requestCount: isNum(o.requestCount) ? o.requestCount : 0,
    });
  }
  return rows;
}

const PAGE_STATUSES: ReadonlySet<string> = new Set([
  "OK",
  "FAILED",
  "PASSWORD",
  "NOT_RUN",
  "NO_PRODUCT",
  "NEEDS_PRODUCT_ACCESS",
]);

/** A stored list domain: a bare lower-case hostname (gc-0htk). */
function isStoredDomain(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(v);
}

/** Parse a SpeedReport.pages Json value; malformed entries are dropped. */
export function readSpeedPages(value: unknown): SpeedPageResult[] {
  if (!Array.isArray(value)) return [];
  const pages: SpeedPageResult[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.page !== "home" && o.page !== "product") continue;
    if (typeof o.status !== "string" || !PAGE_STATUSES.has(o.status)) continue;
    const m = o.metrics as Record<string, unknown> | undefined;
    const fp = o.firstParty as Record<string, unknown> | undefined;
    pages.push({
      page: o.page,
      status: o.status as SpeedPageStatus,
      url: typeof o.url === "string" ? o.url : null,
      ...(typeof o.failureCode === "string"
        ? { failureCode: o.failureCode as SpeedFailureCode }
        : {}),
      runsAttempted: isNum(o.runsAttempted) ? o.runsAttempted : 0,
      runsOk: isNum(o.runsOk) ? o.runsOk : 0,
      ...(m && typeof m === "object"
        ? {
            metrics: {
              score: numOrNull(m.score),
              lcpMs: numOrNull(m.lcpMs),
              tbtMs: numOrNull(m.tbtMs),
              cls: numOrNull(m.cls),
              fcpMs: numOrNull(m.fcpMs),
              speedIndexMs: numOrNull(m.speedIndexMs),
              totalBytes: numOrNull(m.totalBytes),
              requestCount: numOrNull(m.requestCount),
            },
          }
        : {}),
      apps: readCostRows(o.apps),
      otherThirdParty: readCostRows(o.otherThirdParty),
      ...(fp && typeof fp === "object"
        ? {
            firstParty: {
              mainThreadMs: isNum(fp.mainThreadMs) ? fp.mainThreadMs : 0,
              transferBytes: isNum(fp.transferBytes) ? fp.transferBytes : 0,
            },
          }
        : {}),
      ...(Array.isArray(o.maliciousDomains)
        ? { maliciousDomains: o.maliciousDomains.filter(isStoredDomain) }
        : {}),
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Week-over-week change
// ---------------------------------------------------------------------------

export type SpeedMetricDelta = {
  score: number | null;
  lcpMs: number | null;
  tbtMs: number | null;
  totalBytes: number | null;
};

/**
 * Change in the headline metrics vs the previous report's same page (current
 * minus previous). Null when either side has no result for that page, or the
 * page tested a different URL (a different product is not comparable).
 */
export function speedPageDelta(
  current: SpeedPageResult,
  previous: SpeedPageResult | undefined,
): SpeedMetricDelta | null {
  if (!previous || current.status !== "OK" || previous.status !== "OK") return null;
  if (current.url !== previous.url) return null;
  const a = current.metrics;
  const b = previous.metrics;
  if (!a || !b) return null;
  const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);
  return {
    score: diff(a.score, b.score),
    lcpMs: diff(a.lcpMs, b.lcpMs),
    tbtMs: diff(a.tbtMs, b.tbtMs),
    totalBytes: diff(a.totalBytes, b.totalBytes),
  };
}

// ---------------------------------------------------------------------------
// Formatting + merchant copy (no em dashes, plain labels)
// ---------------------------------------------------------------------------

export const SPEED_METRIC_LABELS = {
  score: "Speed score",
  lcp: "Time to show the main content",
  tbt: "Time the page is frozen",
  weight: "Page size",
  requests: "Files loaded",
} as const;

export const SPEED_CAVEAT =
  "Some apps skip loading during speed tests, so their real cost can be higher.";

export const SPEED_INTRO =
  "How fast your store loads on a phone, and which apps slow it down. Tested every week with Google PageSpeed Insights.";
/** Standard's intro (gc-d0ui): the same report, tested once a month. */
export const SPEED_INTRO_MONTHLY =
  "How fast your store loads on a phone, and which apps slow it down. Tested once a month with Google PageSpeed Insights.";
/** Plan bullets (max 40 chars, the Managed Pricing card limit; gc-d0ui). */
export const MONTHLY_SPEED_REPORT_BULLET = "Monthly store speed report, cost per app";
export const WEEKLY_SPEED_REPORT_BULLET = "Weekly store speed report, cost per app";

export const SPEED_TEASER_HEADING = "See which apps slow your store";
export const SPEED_TEASER_BODY =
  "Professional includes a weekly speed report for your homepage and a product page, with the cost of each app: how long it keeps the page busy and how much it adds to the download.";

/** "4.2 s" (one decimal below 10 s, whole seconds above). */
export function formatSeconds(ms: number | null): string {
  if (ms === null) return "Not available";
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** "621 KB" / "1.2 MB" (decimal units, as Lighthouse reports). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Not available";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1000))} KB`;
}

/** Up to this many apps are named in the headline sentence. */
export const HEADLINE_MAX_APPS = 3;

/**
 * The `n` costliest apps by main-thread (processing) time, most first; only
 * apps with any. Shared by the page headline and the summary email (gc-2wnf).
 */
export function topCostlyApps(apps: readonly SpeedCostRow[], n: number): SpeedCostRow[] {
  return apps
    .filter((a) => a.mainThreadMs > 0)
    .sort((a, b) => b.mainThreadMs - a.mainThreadMs)
    .slice(0, n);
}

/**
 * "Klaviyo used 4.0 s of processing time and 621 KB on your homepage." The
 * costliest app's line, shared by the summary email (gc-2wnf, which passes a
 * sanitized name) and the free speed test result.
 */
export function costliestAppLine(app: {
  name: string;
  mainThreadMs: number;
  transferBytes: number;
}): string {
  return `${app.name} used ${formatSeconds(app.mainThreadMs)} of processing time and ${formatBytes(app.transferBytes)} on your homepage.`;
}

/**
 * "These 3 apps cost your homepage 4.2 s of processing time." over the top
 * apps by main-thread time (only apps with any). Null when no app has any.
 */
export function appCostHeadline(apps: SpeedCostRow[], page: SpeedPageKey): string | null {
  const top = topCostlyApps(apps, HEADLINE_MAX_APPS);
  if (top.length === 0) return null;
  const total = top.reduce((sum, a) => sum + a.mainThreadMs, 0);
  const pageName = page === "home" ? "homepage" : "product page";
  const subject = top.length === 1 ? "This app costs" : `These ${top.length} apps cost`;
  return `${subject} your ${pageName} ${formatSeconds(total)} of processing time.`;
}

/** Merchant-safe sentence for a failure code (never Google's raw text). */
export function speedFailureMessage(code: SpeedFailureCode | null | undefined): string {
  switch (code) {
    case "timeout":
      return "The speed test took too long to finish.";
    case "rate_limited":
      return "Google's speed test was busy.";
    case "document_failed":
      return "Google couldn't load this page of your store.";
    case "budget":
      return "Speed tests are paused for today.";
    case "not_configured":
      return "Speed tests aren't available right now.";
    case "no_domain":
      return "We couldn't find your store's web address.";
    case "admin_unavailable":
      return "We couldn't reach your store's settings.";
    case "stuck":
      return "The speed test didn't finish.";
    default:
      return "The speed test didn't finish.";
  }
}

export const PASSWORD_PROTECTED_MESSAGE =
  "Your storefront is password protected, so it can't be tested. Remove the password in Online Store > Preferences, then run the test again.";

export const NO_PRODUCT_MESSAGE =
  "No product is published to your online store, so only the homepage was tested.";

export const NEEDS_PRODUCT_ACCESS_MESSAGE =
  "To test a product page too, allow Products access in Settings.";

export const SPEED_RUNNING_MESSAGE =
  "Speed test running. It takes a few minutes; results appear here when it finishes.";
export const SPEED_RUNNING_TIMED_OUT_MESSAGE =
  "Still running. Refresh the page in a few minutes to see the results.";

// Free speed test copy (plans without the full report).
export const FREE_TEST_INTRO =
  "See how fast your homepage loads on a phone, and which app slows it down the most. Your plan includes one free test with Google PageSpeed Insights.";
export const FREE_TEST_BUTTON = "Run your free speed test";
/** The Free plan-tile bullet (max 40 chars, Managed Pricing card limit; gc-d0ui wording). */
export const FREE_SPEED_TEST_BULLET = "One-time homepage speed test";
export const FREE_TEST_NOT_USED = "Your free test wasn't used, so you can run it again.";
/**
 * How many free-test attempts a shop gets in total. Only an attempt that
 * actually REACHED GOOGLE counts (a FREE_TEST report with at least one
 * PageSpeed call that was not stopped by the daily ceiling): a timeout, a
 * page Google could not load, or a run whose worker died or got stuck after
 * it had called Google (calls are counted as they happen, gc-au2l). A run
 * that never called Google never burns an attempt: a dispatch failure, a
 * worker that died or got stuck before its first call, a missing key, the
 * daily ceiling, and a password page (found by our own pre-check, before any
 * call) all leave the count alone. Without the cap a store Google cannot test
 * could spend PageSpeed calls every day forever. The attempt that reaches the
 * cap still uses the test up if it COMPLETES.
 */
export const FREE_SPEED_TEST_MAX_ATTEMPTS = 5;
/**
 * Free tests stop for the day once the SHARED daily PageSpeed call counter
 * reaches this, so they can never use up the budget paying shops' reports need
 * (PAGESPEED_DAILY_CALL_BUDGET, default 5000: paid keeps the rest). A budget
 * set below the default lowers this in proportion
 * (freeSpeedTestDailyCallCeiling).
 */
export const FREE_SPEED_TEST_DAILY_CALL_CEILING = 600;
/** Shown when a free test was stopped by the daily ceiling. */
export const FREE_TEST_PAUSED_TODAY =
  "Free speed tests are paused for today. Your free test wasn't used and this try doesn't count. You can run it again tomorrow.";
/** The support address shown when the free test cannot be run any more. */
export const FREE_TEST_SUPPORT_EMAIL = "support@alpenglowsoftware.com";
export const FREE_TEST_EXHAUSTED = `The free speed test couldn't complete for this store after ${FREE_SPEED_TEST_MAX_ATTEMPTS} tries, so it can't be run again. Each time, the test timed out or couldn't load your homepage.`;
/** Follows FREE_TEST_EXHAUSTED on the page, before the support address. */
export const FREE_TEST_EXHAUSTED_SUPPORT =
  "If your store is open to visitors and you think this is wrong, email us at";
export const FREE_TEST_RESULT_HEADING = "Your free speed test";
export const FREE_TEST_NO_APP = "No known app added measurable load to your homepage.";
export const FREE_TEST_UPGRADE_HEADING = "Test every week and see the cost of every app";
export const FREE_TEST_UPGRADE_BODY =
  "Professional includes a weekly speed report for your homepage and a product page, with the cost of every app: how long it keeps the page busy and how much it adds to the download.";

// ---------------------------------------------------------------------------
// Page view model (pure; built in the Store speed loader)
// ---------------------------------------------------------------------------

export type SpeedReportRowLike = {
  id: string;
  origin: string;
  status: string;
  failureReason: string | null;
  pages: unknown;
  createdAt: Date;
  /** When the worker started the run; null/absent = still queued. */
  startedAt?: Date | null;
  completedAt: Date | null;
};

export type SpeedReportSummaryView = {
  id: string;
  origin: string;
  status: string;
  failureReason: SpeedFailureCode | null;
  createdAt: string;
  pages: SpeedPageResult[];
};

export type SpeedReportView = {
  /** The newest report of any status (drives the status banner). */
  latest: SpeedReportSummaryView | null;
  /** The newest report WITH results (may be `latest`); drives the numbers. */
  lastResults: SpeedReportSummaryView | null;
  /** The report with results before `lastResults`: the week-over-week baseline. */
  previousResults: SpeedReportSummaryView | null;
};

function toSummaryView(row: SpeedReportRowLike, now: Date): SpeedReportSummaryView {
  const effective = effectiveSpeedReportStatus(row, now);
  return {
    id: row.id,
    origin: row.origin,
    status: effective.status,
    failureReason: effective.failureReason ?? (row.failureReason as SpeedFailureCode | null),
    createdAt: row.createdAt.toISOString(),
    pages: readSpeedPages(row.pages),
  };
}

/** Pick latest / last-with-results / baseline from rows sorted newest first. */
export function buildSpeedReportView(rows: SpeedReportRowLike[], now: Date): SpeedReportView {
  const views = rows.map((r) => toSummaryView(r, now));
  const withResults = views.filter((v) => isSpeedReportWithResults(v.status));
  return {
    latest: views[0] ?? null,
    lastResults: withResults[0] ?? null,
    previousResults: withResults[1] ?? null,
  };
}

/** Lighthouse's score bands: 90+ good, 50-89 needs work, under 50 poor. */
export function speedScoreTone(score: number | null): "success" | "warning" | "critical" | null {
  if (score === null) return null;
  if (score >= 90) return "success";
  if (score >= 50) return "warning";
  return "critical";
}

/**
 * One week-over-week change line, e.g. "Up 5 from last week",
 * "0.8 s faster than last week", "120 KB smaller than last week".
 * Null when there is no baseline for this metric.
 */
export function formatSpeedDelta(
  kind: "score" | "time" | "bytes",
  delta: number | null,
): string | null {
  if (delta === null) return null;
  if (kind === "score") {
    if (delta === 0) return "No change from last week";
    return `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} from last week`;
  }
  if (kind === "time") {
    if (Math.abs(delta) < 100) return "About the same as last week";
    return `${formatSeconds(Math.abs(delta))} ${delta < 0 ? "faster" : "slower"} than last week`;
  }
  if (Math.abs(delta) < 1000) return "About the same as last week";
  return `${formatBytes(Math.abs(delta))} ${delta < 0 ? "smaller" : "larger"} than last week`;
}

// ---------------------------------------------------------------------------
// Per-app speed regressions (gc-vgqc; Professional's weekly report)
// ---------------------------------------------------------------------------

/** An app's download size must rise by at least this many bytes (100 KB) to be named. */
export const SPEED_REGRESSION_MIN_BYTES = 100_000;
/** An app's processing time must rise by at least this many ms to be named. */
export const SPEED_REGRESSION_MIN_MS = 200;
/** ...AND by at least this share of its previous value (25%). */
export const SPEED_REGRESSION_MIN_RATIO = 0.25;
/** At most this many apps are named (email and Speed page alike). */
export const SPEED_REGRESSION_MAX_APPS = 3;

/**
 * One app named as new or costlier vs the previous comparable report.
 * `previous` is null for a new app. `timeUp` / `sizeUp`: which cost passed its
 * floor (for a new app, measured from zero).
 */
export type SpeedAppRegression = {
  name: string;
  kind: "new" | "up";
  current: { mainThreadMs: number; transferBytes: number };
  previous: { mainThreadMs: number; transferBytes: number } | null;
  timeUp: boolean;
  sizeUp: boolean;
};

/** A rise past its absolute floor AND at least SPEED_REGRESSION_MIN_RATIO of the old value. */
function rosePast(before: number, after: number, floor: number): boolean {
  const rise = after - before;
  return rise >= floor && rise >= before * SPEED_REGRESSION_MIN_RATIO;
}

/**
 * The apps to name for one page (gc-vgqc): an app NEW in the current per-app
 * list (absent from the previous one) whose cost passes a floor, or an app
 * whose download size rose by >= SPEED_REGRESSION_MIN_BYTES or processing time
 * by >= SPEED_REGRESSION_MIN_MS, that rise also >= 25% of its previous value.
 *
 * Noise guards: both pages must be OK with metrics and have tested the SAME
 * URL; otherwise nothing is named (so an app is never "new" because the
 * previous page failed or tested a different product). Only matched apps
 * (`apps`), never unmatched third-party hosts.
 *
 * Order: biggest processing-time rise first, then biggest download-size rise,
 * then name; capped at SPEED_REGRESSION_MAX_APPS. Pure; shared by the summary
 * email and the Store speed page.
 */
export function speedAppRegressions(
  current: SpeedPageResult,
  previous: SpeedPageResult | undefined | null,
): SpeedAppRegression[] {
  if (!previous || current.status !== "OK" || previous.status !== "OK") return [];
  if (!current.metrics || !previous.metrics) return [];
  if (!current.url || current.url !== previous.url) return [];

  const before = new Map((previous.apps ?? []).map((a) => [a.name, a]));
  const found: SpeedAppRegression[] = [];
  for (const app of current.apps ?? []) {
    const old = before.get(app.name);
    const prev = old ? { mainThreadMs: old.mainThreadMs, transferBytes: old.transferBytes } : null;
    const timeUp = rosePast(prev?.mainThreadMs ?? 0, app.mainThreadMs, SPEED_REGRESSION_MIN_MS);
    const sizeUp = rosePast(
      prev?.transferBytes ?? 0,
      app.transferBytes,
      SPEED_REGRESSION_MIN_BYTES,
    );
    if (!timeUp && !sizeUp) continue;
    found.push({
      name: app.name,
      kind: prev ? "up" : "new",
      current: { mainThreadMs: app.mainThreadMs, transferBytes: app.transferBytes },
      previous: prev,
      timeUp,
      sizeUp,
    });
  }
  const rise = (r: SpeedAppRegression, key: "mainThreadMs" | "transferBytes") =>
    r.current[key] - (r.previous?.[key] ?? 0);
  return found
    .sort(
      (a, b) =>
        rise(b, "mainThreadMs") - rise(a, "mainThreadMs") ||
        rise(b, "transferBytes") - rise(a, "transferBytes") ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .slice(0, SPEED_REGRESSION_MAX_APPS);
}

/**
 * The Store speed page badges for one named app: ["New"], or "Up 0.5 s" /
 * "Up 120 KB" for each cost that passed its floor.
 */
export function speedRegressionBadges(r: SpeedAppRegression): string[] {
  if (r.kind === "new") return ["New"];
  const badges: string[] = [];
  const prev = r.previous!;
  if (r.timeUp) badges.push(`Up ${formatSeconds(r.current.mainThreadMs - prev.mainThreadMs)}`);
  if (r.sizeUp) badges.push(`Up ${formatBytes(r.current.transferBytes - prev.transferBytes)}`);
  return badges;
}

/** "Judge.me's" / "Yotpo Reviews'" (no "s's"). */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/**
 * The summary email sentence for one named homepage app (gc-vgqc), e.g.
 *   "Klaviyo is new since the test before and adds 140 KB and 0.3 s of processing time on your homepage."
 *   "Judge.me's processing time on your homepage rose from 0.4 s to 0.9 s."
 *   "Judge.me's download size on your homepage rose from 120 KB to 340 KB."
 *   "Judge.me's processing time on your homepage rose from 0.4 s to 0.9 s and its download size from 120 KB to 340 KB."
 * A new app's cost that rounds to zero ("0 KB", "0.0 s") is left out. `name`
 * is passed separately so the email can sanitize it.
 */
export function speedRegressionLine(r: SpeedAppRegression, name: string = r.name): string {
  const c = r.current;
  if (r.kind === "new") {
    const parts: string[] = [];
    if (Math.round(c.transferBytes / 1000) > 0) parts.push(formatBytes(c.transferBytes));
    if (Math.round(c.mainThreadMs / 100) > 0) {
      parts.push(`${formatSeconds(c.mainThreadMs)} of processing time`);
    }
    return `${name} is new since the test before and adds ${parts.join(" and ")} on your homepage.`;
  }
  const p = r.previous!;
  const time = `from ${formatSeconds(p.mainThreadMs)} to ${formatSeconds(c.mainThreadMs)}`;
  const size = `from ${formatBytes(p.transferBytes)} to ${formatBytes(c.transferBytes)}`;
  if (r.timeUp && r.sizeUp) {
    return `${possessive(name)} processing time on your homepage rose ${time} and its download size ${size}.`;
  }
  if (r.timeUp) return `${possessive(name)} processing time on your homepage rose ${time}.`;
  return `${possessive(name)} download size on your homepage rose ${size}.`;
}

// ---------------------------------------------------------------------------
// Free speed test (pure; plans without the full report)
// ---------------------------------------------------------------------------

/** The homepage page of a report when it has a score, else null. */
function scoredHome(
  pages: SpeedPageResult[],
): (SpeedPageResult & { metrics: SpeedMetrics }) | null {
  const home = pages.find((p) => p.page === "home");
  if (!home || home.status !== "OK" || !home.metrics || home.metrics.score === null) return null;
  return home as SpeedPageResult & { metrics: SpeedMetrics };
}

/**
 * Whether a FREE_TEST report uses the free test up: it COMPLETED with a
 * homepage score. A password page, a failure, a budget skip, a run with no
 * score and a cancelled run do not. The worker stamps Shop.freeSpeedTestUsedAt
 * on exactly this condition.
 */
export function freeSpeedTestConsumed(status: string, pages: SpeedPageResult[] | null): boolean {
  return status === SPEED_REPORT_STATUS.COMPLETED && scoredHome(pages ?? []) !== null;
}

/**
 * What a plan without the full report may see of its free test: the homepage
 * score and core timings, and ONE line about the costliest app. Never the
 * per-app table, other third parties, first-party totals, the product page
 * or any other report: the loader sends only this.
 */
export type FreeSpeedTestResult = {
  reportId: string;
  createdAt: string;
  metrics: {
    score: number;
    lcpMs: number | null;
    tbtMs: number | null;
    totalBytes: number | null;
    requestCount: number | null;
  };
  costliestApp: { name: string; mainThreadMs: number; transferBytes: number } | null;
};

export type FreeSpeedTestView = {
  /**
   * available: the test can be run; running: one is in progress; used: done;
   * exhausted: FREE_SPEED_TEST_MAX_ATTEMPTS runs started and none used it up.
   */
  state: "available" | "running" | "used" | "exhausted";
  /** The result that used the test up (state "used"). */
  result: FreeSpeedTestResult | null;
  /** The latest attempt that did NOT use the test up (state "available"). */
  lastAttempt: { status: string; failureReason: SpeedFailureCode | null; createdAt: string } | null;
};

/** The stripped result of one report, or null when it did not use the test up. */
export function freeSpeedTestResultOf(row: SpeedReportRowLike): FreeSpeedTestResult | null {
  const pages = readSpeedPages(row.pages);
  if (!freeSpeedTestConsumed(row.status, pages)) return null;
  const home = scoredHome(pages)!;
  const top = topCostlyApps(home.apps ?? [], 1)[0];
  return {
    reportId: row.id,
    createdAt: row.createdAt.toISOString(),
    metrics: {
      score: home.metrics.score!,
      lcpMs: home.metrics.lcpMs,
      tbtMs: home.metrics.tbtMs,
      totalBytes: home.metrics.totalBytes,
      requestCount: home.metrics.requestCount,
    },
    costliestApp: top
      ? { name: top.name, mainThreadMs: top.mainThreadMs, transferBytes: top.transferBytes }
      : null,
  };
}

/**
 * The free test's state from the shop's FREE_TEST reports (newest first),
 * Shop.freeSpeedTestUsedAt and how many of its attempts count toward the cap
 * (`attempts`: those that reached Google, see FREE_SPEED_TEST_MAX_ATTEMPTS). Used = the stamp is set (the result shown is the newest
 * report that used it up). Otherwise a RUNNING report (not abandoned) means
 * running; else `attempts` at FREE_SPEED_TEST_MAX_ATTEMPTS means exhausted;
 * else available, with the latest attempt to explain why it can be run again.
 */
export function buildFreeSpeedTestView(
  rows: SpeedReportRowLike[],
  usedAt: Date | null,
  now: Date,
  attempts: number,
): FreeSpeedTestView {
  if (usedAt) {
    let result: FreeSpeedTestResult | null = null;
    for (const row of rows) {
      result = freeSpeedTestResultOf(row);
      if (result) break;
    }
    return { state: "used", result, lastAttempt: null };
  }
  const latest = rows[0] ? toSummaryView(rows[0], now) : null;
  if (latest?.status === SPEED_REPORT_STATUS.RUNNING) {
    return { state: "running", result: null, lastAttempt: null };
  }
  if (attempts >= FREE_SPEED_TEST_MAX_ATTEMPTS) {
    return { state: "exhausted", result: null, lastAttempt: null };
  }
  return {
    state: "available",
    result: null,
    lastAttempt: latest
      ? { status: latest.status, failureReason: latest.failureReason, createdAt: latest.createdAt }
      : null,
  };
}
