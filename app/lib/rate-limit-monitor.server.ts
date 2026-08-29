/**
 * Rate-limit module: throttle parsing, proximity alerting, and backoff.
 *
 * This is the single home for everything that reads Shopify's GraphQL
 * `extensions.cost.throttleStatus`:
 *
 *   - {@link parseThrottleStatus}  — extract the throttle block once.
 *   - {@link checkThrottleStatus} / {@link checkThrottleStatusFromExtensions}
 *                                  — operational alerting (warn/error logs).
 *   - {@link checkRateLimit}       — proactive backoff: sleep when headroom is
 *                                    low so the next request does not throttle.
 *   - {@link isThrottledError}     — classify a GraphQL error as THROTTLED so a
 *                                    paginated fetch can retry instead of fail.
 *
 * Alerting is an operational signal only — no database writes, no in-memory
 * state. Backoff sleeps the current async task; callers `await` it after each
 * paginated page.
 *
 * Thresholds (alerting):
 *   < 20% remaining  →  logger.warn  (rate-limit-proximity)
 *   <  5% remaining  →  logger.error (rate-limit-critical) → forwarded to Sentry
 */

import { logger } from "./logger.server";
import { recordApiError } from "../models/ops-event.server";

/** Shape of the throttleStatus block inside GraphQL response extensions. */
export type ThrottleStatus = {
  currentlyAvailable: number;
  maximumAvailable: number;
  restoreRate: number;
};

/**
 * Loosely-parsed throttle block. Each field is present only when it was a
 * number in the response; absent/non-numeric fields are dropped so callers can
 * decide whether to require them.
 */
export type ParsedThrottleStatus = {
  currentlyAvailable?: number;
  maximumAvailable?: number;
  restoreRate?: number;
};

const WARN_THRESHOLD = 0.2; // 20% remaining
const ERROR_THRESHOLD = 0.05; // 5% remaining

/**
 * Below this many query-cost points of headroom, {@link checkRateLimit} sleeps
 * to let the bucket refill before the next request.
 */
const RATE_LIMIT_THRESHOLD = 100;

/** Default restore rate (points/sec) assumed when the response omits it. */
const DEFAULT_RESTORE_RATE = 50;

/**
 * Extract the `cost.throttleStatus` block from a raw GraphQL `extensions`
 * value. The single parser shared by alerting and backoff (QLT-4).
 *
 * @param extensions  Raw extensions value from a GraphQL JSON response.
 * @returns A {@link ParsedThrottleStatus} with only the numeric fields that
 *          were present, or `null` if no throttleStatus block exists at all.
 */
export function parseThrottleStatus(extensions: unknown): ParsedThrottleStatus | null {
  const ext = extensions as Record<string, unknown> | null | undefined;
  if (!ext) return null;

  const cost = ext.cost as Record<string, unknown> | null | undefined;
  if (!cost) return null;

  const throttle = cost.throttleStatus as Record<string, unknown> | null | undefined;
  if (!throttle) return null;

  const parsed: ParsedThrottleStatus = {};
  if (typeof throttle.currentlyAvailable === "number") {
    parsed.currentlyAvailable = throttle.currentlyAvailable;
  }
  if (typeof throttle.maximumAvailable === "number") {
    parsed.maximumAvailable = throttle.maximumAvailable;
  }
  if (typeof throttle.restoreRate === "number") {
    parsed.restoreRate = throttle.restoreRate;
  }
  return parsed;
}

/** Minimal shape of a GraphQL error entry we inspect for a THROTTLED code. */
type GraphQLErrorLike = {
  message?: unknown;
  extensions?: { code?: unknown } | null;
};

/**
 * True when a GraphQL error represents a rate-limit (THROTTLED) failure.
 *
 * Shopify returns `extensions.code === "THROTTLED"`; we also match a "throttled"
 * message as a fallback for responses that omit the machine-readable code.
 * Used by the pagination helper to back off and resume rather than fail the
 * whole step (PRF-3).
 */
export function isThrottledError(error: GraphQLErrorLike | null | undefined): boolean {
  if (!error) return false;
  const code = error.extensions?.code;
  if (typeof code === "string" && code.toUpperCase() === "THROTTLED") {
    return true;
  }
  return typeof error.message === "string" && /throttled/i.test(error.message);
}

/**
 * Inspect throttleStatus and sleep if headroom is low, so the next paginated
 * request does not get throttled. Proactive backoff (QLT-4).
 *
 * Previously lived in `theme-fetcher.server.ts` with its own duplicate parser
 * and a hard-coded `[theme-fetcher]` log prefix even when called by the product,
 * content, redirect, and translation fetchers. It now lives here, parses via
 * {@link parseThrottleStatus}, and logs a neutral `[rate-limit]` prefix.
 *
 * @param extensions  Raw extensions object from a GraphQL response.
 * @returns           Currently available query-cost points (after any sleep).
 *                    `Infinity` when the response carries no throttle status.
 */
export async function checkRateLimit(extensions: unknown): Promise<number> {
  const throttle = parseThrottleStatus(extensions);
  if (!throttle) return Infinity;

  const currentlyAvailable = throttle.currentlyAvailable ?? 0;
  const restoreRate = throttle.restoreRate ?? DEFAULT_RESTORE_RATE;

  if (currentlyAvailable < RATE_LIMIT_THRESHOLD) {
    const pointsNeeded = RATE_LIMIT_THRESHOLD - currentlyAvailable;
    const sleepMs = Math.ceil((pointsNeeded / restoreRate) * 1000);
    console.log(
      `[rate-limit] Headroom low (${currentlyAvailable} pts). ` +
        `Sleeping ${sleepMs}ms to restore capacity.`,
    );
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    return RATE_LIMIT_THRESHOLD; // optimistic — we just waited for it
  }

  return currentlyAvailable;
}

/**
 * Check the current throttle status for a shop and log a warning or error
 * if query budget is running low.
 *
 * This function is intentionally synchronous. Alongside structured log output it
 * also records a durable API_ERROR OpsEvent (best-effort, fire-and-forget) so the
 * daily operator digest can count rate-limit errors/warnings; that write never
 * throws and is not awaited, keeping the function synchronous for its callers.
 * Callers should invoke it after each GraphQL response but must not change their
 * control flow based on its return value.
 *
 * @param shopDomain     The myshopify domain of the shop making requests.
 * @param throttleStatus The throttleStatus object from extensions.cost.
 */
export function checkThrottleStatus(shopDomain: string, throttleStatus: ThrottleStatus): void {
  const { currentlyAvailable, maximumAvailable, restoreRate } = throttleStatus;

  // Guard against a zero or negative maximum to avoid division by zero.
  if (maximumAvailable <= 0) return;

  const percentRemaining = currentlyAvailable / maximumAvailable;

  if (percentRemaining < ERROR_THRESHOLD) {
    logger.error("rate-limit-critical", {
      shopDomain,
      available: currentlyAvailable,
      maximum: maximumAvailable,
      percentRemaining: Math.round(percentRemaining * 100),
      restoreRate,
    });
    void recordApiError({
      level: "error",
      code: "rate_limit_critical",
      shopDomain,
      message: "GraphQL rate-limit critical (<5% headroom)",
      metadata: { available: currentlyAvailable, maximum: maximumAvailable },
    });
  } else if (percentRemaining < WARN_THRESHOLD) {
    logger.warn("rate-limit-proximity", {
      shopDomain,
      available: currentlyAvailable,
      maximum: maximumAvailable,
      percentRemaining: Math.round(percentRemaining * 100),
      restoreRate,
    });
    void recordApiError({
      level: "warn",
      code: "rate_limit_proximity",
      shopDomain,
      message: "GraphQL rate-limit proximity (<20% headroom)",
      metadata: { available: currentlyAvailable, maximum: maximumAvailable },
    });
  }
}

/**
 * Extract throttleStatus from a raw GraphQL response extensions block and
 * call checkThrottleStatus if the data is present and well-formed.
 *
 * Silently skips if extensions or throttleStatus are absent — not all GraphQL
 * responses include cost tracking (e.g., mutations may omit it).
 *
 * @param shopDomain  The myshopify domain of the shop making requests.
 * @param extensions  Raw extensions value from a GraphQL JSON response.
 */
export function checkThrottleStatusFromExtensions(shopDomain: string, extensions: unknown): void {
  const throttle = parseThrottleStatus(extensions);
  if (!throttle) return;

  // Alerting needs all three fields; skip silently if any is missing or
  // non-numeric (parseThrottleStatus already dropped non-numeric fields).
  if (
    throttle.currentlyAvailable === undefined ||
    throttle.maximumAvailable === undefined ||
    throttle.restoreRate === undefined
  ) {
    return;
  }

  checkThrottleStatus(shopDomain, {
    currentlyAvailable: throttle.currentlyAvailable,
    maximumAvailable: throttle.maximumAvailable,
    restoreRate: throttle.restoreRate,
  });
}
