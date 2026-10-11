/**
 * Google PageSpeed Insights v5 client (gc-wt3y store speed report).
 *
 * One call = one Lighthouse run of one public storefront URL, mobile,
 * performance category only. NEVER THROWS: every failure is a short code the
 * worker maps to merchant copy (speedFailureMessage).
 *
 * Secrets: the API key rides in the request query (`key=`), so the request URL
 * is built here, handed to fetch, and never returned, logged or put in an
 * error. Callers log the tested page's host and the outcome code only. Google's
 * error text is never surfaced (it can echo the request).
 */

import type { SpeedFailureCode } from "../lib/speed-report";

export const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Per-call timeout. A mobile Lighthouse run on a heavy storefront routinely
 * takes 20-40 s at Google; 90 s leaves headroom without letting one call hold
 * the (concurrency 1) worker for long.
 */
export const PAGESPEED_TIMEOUT_MS = 90_000;

/** A PageSpeed response larger than this is refused (they are ~1-3 MB). */
export const PAGESPEED_MAX_RESPONSE_CHARS = 25_000_000;

/** Minimal fetch shape (global fetch, or a test double). */
export type PageSpeedFetch = (
  url: string,
  init: { method: "GET"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export type PageSpeedErrorCode = Extract<
  SpeedFailureCode,
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "server_error"
  | "document_failed"
  | "network"
  | "bad_response"
>;

export type PageSpeedCallResult =
  | { ok: true; lighthouse: unknown }
  | { ok: false; code: PageSpeedErrorCode; httpStatus: number | null };

/**
 * Lighthouse runtime error codes meaning "the page itself could not be
 * loaded/rendered" (bad URL, DNS, 4xx/5xx document, no paint), as opposed to a
 * PageSpeed outage. Matched in `lighthouseResult.runtimeError.code` and in
 * Google's error message ("Lighthouse returned error: FAILED_DOCUMENT_REQUEST").
 */
const DOCUMENT_FAILURE_RE =
  /\b(FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|NO_FCP|NO_LCP|NOT_HTML|PAGE_HUNG|INSECURE_DOCUMENT_REQUEST|CRI_TIMEOUT|NO_NAVSTART|PROTOCOL_TIMEOUT)\b/;

/** Build the PageSpeed request URL. Exported for tests; never log its result. */
export function buildPageSpeedRequestUrl(pageUrl: string, apiKey: string): string {
  const params = new URLSearchParams({
    url: pageUrl,
    strategy: "mobile",
    category: "performance",
    key: apiKey,
  });
  return `${PAGESPEED_ENDPOINT}?${params.toString()}`;
}

function errorMessageOf(body: unknown): string {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === "string" ? err.message : "";
}

/**
 * Classify a parsed PageSpeed body: a usable lighthouseResult, a Lighthouse
 * runtime error (the page could not be loaded), or not a PageSpeed result.
 */
export function classifyPageSpeedBody(body: unknown): PageSpeedCallResult {
  const lhr = (body as { lighthouseResult?: unknown } | null)?.lighthouseResult;
  if (!lhr || typeof lhr !== "object") {
    return { ok: false, code: "bad_response", httpStatus: 200 };
  }
  const runtimeError = (lhr as { runtimeError?: { code?: unknown } }).runtimeError;
  if (runtimeError && typeof runtimeError.code === "string" && runtimeError.code !== "") {
    return { ok: false, code: "document_failed", httpStatus: 200 };
  }
  return { ok: true, lighthouse: lhr };
}

/** Map a non-2xx PageSpeed response to a failure code. */
export function classifyPageSpeedHttpError(status: number, body: unknown): PageSpeedErrorCode {
  if (status === 429) return "rate_limited";
  if (DOCUMENT_FAILURE_RE.test(errorMessageOf(body))) return "document_failed";
  if (status >= 500) return "server_error";
  return "http_error";
}

/**
 * Run PageSpeed once for `pageUrl`. The caller has already validated the URL
 * (https, the shop's own primary domain) and reserved the call against the
 * daily budget.
 */
export async function callPageSpeed(
  pageUrl: string,
  opts: { apiKey: string; fetchImpl?: PageSpeedFetch; timeoutMs?: number },
): Promise<PageSpeedCallResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as PageSpeedFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGESPEED_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(buildPageSpeedRequestUrl(pageUrl, opts.apiKey), {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } catch {
      return {
        ok: false,
        code: controller.signal.aborted ? "timeout" : "network",
        httpStatus: null,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return {
        ok: false,
        code: controller.signal.aborted ? "timeout" : "network",
        httpStatus: response.status,
      };
    }
    if (text.length > PAGESPEED_MAX_RESPONSE_CHARS) {
      return { ok: false, code: "bad_response", httpStatus: response.status };
    }

    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        code: classifyPageSpeedHttpError(response.status, body),
        httpStatus: response.status,
      };
    }
    if (body === null) return { ok: false, code: "bad_response", httpStatus: response.status };
    return classifyPageSpeedBody(body);
  } finally {
    clearTimeout(timer);
  }
}
