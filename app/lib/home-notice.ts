/**
 * Home's one notice slot (gc-np1d.6, page map "### Home"): at most ONE of
 * these notices renders, as a quiet notice at the bottom of the page, below
 * "What it's costing you". Pure and client-safe.
 *
 * Outside the slot (unchanged): the action error banner, security risk and
 * checkout-guard incident banners, scan-limit copy, the rescan and
 * theme-changed nudges (only with no "scan" action card), and the
 * install-source card.
 *
 * Telemetry: only the winner may record a "shown" stamp. The consent notices
 * (guard email, summary emails) claim from the client once rendered, so the
 * route passes them to their claim hook only when they win. The interruptive
 * prompts (summary opt-in, feedback) claim in the loader, so the loader holds
 * them back whenever a consent notice is (or was just) in the slot: see
 * homePromptsHeld.
 */
import { PROMPT_CAP_WINDOW_MS } from "./prompt-cap";

/** Every notice the slot can hold, highest priority first. */
export const HOME_NOTICE_PRIORITY = [
  "guard_email",
  "summary_notice",
  "summary_optin",
  "feedback",
  "multi_theme",
  "app_removed",
  "new_high",
] as const;

export type HomeNoticeKey = (typeof HOME_NOTICE_PRIORITY)[number];

/** Which notices want the slot on this render (absent = false). */
export type HomeNoticeCandidates = Partial<Record<HomeNoticeKey, boolean>>;

/** The one notice to render in the slot, or null when none wants it. */
export function pickHomeNotice(candidates: HomeNoticeCandidates): HomeNoticeKey | null {
  return HOME_NOTICE_PRIORITY.find((key) => candidates[key] === true) ?? null;
}

/**
 * Whether the summary-email opt-in holds the slot: while its prompt shows, and
 * after "Turn on" for the rest of the page view, so its success or failure
 * line stays on screen (the loader stops returning the prompt once answered).
 * Nothing renders while that request is in flight. "No thanks" frees the slot.
 */
export function summaryOptInHoldsSlot(
  promptVisible: boolean,
  answered: "accept" | "decline" | null,
): boolean {
  return promptVisible || answered === "accept";
}

/**
 * Whether Home's loader must skip its interruptive prompts (summary opt-in,
 * feedback) on this load, so they claim nothing they would not render.
 *
 * Both rank below the two consent notices. A consent notice offered on this
 * load wins the slot. One claimed in the last PROMPT_CAP_WINDOW_MS may still
 * be on screen: the client keeps it until answered, while the loader stops
 * offering it once stamped (any revalidation, e.g. the 3s scan poll or the
 * claim post itself). A hard 24h hold covers that window without guessing
 * whether a tab still shows it. Exactly 24h no longer holds.
 */
export function homePromptsHeld(input: {
  guardEmailNoticeOffered: boolean;
  summaryNoticeOffered: boolean;
  guardEmailNoticeShownAt: Date | null;
  summaryNoticeShownAt: Date | null;
  now: Date;
}): boolean {
  if (input.guardEmailNoticeOffered || input.summaryNoticeOffered) return true;
  const recent = (at: Date | null | undefined) =>
    at instanceof Date && input.now.getTime() - at.getTime() < PROMPT_CAP_WINDOW_MS;
  return recent(input.guardEmailNoticeShownAt) || recent(input.summaryNoticeShownAt);
}
