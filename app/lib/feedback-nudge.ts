/**
 * Merchant feedback nudge + neutral App Store review asks (gc-97k.3).
 *
 * Pure and client-safe: the eligibility gate, the one-prompt-per-page picker,
 * and the merchant-facing copy shared by the home page and /app/feedback.
 *
 * Review asks are NEUTRAL and go to everyone (Shopify App Store policy: review
 * requests must not target or bias toward satisfied merchants). Nothing here may
 * depend on a CSAT score or on how many findings a scan produced.
 */
import { APP_HANDLE } from "./plans";

/**
 * Survey length caps. Shared by the form (maxLength) and server validation, so
 * they live here (client-safe) rather than in feedback.server.
 */
export const FEEDBACK_MAX_TEXT_LEN = 2000;
export const FEEDBACK_MAX_EMAIL_LEN = 320;

/** Install age before the nudge may show: time to form an opinion. */
export const FEEDBACK_NUDGE_MIN_INSTALL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole UTC calendar days since the epoch (the UTC date, as a number). */
function utcDayNumber(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY);
}

export type FeedbackNudgeGateInput = {
  installedAt: Date;
  /** completedAt of the shop's FIRST successful (COMPLETED/PARTIAL) scan; null = none yet. */
  firstSuccessfulScanAt: Date | null;
  feedbackNudgeDismissedAt: Date | null;
  feedbackSubmittedAt: Date | null;
};

/**
 * Should the home page offer the feedback nudge? True only when ALL hold:
 *   - not dismissed and not submitted;
 *   - the shop has a successful scan;
 *   - installed at least FEEDBACK_NUDGE_MIN_INSTALL_DAYS (inclusive);
 *   - `now` falls on a LATER UTC calendar day than the first successful scan.
 *     The merchant loading the page now is the return visit, so no view
 *     counter is needed.
 * All plans are eligible.
 */
export function shouldShowFeedbackNudge(input: FeedbackNudgeGateInput, now: Date): boolean {
  if (input.feedbackNudgeDismissedAt !== null || input.feedbackSubmittedAt !== null) return false;
  if (input.firstSuccessfulScanAt === null) return false;
  if (now.getTime() - input.installedAt.getTime() < FEEDBACK_NUDGE_MIN_INSTALL_DAYS * MS_PER_DAY) {
    return false;
  }
  return utcDayNumber(now) > utcDayNumber(input.firstSuccessfulScanAt);
}

/** The single merchant prompt the home page shows, if any. */
export type HomePrompt = "feedback" | "review" | null;

/**
 * At most one of {feedback nudge, review prompt} renders on the home page.
 * Feedback wins when both are eligible.
 */
export function pickHomePrompt(eligible: { feedback: boolean; review: boolean }): HomePrompt {
  if (eligible.feedback) return "feedback";
  if (eligible.review) return "review";
  return null;
}

/** App Store listing deep link that opens the "Write a review" modal. */
export const APP_STORE_REVIEW_URL = `https://apps.shopify.com/${APP_HANDLE}#modal-show=WriteReviewModal`;

/** /app/feedback with the marker its loader uses to count the nudge click. */
export const FEEDBACK_NUDGE_HREF = "/app/feedback?src=nudge";

export const FEEDBACK_NUDGE_COPY = {
  heading: "How is Ghost Code working for you?",
  body: "Tell us what is working and what is not. It takes about two minutes, and we read every response.",
  cta: "Share feedback",
  dismiss: "Not now",
} as const;

/** The existing home-page review banner, rewritten to neutral wording. */
export const REVIEW_BANNER_TEXT =
  "We value feedback. Reviews on the Shopify App Store help us improve and help other merchants decide. Let us know how we're doing.";

/** Shown on the feedback success state to EVERY submitter, whatever their rating. */
export const FEEDBACK_THANKS_COPY = {
  heading: "Thanks for the feedback",
  body: "Thanks for the feedback. Reviews on the Shopify App Store help other merchants decide. Let us know how we're doing there too.",
  reviewCta: "Write a review",
  skip: "Not now",
} as const;
