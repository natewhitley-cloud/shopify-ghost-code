/**
 * Merchant-facing in-app copy for summary emails (gc-ol95): Home's one-time
 * "Summary emails are on" notice, Home's one-time "New: summary emails" opt-in
 * prompt (gc-xorg) and the Settings "Summary emails" card.
 * Pure and client-safe. The email's own copy lives in
 * app/services/summary-email.server.ts.
 *
 * Honesty rules: the card never says emails are sent while sending is not
 * configured, and never promises more than the email does (only when something
 * changed: new or fixed findings, or an app that is no longer active; for
 * Standard and Professional while the store speed report is live, also a
 * noticeable speed change, which can trigger a send on its own, gc-2wnf,
 * gc-d0ui).
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

/**
 * Home's opt-in prompt (gc-xorg, owner-approved copy) for shops paid before
 * gc-ol95 shipped: they were never told, so they get nothing until they choose.
 */
export const SUMMARY_OPTIN_HEADING = "New: summary emails";

export function summaryOptInBody(email: string | null, cadence: SummaryCadence): string {
  return `Get a ${cadence} digest of what changed in your store: new or fixed findings, and apps that are no longer active. We'll send it to ${email ?? OWNER_EMAIL_FALLBACK}, only when something changed.`;
}

export const SUMMARY_OPTIN_ACCEPT = "Turn on";
export const SUMMARY_OPTIN_DECLINE = "No thanks";

/** Shown after "Turn on", before its "Settings" link (rendered as a link to /app/settings). */
export const SUMMARY_OPTIN_SUCCESS_LEAD = "Summary emails are on. You can turn them off in";

/**
 * Shown when "Turn on" was not applied (the shop is no longer eligible, or the
 * request failed), before its "Settings" link.
 */
export const SUMMARY_OPTIN_FAILED_LEAD =
  "We couldn't turn on summary emails. You can turn them on in";

export const SUMMARY_CARD_HEADING = "Summary emails";

export function summaryToggleLabel(cadence: SummaryCadence): string {
  return `Email me a summary after each ${cadence} scan`;
}

/**
 * Card paragraph while sending is configured. `speedInSummary`: the email can
 * carry (and be sent for) a store speed change, i.e. Standard or Professional
 * with the speed report live (gc-2wnf, gc-d0ui).
 */
export function summaryLiveParagraph(email: string | null, speedInSummary = false): string {
  const who = email ?? OWNER_EMAIL_FALLBACK;
  if (speedInSummary) {
    return `We email ${who} only when something changed: new or fixed findings, an app that is no longer active, or a noticeable change in your store speed.`;
  }
  return `We email ${who} only when something changed: new or fixed findings, or an app that is no longer active.`;
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
 * What the Settings checkbox shows (gc-ol95): the toggle is on AND the merchant
 * either knows (notice shown, or opted in while sending was live) or will be
 * told before any email (notice pending). A shop that was never told and owes
 * no notice (paid before this shipped, toggle at its default ON) reads OFF,
 * matching the fact that nothing will be sent to it.
 */
export function summaryEffectivelyOn(shop: {
  alertsEnabled: boolean;
  summaryNoticePendingAt: Date | string | null;
  summaryNoticeShownAt: Date | string | null;
  summaryOptedInAt: Date | string | null;
}): boolean {
  return (
    shop.alertsEnabled &&
    (shop.summaryNoticeShownAt !== null ||
      shop.summaryOptedInAt !== null ||
      shop.summaryNoticePendingAt !== null)
  );
}
