/**
 * Affected-app advisory (gc-14x5): what the scan page needs from the curated
 * list for a STORED finding. The list is server-only, so the loader resolves
 * it here and passes plain values to the card.
 */
import {
  activeAdvisories,
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  matchAdvisoryScriptHost,
  type AppIncidentAdvisory,
} from "../data/app-incident-advisories.server";
import { hostnameFromUrl } from "../lib/url.server";

/**
 * The public report behind a stored APP_INCIDENT_ADVISORY finding, or null.
 *
 * A finding stores no reference to its list entry, so the entry is resolved
 * by rebuilding each entry's description (advisoryDescription, the detector's
 * own builder) and comparing it with the stored one. That is exact: the
 * description holds the entry's app name, matched host, summary and date.
 *
 * Null (the card then shows no link) when the finding is another type, when
 * the entry was removed or reworded since the scan, or when it has passed its
 * review date at `now`: an expired entry is no longer vouched for.
 */
export function advisoryReportUrlForFinding(
  finding: { findingType: string; description: string },
  now: Date = new Date(),
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): string | null {
  return advisoryForFinding(finding, activeAdvisories(now, advisories))?.sourceUrl ?? null;
}

/** The entry of `advisories` an APP_INCIDENT_ADVISORY finding was emitted for, or null. */
function advisoryForFinding(
  finding: { findingType: string; description: string },
  advisories: ReadonlyArray<AppIncidentAdvisory>,
): AppIncidentAdvisory | null {
  if (finding.findingType !== "APP_INCIDENT_ADVISORY") return null;
  for (const advisory of advisories) {
    for (const scriptHost of advisory.scriptHosts) {
      if (advisoryDescription({ advisory, scriptHost }) === finding.description) return advisory;
    }
  }
  return null;
}

/**
 * No double report: drop the "unrecognized script" rows on a host whose app
 * the scan is reporting as an advisory, so the merchant is not also asked
 * "which app left this?" about an app the page already names.
 *
 * "Reporting" means an advisory finding for that entry is among
 * `persistedFindings` (the findings this scan will store: the check is live,
 * the theme is the published one, the entry is unexpired and the theme really
 * loads the script). With no such finding nothing is dropped, so a host that
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
