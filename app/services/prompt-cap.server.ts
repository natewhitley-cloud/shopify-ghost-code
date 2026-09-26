/**
 * Server side of the cross-prompt frequency cap (gc-97k.6).
 *
 * Every page that can render an interruptive prompt makes the same two calls:
 *   1. loadShopPromptState: the shop's prompt state (Shop fields plus the first
 *      successful scan's completedAt, read only when a rule can use it). Start
 *      it alongside the page's other reads; it is independent of them.
 *   2. resolvePrompt: computes the shop's GLOBAL eligibility
 *      (shopPromptEligibility), runs the pure pickPrompt against what THIS page
 *      can render, and claims the shop's durable prompt slot when the pick
 *      opens a new 24h window.
 * Home and the scan results page therefore always agree on which prompt is
 * pending (owner decision 1A).
 *
 * resolvePrompt NEVER THROWS: on any failure it logs and returns null (no
 * prompt). Failing closed keeps the cap honest, and a missing prompt never
 * breaks a page.
 */
import { logger } from "../lib/logger.server";
import { pickPrompt, promptClaimNeeded } from "../lib/prompt-cap";
import type { PromptCapState, PromptKey } from "../lib/prompt-cap";
import {
  firstSuccessfulScanNeeded,
  shopPromptEligibility,
  upgradeReturnPossible,
} from "../lib/prompt-eligibility";
import type { ShopPromptState } from "../lib/prompt-eligibility";
import {
  getFirstSuccessfulScanCompletedAt,
  getLatestSuccessfulScanNonMaliciousCount,
} from "../models/scan.server";
import { claimPromptSlot, getShopMetadata } from "../models/shop.server";
import type { ShopMetadata } from "../models/shop.server";

/** The shop's prompt eligibility inputs plus its cap state. */
export type ShopPromptContext = ShopPromptState & PromptCapState;

/**
 * Load the shop's prompt state. `shop` is the metadata the loader already
 * read. At most two cheap queries, in parallel, each only when a prompt rule
 * can use it:
 *   - the first successful scan's completedAt (firstSuccessfulScanNeeded);
 *   - the latest successful scan's non-malicious finding count, for the
 *     return banner's hidden-findings rule (upgradeReturnPossible: Free, not
 *     retired). Both pages need the SAME shop-level value, and neither page
 *     has it already (Home loads the latest scan of any status, the results
 *     page loads the scan being viewed), so it is one indexed count query
 *     rather than page data.
 * Throws only if a read does, like any other loader read.
 */
export async function loadShopPromptState(
  shop: ShopMetadata,
  now: Date,
): Promise<ShopPromptContext> {
  const [firstSuccessfulScanAt, latestScanNonMaliciousCount] = await Promise.all([
    firstSuccessfulScanNeeded(shop, now)
      ? getFirstSuccessfulScanCompletedAt(shop.id)
      : Promise.resolve(null),
    upgradeReturnPossible(shop)
      ? getLatestSuccessfulScanNonMaliciousCount(shop.id)
      : Promise.resolve(null),
  ]);
  return { ...shop, firstSuccessfulScanAt, latestScanNonMaliciousCount };
}

export type ResolvePromptInput = {
  /** session.shop, unchanged. */
  shopDomain: string;
  /** From loadShopPromptState, read on this load. */
  state: ShopPromptContext;
  /** The prompts THIS page can render (HOME_PROMPTS / scanResultsPrompts). */
  renderable: readonly PromptKey[];
  /** The prompts THIS page defers (HOME_DEFERRED_PROMPTS / scanResultsDeferredPrompts). */
  deferred: readonly PromptKey[];
  now: Date;
};

/**
 * The single interruptive prompt to render on this page view, or null.
 *
 * - Nothing pending, the cap blocks the pending prompt, or this page cannot
 *   render it: null, no write.
 * - The review popup (gc-97k.7) is returned with NO write: the ATTEMPT and the
 *   slot claim happen together only when the client is about to call the
 *   Reviews API (the review-request action, keyed by the nonce the loader
 *   issues). A load that picks it but never fires (a revalidation) therefore
 *   burns nothing and holds no slot.
 * - The same prompt re-rendering inside its window: that prompt, no write.
 * - Otherwise the pick claims the slot (claimPromptSlot, keyed on the state this
 *   load read). If a concurrent load changed the slot first, the claim loses:
 *   re-read the state once and re-pick WITHOUT claiming again. If the winner
 *   claimed the same prompt, it renders here too; if it claimed a different
 *   one, this load renders nothing.
 */
export async function resolvePrompt(input: ResolvePromptInput): Promise<PromptKey | null> {
  const { shopDomain, state, renderable, deferred, now } = input;
  const picked = pickPrompt({
    ...state,
    ...shopPromptEligibility(state, now),
    renderable,
    deferred,
    now,
  });
  if (picked === null || picked === "review_popup") return picked;
  if (!promptClaimNeeded(picked, state, now)) return picked;

  try {
    if (await claimPromptSlot(shopDomain, picked, state, now)) return picked;

    const fresh = await getShopMetadata(shopDomain);
    if (fresh === null) return null;
    // The scan facts cannot change between the two reads that matter here, so
    // the values this load already read are reused.
    const freshState: ShopPromptContext = {
      ...fresh,
      firstSuccessfulScanAt: state.firstSuccessfulScanAt,
      latestScanNonMaliciousCount: state.latestScanNonMaliciousCount,
    };
    const repicked = pickPrompt({
      ...freshState,
      ...shopPromptEligibility(freshState, now),
      renderable,
      deferred,
      now,
    });
    // A re-pick of the popup is left alone (this load claimed another slot).
    return repicked !== null &&
      repicked !== "review_popup" &&
      !promptClaimNeeded(repicked, freshState, now)
      ? repicked
      : null;
  } catch (err) {
    logger.error("prompt-cap-claim-failed", {
      shop: shopDomain,
      prompt: picked,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
