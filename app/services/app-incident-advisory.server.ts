/**
 * Affected-app advisory (gc-14x5): what the server needs from the curated
 * list for a STORED finding (the Security risk banner resolves its entry
 * through advisoryForFinding, see security-risk.server.ts).
 */
import {
  advisoryDescriptions,
  APP_INCIDENT_ADVISORIES,
  matchAdvisoryScriptHost,
  type AppIncidentAdvisory,
} from "../data/app-incident-advisories.server";
import { hostnameFromUrl } from "../lib/url.server";

/**
 * The entry of `advisories` an APP_INCIDENT_ADVISORY finding was emitted for,
 * or null. Review dates are NOT applied: pass only the entries that count.
 */
export function advisoryForFinding(
  finding: { findingType: string; description: string },
  advisories: ReadonlyArray<AppIncidentAdvisory>,
): AppIncidentAdvisory | null {
  if (finding.findingType !== "APP_INCIDENT_ADVISORY") return null;
  return (
    advisories.find((advisory) => advisoryDescriptions(advisory).includes(finding.description)) ??
    null
  );
}

/**
 * No double report: drop the "unrecognized script" rows on a host whose app
 * the scan is reporting as an advisory, so the merchant is not also asked
 * "which app left this?" about an app the page already names.
 *
 * "Reporting" means an advisory finding for that entry is among
 * `persistedFindings` (the findings this scan will store: the check is live,
 * the theme is the published one, the entry is unexpired and the theme really
 * loads the script or has the app's embed turned on). With no such finding
 * nothing is dropped, so a host that
 * is only mentioned, an expired entry or a dark check leaves the rows exactly
 * as they were.
 */
export function dropAdvisoryUnknownScripts<T extends { url: string }>(
  unknownScripts: readonly T[],
  persistedFindings: ReadonlyArray<{ findingType: string; description: string }>,
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): T[] {
  const reported = persistedFindings
    .map((finding) => advisoryForFinding(finding, advisories))
    .filter((advisory): advisory is AppIncidentAdvisory => advisory !== null);
  if (reported.length === 0) return [...unknownScripts];
  return unknownScripts.filter((script) => {
    const host = hostnameFromUrl(script.url);
    return host === null || matchAdvisoryScriptHost(host, reported) === null;
  });
}
