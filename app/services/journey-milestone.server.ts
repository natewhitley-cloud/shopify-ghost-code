/**
 * Durable journey milestones (gc-dpm.1): firstOpenedAt, firstResultsViewedAt,
 * plus the per-scan results-view stamps (Scan.viewedOnHomeAt /
 * viewedOnScanPageAt) behind the operator digest's result-views line.
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
import { claimScanViewStamp } from "../models/scan.server";
import type { ScanResultsPage } from "../models/scan.server";
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

/**
 * Stamp the first time `page` rendered this scan's RESULTS, if still unset.
 * Callers pass only a SUCCESSFUL scan (owned by `shopId`, the session shop's
 * id) whose results the page renders, and gate on the stamp value they already
 * loaded (null) so a revisit or a 3s poll issues no query. Returns true when
 * this call made the stamp.
 *
 * What counts as a view (by design): a Home tab left open while a scan runs
 * stamps "viewed on Home" when its poll swaps in the finished results, even if
 * nobody is looking; and opening an old scan from the history list stamps a
 * scan-page view for that scan the first time it is opened.
 *
 * NEVER THROWS: failure logs as `scan-results-view-claim-failed`.
 */
export async function recordScanResultsViewOnce(
  scanId: string,
  shopId: string,
  page: ScanResultsPage,
  shopDomain: string,
): Promise<boolean> {
  try {
    return await claimScanViewStamp(scanId, shopId, page);
  } catch (err) {
    logger.error("scan-results-view-claim-failed", {
      shop: shopDomain,
      scanId,
      page,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
