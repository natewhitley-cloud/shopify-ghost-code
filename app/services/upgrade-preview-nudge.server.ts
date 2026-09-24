/**
 * Free-tier upgrade-preview nudge (gc-97k.4): once-per-merchant funnel events.
 *
 * The teaser on a Free shop's scan page ("N more findings on Standard: ...")
 * reports shown -> clicked -> converted through nudge-telemetry. The dedup
 * (atomic Shop stamp claim, emit only when the claim wins) is the shared
 * recordNudgeStageOnce in nudge-stage.server; this module pins it to the
 * upgrade-preview nudge so its callers stay one-argument simple.
 *
 * The teaser has no dismiss control, so there is no `dismissed` stage.
 *
 * NEVER THROWS (see recordNudgeStageOnce).
 */
import { recordNudgeStageOnce } from "./nudge-stage.server";
import type { NudgeStageOf } from "./nudge-stage.server";
import { NUDGE_KEYS } from "./nudge-telemetry.server";

/** A stage of the free-tier upgrade-preview nudge funnel. */
export type UpgradePreviewStage = NudgeStageOf<typeof NUDGE_KEYS.UPGRADE_PREVIEW>;

/**
 * Emit the upgrade-preview `stage` event for this shop, at most once ever.
 * `shopDomain` must be session.shop unchanged (deleteShopData purges by it).
 * Returns true when the event was emitted by this call.
 */
export function recordUpgradePreviewStageOnce(
  stage: UpgradePreviewStage,
  shopDomain: string,
): Promise<boolean> {
  return recordNudgeStageOnce(NUDGE_KEYS.UPGRADE_PREVIEW, stage, shopDomain);
}
