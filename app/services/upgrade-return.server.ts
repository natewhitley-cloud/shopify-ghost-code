/**
 * Return-visit upgrade nudge, Free only (gc-97k.9): the server-side writes.
 *
 * When WHEN it shows is decided by isUpgradeReturnEligible (app/lib/
 * upgrade-return.ts) plus the cross-prompt cap; this module records what
 * happened:
 *   - markUpgradeReturnShown: the banner rendered. Starts a new weekly episode
 *     (plain update of upgradeReturnLastShownAt) unless one is open, and emits
 *     `shown` once per merchant.
 *   - dismissUpgradeReturn: "Not now". Counts only inside an open episode, at
 *     most once per episode (repeat or concurrent submits count once): one
 *     conditional statement increments the dismiss count and ends the
 *     episode. Emits `dismissed` once per merchant, only when it counted.
 * `clicked` (the /app/upgrade ping) and `converted` (billing reconciler) go
 * through recordNudgeStageOnce directly, like the upgrade preview's.
 *
 * NEVER THROWS: a failed write is logged; telemetry never breaks the page.
 */
import { recordNudgeStageOnce } from "./nudge-stage.server";
import { NUDGE_KEYS } from "./nudge-telemetry.server";
import { logger } from "../lib/logger.server";
import { PROMPT_CAP_WINDOW_MS } from "../lib/prompt-cap";
import { isUpgradeReturnEpisodeOpen } from "../lib/upgrade-return";
import type { UpgradeReturnEpisode } from "../lib/upgrade-return";
import { recordUpgradeReturnDismissal, startUpgradeReturnEpisode } from "../models/shop.server";

function logFailure(event: string, shopDomain: string, err: unknown): void {
  logger.error(event, {
    shop: shopDomain,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The banner rendered on this page view. `shop` is the state the loader read
 * (before this view). `shopDomain` must be session.shop unchanged.
 */
export async function markUpgradeReturnShown(
  shopDomain: string,
  shop: UpgradeReturnEpisode & { upgradeReturnShownAt: Date | null },
  now: Date,
): Promise<void> {
  if (!isUpgradeReturnEpisodeOpen(shop, now)) {
    try {
      await startUpgradeReturnEpisode(shopDomain, now);
    } catch (err) {
      logFailure("upgrade-return-episode-write-failed", shopDomain, err);
    }
  }
  if (shop.upgradeReturnShownAt === null) {
    await recordNudgeStageOnce(NUDGE_KEYS.UPGRADE_RETURN, "shown", shopDomain);
  }
}

/**
 * "Not now" on the banner. `shop` is the episode state the action read on this
 * request; `shopDomain` must be session.shop unchanged. No open episode (never
 * shown, the 24h window passed, or already dismissed): nothing is written or
 * emitted. Returns true IFF this call counted a dismissal.
 */
export async function dismissUpgradeReturn(
  shopDomain: string,
  shop: UpgradeReturnEpisode,
  now: Date,
): Promise<boolean> {
  const started = shop.upgradeReturnLastShownAt;
  if (started === null || !isUpgradeReturnEpisodeOpen(shop, now)) return false;
  let counted: boolean;
  try {
    counted = await recordUpgradeReturnDismissal(
      shopDomain,
      {
        upgradeReturnLastShownAt: started,
        upgradeReturnLastDismissedAt: shop.upgradeReturnLastDismissedAt,
      },
      now,
      PROMPT_CAP_WINDOW_MS,
    );
  } catch (err) {
    logFailure("upgrade-return-dismiss-write-failed", shopDomain, err);
    return false;
  }
  if (!counted) return false;
  await recordNudgeStageOnce(NUDGE_KEYS.UPGRADE_RETURN, "dismissed", shopDomain);
  return true;
}
