/**
 * Home's one-time summary-email opt-in prompt (gc-xorg): who is eligible.
 *
 * Pure and client-safe. Summary emails (gc-ol95) need consent: a shop gets
 * one only if alertsEnabled AND (summaryNoticeShownAt OR summaryOptedInAt).
 * A shop that moves Free -> paid owes Home's "Summary emails are on" notice
 * (summaryNoticePendingAt). A shop that was ALREADY paid when gc-ol95 shipped
 * holds none of those stamps, so it never gets an email and Settings reads OFF.
 * This prompt asks those shops once: "Turn on" is the Settings opt-in
 * (summaryOptedInAt, the consent stamp), "No thanks" stamps
 * summaryOptInDeclinedAt and the prompt never returns.
 *
 * It is an INTERRUPTIVE prompt (PromptKey `summary_optin`, ./prompt-cap): it
 * goes through the cross-prompt cap, and the cap's 24h same-prompt window lets
 * an ignored prompt show again on a later visit. It is offered for
 * SUMMARY_OPTIN_OFFER_MS (14 days) from its first render
 * (summaryOptInFirstShownAt, gc-rxq0), then retired: it outranks the feedback
 * nudge on Home, so an offer that never ended would starve that nudge for a
 * merchant who never answers. Retirement writes nothing (not a decline,
 * alertsEnabled untouched); Settings stays the way in.
 *
 * The plan's cadence and whether sending is configured are server facts
 * (billing.server / env), so the server computes them and passes them in.
 */
import type { SummaryCadence } from "./summary-email-copy";

export type SummaryOptInState = {
  /** getPlanFeatures(plan).alertCadence, computed server side: "none" on Free. */
  summaryCadence: SummaryCadence | "none";
  /** getMerchantAlertConfigStatus().configured, computed server side. */
  summarySendingConfigured: boolean;
  /** False = the merchant turned summaries off or unsubscribed: never nag. */
  alertsEnabled: boolean;
  uninstalledAt: Date | null;
  summaryNoticePendingAt: Date | null;
  summaryNoticeShownAt: Date | null;
  summaryOptedInAt: Date | null;
  summaryOptInDeclinedAt: Date | null;
  /** First render of the prompt (gc-rxq0); null = never shown. */
  summaryOptInFirstShownAt: Date | null;
};

/**
 * How long the prompt is offered, from its first render (gc-rxq0). Exactly 14
 * days after summaryOptInFirstShownAt it is retired.
 */
export const SUMMARY_OPTIN_OFFER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * True when the shop should be asked: a plan with summaries, sending
 * configured, the toggle not turned off, installed, and no consent decision of
 * any kind yet (no notice owed or shown, never opted in, never declined),
 * and the offer not retired (never shown, or first shown less than
 * SUMMARY_OPTIN_OFFER_MS before `now`).
 * A missing (undefined) stamp counts as set, so incomplete data never asks.
 */
export function isSummaryOptInEligible(state: SummaryOptInState, now: Date): boolean {
  const firstShown = state.summaryOptInFirstShownAt;
  const offerOpen =
    firstShown === null ||
    (firstShown !== undefined && now.getTime() - firstShown.getTime() < SUMMARY_OPTIN_OFFER_MS);
  return (
    offerOpen &&
    state.summaryCadence !== "none" &&
    state.summarySendingConfigured &&
    state.alertsEnabled &&
    state.uninstalledAt === null &&
    state.summaryNoticePendingAt === null &&
    state.summaryNoticeShownAt === null &&
    state.summaryOptedInAt === null &&
    state.summaryOptInDeclinedAt === null
  );
}
