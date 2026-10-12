/**
 * Store speed report orchestration (gc-wt3y). The speed-report-run Inngest
 * worker is a thin sequence of steps over these functions:
 *
 *   prepareSpeedReportRun   gate (flag, plan, install) + key check + report row
 *   resolveSpeedTargets     Admin API: primary domain + one product URL
 *   precheckStorefrontPassword  one storefront GET: password page? (no PSI cost)
 *   resolvePublicProductTarget  without read_products, and only when the
 *                           pre-check found no password page: the product URL
 *                           from the public /products.json (gc-9mbw)
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
import {
  type DnsLookupAll,
  guardedStorefrontGet,
  isBareHostname,
  isPasswordPageHtml,
  isPasswordPath,
  readStorefrontHomepage,
  type StorefrontFetch,
} from "./storefront-fetcher.server";
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
  failAbandonedSpeedReport,
  finishSpeedReport,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
  hasRecentSpeedReportEvent,
  releaseSpeedReportRunNow,
  reservePageSpeedCall,
  startManualSpeedReport,
  startSpeedReportForRun,
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
  | { proceed: false; outcome: SpeedIneligibleReason | "not_configured" | "no_report" };

/**
 * Gate the run and make sure a report row exists, stamped with this Inngest
 * run and the time the worker STARTED it (the stuck clock, gc-wt3y #3).
 * MANUAL runs arrive with the RUNNING row the Run-now action created (gone or
 * no longer RUNNING: `no_report`, nothing is called); SCHEDULED runs create
 * theirs here, keyed on the run so a retried prepare reuses it (gc-wt3y #8).
 * Refused runs never call Google: an ineligible MANUAL row is closed as
 * FAILED/not_eligible; a missing key (flag on) closes the row as
 * FAILED/not_configured and records a "not configured" ops event.
 */
export async function prepareSpeedReportRun(input: {
  shopId: string;
  origin: SpeedReportOrigin;
  reportId?: string;
  runId: string;
  now?: Date;
}): Promise<PrepareResult> {
  const now = input.now ?? new Date();
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

  let row: { id: string };
  if (input.reportId) {
    if (!(await startManualSpeedReport(input.reportId, input.runId, now))) {
      logger.info("speed report row missing", {
        function: LOG_FN,
        event: "speed_report_no_row",
        shopId: input.shopId,
        reportId: input.reportId,
      });
      return { proceed: false, outcome: "no_report" };
    }
    row = { id: input.reportId };
  } else {
    row = await startSpeedReportForRun(input.shopId, input.origin, input.runId, now);
  }

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
    startedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Failure / cancel cleanup
// ---------------------------------------------------------------------------

export type AbandonedRun = {
  shopId: string;
  origin: SpeedReportOrigin;
  /** The Inngest run that died or was cancelled. */
  runId: string;
  /** MANUAL: the Run-now row (it exists even when the run never started). */
  reportId?: string;
  /** MANUAL: the Run-now claim to hand back (ISO), and the value before it. */
  runNowClaimedAt?: string;
  runNowPrevious?: string | null;
};

/**
 * The AbandonedRun for a failed/cancelled run, from the event that started it
 * (`speed-report/requested` data, carried in Inngest's failure/cancel event).
 * Null when that data is missing or malformed: nothing can be closed.
 */
export function abandonedRunFromEvent(original: unknown, runId: unknown): AbandonedRun | null {
  const data = (original as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof runId !== "string" || runId === "") return null;
  const { shopId, origin, reportId, runNowClaimedAt, runNowPrevious } = data;
  if (typeof shopId !== "string" || shopId === "") return null;
  if (origin !== SPEED_REPORT_ORIGIN.SCHEDULED && origin !== SPEED_REPORT_ORIGIN.MANUAL) {
    return null;
  }
  return {
    shopId,
    origin,
    runId,
    ...(typeof reportId === "string" ? { reportId } : {}),
    ...(typeof runNowClaimedAt === "string" ? { runNowClaimedAt } : {}),
    ...(typeof runNowPrevious === "string" || runNowPrevious === null ? { runNowPrevious } : {}),
  };
}

/**
 * A speed-report-run that will not finish (retries exhausted: `worker_failed`;
 * cancelled by its start/finish timeout: `stuck`) must not leave its report
 * RUNNING forever (gc-wt3y #2/#3). Closes the RUNNING row as FAILED (missing
 * row tolerated), hands a MANUAL run's Run-now slot back, and records the
 * speed_report ops event ONLY when a row was actually closed and the shop
 * still exists: a redacted shop gets no new row keyed on its domain. `calls`
 * is 0 in that event: calls made before the failure are not tracked per run.
 */
export async function closeAbandonedSpeedReport(
  run: AbandonedRun,
  reason: Extract<SpeedFailureCode, "worker_failed" | "stuck">,
  now: Date = new Date(),
): Promise<void> {
  const closed = await failAbandonedSpeedReport(
    { shopId: run.shopId, runId: run.runId, ...(run.reportId ? { reportId: run.reportId } : {}) },
    reason,
    now,
  );
  if (run.origin === SPEED_REPORT_ORIGIN.MANUAL && run.runNowClaimedAt) {
    await releaseSpeedReportRunNow(
      run.shopId,
      new Date(run.runNowClaimedAt),
      run.runNowPrevious ? new Date(run.runNowPrevious) : null,
    );
  }
  if (closed > 0) {
    const shop = await db.shop.findUnique({ where: { id: run.shopId }, select: { domain: true } });
    if (shop) {
      await recordSpeedReportEvent(shop.domain, {
        status: SPEED_REPORT_STATUS.FAILED,
        origin: run.origin,
        calls: 0,
        durationMs: 0,
        reason,
      });
    }
  }
  logger.warn("speed report abandoned", {
    function: LOG_FN,
    event: "speed_report_abandoned",
    shopId: run.shopId,
    outcome: reason,
    closed,
  });
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

/**
 * Why the URLs could not be resolved: the shop has no usable primary domain
 * (`no_domain`), or the Admin API itself could not be read (`admin_unavailable`:
 * offline token gone, throttled, outage), which is not the merchant's address.
 */
export type TargetsFailure = Extract<SpeedFailureCode, "no_domain" | "admin_unavailable">;

export type ResolveTargetsResult =
  | { ok: true; targets: SpeedTargets }
  | { ok: false; reason: TargetsFailure };

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

// ---------------------------------------------------------------------------
// Product fallback without read_products (gc-9mbw): the public /products.json
// ---------------------------------------------------------------------------

/** Products read from /products.json (Shopify's public max per page). */
export const PUBLIC_PRODUCTS_LIMIT = 250;

/**
 * A product handle we are willing to put in a URL: letters (any script),
 * digits, "-" and "_", starting with a letter or digit, at most 255 chars.
 * Rejects everything that could change the path or host: "/", "\\", ".",
 * "%" (pre-encoded input), "?", "#", ":", "@", whitespace and controls.
 */
const SAFE_HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,254}$/u;

export function isSafeProductHandle(handle: unknown): handle is string {
  return typeof handle === "string" && SAFE_HANDLE_RE.test(handle);
}

/**
 * Pick the product page from a /products.json body: the OLDEST product by
 * created_at (id breaks ties), the same "oldest first" rule as the Admin path
 * (sortKey ID), so the same product is tested week after week. The endpoint
 * lists only products published to the online store; a product with a
 * published_at of null is skipped anyway. Products with an unsafe handle or
 * no parseable created_at are skipped. The URL is built on the primary host
 * and must pass productUrlOnPrimaryHost and isAllowedSpeedTarget.
 * Null = no usable product (malformed body, empty list, nothing safe).
 *
 * Limit: only the first PUBLIC_PRODUCTS_LIMIT products are seen, so on a
 * larger catalog "oldest" is the oldest of that page.
 */
export function pickPublicProductUrl(body: string, primaryHost: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const products = (parsed as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) return null;

  let best: { created: number; id: number; handle: string } | null = null;
  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (!isSafeProductHandle(o.handle)) continue;
    if (typeof o.published_at !== "string") continue;
    const created = typeof o.created_at === "string" ? Date.parse(o.created_at) : NaN;
    if (!Number.isFinite(created)) continue;
    const id = typeof o.id === "number" && Number.isFinite(o.id) ? o.id : Number.MAX_SAFE_INTEGER;
    if (!best || created < best.created || (created === best.created && id < best.id)) {
      best = { created, id, handle: o.handle };
    }
  }
  if (!best) return null;

  const url = productUrlOnPrimaryHost(
    `https://${primaryHost}/products/${encodeURIComponent(best.handle)}`,
    primaryHost,
  );
  return url && isAllowedSpeedTarget(url, primaryHost) ? url : null;
}

/**
 * Without read_products, pick the product page from the PUBLIC storefront:
 * `https://<primary host>/products.json?limit=PUBLIC_PRODUCTS_LIMIT`, read
 * through the storefront fetcher's guarded GET (primary host only, https,
 * manual redirects capped and limited to the shop's own hosts, DNS-rebinding
 * safe agent, body cap, timeout). Re-checks the speed gate FIRST (flag,
 * install, Professional), so a dark feature or a non-Pro shop never reads the
 * storefront. Anything short of a usable product (password page, 404,
 * redirect elsewhere, non-JSON, empty) keeps NEEDS_PRODUCT_ACCESS: homepage
 * only, with the same message as before. Logs host + outcome only. Never throws.
 */
export async function resolvePublicProductTarget(input: {
  shopId: string;
  primaryHost: string;
  storeHosts: string[];
  fetchImpl?: StorefrontFetch;
  dnsLookup?: DnsLookupAll;
}): Promise<ProductTarget> {
  const fallback: ProductTarget = { status: "NEEDS_PRODUCT_ACCESS" };
  const log = (outcome: string) =>
    logger.info("speed product fallback", {
      function: LOG_FN,
      event: "speed_product_fallback",
      shopId: input.shopId,
      host: input.primaryHost,
      outcome,
    });
  try {
    const gate = await checkSpeedReportEligibility(input.shopId);
    if (!gate.eligible) {
      log(gate.reason);
      return fallback;
    }
    if (!isBareHostname(input.primaryHost)) {
      log("no_domain");
      return fallback;
    }
    const read = await guardedStorefrontGet(
      new URL(`https://${input.primaryHost}/products.json?limit=${PUBLIC_PRODUCTS_LIMIT}`),
      {
        allowedHosts: new Set(input.storeHosts),
        accept: "application/json",
        // Only a 2xx that is not the password page is worth reading.
        readBody: (url, status) => !isPasswordPath(url.pathname) && status >= 200 && status < 300,
        fetchImpl: input.fetchImpl,
        dnsLookup: input.dnsLookup,
      },
    );
    if (read.status === "unreachable") {
      log(read.reason);
      return fallback;
    }
    if (isPasswordPath(read.url.pathname)) {
      log("password");
      return fallback;
    }
    if (read.body === null) {
      log("http_status");
      return fallback;
    }
    const url = pickPublicProductUrl(read.body, input.primaryHost);
    if (!url) {
      log("no_usable_product");
      return fallback;
    }
    log("ok");
    return { status: "OK", url };
  } catch {
    log("error");
    return fallback;
  }
}

/**
 * Read the shop's primary host, then pick the product page through the Admin
 * API (read_products). Without that scope the product stays
 * NEEDS_PRODUCT_ACCESS here: the public /products.json fallback
 * (resolvePublicProductTarget) runs only after the password pre-check, so a
 * password-protected store gets no storefront read beyond that check.
 */
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
      errors?: unknown[];
    };
    if (Array.isArray(body?.errors) && body.errors.length > 0 && !body.data?.shop) {
      return { ok: false, reason: "admin_unavailable" };
    }
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
    return { ok: false, reason: "admin_unavailable" };
  }
  if (!primaryHost || !isBareHostname(primaryHost)) return { ok: false, reason: "no_domain" };
  primaryHost = primaryHost.toLowerCase();

  const product = await resolveProductTarget(admin, primaryHost);
  const storeHosts = [primaryHost, ...(myshopifyHost ? [myshopifyHost] : [])];
  return {
    ok: true,
    targets: { homeUrl: `https://${primaryHost}/`, primaryHost, storeHosts, product },
  };
}

// ---------------------------------------------------------------------------
// Step 2b: password pre-check (no PageSpeed cost)
// ---------------------------------------------------------------------------

/**
 * password  the homepage is Shopify's password page: test nothing
 * open      the homepage is readable and not the password page
 * unknown   the read failed (network, timeout, refused redirect, too large):
 *           go on to PageSpeed, whose final-URL / 401 checks still apply
 * skipped   flag off or the shop is no longer eligible: nothing was fetched
 */
export type PasswordPrecheck = "password" | "open" | "unknown" | "skipped";

/**
 * One GET of `https://<primary host>/` through the scanner's SSRF-safe
 * storefront read (readStorefrontHomepage: connect-time address guard,
 * redirects only to the shop's own hosts, 10 s, 5 MB), BEFORE any PageSpeed
 * call or budget reservation. A password-protected store either redirects to
 * /password or serves the password page at / (200 or 401), so both the final
 * path and the HTML are checked. A failed read never blocks the run.
 */
export async function precheckStorefrontPassword(input: {
  shopId: string;
  primaryHost: string;
  storeHosts: string[];
  fetchImpl?: StorefrontFetch;
}): Promise<PasswordPrecheck> {
  const gate = await checkSpeedReportEligibility(input.shopId);
  if (!gate.eligible) return "skipped";

  const primaryHost = input.primaryHost.toLowerCase();
  const read = await readStorefrontHomepage(
    {
      primaryHost,
      myshopifyHost: input.storeHosts.find((h) => h.toLowerCase() !== primaryHost) ?? null,
    },
    {
      // A password page can answer 401, so its body is read too.
      readBody: (url, status) =>
        !isPasswordPath(url.pathname) && ((status >= 200 && status < 300) || status === 401),
      fetchImpl: input.fetchImpl,
    },
  );
  let outcome: PasswordPrecheck;
  if (read.status === "unreachable") outcome = "unknown";
  else if (isPasswordPath(read.url.pathname)) outcome = "password";
  else if (read.body !== null && isPasswordPageHtml(read.body)) outcome = "password";
  else outcome = read.body === null ? "unknown" : "open";

  logger.info("speed report password pre-check", {
    function: LOG_FN,
    event: "speed_password_precheck",
    shopId: input.shopId,
    host: primaryHost,
    outcome: read.status === "unreachable" ? `${outcome}:${read.reason}` : outcome,
    ...(read.status === "read" ? { httpStatus: read.httpStatus } : {}),
  });
  return outcome;
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

/**
 * Whether this attempt ends this page only: the page itself cannot be loaded,
 * or a run timed out (gc-zees). A run that outlasts PAGESPEED_TIMEOUT_MS means
 * the page is too heavy for Google to finish in time, and the next runs of
 * that page would almost surely time out too, each holding the worker for the
 * full timeout and spending a call. The other page still runs. The page keeps
 * an OK result when an earlier run of it succeeded (buildSpeedPageResult).
 */
export function attemptHaltsPage(a: SpeedAttempt): boolean {
  return a.kind === "error" && (a.code === "document_failed" || a.code === "timeout");
}

/**
 * One PageSpeed run of one page. Re-checks the gate and the key, validates the
 * target, reserves the call against today's budget, then calls Google. NEVER
 * THROWS for a Google-side failure (those are `error` attempts), so a Google
 * error does not make Inngest retry the step and repeat the call. A call can
 * still repeat if the worker dies after it but before the step's result is
 * recorded: at most once (the function has retries: 1), and the repeat
 * reserves its own budget. A DB error before the call (gate/budget) may throw
 * and is retried by the step, which is safe because nothing was sent yet.
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
    // The storefront answered Lighthouse 401: Shopify's password page.
    attempt =
      result.code === "document_failed" && result.documentStatus === 401
        ? { kind: "password" }
        : { kind: "error", code: result.code };
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
 * `targets` null = the URLs could not be resolved: FAILED with `targetsFailure`
 * (no_domain when not given).
 * `passwordProtected` = the pre-check found the password page: every tested
 * page is PASSWORD with no call made.
 */
export async function finalizeSpeedReport(input: {
  reportId: string;
  shopDomain: string;
  origin: SpeedReportOrigin;
  startedAt: string;
  targets: SpeedTargets | null;
  targetsFailure?: TargetsFailure;
  tested: PageAttempts[];
  haltCode?: SpeedFailureCode;
  passwordProtected?: boolean;
}): Promise<{ status: SpeedReportStatus; calls: number }> {
  const calls = input.tested.reduce((n, p) => n + p.attempts.filter(attemptCalledGoogle).length, 0);
  let status: SpeedReportStatus;
  let failureReason: SpeedFailureCode | null = null;
  let pages: SpeedPageResult[] | null = null;

  if (!input.targets) {
    status = SPEED_REPORT_STATUS.FAILED;
    failureReason = input.targetsFailure ?? "no_domain";
  } else {
    pages = input.tested.map((p) =>
      input.passwordProtected
        ? { page: p.page, url: p.url, status: "PASSWORD" as const, runsAttempted: 0, runsOk: 0 }
        : buildSpeedPageResult(p.page, p.url, p.attempts, input.haltCode),
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

/** At most one "not configured" ops event per shop per this window. */
export const NOT_CONFIGURED_EVENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Start a MANUAL speed report for the session shop: at most once per 24h,
 * never while one is already running, Professional only (the caller has
 * already 404ed when the feature is dark). A missing key refuses before the
 * 24h slot is claimed and records the "not configured" ops event at most once
 * an hour per shop (clicks cannot write unbounded events, gc-wt3y #9). If the
 * row cannot be created or the event cannot be sent, the slot is handed back
 * (and a created row closed as FAILED, gc-wt3y #7). The event carries the
 * claim so a run that later dies or is cancelled hands it back too.
 */
export async function requestSpeedReportRunNow(
  shop: { id: string; domain: string; plan: string },
  now: Date,
): Promise<RunNowResult> {
  if (!getPlanFeatures(shop.plan).speedReport)
    return { ok: false, error: RUN_NOW_ERRORS.notInPlan };

  if (!getPageSpeedApiKey()) {
    const since = new Date(now.getTime() - NOT_CONFIGURED_EVENT_WINDOW_MS);
    if (!(await hasRecentSpeedReportEvent(shop.domain, "not_configured", since))) {
      await recordSpeedReportEvent(shop.domain, {
        status: SPEED_REPORT_STATUS.FAILED,
        origin: SPEED_REPORT_ORIGIN.MANUAL,
        calls: 0,
        durationMs: 0,
        reason: "not_configured",
      });
    }
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

  let row: { id: string };
  try {
    row = await createSpeedReport(shop.id, SPEED_REPORT_ORIGIN.MANUAL);
  } catch (err) {
    logger.error("speed report row create failed", {
      function: LOG_FN,
      event: "speed_report_create_failed",
      shopId: shop.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseSpeedReportRunNow(shop.id, now, previous);
    return { ok: false, error: RUN_NOW_ERRORS.dispatch };
  }
  try {
    await inngest.send({
      name: "speed-report/requested",
      data: {
        shopId: shop.id,
        origin: SPEED_REPORT_ORIGIN.MANUAL,
        reportId: row.id,
        runNowClaimedAt: now.toISOString(),
        runNowPrevious: previous ? previous.toISOString() : null,
      },
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
