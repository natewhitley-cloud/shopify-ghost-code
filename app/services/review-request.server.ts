/**
 * Native App Store review popup (gc-97k.7): record the result the client
 * reported for the attempt the loader already recorded.
 *
 * The results page asks App Bridge for the modal and POSTs the outcome code to
 * app/routes/app.review-request.tsx, which calls this. REVIEW_RESULT_POLICY
 * (app/lib/review-request.ts) decides what the code means:
 *   - terminal: stamp reviewPopupRequestedAt once ever (never requested again).
 *     Only "success" (Shopify displayed the modal) also claims the shop's 24h
 *     prompt slot, in the same statement.
 *   - retryable: set reviewPopupRetryAfter = now + the code's delay, once per
 *     attempt.
 * Only the call whose write wins records telemetry under the `review_request`
 * nudge, so concurrent tabs or a replayed POST count once:
 *   - "success": `shown`.
 *   - any other code: `not_shown` with the code, so the digest can say why.
 *
 * Nothing is recorded about whether the merchant then left a review.
 *
 * NEVER THROWS: a failed write is logged and treated as "not recorded".
 */
import { NUDGE_KEYS, recordNudgeNotShown, recordNudgeShown } from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import type { PromptKey } from "../lib/prompt-cap";
import {
  REVIEW_POPUP_ATTEMPT_COOLDOWN_MS,
  REVIEW_POPUP_MAX_ATTEMPTS,
  REVIEW_RESULT_POLICY,
} from "../lib/review-request";
import type { ReviewRequestCode } from "../lib/review-request";
import {
  claimReviewPopupAttempt,
  recordReviewPopupRetry,
  recordReviewPopupTerminal,
} from "../models/shop.server";

/** The prompt key a displayed popup claims the cap slot under. */
const REVIEW_POPUP_PROMPT: PromptKey = "review_popup";

/**
 * Apply the code's policy and emit its one event. `shopDomain` must be
 * session.shop unchanged (deleteShopData purges the events by it). Returns
 * true when this call's write won (and so recorded the event).
 */
export async function recordReviewRequestResult(
  shopDomain: string,
  code: ReviewRequestCode,
  now: Date,
): Promise<boolean> {
  const policy = REVIEW_RESULT_POLICY[code];
  let recorded: boolean;
  try {
    recorded =
      policy.kind === "terminal"
        ? await recordReviewPopupTerminal(
            shopDomain,
            code,
            now,
            code === "success" ? REVIEW_POPUP_PROMPT : null,
          )
        : await recordReviewPopupRetry(shopDomain, code, new Date(now.getTime() + policy.afterMs));
  } catch (err) {
    logger.error("review-request-record-failed", {
      shop: shopDomain,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!recorded) return false;

  if (code === "success") {
    await recordNudgeShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain);
  } else {
    await recordNudgeNotShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain, code);
  }
  return true;
}

/**
 * Record the ATTEMPT the client is about to make (gc-97k.7). `previous` is the
 * parsed nonce: the last attempt time the loader read. Refuses (false, no
 * write) when that attempt is still inside its 24h cooldown, so a replayed or
 * forged nonce cannot shorten it; otherwise one compare-and-set
 * (claimReviewPopupAttempt) that also refuses a terminal shop or one at 5
 * attempts. True IFF this call recorded it; the client calls the Reviews API
 * only then. NEVER THROWS: a failed write is logged and false.
 */
export async function claimReviewRequestAttempt(
  shopDomain: string,
  previous: Date | null,
  now: Date,
): Promise<boolean> {
  if (previous !== null && now.getTime() - previous.getTime() <= REVIEW_POPUP_ATTEMPT_COOLDOWN_MS) {
    return false;
  }
  try {
    return await claimReviewPopupAttempt(shopDomain, previous, now, REVIEW_POPUP_MAX_ATTEMPTS);
  } catch (err) {
    logger.error("review-request-attempt-claim-failed", {
      shop: shopDomain,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
