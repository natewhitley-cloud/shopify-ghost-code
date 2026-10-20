/**
 * Security risk banner views (gc-q5z8): resolves stored APP_INCIDENT_ADVISORY
 * and MALICIOUS_SCRIPT findings against the server-only curated lists and
 * returns plain values for the page (see app/lib/security-risk.ts for the
 * copy and for which findings the caller passes).
 *
 * Order: malicious code first (grouped by domain, in theme order), then the
 * advisories in the order given (callers pass them ranked).
 */
import type { FindingType } from "@prisma/client";

import { advisoryForFinding } from "./app-incident-advisory.server";
import type { FindingRow } from "./finding-aggregation.server";
import { getOwnSectionFindings } from "./free-preview.server";
import {
  activeAdvisories,
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  formatAdvisoryDate,
  type AppIncidentAdvisory,
} from "../data/app-incident-advisories.server";
import {
  homepageMaliciousDescription,
  KNOWN_MALICIOUS_DOMAINS,
  maliciousDescription,
  type MaliciousDomain,
} from "../data/malicious-domains.server";
import { isHomepageMaliciousFinding } from "../lib/finding-classification";
import { isAdvisoryEmbedFinding } from "../lib/finding-remediation";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import type { AdvisoryRisk, MaliciousRisk, SecurityRisk } from "../lib/security-risk";
import { getFindingsForScan } from "../models/finding.server";

/** The stored finding fields the builder reads. */
export interface SecurityRiskSourceFinding {
  id: string;
  findingType: string;
  filename: string;
  lineNumber: number;
  description: string;
}

/**
 * The list entry a stored advisory finding was emitted for, expired entries
 * included (the wording still applies; only the source link is withheld once
 * the entry is past its review date). The same match as the report link
 * (advisoryForFinding: the entry's rebuilt descriptions).
 */
export function advisoryEntryForFinding(
  finding: { findingType: string; description: string },
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): AppIncidentAdvisory | null {
  return advisoryForFinding(finding, advisories);
}

/** "On 13 October 2026, {report}." for an entry. */
export function advisoryReportSentence(advisory: AppIncidentAdvisory): string {
  return `On ${formatAdvisoryDate(advisory.incidentDate)}, ${advisory.report}.`;
}

/**
 * The script host a host-signal advisory matched: the host whose rebuilt
 * description (the detector's own builder) is the stored one. No parsing of
 * the description's format.
 */
function matchedHost(advisory: AppIncidentAdvisory | null, description: string): string | null {
  if (advisory === null) return null;
  return (
    advisory.scriptHosts.find(
      (scriptHost) => advisoryDescription({ advisory, scriptHost }) === description,
    ) ?? null
  );
}

function advisoryRisk(
  finding: SecurityRiskSourceFinding,
  now: Date,
  advisories: ReadonlyArray<AppIncidentAdvisory>,
): AdvisoryRisk {
  const entry = advisoryEntryForFinding(finding, advisories);
  const live = entry !== null && activeAdvisories(now, [entry]).length > 0;
  const signal = isAdvisoryEmbedFinding(finding) ? "embed" : "host";
  return {
    kind: "advisory",
    finding: { id: finding.id, filename: finding.filename, lineNumber: finding.lineNumber },
    appName: entry?.appName ?? null,
    report: entry ? advisoryReportSentence(entry) : null,
    reportedByDeveloper: entry?.reportedByDeveloper ?? false,
    sourceUrl: live && entry ? entry.sourceUrl : null,
    signal,
    scriptHost: signal === "host" ? matchedHost(entry, finding.description) : null,
    description: finding.description,
  };
}

/**
 * The list entry whose description a stored malicious finding carries, or
 * null: the theme wording, or the homepage wording (gc-0htk).
 */
function maliciousEntryForFinding(
  description: string,
  domains: ReadonlyArray<MaliciousDomain>,
): MaliciousDomain | null {
  return (
    domains.find(
      (d) =>
        maliciousDescription(d) === description || homepageMaliciousDescription(d) === description,
    ) ?? null
  );
}

function maliciousRisks(
  findings: readonly SecurityRiskSourceFinding[],
  domains: ReadonlyArray<MaliciousDomain>,
): MaliciousRisk[] {
  const sorted = [...findings].sort(
    (a, b) => a.filename.localeCompare(b.filename) || a.lineNumber - b.lineNumber,
  );
  const byKey = new Map<string, MaliciousRisk>();
  for (const f of sorted) {
    const entry = maliciousEntryForFinding(f.description, domains);
    // gc-0htk: one banner per domain AND source, so a homepage hit never
    // reads as a theme reference (or the other way round).
    const seenIn = isHomepageMaliciousFinding(f) ? "homepage" : "theme";
    // An unknown description (entry removed or reworded) groups by itself.
    const key = `${seenIn}:${entry ? `domain:${entry.domain}` : `description:${f.description}`}`;
    const location = { id: f.id, filename: f.filename, lineNumber: f.lineNumber };
    const existing = byKey.get(key);
    if (existing) {
      existing.findings.push(location);
      continue;
    }
    byKey.set(key, {
      kind: "malicious",
      seenIn,
      domain: entry?.domain ?? null,
      note: entry?.note ?? null,
      // An entry's advice assumes a theme reference to remove.
      advice: seenIn === "theme" ? (entry?.advice ?? null) : null,
      findings: [location],
      description: f.description,
    });
  }
  return [...byKey.values()];
}

/**
 * The banners for a scan, malicious first. Pass the advisories the page shows
 * (non-ignored) and the malicious findings it shows (all of them).
 */
export function buildSecurityRisks(
  input: {
    advisories: readonly SecurityRiskSourceFinding[];
    malicious: readonly SecurityRiskSourceFinding[];
    now: Date;
  },
  lists: {
    advisories?: ReadonlyArray<AppIncidentAdvisory>;
    domains?: ReadonlyArray<MaliciousDomain>;
  } = {},
): SecurityRisk[] {
  const advisoryList = lists.advisories ?? APP_INCIDENT_ADVISORIES;
  const domainList = lists.domains ?? KNOWN_MALICIOUS_DOMAINS;
  return [
    ...maliciousRisks(
      input.malicious.filter((f) => f.findingType === "MALICIOUS_SCRIPT"),
      domainList,
    ),
    ...input.advisories
      .filter((f) => f.findingType === "APP_INCIDENT_ADVISORY")
      .map((f) => advisoryRisk(f, input.now, advisoryList)),
  ];
}

/**
 * Per-finding wording for the "Start here" rows of advisory findings: the
 * app's name and the report sentence, keyed by finding id. Findings whose
 * entry is unknown are left out (the row keeps the neutral type copy).
 */
export function advisoryStartHereCopy(
  findings: ReadonlyArray<{ id: string; findingType: string; description: string }>,
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): Record<string, { appName: string; report: string }> {
  const out: Record<string, { appName: string; report: string }> = {};
  for (const f of findings) {
    const entry = advisoryEntryForFinding(f, advisories);
    if (entry) out[f.id] = { appName: entry.appName, report: advisoryReportSentence(entry) };
  }
  return out;
}

/**
 * Home's banners for its latest successful scan. Reads nothing for a scan with
 * no security risk (the counts are already loaded); otherwise at most one
 * small read per type: the non-ignored advisories (none for a shop with
 * ignores: the summary's kept rows) and every malicious finding, ignored or
 * not (one row per (line, domain)).
 *
 * NEVER throws: a failed read is logged and yields no banners. Home's findings
 * tile and Theme health are built from the counts alone and still say there
 * is a security risk.
 */
export async function loadHomeSecurityRisks(input: {
  shopId: string;
  scanId: string;
  /** The scan's ignore-filtered per-type counts. */
  keptByType: Partial<Record<FindingType, number>>;
  /** The scan's kept findings when the summary had to read them (shop with ignores), else null. */
  keptFindings: readonly FindingRow[] | null;
  /** MALICIOUS_SCRIPT findings the scan found, ignored ones included. */
  maliciousFound: number;
  now: Date;
}): Promise<SecurityRisk[]> {
  const advisoryCount = input.keptByType.APP_INCIDENT_ADVISORY ?? 0;
  if (advisoryCount <= 0 && input.maliciousFound <= 0) return [];
  try {
    const [advisories, malicious] = await Promise.all([
      advisoryCount > 0
        ? getOwnSectionFindings(input.scanId, input.keptByType, input.keptFindings)
        : Promise.resolve([]),
      input.maliciousFound > 0
        ? getFindingsForScan(input.scanId, { findingType: "MALICIOUS_SCRIPT" })
        : Promise.resolve([]),
    ]);
    return buildSecurityRisks({ advisories, malicious, now: input.now });
  } catch (err) {
    logger.warn("security risk: banners unavailable", {
      function: "loadHomeSecurityRisks",
      shopId: input.shopId,
      ...safeErrorFields(err),
    });
    return [];
  }
}
