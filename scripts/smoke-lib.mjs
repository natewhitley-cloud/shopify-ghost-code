/**
 * Pure helpers for scripts/smoke.mjs (gc-7y2). Kept in their own module, free
 * of top-level side effects, so they can be unit-tested
 * (tests/scripts/smoke-lib.test.ts). Dependency-free, like smoke.mjs itself.
 */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shortest SHA prefix accepted as a match (git's default abbreviation). */
export const MIN_SHA_PREFIX = 7;

/**
 * Upper bound for the SHA wait/interval env overrides. Keeps a typo'd huge
 * value from overflowing setTimeout (max 2^31-1 ms, else it fires at once).
 */
export const MAX_ENV_MS = 30 * 60_000;

const HEX_SHA = new RegExp(`^[0-9a-fA-F]{${MIN_SHA_PREFIX},}$`);

/**
 * Thrown by a report fetcher for a failure that retrying cannot fix (e.g. a
 * 401/403 from /health/deep). waitForShaMatch stops polling on it at once.
 */
export class PermanentSmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentSmokeError";
  }
}

/**
 * True when both SHAs are hex strings of at least MIN_SHA_PREFIX characters
 * and one is a prefix of the other (CI passes the full SHA; a short SHA on
 * either side still counts). A 1-char or non-hex value never matches.
 *
 * @param {unknown} expected
 * @param {unknown} deployed
 * @returns {boolean}
 */
export function shaMatches(expected, deployed) {
  if (typeof expected !== "string" || typeof deployed !== "string") return false;
  if (!HEX_SHA.test(expected) || !HEX_SHA.test(deployed)) return false;
  return expected.startsWith(deployed) || deployed.startsWith(expected);
}

/**
 * Parse an env var as a positive integer, falling back to `fallback` when it is
 * unset, empty, or anything other than a positive whole number, and clamping
 * it to `max`.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} [max]
 * @returns {number}
 */
export function parsePositiveIntEnv(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!(value > 0)) return fallback;
  return Math.min(value, max);
}

/**
 * Validate a /health/deep response into a report. 401/403 is PERMANENT (a
 * wrong/missing HEALTH_CHECK_TOKEN will not fix itself by retrying); a
 * non-JSON body or one without `deployedSha` is a retryable Error. Never puts
 * the token value in a message.
 *
 * @param {number} httpStatus
 * @param {unknown} body parsed JSON, or undefined when the body was not JSON
 * @param {{ tokenSet: boolean }} opts
 * @returns {{ httpStatus: number, body: Record<string, any> }}
 */
export function toDeepReport(httpStatus, body, { tokenSet }) {
  if (httpStatus === 401 || httpStatus === 403) {
    throw new PermanentSmokeError(
      `unauthorized (HTTP ${httpStatus}): check HEALTH_CHECK_TOKEN${tokenSet ? "" : " (not set)"}`,
    );
  }
  if (body === null || typeof body !== "object") {
    throw new Error(`non-JSON response (HTTP ${httpStatus})`);
  }
  if (!("deployedSha" in body)) {
    throw new Error(`HTTP ${httpStatus}${body.message ? `: ${body.message}` : ""}`);
  }
  return { httpStatus, body };
}

/**
 * Decide the deep-health gate from ONE report. Passes only when the body says
 * "ok" with HTTP 200 and, if `expectedSha` is set, its deployedSha matches.
 * With `expectedSha` unset the SHA is reported "unverified" (warn-only).
 *
 * @param {{ httpStatus: number, body: Record<string, any> }} report
 * @param {string | undefined} expectedSha
 * @returns {
 *   | { ok: true, sha: "match" | "unverified", deployedSha: unknown }
 *   | { ok: false, reason: string }
 * }
 */
export function evaluateDeepGate({ httpStatus, body }, expectedSha) {
  if (body.status !== "ok" || httpStatus !== 200) {
    return {
      ok: false,
      reason: `Smoke test failed — status "${body.status}"${body.message ? `: ${body.message}` : ""}`,
    };
  }
  const deployedSha = body.deployedSha ?? null;
  if (shaMatches(expectedSha, deployedSha)) return { ok: true, sha: "match", deployedSha };
  if (expectedSha) {
    return {
      ok: false,
      reason: `SHA pin mismatch — expected ${expectedSha}, got ${deployedSha ?? "null"}`,
    };
  }
  return { ok: true, sha: "unverified", deployedSha };
}

/**
 * Poll `fetchReport` until its body's deployedSha matches `expectedSha`, or
 * until `timeoutMs` has elapsed. Railway keeps routing to the old container for
 * a short while after the new one is up, so a single read can see the previous
 * SHA even on a good deploy. Returns the exact report that matched so callers
 * gate on that response instead of re-requesting (which could hit the old
 * container again mid-swap).
 *
 * Always makes at least one attempt, and one final attempt at the deadline.
 * A thrown Error (network, non-JSON, 5xx) is retried like a mismatch; a thrown
 * PermanentSmokeError stops at once. Never sleeps past the deadline.
 *
 * @param {object} opts
 * @param {string} opts.expectedSha
 * @param {() => Promise<{ httpStatus: number, body: Record<string, any> }>} opts.fetchReport
 * @param {number} opts.timeoutMs
 * @param {number} opts.intervalMs
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(info: { attempt: number, lastSeen: unknown, lastError: string | null }) => void} [opts.onRetry]
 * @returns {Promise<
 *   | { ok: true, sha: string, report: { httpStatus: number, body: Record<string, any> }, attempts: number }
 *   | { ok: false, permanent: boolean, lastSeen: unknown, lastError: string | null, attempts: number }
 * >}
 */
export async function waitForShaMatch({
  expectedSha,
  fetchReport,
  timeoutMs,
  intervalMs,
  sleep = defaultSleep,
  now = Date.now,
  onRetry,
}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastSeen = null;
  let lastError = null;

  for (;;) {
    attempts++;
    try {
      const report = await fetchReport();
      lastSeen = report.body.deployedSha ?? null;
      lastError = null;
      if (shaMatches(expectedSha, lastSeen)) {
        return { ok: true, sha: lastSeen, report, attempts };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentSmokeError) {
        return { ok: false, permanent: true, lastSeen, lastError, attempts };
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, permanent: false, lastSeen, lastError, attempts };
    onRetry?.({ attempt: attempts, lastSeen, lastError });
    await sleep(Math.min(intervalMs, remaining));
  }
}
