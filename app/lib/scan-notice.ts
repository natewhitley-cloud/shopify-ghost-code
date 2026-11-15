/**
 * The scan page's one notice slot (gc-np1d.6, decision A, page map
 * "### Scan results"): at most ONE of these notices renders, as a quiet
 * notice directly below the value-action card. Pure and client-safe.
 *
 * The action card is the page's one upgrade ask above the findings; the slot
 * may hold one more. Nothing else on the page asks for an upgrade: the
 * walk-coverage notice keeps its "Professional checks ..." line without a
 * button.
 *
 * Outside the slot (unchanged, never paywalled): the security risk and
 * checkout-guard banners, the failed / timed-out scan banners and the
 * coverage notices.
 *
 * Telemetry: only the winner records a "shown" stamp (the return banner's
 * episode, the teaser's stage, the stale-results nudge). The return banner is
 * a capped prompt and claims in resolvePrompt; it ranks first, so a claimed
 * return banner always wins the slot.
 */
import { PROMPT_CAP_WINDOW_MS } from "./prompt-cap";

/** Every notice the slot can hold, highest priority first. */
export const SCAN_NOTICE_PRIORITY = ["upgrade_return", "upgrade_preview", "stale_results"] as const;

export type ScanNoticeKey = (typeof SCAN_NOTICE_PRIORITY)[number];

/** Which notices want the slot on this load (absent = false). */
export type ScanNoticeCandidates = Partial<Record<ScanNoticeKey, boolean>>;

/** The one notice to render in the slot, or null when none wants it. */
export function pickScanNotice(candidates: ScanNoticeCandidates): ScanNoticeKey | null {
  return SCAN_NOTICE_PRIORITY.find((key) => candidates[key] === true) ?? null;
}

/**
 * The notice the slot renders in this view. After "Not now" on the return
 * banner the slot stays empty for the rest of the view (audit r1 M3), even if
 * a later load picks another notice: nothing takes the dismissed banner's spot.
 */
export function visibleScanNotice(
  picked: ScanNoticeKey | null,
  upgradeReturnDismissed: boolean,
): ScanNoticeKey | null {
  return upgradeReturnDismissed ? null : picked;
}

/**
 * Whether the teaser is held after "Not now" on the return banner (audit r2
 * M1): for PROMPT_CAP_WINDOW_MS (24h) after the stored dismissal, a load that
 * would pick the teaser leaves the slot empty instead, so it records no
 * "shown" stamp. A later reload in the same view (e.g. after an ignore) can
 * no longer stamp a teaser the client keeps hidden. A hard 24h hold, like
 * homePromptsHeld, without guessing whether a tab still shows the page.
 * Exactly 24h no longer holds.
 */
export function scanTeaserHeld(upgradeReturnLastDismissedAt: Date | null, now: Date): boolean {
  return (
    upgradeReturnLastDismissedAt instanceof Date &&
    now.getTime() - upgradeReturnLastDismissedAt.getTime() < PROMPT_CAP_WINDOW_MS
  );
}
