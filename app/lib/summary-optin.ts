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
 * an ignored prompt show again on a later visit until the merchant chooses.
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
};

/**
 * True when the shop should be asked: a plan with summaries, sending
 * configured, the toggle not turned off, installed, and no consent decision of
 * any kind yet (no notice owed or shown, never opted in, never declined).
 * A missing (undefined) stamp counts as set, so incomplete data never asks.
 */
export function isSummaryOptInEligible(state: SummaryOptInState): boolean {
  return (
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
