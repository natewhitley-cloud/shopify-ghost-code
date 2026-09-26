/**
 * Server side of the cross-prompt frequency cap (gc-97k.6).
 *
 * resolvePrompt is the ONE call a loader makes to decide which interruptive
 * prompt (if any) renders on this page view: it runs the pure pickPrompt, then
 * claims the shop's durable prompt slot when the pick opens a new 24h window.
 *
 * NEVER THROWS: on any failure it logs and returns null (no prompt). Failing
 * closed keeps the cap honest, and a missing prompt never breaks a page.
 */
import { logger } from "../lib/logger.server";
import { pickPrompt, promptClaimNeeded } from "../lib/prompt-cap";
import type { PromptCapState, PromptKey } from "../lib/prompt-cap";
import { claimPromptSlot, getShopMetadata } from "../models/shop.server";

export type ResolvePromptInput = PromptCapState & {
  /** session.shop, unchanged. */
  shopDomain: string;
  /** The prompts whose own eligibility rules pass on this page view. */
  eligible: readonly PromptKey[];
  now: Date;
};

/**
 * The single interruptive prompt to render, or null.
 *
 * - Nothing eligible, or the cap blocks everything: null, no write.
 * - The same prompt re-rendering inside its window: that prompt, no write.
 * - Otherwise the pick claims the slot (claimPromptSlot, keyed on the state this
 *   load read). If a concurrent load changed the slot first, the claim loses:
 *   re-read the state once and re-pick WITHOUT claiming again. If the winner
 *   claimed the same prompt, it renders here too; if it claimed a different
 *   one, this load renders nothing.
 */
export async function resolvePrompt(input: ResolvePromptInput): Promise<PromptKey | null> {
  const { shopDomain, eligible, now } = input;
  const picked = pickPrompt(input);
  if (picked === null || !promptClaimNeeded(picked, input, now)) return picked;

  try {
    if (await claimPromptSlot(shopDomain, picked, input, now)) return picked;

    const fresh = await getShopMetadata(shopDomain);
    if (fresh === null) return null;
    const repicked = pickPrompt({ ...fresh, eligible, now });
    return repicked !== null && !promptClaimNeeded(repicked, fresh, now) ? repicked : null;
  } catch (err) {
    logger.error("prompt-cap-claim-failed", {
      shop: shopDomain,
      prompt: picked,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
