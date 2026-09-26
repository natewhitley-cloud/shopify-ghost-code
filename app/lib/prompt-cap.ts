/**
 * Cross-prompt frequency cap for interruptive merchant prompts (gc-97k.6).
 *
 * Pure and client-safe. Which prompts a SHOP is eligible for is decided by
 * shopPromptEligibility (./prompt-eligibility); the server side (loading that
 * state and claiming the durable slot on Shop) lives in
 * app/services/prompt-cap.server.ts.
 *
 * Interruptive prompts are the ones in PROMPT_KEYS. The inline Free-tier
 * upgrade teaser in scan results is CONTENT, not a prompt: it is never capped
 * and never counted here. The neutral review link on the feedback success page
 * is in-flow, not a prompt, and is not counted either.
 *
 * Rules (strict GLOBAL priority, owner decision 1A):
 *   1. At most ONE interruptive prompt per page view (pickPrompt returns one key).
 *   2. The prompt that may render anywhere is the highest-priority prompt the
 *      SHOP is eligible for, whatever page is loading. Each page declares which
 *      prompts it can render (HOME_PROMPTS, scanResultsPrompts). A page that
 *      cannot render the top prompt renders NOTHING: a lower-priority prompt
 *      never takes the slot while a higher one is pending.
 *   3. At most one DISTINCT prompt per shop per PROMPT_CAP_WINDOW_MS (24h).
 *      Within the window after a prompt was first shown, only that SAME prompt
 *      may render again (so it does not vanish on reload before the merchant
 *      acts), and only while it is still the top eligible prompt; if the holder
 *      is no longer eligible, nothing renders until the window has passed.
 */
import { PLANS } from "./plans";

/** Every interruptive prompt, in priority order (first = highest). */
export const PROMPT_KEYS = ["review_popup", "upgrade_return", "feedback"] as const;

/**
 * review_popup:   native App Store review popup (gc-97k.7).
 * upgrade_return: return-visit upgrade nudge, Free only (gc-97k.9).
 * feedback:       home-page feedback nudge (gc-97k.3).
 *
 * The former home-page review banner (`review_banner`) is retired (owner
 * decision 2A). A stored lastPromptKey of "review_banner" is an unknown key:
 * it blocks every prompt until its window expires, like any unknown key.
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

// ---------------------------------------------------------------------------
// Page renderability: which prompts each page can render
// ---------------------------------------------------------------------------

/** Home (/app) can render only the feedback nudge. */
export const HOME_PROMPTS: readonly PromptKey[] = ["feedback"];

/**
 * The scan results page (/app/scans/:id) can render, for a SUCCESSFUL
 * (COMPLETED / PARTIAL) scan only:
 *   - review_popup on every plan;
 *   - upgrade_return on the Free plan, when the page has hidden findings for
 *     the banner to talk about.
 * An unsuccessful scan's page (including the ~3s in-progress poll) renders no
 * prompt at all.
 */
export function scanResultsPrompts(page: {
  scanSuccessful: boolean;
  plan: string;
  hasHiddenFindings: boolean;
}): PromptKey[] {
  if (!page.scanSuccessful) return [];
  const prompts: PromptKey[] = ["review_popup"];
  if (page.plan === PLANS.FREE && page.hasHiddenFindings) prompts.push("upgrade_return");
  return prompts;
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export type PickPromptInput = PromptCapState & {
  /** Every prompt the SHOP is eligible for (shopPromptEligibility), any order. */
  eligible: readonly PromptKey[];
  /** The prompts THIS page can render (HOME_PROMPTS / scanResultsPrompts). */
  renderable: readonly PromptKey[];
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
 * The highest-priority prompt the shop is eligible for (the PENDING prompt),
 * or null when none is.
 */
export function topEligiblePrompt(eligible: readonly PromptKey[]): PromptKey | null {
  return PROMPT_KEYS.find((key) => eligible.includes(key)) ?? null;
}

/**
 * The single interruptive prompt to render on this page view, or null.
 *
 *   1. Take the highest-priority GLOBALLY eligible prompt (none: null).
 *   2. Inside an open 24h window only the prompt that opened it may render; any
 *      other top prompt (including when the holder is no longer eligible) gets
 *      null until the window passes.
 *   3. Render it only if this page can; otherwise null (and no claim).
 */
export function pickPrompt(input: PickPromptInput): PromptKey | null {
  const top = topEligiblePrompt(input.eligible);
  if (top === null) return null;
  if (isWindowOpen(input, input.now) && top !== input.lastPromptKey) return null;
  return input.renderable.includes(top) ? top : null;
}

/**
 * Does rendering `picked` need a new durable claim? True when it differs from
 * the recorded prompt or the window has expired; false when it is the same
 * prompt re-rendering inside its window (the window is NOT extended).
 */
export function promptClaimNeeded(picked: PromptKey, state: PromptCapState, now: Date): boolean {
  return picked !== state.lastPromptKey || !isWindowOpen(state, now);
}
