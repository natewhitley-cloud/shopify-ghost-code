/**
 * Client-error telemetry core (gc-nn6). Pure and client-safe: no DOM, no IO.
 *
 * Shared by BOTH ends of the pipe, so there is one privacy contract:
 *   - the browser reporter (client-error-reporter.ts) sanitizes and gates each
 *     report before beaconing it, and
 *   - the server action (routes/app.client-error.tsx) re-runs the SAME
 *     sanitizer on whatever arrived, because the client is never trusted.
 *
 * What a stored report may contain: an error kind, a message (<= 300 chars),
 * the top 5 stack frames (each <= 200 chars), the App page path, an HTTP
 * status for fetch failures, and (server-derived) a browser family. URLs keep
 * their path but lose query strings and hashes; JWTs, bearer tokens and email
 * addresses are redacted. No shop, user, or customer data is accepted from the
 * client: the shop comes from the session on the server.
 */

/** Where the reporter beacons to; the reporter never reports this path itself. */
export const CLIENT_ERROR_ENDPOINT = "/app/client-error";

export const CLIENT_ERROR_LIMITS = {
  messageChars: 300,
  stackFrames: 5,
  frameChars: 200,
  pathChars: 200,
  /** Distinct reports one page load may send. */
  beaconsPerPage: 5,
} as const;

export const CLIENT_ERROR_KINDS = ["error", "rejection", "boundary", "fetch"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export function isClientErrorKind(value: unknown): value is ClientErrorKind {
  return typeof value === "string" && (CLIENT_ERROR_KINDS as readonly string[]).includes(value);
}

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  path: string;
  stack?: string;
  status?: number;
}

export const BROWSER_FAMILIES = [
  "chrome",
  "edge",
  "firefox",
  "safari",
  "opera",
  "samsung",
  "other",
] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

// The body of a query string or fragment: runs until whitespace, a quote or a
// paren. A `:` is part of the query (and removed with it) EXCEPT where it
// begins a trailing `:line` / `:line:col` (digits) followed by whitespace, a
// closing paren, a quote or end of string, so a stack frame's position
// survives while `?token=abc:secret-tail` or a nested `?r=https://y/z?k=v`
// is removed whole. Every alternative consumes exactly one char, so this is
// linear per start position.
const QUERY_BODY = String.raw`(?:[^\s'"():]|:(?!\d+(?::\d+)?(?=[\s)'"]|$)))*`;
// A URL's query string or fragment: from `?`/`#` per QUERY_BODY.
const URL_QUERY = new RegExp(
  String.raw`(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"()]+)[?#]` + QUERY_BODY,
  "gi",
);
// A query string on a bare path (e.g. "GET /app/x.data?shop=..."). The path
// must start the text or follow whitespace, `(`, a quote, `[`, `=` or `,`
// (kept in the output).
const PATH_QUERY = new RegExp(String.raw`(^|[\s('"\[=,])(\/[^\s?#'"()]*)[?#]` + QUERY_BODY, "g");
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
// Shopify Admin API tokens (shpat_, shpca_, shppa_, shpss_).
const SHOPIFY_TOKEN = /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{16,}/g;
// Scrub at most this much raw input: the regexes above are linear per start
// position but not overall, so unbounded input could stall the event loop or
// a browser tab (audit M1). Generous vs the 300-char stored message.
const SCRUB_INPUT_CHARS = 2000;

/**
 * Remove the parts of free text that could carry secrets or personal data:
 * URL query strings and hashes (path kept), JWTs (App Bridge session tokens),
 * Shopify access tokens, bearer tokens, and email addresses. Only the first
 * SCRUB_INPUT_CHARS are kept.
 */
export function scrubText(text: string): string {
  return text
    .slice(0, SCRUB_INPUT_CHARS)
    .replace(JWT, "[redacted]")
    .replace(SHOPIFY_TOKEN, "[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(EMAIL, "[email]")
    .replace(URL_QUERY, "$1")
    .replace(PATH_QUERY, "$1$2");
}

/** A scrubbed, whitespace-collapsed message of at most 300 chars; "" if not a string. */
export function sanitizeMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Scrub BEFORE truncating so a cut can never leave half a query string behind.
  return scrubText(raw).replace(/\s+/g, " ").trim().slice(0, CLIENT_ERROR_LIMITS.messageChars);
}

// A stack frame line: V8 "at fn (url:l:c)" or Firefox/Safari "fn@url:l:c".
const FRAME = /^at\s|@/;

/**
 * The top 5 stack frames, each scrubbed and capped, joined by newlines.
 * Non-frame lines (V8's leading "TypeError: message") are dropped. Undefined
 * when there are no frames.
 */
export function sanitizeStack(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const frames = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line))
    .slice(0, CLIENT_ERROR_LIMITS.stackFrames)
    .map((line) => scrubText(line).slice(0, CLIENT_ERROR_LIMITS.frameChars));
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/**
 * An absolute path with no query string or hash, at most 200 chars. Accepts a
 * full http(s) URL (its pathname is kept). "" for anything else.
 */
export function sanitizePath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let path = raw;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return "";
    }
  }
  path = path.split(/[?#]/, 1)[0];
  if (!path.startsWith("/")) return "";
  return path.slice(0, CLIENT_ERROR_LIMITS.pathChars);
}

/** An integer HTTP status in 0..599 (0 = network failure), else undefined. */
export function sanitizeStatus(raw: unknown): number | undefined {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 599 ? n : undefined;
}

/**
 * Whether an HTTP status is worth reporting: a network failure (0) or any
 * 4xx/5xx EXCEPT 401. A 401 is App Bridge's session-token re-auth handshake
 * (it retries with a fresh token); a persistent auth failure would also
 * block the beacon itself, so reporting it can never succeed anyway.
 */
export function isReportableStatus(status: number): boolean {
  return status === 0 || (status >= 400 && status !== 401);
}

/**
 * Validate + sanitize an untrusted report. Only the known fields are read
 * (anything else, e.g. a client-supplied shop, is dropped). Null when the
 * kind is unknown or the message is empty after sanitizing.
 */
export function sanitizeClientErrorReport(raw: Record<string, unknown>): ClientErrorReport | null {
  if (!isClientErrorKind(raw.kind)) return null;
  const message = sanitizeMessage(raw.message);
  if (message === "") return null;
  const report: ClientErrorReport = { kind: raw.kind, message, path: sanitizePath(raw.path) };
  const stack = sanitizeStack(raw.stack);
  if (stack !== undefined) report.stack = stack;
  const status = sanitizeStatus(raw.status);
  if (status !== undefined) report.status = status;
  return report;
}

/**
 * Per-page-load dedupe + rate limit. `admit` returns true the first time a
 * report with a given kind + message + path + status is seen, up to `max`
 * distinct reports; duplicates never spend the budget. The stack is NOT part
 * of the identity, so one error thrown from several call sites counts once.
 */
export function createReportGate(max: number = CLIENT_ERROR_LIMITS.beaconsPerPage) {
  const seen = new Set<string>();
  return {
    admit(report: ClientErrorReport): boolean {
      const id = [report.kind, report.message, report.path, report.status ?? ""].join("|");
      if (seen.has(id) || seen.size >= max) return false;
      seen.add(id);
      return true;
    },
  };
}

/**
 * Coarse browser family from a User-Agent header (server-side: the request's
 * own header, never a client-supplied field). Order matters: Edge, Opera and
 * Samsung all also claim "Chrome", and Chrome/Firefox on iOS claim "Safari".
 */
export function browserFamily(userAgent: string | null | undefined): BrowserFamily {
  const ua = userAgent ?? "";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "opera";
  if (/\bSamsungBrowser\//.test(ua)) return "samsung";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "firefox";
  if (/\bChrome\/|\bCriOS\//.test(ua)) return "chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "safari";
  return "other";
}
