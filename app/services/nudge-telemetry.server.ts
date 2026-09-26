/**
 * Nudge-funnel telemetry (gc-97k.1), ported from ClearSignal's
 * nudge-telemetry.server (ba-1zbf.1).
 *
 * A standard way to measure ANY in-app nudge's funnel:
 *
 *     shown -> clicked -> { converted | dismissed }
 *
 * plus `not_shown` for a nudge the platform declined to display (gc-97k.7:
 * Shopify's native review modal), with a short allow-listed reason `code`.
 *
 * Each stage is one `OpsEvent` row: eventType = one of NUDGE_FUNNEL_EVENT_TYPES,
 * key = the shop DOMAIN, metadata = { nudgeKey }. The operator digest groups
 * them per nudgeKey (aggregateNudgeFunnel), so a new nudge needs no
 * nudge-specific plumbing beyond a new NUDGE_KEYS entry.
 *
 * GhostCode differences from the ClearSignal original:
 *   - Sink is `recordOpsEvent`, not an ObsEvent `captureMessage`.
 *   - OpsEvent has no shopId column, so the emitters take the shop DOMAIN and
 *     write it as `key`. That is exactly what deleteShopData's `key: domain`
 *     clause purges on shop/redact, and pruneOpsEvents ages the rows out at 90d.
 *     Pass the same domain string the session carries (session.shop); do not
 *     reformat it, or the redact clause may not match.
 *   - `nudgeKey` is typed to NUDGE_KEYS so a typo fails the build.
 *
 * NEVER THROWS: recordOpsEvent already swallows and logs any persistence
 * error, so these are safe to `await` (or `void`) in a loader or action.
 *
 * DEDUP is the caller's job. `recordNudgeShown` writes a row every call; a
 * nudge rendered from a hot loader should guard it to once-per-merchant so
 * impressions are not inflated by every page load. `clicked` is typically driven
 * by a `?src=nudge` marker on the CTA link, checked in the target's loader.
 */
import { OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";

/** The nudges that exist (or are planned). The digest renders these by name. */
export const NUDGE_KEYS = {
  UPGRADE_PREVIEW: "upgrade_preview", // gc-97k.4
  FEEDBACK: "feedback", // gc-97k.3
  REVIEW_REQUEST: "review_request", // gc-97k.7
  UPGRADE_RETURN: "upgrade_return", // gc-97k.9
} as const;

export type NudgeKey = (typeof NUDGE_KEYS)[keyof typeof NUDGE_KEYS];

type NudgeEventType =
  | typeof OPS_EVENT_TYPES.NUDGE_SHOWN
  | typeof OPS_EVENT_TYPES.NUDGE_CLICKED
  | typeof OPS_EVENT_TYPES.NUDGE_DISMISSED
  | typeof OPS_EVENT_TYPES.NUDGE_CONVERTED
  | typeof OPS_EVENT_TYPES.NUDGE_NOT_SHOWN;

function recordNudgeEvent(
  eventType: NudgeEventType,
  nudgeKey: NudgeKey,
  shopDomain: string,
  extra?: { code: string },
): Promise<void> {
  return recordOpsEvent({ eventType, key: shopDomain, metadata: { nudgeKey, ...extra } });
}

/** The nudge was rendered to the merchant (guard to once-per-merchant upstream). */
export function recordNudgeShown(nudgeKey: NudgeKey, shopDomain: string): Promise<void> {
  return recordNudgeEvent(OPS_EVENT_TYPES.NUDGE_SHOWN, nudgeKey, shopDomain);
}

/** The merchant clicked the nudge's CTA (typically detected via ?src=nudge). */
export function recordNudgeClicked(nudgeKey: NudgeKey, shopDomain: string): Promise<void> {
  return recordNudgeEvent(OPS_EVENT_TYPES.NUDGE_CLICKED, nudgeKey, shopDomain);
}

/** The merchant dismissed the nudge ("Not now"). Terminal (negative). */
export function recordNudgeDismissed(nudgeKey: NudgeKey, shopDomain: string): Promise<void> {
  return recordNudgeEvent(OPS_EVENT_TYPES.NUDGE_DISMISSED, nudgeKey, shopDomain);
}

/**
 * The app asked the platform to show the nudge and it declined (e.g. Shopify's
 * review modal in its cooldown), so the merchant saw nothing. `code` is the
 * reason; pass only an allow-listed value, never free text (counts-only).
 */
export function recordNudgeNotShown(
  nudgeKey: NudgeKey,
  shopDomain: string,
  code: string,
): Promise<void> {
  return recordNudgeEvent(OPS_EVENT_TYPES.NUDGE_NOT_SHOWN, nudgeKey, shopDomain, { code });
}

/** The merchant completed the nudge's goal (e.g. upgraded). Terminal (positive). */
export function recordNudgeConverted(nudgeKey: NudgeKey, shopDomain: string): Promise<void> {
  return recordNudgeEvent(OPS_EVENT_TYPES.NUDGE_CONVERTED, nudgeKey, shopDomain);
}
