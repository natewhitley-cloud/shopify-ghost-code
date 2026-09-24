/**
 * Once-per-merchant nudge funnel stages (gc-97k.4 generalized for gc-97k.3).
 *
 * nudge-telemetry.server writes one nudge_* OpsEvent per call and leaves dedup
 * to the caller. This module supplies it for every nudge: each (nudge, stage)
 * maps to a Shop stamp column, the stage first claims that column atomically
 * (claimNudgeStage: updateMany where the column IS NULL) and the event is
 * emitted only when the claim wins. Reloads, concurrent renders, repeat clicks
 * and repeat submits therefore never double-count.
 *
 * A nudge only lists the stages it has: the upgrade preview has no dismiss
 * control, so it has no `dismissed` entry and passing one fails the build.
 *
 * NEVER THROWS: a failed claim is logged and treated as "not first", so a
 * telemetry problem can never break the page, action or job that called it.
 */
import type { Prisma } from "@prisma/client";

import {
  NUDGE_KEYS,
  recordNudgeClicked,
  recordNudgeConverted,
  recordNudgeDismissed,
  recordNudgeShown,
} from "./nudge-telemetry.server";
import type { NudgeKey } from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import { claimNudgeStage } from "../models/shop.server";
import type { NudgeStageColumn } from "../models/shop.server";

export type NudgeStage = "shown" | "clicked" | "dismissed" | "converted";

type StageClaim = { column: NudgeStageColumn; extraWhere?: Prisma.ShopWhereInput };

const NUDGE_STAGE_CLAIMS = {
  [NUDGE_KEYS.UPGRADE_PREVIEW]: {
    shown: { column: "upgradePreviewShownAt" },
    clicked: { column: "upgradePreviewClickedAt" },
    // Only a merchant who clicked the preview CTA counts as a conversion of it.
    converted: {
      column: "upgradePreviewConvertedAt",
      extraWhere: { upgradePreviewClickedAt: { not: null } },
    },
  },
  [NUDGE_KEYS.FEEDBACK]: {
    shown: { column: "feedbackNudgeShownAt" },
    clicked: { column: "feedbackNudgeClickedAt" },
    dismissed: { column: "feedbackNudgeDismissedAt" },
    // The FIRST submission, whether or not it came through the nudge.
    converted: { column: "feedbackSubmittedAt" },
  },
} as const satisfies Record<NudgeKey, Partial<Record<NudgeStage, StageClaim>>>;

/** The stages a given nudge supports (e.g. no `dismissed` for the upgrade preview). */
export type NudgeStageOf<K extends NudgeKey> = keyof (typeof NUDGE_STAGE_CLAIMS)[K] & NudgeStage;

const EMITTERS: Record<NudgeStage, typeof recordNudgeShown> = {
  shown: recordNudgeShown,
  clicked: recordNudgeClicked,
  dismissed: recordNudgeDismissed,
  converted: recordNudgeConverted,
};

/**
 * Claim `stage` of `nudgeKey` for this shop and emit its funnel event, at most
 * once ever. `shopDomain` must be session.shop unchanged (deleteShopData purges
 * the events by it). Returns true when the event was emitted by this call.
 *
 * Failure logs as `<nudge-key>-nudge-claim-failed` (e.g.
 * `upgrade-preview-nudge-claim-failed`).
 */
export async function recordNudgeStageOnce<K extends NudgeKey>(
  nudgeKey: K,
  stage: NudgeStageOf<K>,
  shopDomain: string,
): Promise<boolean> {
  const claims: Partial<Record<NudgeStage, StageClaim>> = NUDGE_STAGE_CLAIMS[nudgeKey];
  const claim = claims[stage] as StageClaim;
  let claimed: boolean;
  try {
    claimed = await claimNudgeStage(shopDomain, claim.column, claim.extraWhere);
  } catch (err) {
    logger.error(`${nudgeKey.replaceAll("_", "-")}-nudge-claim-failed`, {
      shop: shopDomain,
      stage,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!claimed) return false;
  await EMITTERS[stage](nudgeKey, shopDomain);
  return true;
}
