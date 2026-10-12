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
 * Per-call timeout (gc-zees). A mobile Lighthouse run on a typical storefront
 * takes ~30 s at Google, but a heavy one can take far longer (measured
 * 2026-10-11: allbirds.com returned a valid result after 193 s), so 240 s
 * lets heavy stores finish. A timeout ends that page's remaining runs
 * (attemptHaltsPage), so a hopeless page holds the (concurrency 1) worker for
 * one timeout, not three.
 *
 * Ceilings this must stay under: the worker's 45 m finish timeout (worst case
 * 6 calls x 240 s = 24 m) and the host's HTTP limits: each call runs inside
 * one Inngest step request, which answers only when the step ends. Node's
 * server timeouts only bound receiving the request, but Railway's proxy is
 * reported to cut a response that sends nothing for 5 minutes (15 m hard
 * max). Do not raise this much past ~270 s without streaming the response.
 */
export const PAGESPEED_TIMEOUT_MS = 240_000;

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
  | {
      ok: false;
      code: PageSpeedErrorCode;
      httpStatus: number | null;
      /**
       * document_failed only: the HTTP status the STOREFRONT answered
       * Lighthouse with, when Google's message names it ("(Status code: 401)").
       * A number, never Google's text.
       */
      documentStatus?: number;
    };

/**
 * Lighthouse runtime error codes meaning "the page itself could not be
 * loaded/rendered" (bad URL, DNS, 4xx/5xx document, no paint), as opposed to a
 * PageSpeed outage. Matched in `lighthouseResult.runtimeError.code` and in
 * Google's error message ("Lighthouse returned error: FAILED_DOCUMENT_REQUEST").
 */
const DOCUMENT_FAILURE_RE =
  /\b(FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|NO_FCP|NO_LCP|NOT_HTML|PAGE_HUNG|INSECURE_DOCUMENT_REQUEST|CRI_TIMEOUT|NO_NAVSTART|PROTOCOL_TIMEOUT)\b/;

/** Lighthouse's "(Status code: 401)" suffix on a document failure message. */
const DOCUMENT_STATUS_RE = /\(Status code: (\d{3})\)/;

/** The storefront status a Lighthouse message names, if any. */
function documentStatusOf(message: string): { documentStatus: number } | Record<string, never> {
  const match = DOCUMENT_STATUS_RE.exec(message);
  return match ? { documentStatus: Number(match[1]) } : {};
}

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
  const runtimeError = (lhr as { runtimeError?: { code?: unknown; message?: unknown } })
    .runtimeError;
  // Lighthouse can report `runtimeError: { code: "NO_ERROR" }` on a good run.
  if (
    runtimeError &&
    typeof runtimeError.code === "string" &&
    runtimeError.code !== "" &&
    runtimeError.code !== "NO_ERROR"
  ) {
    const message = typeof runtimeError.message === "string" ? runtimeError.message : "";
    return { ok: false, code: "document_failed", httpStatus: 200, ...documentStatusOf(message) };
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
      const code = classifyPageSpeedHttpError(response.status, body);
      return {
        ok: false,
        code,
        httpStatus: response.status,
        ...(code === "document_failed" ? documentStatusOf(errorMessageOf(body)) : {}),
      };
    }
    if (body === null) return { ok: false, code: "bad_response", httpStatus: response.status };
    return classifyPageSpeedBody(body);
  } finally {
    clearTimeout(timer);
  }
}
