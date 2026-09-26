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
 *      does not take the slot while a higher one is pending.
 *      BOUNDED BLOCKING: a higher prompt blocks lower ones for at most
 *      PROMPT_BLOCK_MAX_MS (7 days) after it became eligible (its
 *      `eligibleSince`). After that, on a page that cannot render it, it is
 *      skipped and a lower prompt that page CAN render may take the slot. It
 *      stays eligible and still renders on its own page whenever the slot is
 *      free (rule 3). This stops a prompt the merchant never reaches (e.g. a
 *      results page they never reopen) from starving the others forever.
 *   3. At most one DISTINCT prompt per shop per PROMPT_CAP_WINDOW_MS (24h).
 *      Within the window after a prompt was first shown, only that SAME prompt
 *      may render again (so it does not vanish on reload before the merchant
 *      acts), and only while it is still the top eligible prompt; if the holder
 *      is no longer eligible, nothing renders until the window has passed.
 */
import { PLANS } from "./plans";
import { REVIEW_POPUP_MIN_SCAN_AGE_MS } from "./review-request";

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

/**
 * Bounded blocking: the longest an eligible prompt that has not rendered
 * blocks lower-priority prompts, counted from when it became eligible.
 * Exactly 7 days no longer blocks.
 */
export const PROMPT_BLOCK_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Home defers nothing. */
export const HOME_DEFERRED_PROMPTS: readonly PromptKey[] = [];

/**
 * The scan results page (/app/scans/:id) can render, for a SUCCESSFUL
 * (COMPLETED / PARTIAL) scan only:
 *   - review_popup on every plan, unless the scan completed less than
 *     REVIEW_POPUP_MIN_SCAN_AGE_MS ago (then it is DEFERRED on this page, see
 *     scanResultsDeferredPrompts);
 *   - upgrade_return on the Free plan, when the page has hidden findings for
 *     the banner to talk about.
 * An unsuccessful scan's page (including the ~3s in-progress poll) renders no
 * prompt at all.
 */
export function scanResultsPrompts(page: ScanResultsPage): PromptKey[] {
  if (!page.scanSuccessful) return [];
  const prompts: PromptKey[] = [];
  if (!isScanJustFinished(page)) prompts.push("review_popup");
  if (page.plan === PLANS.FREE && page.hasHiddenFindings) prompts.push("upgrade_return");
  return prompts;
}

/** What the scan results page knows about itself. */
export type ScanResultsPage = {
  scanSuccessful: boolean;
  plan: string;
  hasHiddenFindings: boolean;
  /** The scan's completedAt (null: not completed). */
  scanCompletedAt: Date | null;
  now: Date;
};

/** The scan completed less than REVIEW_POPUP_MIN_SCAN_AGE_MS ago. */
function isScanJustFinished(page: ScanResultsPage): boolean {
  return (
    page.scanCompletedAt !== null &&
    page.now.getTime() - page.scanCompletedAt.getTime() < REVIEW_POPUP_MIN_SCAN_AGE_MS
  );
}

/**
 * Prompts the scan results page DEFERS: it neither renders them nor lets them
 * block a lower prompt it can render. review_popup on a successful scan that
 * just finished (the merchant is watching it complete): the return banner may
 * render meanwhile, and the popup waits for a later visit.
 */
export function scanResultsDeferredPrompts(page: ScanResultsPage): PromptKey[] {
  return page.scanSuccessful && isScanJustFinished(page) ? ["review_popup"] : [];
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export type PickPromptInput = PromptCapState & {
  /** Every prompt the SHOP is eligible for (shopPromptEligibility), any order. */
  eligible: readonly PromptKey[];
  /**
   * When each eligible prompt became eligible (shopPromptEligibility). A key
   * without a date never stops blocking (used for the lowest-priority prompt,
   * which blocks nothing).
   */
  eligibleSince: Partial<Record<PromptKey, Date>>;
  /** The prompts THIS page can render (HOME_PROMPTS / scanResultsPrompts). */
  renderable: readonly PromptKey[];
  /**
   * Prompts THIS page deliberately defers (HOME_DEFERRED_PROMPTS /
   * scanResultsDeferredPrompts): skipped here, never blocking.
   */
  deferred: readonly PromptKey[];
  now: Date;
};

/**
 * True while the last shown prompt still holds the slot: a prompt was recorded
 * and less than PROMPT_CAP_WINDOW_MS has elapsed. Exactly 24h is expired.
 * A missing key or timestamp means no prompt holds the slot.
 */
export function isPromptWindowOpen(state: PromptCapState, now: Date): boolean {
  if (state.lastPromptKey === null || state.lastPromptShownAt === null) return false;
  return now.getTime() - state.lastPromptShownAt.getTime() < PROMPT_CAP_WINDOW_MS;
}

/**
 * True while an eligible prompt still blocks lower ones: less than
 * PROMPT_BLOCK_MAX_MS since it became eligible, or no eligibleSince at all.
 */
export function isStillBlocking(since: Date | undefined, now: Date): boolean {
  return since === undefined || now.getTime() - since.getTime() < PROMPT_BLOCK_MAX_MS;
}

/**
 * The prompt this PAGE should consider (before the 24h window), or null.
 * Walks the eligible prompts in priority order, skipping those this page
 * defers: the first one this page can render is the candidate; an earlier one it cannot render blocks (null)
 * while isStillBlocking, and is skipped once its 7 days are up.
 */
export function pagePendingPrompt(
  input: Pick<PickPromptInput, "eligible" | "eligibleSince" | "renderable" | "deferred" | "now">,
): PromptKey | null {
  for (const key of PROMPT_KEYS) {
    if (!input.eligible.includes(key) || input.deferred.includes(key)) continue;
    if (input.renderable.includes(key)) return key;
    if (isStillBlocking(input.eligibleSince[key], input.now)) return null;
  }
  return null;
}

/**
 * The single interruptive prompt to render on this page view, or null.
 *
 *   1. pagePendingPrompt: the highest-priority eligible prompt this page can
 *      render, unless a higher one it cannot render still blocks (7-day bound).
 *   2. Inside an open 24h window only the prompt that opened it may render;
 *      any other candidate (including when the holder is no longer eligible)
 *      gets null until the window passes. Nothing is ever claimed on null.
 */
export function pickPrompt(input: PickPromptInput): PromptKey | null {
  const candidate = pagePendingPrompt(input);
  if (candidate === null) return null;
  if (isPromptWindowOpen(input, input.now) && candidate !== input.lastPromptKey) return null;
  return candidate;
}

/**
 * Does rendering `picked` need a new durable claim? True when it differs from
 * the recorded prompt or the window has expired; false when it is the same
 * prompt re-rendering inside its window (the window is NOT extended).
 */
export function promptClaimNeeded(picked: PromptKey, state: PromptCapState, now: Date): boolean {
  return picked !== state.lastPromptKey || !isPromptWindowOpen(state, now);
}
