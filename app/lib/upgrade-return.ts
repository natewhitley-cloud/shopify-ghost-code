/**
 * Return-visit upgrade nudge, Free only (gc-97k.9): the banner at the top of a
 * scan's results asking a returning Free merchant to unlock the rest.
 *
 * Pure and client-safe. The banner reuses the Free teaser's copy source
 * (upgradePreviewCopy: the hidden count + lane breakdown, and the trial vs
 * "Upgrade to Standard" CTA), so this module owns only WHEN it shows.
 *
 * Episodes: the nudge re-shows at most weekly. An episode starts on the first
 * page view that renders it (Shop.upgradeReturnLastShownAt := now) and lasts
 * the cross-prompt cap's 24h window, so it persists on reloads until the
 * merchant acts. "Not now" ends the episode early and counts toward retiring
 * the nudge after UPGRADE_RETURN_MAX_DISMISSALS.
 */
import { PLANS } from "./plans";
import { PROMPT_CAP_WINDOW_MS } from "./prompt-cap";

/** The first successful scan must have completed at least this long ago. */
export const UPGRADE_RETURN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** A new episode may start this long after the previous one started. */
export const UPGRADE_RETURN_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;

/** "Not now" this many times retires the nudge for good. */
export const UPGRADE_RETURN_MAX_DISMISSALS = 3;

export const UPGRADE_RETURN_HEADING = "Ready to clean up the rest?";
export const UPGRADE_RETURN_DISMISS_LABEL = "Not now";

/** When the current episode started and when it was last dismissed. */
export type UpgradeReturnEpisode = {
  upgradeReturnLastShownAt: Date | null;
  upgradeReturnLastDismissedAt: Date | null;
};

export type UpgradeReturnState = UpgradeReturnEpisode & {
  plan: string;
  /** completedAt of the shop's first successful scan, or null if none. */
  firstSuccessfulScanAt: Date | null;
  upgradeReturnDismissCount: number;
};

/**
 * Is this view inside the episode that is currently showing? Started less than
 * the 24h cap window ago and not dismissed since it started.
 */
export function isUpgradeReturnEpisodeOpen(state: UpgradeReturnEpisode, now: Date): boolean {
  const started = state.upgradeReturnLastShownAt;
  if (started === null) return false;
  if (now.getTime() - started.getTime() >= PROMPT_CAP_WINDOW_MS) return false;
  const dismissed = state.upgradeReturnLastDismissedAt;
  return dismissed === null || dismissed.getTime() < started.getTime();
}

/**
 * May this results view show the banner (before the cross-prompt cap)?
 *   - Free plan only;
 *   - the page has hidden findings to talk about (`hasHiddenFindings`);
 *   - the first successful scan completed 24h+ ago (exactly 24h qualifies);
 *   - fewer than 3 "Not now" clicks ever;
 *   - and either the current episode is still open (reload persistence), or a
 *     new one may start: never shown, or the last episode started 7d+ ago
 *     (exactly 7d qualifies).
 */
export function isUpgradeReturnEligible(
  state: UpgradeReturnState,
  hasHiddenFindings: boolean,
  now: Date,
): boolean {
  if (state.plan !== PLANS.FREE || !hasHiddenFindings) return false;
  if (state.firstSuccessfulScanAt === null) return false;
  if (now.getTime() - state.firstSuccessfulScanAt.getTime() < UPGRADE_RETURN_MIN_AGE_MS) {
    return false;
  }
  if (state.upgradeReturnDismissCount >= UPGRADE_RETURN_MAX_DISMISSALS) return false;
  if (isUpgradeReturnEpisodeOpen(state, now)) return true;
  const last = state.upgradeReturnLastShownAt;
  return last === null || now.getTime() - last.getTime() >= UPGRADE_RETURN_RESHOW_MS;
}
