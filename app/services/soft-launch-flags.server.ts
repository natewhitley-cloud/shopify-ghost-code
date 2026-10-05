import { FindingType } from "@prisma/client";

/**
 * Soft-launched finding types (spec 5.6): detected on every scan but persisted
 * only when the mapped env var === "true". Never-in-prod detectors go here until
 * their first output has had a precision review. Shared (not worker-local) so
 * the scan engine can exclude these types from GHOST_APP_EMBED corroboration
 * (gc-n02p): evidence the merchant will never see must not justify a finding.
 */
export const SOFT_LAUNCH_FLAGS: Partial<Record<FindingType, string>> = {
  [FindingType.SETTINGS_DRIFT]: "SETTINGS_DRIFT_LIVE_ENABLED",
  [FindingType.APP_EMBED_OFF]: "APP_EMBED_LIVE_ENABLED",
  [FindingType.GHOST_APP_EMBED]: "APP_EMBED_LIVE_ENABLED",
  // Also gates the storefront request itself (isScriptTagSunsetLive below):
  // flag off = no storefront fetch, no category, no finding (dark).
  [FindingType.SCRIPT_TAG_SUNSET]: "SCRIPT_TAG_SUNSET_LIVE_ENABLED",
};

/**
 * Whether a FindingType is live right now: true unless it is soft-launched and
 * its env flag is not exactly "true". The ONE place a soft-launch flag is read,
 * shared by the scan worker's persistence filter and the storefront step gate.
 */
export function isSoftLaunchLive(type: FindingType): boolean {
  const flag = SOFT_LAUNCH_FLAGS[type];
  return !flag || process.env[flag] === "true";
}

/**
 * Whether the storefront script-tag audit may run. Gates the storefront HTTP
 * request itself, not just persistence: the scanner never reads the public
 * storefront while this is false.
 */
export function isScriptTagSunsetLive(): boolean {
  return isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET);
}
