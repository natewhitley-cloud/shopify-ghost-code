/**
 * Affected-app advisory (gc-14x5): what the scan page needs from the curated
 * list for a STORED finding. The list is server-only, so the loader resolves
 * it here and passes plain values to the card.
 */
import {
  activeAdvisories,
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  type AppIncidentAdvisory,
} from "../data/app-incident-advisories.server";

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
  if (finding.findingType !== "APP_INCIDENT_ADVISORY") return null;
  for (const advisory of activeAdvisories(now, advisories)) {
    for (const scriptHost of advisory.scriptHosts) {
      if (advisoryDescription({ advisory, scriptHost }) === finding.description) {
        return advisory.sourceUrl;
      }
    }
  }
  return null;
}
