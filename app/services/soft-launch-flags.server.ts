import { FindingType } from "@prisma/client";

import { activeAdvisories } from "../data/app-incident-advisories.server";

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
  // Read from the SAME single homepage request (gc-i6du), so it shares that
  // request's flag: flag off = no request, no category, no finding, not live.
  [FindingType.LIQUID_ERROR_RENDERED]: "SCRIPT_TAG_SUNSET_LIVE_ENABLED",
  // Affected-app advisory (gc-14x5): never in prod before, and it names a
  // real vendor, so it stays dark until its first output has been reviewed.
  [FindingType.APP_INCIDENT_ADVISORY]: "APP_INCIDENT_ADVISORY_LIVE_ENABLED",
};

/**
 * Whether a FindingType is live right now: true unless it is soft-launched and
 * its env flag is not exactly "true". The ONE place a soft-launch flag is read,
 * shared by the scan worker's persistence filter and the storefront step gate.
 */
export function isSoftLaunchLive(type: FindingType): boolean {
  if (type === FindingType.APP_INCIDENT_ADVISORY) return isAdvisoryCheckLive();
  const flag = SOFT_LAUNCH_FLAGS[type];
  return !flag || process.env[flag] === "true";
}

/**
 * Whether the affected-app advisory check is live at `now` (gc-14x5): its
 * flag is on AND at least one list entry has not passed its review date.
 *
 * The second half is what keeps an EXPIRED advisory from reading as "fixed".
 * When the last entry expires the detector emits nothing, and a scan taken
 * then records the type as not live, so the differ and the summary email
 * treat the type as un-audited: the old finding is neither fixed nor (once an
 * entry is renewed) new. Theme health likewise promises nothing for it.
 * Limit: with several entries, one expiring while another is still active
 * leaves the type live, so that one finding does read as resolved.
 */
export function isAdvisoryCheckLive(now: Date = new Date()): boolean {
  return areStoredAdvisoriesShown() && activeAdvisories(now).length > 0;
}

/**
 * The read-time kill switch for the affected-app advisory (gc-5nok): whether
 * STORED APP_INCIDENT_ADVISORY findings may be shown anywhere. The one read of
 * its flag (isAdvisoryCheckLive builds on it). With the flag off, every read
 * path drops them (finding-aggregation.server's choke point), whatever is
 * stored. Deliberately the flag alone, not isAdvisoryCheckLive: an entry past
 * its review date keeps showing on the scans that hold it until the next scan
 * (see the runbook's "After reviewBy").
 */
export function areStoredAdvisoriesShown(): boolean {
  const flag = SOFT_LAUNCH_FLAGS[FindingType.APP_INCIDENT_ADVISORY];
  return process.env[flag!] === "true";
}

/**
 * Whether the storefront script-tag audit may run. Gates the storefront HTTP
 * request itself, not just persistence: the scanner never reads the public
 * storefront while this is false.
 */
export function isScriptTagSunsetLive(): boolean {
  return isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET);
}

/**
 * Whether the known-malicious domain list is also matched against data the
 * app already reads at runtime (gc-0htk): the served homepage HTML (only
 * while the storefront read itself is live, see isScriptTagSunsetLive) and
 * the speed test's request list. Deliberately NOT in SOFT_LAUNCH_FLAGS: the
 * hits are MALICIOUS_SCRIPT findings, and that type's theme-file detector is
 * always live. Off = no matching, nothing stored, nothing shown.
 */
export function isRuntimeMaliciousCheckLive(): boolean {
  return process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED === "true";
}

/**
 * Whether a scan checks the served homepage for known malicious code
 * (gc-0htk): the homepage is read only by the storefront step, which runs
 * only while the script-tag audit is live, and matched only while the runtime
 * check is live. Theme health counts the homepage part of the malicious row
 * as "on now" exactly then (gc-3y89 item 6).
 */
export function isHomepageMaliciousCheckLive(): boolean {
  return isRuntimeMaliciousCheckLive() && isScriptTagSunsetLive();
}

/**
 * Whether the suspicious-code detector runs (gc-dcyh Phase 0): obfuscated or
 * pirated-marker asset JavaScript, counted into the scan_signal OpsEvent only.
 * Deliberately NOT in SOFT_LAUNCH_FLAGS: it has no FindingType and creates no
 * Finding rows, nothing a merchant can see. Off (unset or anything but "true")
 * = the detector does not run at all and scan_signal is unchanged. Read in the
 * scan worker thread, whose env is a copy of the process env taken at spawn.
 */
export function isSuspiciousCodeSignalEnabled(): boolean {
  return process.env.SUSPICIOUS_CODE_SIGNAL_ENABLED === "true";
}
