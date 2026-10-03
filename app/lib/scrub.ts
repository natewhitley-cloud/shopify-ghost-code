/**
 * PII scrub — the redaction boundary for every structured log line (gc-t7o2,
 * ported from FraudPilot ft-h6o/ft-edm; ClearSignal ba-cvz7 has the same
 * module). Keep the three copies in step when changing the rules here.
 */

/**
 * Key substrings whose VALUE is always redacted (case-insensitive, substring
 * match). Deliberately broad: over-redaction is the safe failure mode at a
 * compliance boundary. NOTE the `ip` substring also matches keys like
 * `description`/`shipping` — intentional; we would rather redact a benign
 * field than leak an address.
 */
const REDACT_KEY_SUBSTRINGS = [
  "ip",
  "ipaddress",
  "email",
  "visitorid",
  "accesstoken",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "secret",
  "password",
  "sessiontoken",
  // Shopify embedded-load query params (ft-h6o): `hmac` signs the request,
  // `session` identifies it. (`id_token` is already covered by "token".)
  "hmac",
  "session",
];

const REDACTED = "[REDACTED]";

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_REGEX = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Broad IPv6 matcher: any run of 2+ colon-separated hex groups, with the
// empty-group form ({0,4}) covering "::" compression. Deliberately broad —
// over-redacting e.g. an "HH:MM:SS" time in a context value is the accepted
// safe failure mode here; NEVER leaking an address is the requirement. This
// replaces a hand-rolled alternation that leaked the tail of compressed forms
// like fe80::a6db:30ff:fe98:e946 (adversarial audit, 2026-08-17).
const IPV6_REGEX = /(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}/g;

// A URL query param: separator, name, value (value ends at the next param,
// fragment, whitespace or quote). Logged URLs (e.g. `request.url` on an SSR
// failure) carry Shopify's `id_token` JWT, `hmac` and `session` here.
const QUERY_PARAM_REGEX = /([?&])([^=&#\s"']+)=([^&#\s"']*)/g;

// Strings are capped BEFORE the regexes run: email/IPv4/IPv6/query matching is
// quadratic on long separator-free input (~7s on 100KB), and every log line
// now passes through here (ft-h6o audit L1).
const MAX_SCRUB_CHARS = 16 * 1024;

// A stack frame's trailing `:line:col` (digits only, so never an address).
// Kept intact so the IPv6 matcher can't eat it (ft-h6o audit M2).
const STACK_FRAME_TAIL = /^(\s*at .*?)(:\d+:\d+\)?)$/;

const MAX_DEPTH = 4;
const MAX_SERIALIZED_BYTES = 8 * 1024;
/**
 * Size cap for a log line's meta (FraudPilot ft-edm audit M3): larger than the
 * 8 KB default so a long id list is not cut to a preview.
 */
export const MAX_LOG_META_BYTES = 32 * 1024;

/** Keys preserved intact at the top level — identifiers/grouping keys, not PII
 * (`shopId` is our own opaque cuid, `code` is a stable grouping code). */
const PRESERVED_KEYS = new Set(["shopId", "code"]);

/**
 * Top-level operational keys exempt from the KEY rule only (as in ClearSignal
 * ba-cvz7): counters and states whose names collide with a fragment ("ip" in
 * sk-IP-ped/scr-IP-t/subscr-IP-tion, "token" in the token-health flags). Their
 * VALUES are still scrubbed. A key not listed here is redacted, which is the
 * safe failure mode: add it here when an operational field shows up as
 * [REDACTED].
 */
const OPERATIONAL_KEYS = new Set([
  "skipped",
  "skippedFiles",
  "skippedCategories",
  "benignLibrarySkips",
  "unknownScriptCount",
  "activeSubscriptionCount",
  "hasRefreshToken",
  "tokenExpired",
]);

function keyIsSensitive(key: string): boolean {
  // Strip separators so `X-Api-Key` / `api_key` / `session-token` still match
  // the separator-free fragments (a hyphen otherwise breaks the substring).
  const lower = key.toLowerCase().replace(/[-_]/g, "");
  return REDACT_KEY_SUBSTRINGS.some((frag) => lower.includes(frag));
}

/** URL-decode for matching; a malformed escape matches raw. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Replace any email / IPv4 / IPv6 substring inside a string with [REDACTED],
 * and the value of any URL query param whose NAME is sensitive (same rule as
 * object keys), e.g. `?id_token=eyJ...` -> `?id_token=[REDACTED]`. A param
 * whose (decoded) VALUE scrubs to something different is redacted whole: it
 * nests a URL carrying its own secrets, e.g. Shopify's session-token bounce
 * `?shopify-reload=https%3A...%26id_token%3DeyJ...` (ft-h6o audit M1).
 * Strings over 16 KB are truncated first (see MAX_SCRUB_CHARS).
 */
export function scrubString(value: string): string {
  return scrubStringAt(value, 0);
}

// Nested-URL levels inspected before a param value is redacted whole: the
// recursion below would otherwise overflow the stack on crafted input like
// "?a=?a=?a=..." (ft-edm M1).
const MAX_PARAM_NESTING = 3;

function scrubStringAt(value: string, depth: number): string {
  const capped =
    value.length > MAX_SCRUB_CHARS ? `${value.slice(0, MAX_SCRUB_CHARS)}...[truncated]` : value;
  return capped
    .replace(QUERY_PARAM_REGEX, (match, sep: string, name: string, paramValue: string) => {
      if (keyIsSensitive(safeDecode(name))) return `${sep}${name}=${REDACTED}`;
      if (depth >= MAX_PARAM_NESTING) return `${sep}${name}=${REDACTED}`;
      const decoded = safeDecode(paramValue);
      return scrubStringAt(decoded, depth + 1) !== decoded ? `${sep}${name}=${REDACTED}` : match;
    })
    .replace(EMAIL_REGEX, REDACTED)
    .replace(IPV4_REGEX, REDACTED)
    .replace(IPV6_REGEX, REDACTED);
}

/**
 * scrubString for a stack trace, line by line, keeping each frame's trailing
 * digits-only `:line:col` so production stacks stay pinpointable.
 */
export function scrubStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => {
      const frame = STACK_FRAME_TAIL.exec(line);
      return frame ? scrubString(frame[1]) + frame[2] : scrubString(line);
    })
    .join("\n");
}

/**
 * Recursively sanitize a single value. `key` drives key-based redaction; pass
 * `""` for array elements (no key). Never throws: depth cap, circular-ref
 * guard, and non-serializable replacement all fail safe.
 */
function scrubValue(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (key && keyIsSensitive(key)) {
    return REDACTED;
  }

  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;
  if (type === "string") {
    return scrubString(value as string);
  }
  if (type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint") {
    return (value as bigint).toString();
  }
  if (type === "function" || type === "symbol") {
    return "[unserializable]";
  }

  // Dates and Errors have no enumerable fields, so the object walk below would
  // log them as `{}` (ft-h6o audit L2).
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }

  if (type === "object") {
    if (depth >= MAX_DEPTH) {
      return "[truncated]";
    }
    if (seen.has(value as object)) {
      return "[Circular]";
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((el) => scrubValue("", el, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(k, v, depth + 1, seen);
    }
    return out;
  }

  return "[unserializable]";
}

/** JSON.stringify that never throws (values are already JSON-safe post-scrub). */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Sanitize an ErrorContext before it is logged OR stored. Pure function, never
 * throws on any input. Top-level `shopId`/`code` are preserved intact; every
 * other value is key-redacted or value-scrubbed and recursed. Enforces a depth
 * cap and a serialized-size cap, `maxBytes` (8 KB by default; the logger passes
 * MAX_LOG_META_BYTES). Over-cap payloads collapse to a truncation marker rather
 * than storing a huge blob. Top-level OPERATIONAL_KEYS skip only the key rule.
 */
export function scrubContext(
  ctx?: Record<string, unknown>,
  maxBytes: number = MAX_SERIALIZED_BYTES,
): Record<string, unknown> {
  if (!ctx || typeof ctx !== "object") {
    return {};
  }

  // Never throws (documented contract): a throwing getter on any property
  // would otherwise propagate out of Object.entries. Any failure falls back to
  // an empty object rather than crashing the caller's capture path.
  try {
    const seen = new WeakSet<object>();
    seen.add(ctx); // a direct self-reference resolves to "[Circular]"
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx)) {
      if (PRESERVED_KEYS.has(key)) {
        out[key] = value;
        continue;
      }
      // An empty key skips the key rule; nested keys are still checked.
      out[key] = scrubValue(OPERATIONAL_KEYS.has(key) ? "" : key, value, 0, seen);
    }

    const serialized = safeStringify(out);
    if (serialized.length > maxBytes) {
      return {
        _truncated: true,
        _bytes: serialized.length,
        preview: serialized.slice(0, maxBytes),
      };
    }
    return out;
  } catch {
    return {};
  }
}
