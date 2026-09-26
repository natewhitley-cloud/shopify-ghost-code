/**
 * Native App Store review popup (gc-97k.7), the review-request action's two
 * writes:
 *
 * claimReviewRequestAttempt (intent=attempt): right before the client asks
 * App Bridge, record the attempt AND claim the shop's 24h prompt slot for the
 * popup, in one compare-and-set (claimReviewPopupAttempt). Claiming at attempt
 * time closes the gap in which another prompt could take the slot while the
 * modal is open, so two prompts can never show within 24h.
 *
 * recordReviewRequestResult (the result report): REVIEW_RESULT_POLICY
 * (app/lib/review-request.ts) decides what the code means:
 *   - terminal: stamp reviewPopupRequestedAt once ever (never requested again);
 *   - retryable: set reviewPopupRetryAfter = now + the code's delay, once per
 *     attempt.
 * The slot: "success" (Shopify displayed the modal) KEEPS the slot the attempt
 * took; any other code hands it back to the holder it replaced
 * (releaseReviewPopupSlot, compare-and-set so a newer holder is never
 * clobbered). A LOST report keeps the slot for its 24h: accepted, the modal
 * may well have been shown.
 * Only the call whose write wins records telemetry under the `review_request`
 * nudge, so concurrent tabs or a replayed POST count once:
 *   - "success": `shown`.
 *   - any other code: `not_shown` with the code, so the digest can say why.
 *
 * Nothing is recorded about whether the merchant then left a review.
 *
 * NEVER THROWS: a failed read or write is logged and treated as "not recorded".
 */
import { NUDGE_KEYS, recordNudgeNotShown, recordNudgeShown } from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import { isPromptWindowOpen } from "../lib/prompt-cap";
import type { PromptKey } from "../lib/prompt-cap";
import {
  isReviewPopupEligible,
  REVIEW_POPUP_MAX_ATTEMPTS,
  REVIEW_POPUP_MIN_DELAY_MS,
  REVIEW_RESULT_POLICY,
} from "../lib/review-request";
import type { ReviewRequestCode } from "../lib/review-request";
import {
  claimReviewPopupAttempt,
  getShopMetadata,
  recordReviewPopupRetry,
  recordReviewPopupTerminal,
  releaseReviewPopupSlot,
} from "../models/shop.server";

/** The prompt key the popup holds the cap slot under. */
const REVIEW_POPUP_PROMPT: PromptKey = "review_popup";

function logFailure(event: string, shopDomain: string, err: unknown, extra = {}): void {
  logger.error(event, {
    shop: shopDomain,
    ...extra,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Apply the code's policy, hand the slot back on a non-success, and emit the
 * one event. `shopDomain` must be session.shop unchanged (deleteShopData purges
 * the events by it). Returns true when this call's write won (and so recorded
 * the event).
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
        ? await recordReviewPopupTerminal(shopDomain, code, now)
        : await recordReviewPopupRetry(shopDomain, code, new Date(now.getTime() + policy.afterMs));
  } catch (err) {
    logFailure("review-request-record-failed", shopDomain, err, { code });
    return false;
  }
  if (!recorded) return false;

  if (code === "success") {
    await recordNudgeShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain);
  } else {
    await releaseSlotAfterNonSuccess(shopDomain);
    await recordNudgeNotShown(NUDGE_KEYS.REVIEW_REQUEST, shopDomain, code);
  }
  return true;
}

/**
 * The modal was not displayed: hand the slot this attempt took back to the
 * holder it replaced. No-op when no attempt is recorded or the popup no longer
 * holds the slot from this attempt. Never throws.
 */
async function releaseSlotAfterNonSuccess(shopDomain: string): Promise<void> {
  try {
    const shop = await getShopMetadata(shopDomain);
    if (shop === null || shop.reviewPopupLastAttemptAt === null) return;
    await releaseReviewPopupSlot(shopDomain, REVIEW_POPUP_PROMPT, shop.reviewPopupLastAttemptAt, {
      lastPromptKey: shop.reviewPopupPrevPromptKey,
      lastPromptShownAt: shop.reviewPopupPrevPromptShownAt,
    });
  } catch (err) {
    logFailure("review-request-slot-release-failed", shopDomain, err);
  }
}

/**
 * Record the ATTEMPT the client is about to make and claim the prompt slot for
 * it (gc-97k.7). `previous` is the parsed nonce: the last attempt time the
 * loader read. The shop is re-read and the SAME rules the loader applied are
 * re-checked, so a hand-made POST cannot skip any of them:
 *   - the nonce is still current (no attempt since the load);
 *   - isReviewPopupEligible: not terminal, first results view 2h+ ago, under 5
 *     attempts, last attempt more than 24h ago, no retry backoff running;
 *   - the prompt slot is free (no open 24h window of ANOTHER prompt).
 * Then ONE compare-and-set (claimReviewPopupAttempt) pins the nonce and the
 * slot and re-checks the limits in SQL. True IFF this call recorded it; the
 * client calls the Reviews API only then. NEVER THROWS.
 */
export async function claimReviewRequestAttempt(
  shopDomain: string,
  previous: Date | null,
  now: Date,
): Promise<boolean> {
  try {
    const shop = await getShopMetadata(shopDomain);
    if (shop === null) return false;
    if ((shop.reviewPopupLastAttemptAt?.getTime() ?? null) !== (previous?.getTime() ?? null)) {
      return false;
    }
    if (!isReviewPopupEligible(shop, now)) return false;
    if (isPromptWindowOpen(shop, now) && shop.lastPromptKey !== REVIEW_POPUP_PROMPT) return false;
    return await claimReviewPopupAttempt(
      shopDomain,
      {
        lastAttemptAt: previous,
        lastPromptKey: shop.lastPromptKey,
        lastPromptShownAt: shop.lastPromptShownAt,
      },
      now,
      {
        maxAttempts: REVIEW_POPUP_MAX_ATTEMPTS,
        firstResultsViewedBy: new Date(now.getTime() - REVIEW_POPUP_MIN_DELAY_MS),
      },
      REVIEW_POPUP_PROMPT,
    );
  } catch (err) {
    logFailure("review-request-attempt-claim-failed", shopDomain, err);
    return false;
  }
}
