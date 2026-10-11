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
} as const;
export type SpeedReportOrigin = (typeof SPEED_REPORT_ORIGIN)[keyof typeof SPEED_REPORT_ORIGIN];

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
 * shown (and treated) as failed: the worker's finish timeout (45 m) is
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
