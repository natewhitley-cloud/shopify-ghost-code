/**
 * Durable journey milestones (gc-dpm.1): firstOpenedAt, firstResultsViewedAt.
 *
 * Each milestone is a once-per-merchant Shop stamp claimed through the SAME
 * atomic helper as the nudge stages (claimShopStamp: updateMany where the column
 * IS NULL), so concurrent first loads stamp exactly once and a later load never
 * moves the timestamp. Callers gate on the value already in their shop metadata
 * (null) so a normal, already-stamped load issues no query at all.
 *
 * NEVER THROWS: a failed claim is logged and reported as "not stamped", so a
 * telemetry problem can never break the loader that called it.
 */
import { logger } from "../lib/logger.server";
import { claimShopStamp } from "../models/shop.server";
import type { JourneyMilestoneColumn } from "../models/shop.server";

/**
 * Stamp `column` for this shop if it is still unset. `shopDomain` must be
 * session.shop unchanged. Returns true when this call made the stamp.
 *
 * Failure logs as `journey-milestone-claim-failed`.
 */
export async function recordJourneyMilestoneOnce(
  column: JourneyMilestoneColumn,
  shopDomain: string,
): Promise<boolean> {
  try {
    return await claimShopStamp(shopDomain, column);
  } catch (err) {
    logger.error("journey-milestone-claim-failed", {
      shop: shopDomain,
      milestone: column,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
