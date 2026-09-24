/**
 * Free-tier upgrade-preview nudge (gc-97k.4): once-per-merchant funnel events.
 *
 * The teaser on a Free shop's scan page ("N more findings on Standard: ...")
 * reports shown -> clicked -> converted through nudge-telemetry. That module
 * leaves dedup to the caller; this one supplies it. Each stage first claims its
 * Shop stamp column atomically (claimUpgradePreviewStage) and emits the
 * nudge_* event only when the claim wins, so reloads, concurrent renders,
 * repeat clicks and repeat upgrades never double-count.
 *
 * The teaser has no dismiss control, so there is no `dismissed` stage.
 *
 * NEVER THROWS: a failed claim is logged and treated as "not first", so a
 * telemetry problem can never break the scan page, the upgrade redirect, or
 * the plan reconcile.
 */
import {
  NUDGE_KEYS,
  recordNudgeClicked,
  recordNudgeConverted,
  recordNudgeShown,
} from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import { claimUpgradePreviewStage } from "../models/shop.server";
import type { UpgradePreviewStage } from "../models/shop.server";

const EMITTERS: Record<UpgradePreviewStage, typeof recordNudgeShown> = {
  shown: recordNudgeShown,
  clicked: recordNudgeClicked,
  converted: recordNudgeConverted,
};

/**
 * Emit the upgrade-preview `stage` event for this shop, at most once ever.
 * `shopDomain` must be session.shop unchanged (deleteShopData purges by it).
 * Returns true when the event was emitted by this call.
 */
export async function recordUpgradePreviewStageOnce(
  stage: UpgradePreviewStage,
  shopDomain: string,
): Promise<boolean> {
  let claimed: boolean;
  try {
    claimed = await claimUpgradePreviewStage(shopDomain, stage);
  } catch (err) {
    logger.error("upgrade-preview-nudge-claim-failed", {
      shop: shopDomain,
      stage,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!claimed) return false;
  await EMITTERS[stage](NUDGE_KEYS.UPGRADE_PREVIEW, shopDomain);
  return true;
}
