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
};
