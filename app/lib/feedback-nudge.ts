/**
 * Merchant feedback nudge + neutral App Store review asks (gc-97k.3).
 *
 * Pure and client-safe: the eligibility gate and the merchant-facing copy
 * shared by the home page and /app/feedback. Which prompt renders (one per page,
 * one distinct prompt per 24h) is decided by pickPrompt in ./prompt-cap.
 *
 * Review asks are NEUTRAL (Shopify App Store policy: review requests must not
 * target or bias toward satisfied merchants). The FEEDBACK nudge and the
 * post-feedback review ask never depend on a CSAT score or on how many findings
 * a scan produced. The standalone home-page review banner keeps its existing
 * >= REVIEW_PROMPT_MIN_FINDINGS (4) trigger by owner decision (2026-09-24).
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

/**
 * Installed at least FEEDBACK_NUDGE_MIN_INSTALL_DAYS (inclusive) as of `now`.
 * Part of shouldShowFeedbackNudge; also used by the home loader to skip the
 * first-successful-scan query for younger shops.
 */
export function feedbackNudgeInstallAgeReached(installedAt: Date, now: Date): boolean {
  return now.getTime() - installedAt.getTime() >= FEEDBACK_NUDGE_MIN_INSTALL_DAYS * MS_PER_DAY;
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
  if (!feedbackNudgeInstallAgeReached(input.installedAt, now)) return false;
  return utcDayNumber(now) > utcDayNumber(input.firstSuccessfulScanAt);
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
