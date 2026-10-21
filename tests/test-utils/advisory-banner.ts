/**
 * The Security risk banner's report link for one stored advisory finding
 * (gc-xtno): the live path, buildSecurityRisks, which the scan page and Home
 * use. Null when the finding is not an advisory, its entry is unknown or
 * reworded, or the entry has passed its review date at `now`.
 */
import type { AppIncidentAdvisory } from "../../app/data/app-incident-advisories.server";
import { buildSecurityRisks } from "../../app/services/security-risk.server";

export function bannerSourceUrl(
  finding: { findingType: string; description: string; filename?: string; lineNumber?: number },
  now: Date = new Date(),
  advisories?: ReadonlyArray<AppIncidentAdvisory>,
): string | null {
  const [risk] = buildSecurityRisks(
    {
      advisories: [{ id: "finding-1", filename: "layout/theme.liquid", lineNumber: 1, ...finding }],
      malicious: [],
      now,
    },
    advisories ? { advisories } : {},
  );
  return risk?.kind === "advisory" ? risk.sourceUrl : null;
}
