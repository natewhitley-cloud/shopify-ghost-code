/**
 * Pure helpers for scripts/smoke.mjs (gc-7y2). Kept in their own module, free
 * of top-level side effects, so they can be unit-tested
 * (tests/scripts/smoke-lib.test.ts). Dependency-free, like smoke.mjs itself.
 */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when both SHAs are present and one is a prefix of the other (CI passes
 * the full SHA; a short SHA on either side still counts as a match).
 *
 * @param {string | null | undefined} expected
 * @param {string | null | undefined} deployed
 * @returns {boolean}
 */
export function shaMatches(expected, deployed) {
  return (
    Boolean(expected) &&
    Boolean(deployed) &&
    (expected.startsWith(deployed) || deployed.startsWith(expected))
  );
}

/**
 * Parse an env var as a positive integer, falling back to `fallback` when it is
 * unset, empty, or anything other than a positive whole number.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveIntEnv(raw, fallback) {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value > 0 ? value : fallback;
}

/**
 * Poll `fetchSha` until it returns a SHA matching `expectedSha`, or until
 * `timeoutMs` has elapsed. Railway keeps routing to the old container for a
 * short while after the new one is up, so a single read can see the previous
 * SHA even on a good deploy.
 *
 * Always makes at least one attempt, and one final attempt at the deadline.
 * A thrown `fetchSha` (network error, non-JSON, auth failure) is retried like
 * a mismatch. Never sleeps past the deadline.
 *
 * @param {object} opts
 * @param {string} opts.expectedSha
 * @param {() => Promise<string | null>} opts.fetchSha
 * @param {number} opts.timeoutMs
 * @param {number} opts.intervalMs
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(info: { attempt: number, lastSeen: string | null, lastError: string | null }) => void} [opts.onRetry]
 * @returns {Promise<
 *   | { ok: true, sha: string, attempts: number }
 *   | { ok: false, lastSeen: string | null, lastError: string | null, attempts: number }
 * >}
 */
export async function waitForShaMatch({
  expectedSha,
  fetchSha,
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
      lastSeen = await fetchSha();
      lastError = null;
      if (shaMatches(expectedSha, lastSeen)) return { ok: true, sha: lastSeen, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, lastSeen, lastError, attempts };
    onRetry?.({ attempt: attempts, lastSeen, lastError });
    await sleep(Math.min(intervalMs, remaining));
  }
}
