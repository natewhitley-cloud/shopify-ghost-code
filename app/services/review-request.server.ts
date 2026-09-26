/**
 * Native App Store review popup (gc-97k.7): record the once-ever request.
 *
 * The results page asks App Bridge for the modal and POSTs the outcome code to
 * app/routes/app.review-request.tsx, which calls this. The shop's
 * reviewPopupRequestedAt stamp is claimed atomically (claimShopStamp), and
 * only the call that wins it records telemetry under the `review_request`
 * nudge, so concurrent tabs or a replayed POST count once:
 *   - code "success" (Shopify displayed the modal): `shown`.
 *   - any other code: `not_shown` with the code, so the digest can say why.
 *
 * Nothing is recorded about whether the merchant then left a review.
 *
 * NEVER THROWS: a failed claim is logged and treated as "not first".
 */
import { NUDGE_KEYS, recordNudgeNotShown, recordNudgeShown } from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import type { ReviewRequestCode } from "../lib/review-request";
import { claimShopStamp } from "../models/shop.server";

/**
 * Stamp the request and emit its one event. `shopDomain` must be session.shop
 * unchanged (deleteShopData purges the events by it). Returns true when this
 * call won the stamp (and so recorded the event).
 */
export async function recordReviewRequestResult(
  shopDomain: string,
  code: ReviewRequestCode,
): Promise<boolean> {
  let claimed: boolean;
  try {
    claimed = await claimShopStamp(shopDomain, "reviewPopupRequestedAt");
  } catch (err) {
    logger.error("review-request-claim-failed", {
      shop: shopDomain,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!claimed) return false;

  if (code === "success") {
    await recordNudgeShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain);
  } else {
    await recordNudgeNotShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain, code);
  }
  return true;
}
