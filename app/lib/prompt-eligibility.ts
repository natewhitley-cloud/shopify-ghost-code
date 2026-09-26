/**
 * Shop-level eligibility for every interruptive prompt (gc-97k.6, owner
 * decision 1A: strict GLOBAL priority).
 *
 * Pure and client-safe. ONE function decides which prompts a SHOP is eligible
 * for, from Shop fields plus its first successful scan's completedAt, and
 * independent of the page being loaded, so Home and the scan results page
 * always agree on which prompt is pending. Each prompt's own rule lives with
 * the prompt:
 *   review_popup    isReviewPopupEligible     (./review-request)
 *   upgrade_return  isUpgradeReturnEligible   (./upgrade-return)
 *   feedback        shouldShowFeedbackNudge   (./feedback-nudge)
 * pickPrompt (./prompt-cap) then applies priority, the 24h window and the
 * page's renderability.
 */
import { feedbackNudgeInstallAgeReached, shouldShowFeedbackNudge } from "./feedback-nudge";
import type { FeedbackNudgeGateInput } from "./feedback-nudge";
import { PLANS } from "./plans";
import type { PromptKey } from "./prompt-cap";
import { isReviewPopupEligible } from "./review-request";
import type { ReviewPopupEligibilityInput } from "./review-request";
import { isUpgradeReturnEligible, UPGRADE_RETURN_MAX_DISMISSALS } from "./upgrade-return";
import type { UpgradeReturnState } from "./upgrade-return";

/** Everything the prompt rules read: Shop fields plus the first successful scan. */
export type ShopPromptState = ReviewPopupEligibilityInput &
  UpgradeReturnState &
  FeedbackNudgeGateInput;

/** The prompts the shop is eligible for, in PROMPT_KEYS (priority) order. */
export function shopPromptEligibility(state: ShopPromptState, now: Date): PromptKey[] {
  const eligible: PromptKey[] = [];
  if (isReviewPopupEligible(state, now)) eligible.push("review_popup");
  if (isUpgradeReturnEligible(state, now)) eligible.push("upgrade_return");
  if (shouldShowFeedbackNudge(state, now)) eligible.push("feedback");
  return eligible;
}

/** The Shop fields firstSuccessfulScanNeeded reads. */
export type FirstScanNeedInput = Pick<
  ShopPromptState,
  | "plan"
  | "upgradeReturnDismissCount"
  | "installedAt"
  | "feedbackNudgeDismissedAt"
  | "feedbackSubmittedAt"
>;

/**
 * Could any prompt rule depend on the first successful scan's completedAt?
 * Only upgrade_return (a Free shop that has not retired it) and feedback (not
 * dismissed, not submitted, and installed long enough) read it. When neither
 * can, the loader skips the query and passes null, which makes both
 * ineligible exactly as the real value would.
 */
export function firstSuccessfulScanNeeded(shop: FirstScanNeedInput, now: Date): boolean {
  const upgradeReturnOpen =
    shop.plan === PLANS.FREE && shop.upgradeReturnDismissCount < UPGRADE_RETURN_MAX_DISMISSALS;
  const feedbackOpen =
    shop.feedbackNudgeDismissedAt === null &&
    shop.feedbackSubmittedAt === null &&
    feedbackNudgeInstallAgeReached(shop.installedAt, now);
  return upgradeReturnOpen || feedbackOpen;
}
