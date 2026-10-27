/**
 * One-time install-source card (gc-3twe): store the answer and emit its
 * `converted` funnel event. `shown` and `dismissed` (Skip) go through
 * recordNudgeStageOnce like every other nudge; the answer cannot, because it
 * must be written atomically with its stamp (claimInstallSourceAnswer).
 *
 * NEVER THROWS, like recordNudgeStageOnce: a failed write is logged and
 * reported as "failed", so the card can ask the merchant to try again.
 */
import { NUDGE_KEYS, recordNudgeConverted } from "./nudge-telemetry.server";
import type { InstallSourceAnswer } from "../lib/install-source";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { claimInstallSourceAnswer } from "../models/shop.server";

/**
 * "stored": this call wrote the answer (and emitted `converted`). "lost": the
 * merchant already answered or skipped, or the card was never offered; nothing
 * changed. "failed": the write threw.
 */
export type InstallSourceAnswerOutcome = "stored" | "lost" | "failed";

/**
 * Store the answer for `shopDomain` (session.shop unchanged) unless the claim
 * loses, and emit `converted` only when this call stored it.
 */
export async function recordInstallSourceAnswer(
  shopDomain: string,
  answer: InstallSourceAnswer,
): Promise<InstallSourceAnswerOutcome> {
  let won: boolean;
  try {
    won = await claimInstallSourceAnswer(shopDomain, answer);
  } catch (err) {
    // Name/code only: a Prisma error message embeds the written data (the
    // merchant's free-text "other" answer).
    logger.error("install-source-answer-failed", { shop: shopDomain, ...safeErrorFields(err) });
    return "failed";
  }
  if (!won) return "lost";
  // Never throws (recordOpsEvent swallows and logs any persistence error).
  await recordNudgeConverted(NUDGE_KEYS.INSTALL_SOURCE, shopDomain);
  return "stored";
}
