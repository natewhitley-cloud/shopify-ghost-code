/**
 * Rate-limit proximity alerting utility.
 *
 * Inspects the throttleStatus returned by Shopify's GraphQL API and logs
 * structured warnings when a shop is close to exhausting its query budget.
 *
 * This is an operational signal only — no database writes, no in-memory state.
 * Call this after every GraphQL response that includes throttle status.
 *
 * Thresholds:
 *   < 20% remaining  →  logger.warn  (rate-limit-proximity)
 *   <  5% remaining  →  logger.error (rate-limit-critical) → forwarded to Sentry
 */

import { logger } from "./logger.server";

/** Shape of the throttleStatus block inside GraphQL response extensions. */
export type ThrottleStatus = {
  currentlyAvailable: number;
  maximumAvailable: number;
  restoreRate: number;
};

const WARN_THRESHOLD = 0.2; // 20% remaining
const ERROR_THRESHOLD = 0.05; // 5% remaining

/**
 * Check the current throttle status for a shop and log a warning or error
 * if query budget is running low.
 *
 * This function is intentionally synchronous and stateless — it has no side
 * effects beyond structured log output. Callers should invoke it after each
 * GraphQL response but must not change their control flow based on its return
 * value.
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
  } else if (percentRemaining < WARN_THRESHOLD) {
    logger.warn("rate-limit-proximity", {
      shopDomain,
      available: currentlyAvailable,
      maximum: maximumAvailable,
      percentRemaining: Math.round(percentRemaining * 100),
      restoreRate,
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
  const ext = extensions as Record<string, unknown> | null | undefined;
  if (!ext) return;

  const cost = ext.cost as Record<string, unknown> | null | undefined;
  if (!cost) return;

  const throttle = cost.throttleStatus as
    | {
        currentlyAvailable?: unknown;
        maximumAvailable?: unknown;
        restoreRate?: unknown;
      }
    | null
    | undefined;
  if (!throttle) return;

  const currentlyAvailable = throttle.currentlyAvailable;
  const maximumAvailable = throttle.maximumAvailable;
  const restoreRate = throttle.restoreRate;

  // Validate all three fields are numbers before calling the core function.
  if (
    typeof currentlyAvailable !== "number" ||
    typeof maximumAvailable !== "number" ||
    typeof restoreRate !== "number"
  ) {
    return;
  }

  checkThrottleStatus(shopDomain, {
    currentlyAvailable,
    maximumAvailable,
    restoreRate,
  });
}
