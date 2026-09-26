/**
 * Cross-prompt frequency cap for interruptive merchant prompts (gc-97k.6).
 *
 * Pure and client-safe. The server side (claiming the durable slot on Shop)
 * lives in app/services/prompt-cap.server.ts.
 *
 * Interruptive prompts are the ones in PROMPT_KEYS. The inline Free-tier
 * upgrade teaser in scan results is CONTENT, not a prompt: it is never capped
 * and never counted here.
 *
 * Rules:
 *   1. At most ONE interruptive prompt per page view (pickPrompt returns one key).
 *   2. At most one DISTINCT prompt per shop per PROMPT_CAP_WINDOW_MS (24h). Within
 *      the window after a prompt was first shown, only that SAME prompt may
 *      render again (so it does not vanish on reload before the merchant acts);
 *      no other prompt may appear until the window has passed.
 *   3. Priority when several are eligible: PROMPT_KEYS order.
 */

/** Every interruptive prompt, in priority order (first = highest). */
export const PROMPT_KEYS = ["review_popup", "upgrade_return", "feedback", "review_banner"] as const;

/**
 * review_popup:   native App Store review popup (gc-97k.7).
 * upgrade_return: return-visit upgrade nudge (gc-97k.9).
 * feedback:       home-page feedback nudge (gc-97k.3).
 * review_banner:  home-page App Store review banner.
 */
export type PromptKey = (typeof PROMPT_KEYS)[number];

/** How long a shown prompt holds the shop's single prompt slot. */
export const PROMPT_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The shop's durable cap state (Shop.lastPromptKey / Shop.lastPromptShownAt). */
export type PromptCapState = {
  /** TEXT column: may hold a key this build no longer knows. */
  lastPromptKey: string | null;
  lastPromptShownAt: Date | null;
};

export type PickPromptInput = PromptCapState & {
  /** The prompts whose own eligibility rules pass on this page view (any order). */
  eligible: readonly PromptKey[];
  now: Date;
};

/**
 * True while the last shown prompt still holds the slot: a prompt was recorded
 * and less than PROMPT_CAP_WINDOW_MS has elapsed. Exactly 24h is expired.
 * A missing key or timestamp means no prompt holds the slot.
 */
function isWindowOpen(state: PromptCapState, now: Date): boolean {
  if (state.lastPromptKey === null || state.lastPromptShownAt === null) return false;
  return now.getTime() - state.lastPromptShownAt.getTime() < PROMPT_CAP_WINDOW_MS;
}

/**
 * The single interruptive prompt to render on this page view, or null.
 *
 * Inside the 24h window only the prompt that opened it may render, and only if
 * it is still eligible. If it is no longer eligible (e.g. dismissed), nothing
 * renders: the next prompt waits for the window to pass. Outside the window the
 * highest-priority eligible prompt wins.
 */
export function pickPrompt(input: PickPromptInput): PromptKey | null {
  if (isWindowOpen(input, input.now)) {
    return input.eligible.find((key) => key === input.lastPromptKey) ?? null;
  }
  return PROMPT_KEYS.find((key) => input.eligible.includes(key)) ?? null;
}

/**
 * Does rendering `picked` need a new durable claim? True when it differs from
 * the recorded prompt or the window has expired; false when it is the same
 * prompt re-rendering inside its window (the window is NOT extended).
 */
export function promptClaimNeeded(picked: PromptKey, state: PromptCapState, now: Date): boolean {
  return picked !== state.lastPromptKey || !isWindowOpen(state, now);
}
