/**
 * Merchant-facing in-app copy for summary emails (gc-ol95): Home's one-time
 * "Summary emails are on" notice and the Settings "Summary emails" card.
 * Pure and client-safe. The email's own copy lives in
 * app/services/summary-email.server.ts.
 *
 * Honesty rules: the card never says emails are sent while sending is not
 * configured, and never promises more than the email does (only when something
 * changed: new or fixed findings, or an app that is no longer active).
 */

export type SummaryCadence = "weekly" | "monthly";

/** Shown when the shop-owner email has not been read yet. */
export const OWNER_EMAIL_FALLBACK = "your store owner email";

export const SUMMARY_NOTICE_HEADING = "Summary emails are on";

/** The notice body before its "Settings" link (rendered as a link to /app/settings). */
export function summaryNoticeLead(email: string | null, cadence: SummaryCadence): string {
  return `We'll email ${email ?? OWNER_EMAIL_FALLBACK} a summary after each ${cadence} scan, only when something changed. You can turn this off in`;
}

export const SUMMARY_NOTICE_DISMISS = "Dismiss";

export const SUMMARY_CARD_HEADING = "Summary emails";

export function summaryToggleLabel(cadence: SummaryCadence): string {
  return `Email me a summary after each ${cadence} scan`;
}

/** Card paragraph while sending is configured. */
export function summaryLiveParagraph(email: string | null): string {
  return `We email ${email ?? OWNER_EMAIL_FALLBACK} only when something changed: new or fixed findings, or an app that is no longer active.`;
}

/** Card paragraph while sending is not configured (dark). */
export const SUMMARY_COMING_SOON =
  "Summary emails are coming soon. We'll let you know before any are sent.";

export const SUMMARY_FREE_PARAGRAPH =
  "Summary emails are included with Standard (monthly) and Professional (weekly).";

export const SUMMARY_SAVED_ON = "Summary emails are on.";
export const SUMMARY_SAVED_ON_DARK = "Saved. We'll let you know before any are sent.";
export const SUMMARY_SAVED_OFF = "Summary emails are off.";

export const SUMMARY_NOT_IN_PLAN = "Summary emails are not included in your plan.";

/**
 * Whether summaries can actually go to this shop as far as consent goes: the
 * toggle is on AND the merchant knows (saw the notice or opted in). The
 * Settings checkbox shows this, so a shop that was never told (toggle at its
 * default ON) is shown unchecked rather than falsely "on".
 */
export function summaryEffectivelyOn(shop: {
  alertsEnabled: boolean;
  summaryNoticeShownAt: Date | string | null;
  summaryOptedInAt: Date | string | null;
}): boolean {
  return (
    shop.alertsEnabled && (shop.summaryNoticeShownAt !== null || shop.summaryOptedInAt !== null)
  );
}
