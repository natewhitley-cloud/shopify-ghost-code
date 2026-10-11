/**
 * Store speed report orchestration (gc-wt3y). The speed-report-run Inngest
 * worker is a thin sequence of steps over these functions:
 *
 *   prepareSpeedReportRun   gate (flag, plan, install) + key check + report row
 *   resolveSpeedTargets     Admin API: primary domain + one product URL
 *   runPageSpeedAttempt     ONE PageSpeed call (re-gates, reserves budget first)
 *   finalizeSpeedReport     median per page, status, row, OpsEvent
 *
 * Guardrails (Nathan, 2026-10-11): Professional only; DARK unless
 * SPEED_REPORT_LIVE_ENABLED; the plan/flag/install gate is re-checked right
 * before EVERY call (a shop that downgraded or uninstalled mid-run gets
 * nothing more); a call is counted against the global daily budget BEFORE it
 * is made; only https URLs on the shop's own primary domain are sent to Google;
 * logs carry the host and an outcome code, never a URL with the key.
 */

import {
  callPageSpeed,
  type PageSpeedErrorCode,
  type PageSpeedFetch,
} from "./pagespeed-client.server";
import {
  selectMedianRun,
  summarizeLighthouse,
  type SpeedRunSummary,
} from "./speed-attribution.server";
import {
  getDailyCallBudget,
  getPageSpeedApiKey,
  isSpeedReportLive,
} from "./speed-report-config.server";
import { isBareHostname } from "./storefront-fetcher.server";
import { inngest } from "../../inngest/client";
import db from "../db.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { type GraphQLResponseError, isAccessDeniedError } from "../lib/scope-check.server";
import {
  buildSpeedReportView,
  computeSpeedReportStatus,
  runNowAvailableAt,
  SPEED_REPORT_ORIGIN,
  SPEED_REPORT_STATUS,
  type SpeedFailureCode,
  type SpeedPageKey,
  type SpeedPageResult,
  type SpeedReportOrigin,
  type SpeedReportStatus,
  speedFailureMessage,
} from "../lib/speed-report";
import { OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";
import {
  claimSpeedReportRunNow,
  createSpeedReport,
  finishSpeedReport,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
  releaseSpeedReportRunNow,
  reservePageSpeedCall,
} from "../models/speed-report.server";
import type { AdminApiContext } from "../types/shopify";

const LOG_FN = "speed-report";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type SpeedIneligibleReason = "disabled" | "no_shop" | "uninstalled" | "not_in_plan";

export type SpeedEligibility =
  | { eligible: true; shop: { id: string; domain: string; plan: string } }
  | { eligible: false; reason: SpeedIneligibleReason };

/**
 * Whether this shop may get a speed report right now: flag on (checked first,
 * so a dark feature does not even read the DB), shop exists, still installed,
 * plan includes it. Internal/dev stores are NOT excluded: that is how the
 * feature is tested (the operator digest filters them out of its numbers).
 */
export async function checkSpeedReportEligibility(shopId: string): Promise<SpeedEligibility> {
  if (!isSpeedReportLive()) return { eligible: false, reason: "disabled" };
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { id: true, domain: true, plan: true, uninstalledAt: true },
  });
  if (!shop) return { eligible: false, reason: "no_shop" };
  if (shop.uninstalledAt) return { eligible: false, reason: "uninstalled" };
  if (!getPlanFeatures(shop.plan).speedReport) return { eligible: false, reason: "not_in_plan" };
  return { eligible: true, shop: { id: shop.id, domain: shop.domain, plan: shop.plan } };
}

// ---------------------------------------------------------------------------
// Step 1: prepare
// ---------------------------------------------------------------------------

export type PrepareResult =
  | { proceed: true; reportId: string; shopDomain: string; startedAt: string }
  | { proceed: false; outcome: SpeedIneligibleReason | "not_configured" };

/**
 * Gate the run and make sure a report row exists. MANUAL runs arrive with the
 * RUNNING row the Run-now action created; SCHEDULED runs create theirs here.
 * Refused runs never call Google: an ineligible MANUAL row is closed as
 * FAILED/not_eligible; a missing key (flag on) closes the row as
 * FAILED/not_configured and records a "not configured" ops event.
 */
export async function prepareSpeedReportRun(input: {
  shopId: string;
  origin: SpeedReportOrigin;
  reportId?: string;
}): Promise<PrepareResult> {
  const gate = await checkSpeedReportEligibility(input.shopId);
  if (!gate.eligible) {
    if (input.reportId) {
      await finishSpeedReport(input.reportId, {
        status: SPEED_REPORT_STATUS.FAILED,
        failureReason: "not_eligible",
        pages: null,
        psiCalls: 0,
      });
    }
    logger.info("speed report skipped", {
      function: LOG_FN,
      event: "speed_report_ineligible",
      shopId: input.shopId,
      outcome: gate.reason,
    });
    return { proceed: false, outcome: gate.reason };
  }

  const row = input.reportId
    ? { id: input.reportId, createdAt: new Date() }
    : await createSpeedReport(input.shopId, input.origin);

  if (!getPageSpeedApiKey()) {
    await finishSpeedReport(row.id, {
      status: SPEED_REPORT_STATUS.FAILED,
      failureReason: "not_configured",
      pages: null,
      psiCalls: 0,
    });
    await recordSpeedReportEvent(gate.shop.domain, {
      status: SPEED_REPORT_STATUS.FAILED,
      origin: input.origin,
      calls: 0,
      durationMs: 0,
      reason: "not_configured",
    });
    logger.warn("speed report not configured", {
      function: LOG_FN,
      event: "speed_report_not_configured",
      shopId: input.shopId,
    });
    return { proceed: false, outcome: "not_configured" };
  }

  return {
    proceed: true,
    reportId: row.id,
    shopDomain: gate.shop.domain,
    startedAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Step 2: which URLs
// ---------------------------------------------------------------------------

export type ProductTarget =
  | { status: "OK"; url: string }
  | { status: "NO_PRODUCT" | "NEEDS_PRODUCT_ACCESS" | "FAILED" };

export type SpeedTargets = {
  /** https://<primary host>/ */
  homeUrl: string;
  primaryHost: string;
  /** The shop's own storefront hosts (primary + myshopify), lowercased. */
  storeHosts: string[];
  product: ProductTarget;
};

export type ResolveTargetsResult = { ok: true; targets: SpeedTargets } | { ok: false };

const SHOP_DOMAIN_QUERY = `
  query SpeedReportShop {
    shop {
      primaryDomain {
        url
        host
      }
      myshopifyDomain
    }
  }
`;

/**
 * Up to 10 active products, oldest first (sortKey ID): a stable choice, so the
 * same product is tested week after week and the change is comparable. The
 * first with an online store URL wins (null = not published to the online
 * store). Needs the optional read_products scope.
 */
const PRODUCT_QUERY = `
  query SpeedReportProduct {
    products(first: 10, sortKey: ID, query: "status:active") {
      nodes {
        onlineStoreUrl
      }
    }
  }
`;

type GraphQLBody = { data?: unknown; errors?: GraphQLResponseError[] };

/** Errors a thrown admin.graphql call carries (GraphqlQueryError shape). */
function thrownGraphQLErrors(err: unknown): GraphQLResponseError[] {
  const errors = (err as { body?: { errors?: { graphQLErrors?: unknown } } } | null)?.body?.errors
    ?.graphQLErrors;
  return Array.isArray(errors) ? (errors as GraphQLResponseError[]) : [];
}

/**
 * The page URL PageSpeed may test: https, exactly the shop's primary host, no
 * credentials or port. Everything sent to Google passes this.
 */
export function isAllowedSpeedTarget(url: string, primaryHost: string): boolean {
  if (!isBareHostname(primaryHost)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === primaryHost.toLowerCase() &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port
  );
}

/**
 * Normalize a product's onlineStoreUrl onto the primary host: keep only its
 * path (no query, no hash), and only when it is a product path. Null when the
 * URL is missing or not a product page.
 */
export function productUrlOnPrimaryHost(raw: unknown, primaryHost: string): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!/\/products\/[^/]+\/?$/.test(parsed.pathname)) return null;
  return `https://${primaryHost}${parsed.pathname}`;
}

async function resolveProductTarget(
  admin: AdminApiContext,
  primaryHost: string,
): Promise<ProductTarget> {
  let body: GraphQLBody;
  try {
    const response = await admin.graphql(PRODUCT_QUERY);
    body = (await response.json()) as GraphQLBody;
  } catch (err) {
    const errors = thrownGraphQLErrors(err);
    if (
      errors.some(isAccessDeniedError) ||
      (err instanceof Error && isAccessDeniedError({ message: err.message }))
    ) {
      return { status: "NEEDS_PRODUCT_ACCESS" };
    }
    return { status: "FAILED" };
  }
  if (body.errors?.length) {
    return body.errors.some(isAccessDeniedError)
      ? { status: "NEEDS_PRODUCT_ACCESS" }
      : { status: "FAILED" };
  }
  const nodes = (body.data as { products?: { nodes?: unknown } } | undefined)?.products?.nodes;
  if (!Array.isArray(nodes)) return { status: "FAILED" };
  for (const node of nodes) {
    const url = productUrlOnPrimaryHost(
      (node as { onlineStoreUrl?: unknown } | null)?.onlineStoreUrl,
      primaryHost,
    );
    if (url) return { status: "OK", url };
  }
  return { status: "NO_PRODUCT" };
}

/** Read the shop's primary host, then pick the product page. */
export async function resolveSpeedTargets(admin: AdminApiContext): Promise<ResolveTargetsResult> {
  let primaryHost: string | null = null;
  let myshopifyHost: string | null = null;
  try {
    const response = await admin.graphql(SHOP_DOMAIN_QUERY);
    const body = (await response.json()) as {
      data?: {
        shop?: {
          primaryDomain?: { url?: unknown; host?: unknown } | null;
          myshopifyDomain?: unknown;
        } | null;
      };
    };
    const shop = body?.data?.shop;
    const primary = shop?.primaryDomain;
    if (typeof primary?.url === "string") {
      try {
        primaryHost = new URL(primary.url).hostname;
      } catch {
        primaryHost = null;
      }
    }
    if (!primaryHost && typeof primary?.host === "string") primaryHost = primary.host;
    if (typeof shop?.myshopifyDomain === "string" && isBareHostname(shop.myshopifyDomain)) {
      myshopifyHost = shop.myshopifyDomain.toLowerCase();
    }
  } catch {
    return { ok: false };
  }
  if (!primaryHost || !isBareHostname(primaryHost)) return { ok: false };
  primaryHost = primaryHost.toLowerCase();

  const product = await resolveProductTarget(admin, primaryHost);
  const storeHosts = [primaryHost, ...(myshopifyHost ? [myshopifyHost] : [])];
  return {
    ok: true,
    targets: { homeUrl: `https://${primaryHost}/`, primaryHost, storeHosts, product },
  };
}

// ---------------------------------------------------------------------------
// Step 3: one PageSpeed call
// ---------------------------------------------------------------------------

export type SpeedAttempt =
  | { kind: "ok"; run: SpeedRunSummary }
  | { kind: "password" }
  | { kind: "error"; code: PageSpeedErrorCode }
  /** Nothing was called: the daily budget is used up. */
  | { kind: "budget" }
  /** Nothing was called: the shop is no longer eligible (or the flag went off). */
  | { kind: "not_eligible" }
  /** Nothing was called: the key disappeared mid-run. */
  | { kind: "not_configured" }
  /** Nothing was called: the URL failed the target check. */
  | { kind: "bad_target" };

/** Whether an attempt reached Google (and so counts as a call). */
export function attemptCalledGoogle(a: SpeedAttempt): boolean {
  return a.kind === "ok" || a.kind === "password" || a.kind === "error";
}

/**
 * Whether this attempt ends the whole run (no further calls for any page):
 * a password page (every page is behind it), the budget, the gate, the key,
 * Google rate limiting us (back off, do not hammer) or a 4xx (a key/config
 * problem that every later call would repeat).
 */
export function attemptHaltsRun(a: SpeedAttempt): boolean {
  if (a.kind === "error") return a.code === "rate_limited" || a.code === "http_error";
  return a.kind !== "ok";
}

/** Whether this attempt ends this page only (the page itself cannot be loaded). */
export function attemptHaltsPage(a: SpeedAttempt): boolean {
  return a.kind === "error" && a.code === "document_failed";
}

/**
 * One PageSpeed run of one page. Re-checks the gate and the key, validates the
 * target, reserves the call against today's budget, then calls Google. NEVER
 * THROWS for a Google-side failure (those are `error` attempts), so an Inngest
 * step retry can never re-issue a call that already happened; a DB error before
 * the call (gate/budget) may throw and is retried by the step, which is safe
 * because nothing was sent yet.
 */
export async function runPageSpeedAttempt(input: {
  shopId: string;
  page: SpeedPageKey;
  pageUrl: string;
  primaryHost: string;
  storeHosts: string[];
  fetchImpl?: PageSpeedFetch;
  now?: () => Date;
}): Promise<SpeedAttempt> {
  const gate = await checkSpeedReportEligibility(input.shopId);
  if (!gate.eligible) return { kind: "not_eligible" };
  const apiKey = getPageSpeedApiKey();
  if (!apiKey) return { kind: "not_configured" };
  if (!isAllowedSpeedTarget(input.pageUrl, input.primaryHost)) return { kind: "bad_target" };

  const now = input.now ?? (() => new Date());
  const reserved = await reservePageSpeedCall(getDailyCallBudget(), now());
  if (!reserved) {
    logger.warn("pagespeed daily budget exhausted", {
      function: LOG_FN,
      event: "pagespeed_budget_exhausted",
      shopId: input.shopId,
    });
    return { kind: "budget" };
  }

  const started = Date.now();
  const result = await callPageSpeed(input.pageUrl, { apiKey, fetchImpl: input.fetchImpl });
  let attempt: SpeedAttempt;
  if (!result.ok) {
    attempt = { kind: "error", code: result.code };
  } else {
    const run = summarizeLighthouse(result.lighthouse, input.storeHosts);
    if (!run) attempt = { kind: "error", code: "bad_response" };
    else if (run.passwordProtected) attempt = { kind: "password" };
    else attempt = { kind: "ok", run };
  }

  // Host + outcome only: never the request URL (it carries the key).
  logger.info("pagespeed call", {
    function: LOG_FN,
    event: "pagespeed_call",
    shopId: input.shopId,
    page: input.page,
    host: input.primaryHost,
    outcome: attempt.kind === "error" ? attempt.code : attempt.kind,
    httpStatus: result.ok ? 200 : result.httpStatus,
    durationMs: Date.now() - started,
  });
  return attempt;
}

// ---------------------------------------------------------------------------
// Step 4: finalize
// ---------------------------------------------------------------------------

/** The failure code an attempt stands for (undefined for ok / password). */
export function attemptFailureCode(a: SpeedAttempt): SpeedFailureCode | undefined {
  switch (a.kind) {
    case "error":
      return a.code;
    case "budget":
      return "budget";
    case "not_eligible":
      return "not_eligible";
    case "not_configured":
      return "not_configured";
    case "bad_target":
      return "no_domain";
    default:
      return undefined;
  }
}

/**
 * One page's stored result from its attempts:
 *   - any password attempt          -> PASSWORD
 *   - at least one ok run           -> OK, the MEDIAN run's numbers
 *   - no call reached Google        -> NOT_RUN (with the reason, e.g. budget)
 *   - otherwise                     -> FAILED with the last error's code
 * `haltCode` labels a page the run never reached (another page halted it).
 */
export function buildSpeedPageResult(
  page: SpeedPageKey,
  url: string,
  attempts: SpeedAttempt[],
  haltCode?: SpeedFailureCode,
): SpeedPageResult {
  const called = attempts.filter(attemptCalledGoogle).length;
  const base = { page, url, runsAttempted: called };
  if (attempts.some((a) => a.kind === "password")) {
    return { ...base, status: "PASSWORD", runsOk: 0 };
  }
  const okRuns = attempts.flatMap((a) => (a.kind === "ok" ? [a.run] : []));
  const median = selectMedianRun(okRuns);
  if (median) {
    return {
      ...base,
      status: "OK",
      runsOk: okRuns.length,
      metrics: median.metrics,
      apps: median.apps,
      otherThirdParty: median.otherThirdParty,
      firstParty: median.firstParty,
    };
  }
  const last = attempts[attempts.length - 1];
  const code = (last && attemptFailureCode(last)) ?? haltCode;
  return {
    ...base,
    status: called === 0 ? "NOT_RUN" : "FAILED",
    runsOk: 0,
    ...(code ? { failureCode: code } : {}),
  };
}

export type PageAttempts = { page: SpeedPageKey; url: string; attempts: SpeedAttempt[] };

/**
 * Build the pages, roll up the status, write the report and its OpsEvent.
 * `targets` null = the URLs could not be resolved (FAILED / no_domain).
 */
export async function finalizeSpeedReport(input: {
  reportId: string;
  shopDomain: string;
  origin: SpeedReportOrigin;
  startedAt: string;
  targets: SpeedTargets | null;
  tested: PageAttempts[];
  haltCode?: SpeedFailureCode;
}): Promise<{ status: SpeedReportStatus; calls: number }> {
  const calls = input.tested.reduce((n, p) => n + p.attempts.filter(attemptCalledGoogle).length, 0);
  let status: SpeedReportStatus;
  let failureReason: SpeedFailureCode | null = null;
  let pages: SpeedPageResult[] | null = null;

  if (!input.targets) {
    status = SPEED_REPORT_STATUS.FAILED;
    failureReason = "no_domain";
  } else {
    pages = input.tested.map((p) =>
      buildSpeedPageResult(p.page, p.url, p.attempts, input.haltCode),
    );
    const product = input.targets.product;
    if (product.status !== "OK") {
      pages.push({
        page: "product",
        url: null,
        status: product.status === "FAILED" ? "FAILED" : product.status,
        runsAttempted: 0,
        runsOk: 0,
        ...(product.status === "FAILED" ? { failureCode: "bad_response" as const } : {}),
      });
    }
    const budgetExhausted = input.tested.some((p) => p.attempts.some((a) => a.kind === "budget"));
    status = computeSpeedReportStatus(pages, { budgetExhausted });
    if (status === SPEED_REPORT_STATUS.SKIPPED_BUDGET) failureReason = "budget";
    else if (status === SPEED_REPORT_STATUS.FAILED) {
      failureReason = pages.find((p) => p.failureCode)?.failureCode ?? null;
    }
  }

  await finishSpeedReport(input.reportId, { status, failureReason, pages, psiCalls: calls });
  const durationMs = Date.now() - new Date(input.startedAt).getTime();
  await recordSpeedReportEvent(input.shopDomain, {
    status,
    origin: input.origin,
    calls,
    durationMs,
    ...(failureReason ? { reason: failureReason } : {}),
  });
  logger.info("speed report finished", {
    function: LOG_FN,
    event: "speed_report_finished",
    reportId: input.reportId,
    outcome: status,
    calls,
    durationMs,
  });
  return { status, calls };
}

// ---------------------------------------------------------------------------
// OpsEvent
// ---------------------------------------------------------------------------

export type SpeedReportEventMetadata = {
  status: SpeedReportStatus;
  origin: SpeedReportOrigin;
  calls: number;
  durationMs: number;
  reason?: SpeedFailureCode;
};

/** One speed_report OpsEvent, keyed on the shop domain (redact reaches it). */
export async function recordSpeedReportEvent(
  shopDomain: string,
  metadata: SpeedReportEventMetadata,
): Promise<void> {
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.SPEED_REPORT,
    key: shopDomain,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// "Run speed test now" (request context: the Store speed route action)
// ---------------------------------------------------------------------------

export const RUN_NOW_ERRORS = {
  notInPlan: "Store speed reports are part of the Professional plan.",
  running: "A speed test is already running. Results appear here when it finishes.",
  cooldown: "You can run the speed test once a day.",
  dispatch: "We couldn't start the speed test. Try again in a few minutes.",
} as const;

export type RunNowResult =
  | { ok: true; reportId: string }
  | { ok: false; error: string; nextAvailableAt?: string };

/**
 * Start a MANUAL speed report for the session shop: at most once per 24h,
 * never while one is already running, Professional only (the caller has
 * already 404ed when the feature is dark). A missing key refuses before the
 * 24h slot is claimed (and records the "not configured" ops event). If the
 * event cannot be sent, the row is closed as FAILED and the slot handed back.
 */
export async function requestSpeedReportRunNow(
  shop: { id: string; domain: string; plan: string },
  now: Date,
): Promise<RunNowResult> {
  if (!getPlanFeatures(shop.plan).speedReport)
    return { ok: false, error: RUN_NOW_ERRORS.notInPlan };

  if (!getPageSpeedApiKey()) {
    await recordSpeedReportEvent(shop.domain, {
      status: SPEED_REPORT_STATUS.FAILED,
      origin: SPEED_REPORT_ORIGIN.MANUAL,
      calls: 0,
      durationMs: 0,
      reason: "not_configured",
    });
    logger.warn("speed report not configured", {
      function: LOG_FN,
      event: "speed_report_not_configured",
      shopId: shop.id,
    });
    return { ok: false, error: speedFailureMessage("not_configured") };
  }

  const { latest } = buildSpeedReportView(await getRecentSpeedReports(shop.id), now);
  if (latest?.status === SPEED_REPORT_STATUS.RUNNING) {
    return { ok: false, error: RUN_NOW_ERRORS.running };
  }

  const previous = await getSpeedReportRequestedAt(shop.id);
  if (!(await claimSpeedReportRunNow(shop.id, now))) {
    const next = runNowAvailableAt(previous, now);
    return {
      ok: false,
      error: RUN_NOW_ERRORS.cooldown,
      ...(next ? { nextAvailableAt: next.toISOString() } : {}),
    };
  }

  const row = await createSpeedReport(shop.id, SPEED_REPORT_ORIGIN.MANUAL);
  try {
    await inngest.send({
      name: "speed-report/requested",
      data: { shopId: shop.id, origin: SPEED_REPORT_ORIGIN.MANUAL, reportId: row.id },
    });
  } catch (err) {
    logger.error("speed report dispatch failed", {
      function: LOG_FN,
      event: "speed_report_dispatch_failed",
      shopId: shop.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await finishSpeedReport(row.id, {
      status: SPEED_REPORT_STATUS.FAILED,
      failureReason: "dispatch_failed",
      pages: null,
      psiCalls: 0,
    });
    await releaseSpeedReportRunNow(shop.id, now, previous);
    return { ok: false, error: RUN_NOW_ERRORS.dispatch };
  }
  return { ok: true, reportId: row.id };
}
