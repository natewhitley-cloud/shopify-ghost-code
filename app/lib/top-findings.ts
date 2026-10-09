/**
 * "Start here" top findings (gc-bn0x): the ONE ranking used everywhere a scan's
 * most important findings are chosen (the scan page and Home's "Start here"
 * block, and the Free preview picker's order).
 *
 * Pure and client-safe (no DB, no React, no `.server` imports), like
 * finding-consequence.ts. The bounded DB reads that feed it live in
 * app/services/top-findings.server.ts.
 *
 * Ranking (compareFindingImportance), most important first:
 *   1. MALICIOUS_SCRIPT before everything else.
 *   2. Severity: HIGH > MEDIUM > LOW.
 *   3. Consequence urgency: act-now > compounding > whenever (URGENCY_RANK of
 *      the type's CONSEQUENCE_MAP entry).
 *   4. Primary lane in LANES display order.
 *   5. Stable tie-break: createdAt (oldest first), then id.
 *
 * Diversity (pickTopFindings): slots are filled greedily in rank order, but a
 * finding whose TYPE is already picked is passed over when a not-yet-picked
 * type of the SAME severity (the "comparable importance" bar) is still
 * available; the best such finding takes the slot instead. A lower-severity
 * finding never displaces a higher one, so 3 HIGH scripts still beat a LOW
 * finding of another type. MALICIOUS_SCRIPT is exempt: security findings are
 * never displaced and always shown first.
 *
 * Plan safety is the CALLER's job: pass only findings the plan already shows
 * in full (on Free: the free-preview rows plus the always-visible malicious
 * ones). Ignored findings must be excluded before they get here.
 */
import type { FindingType, Severity } from "@prisma/client";

import { adminResourceLocatorLabel } from "./admin-resource-url";
import { isAdminResourceFinding, isStorefrontFinding } from "./finding-classification";
import { CONSEQUENCE_MAP, LANES, soWhatForLane, URGENCY_RANK } from "./finding-consequence";
import type { LaneKey } from "./finding-consequence";
import { findingTypeLabel } from "./finding-type-labels";

/** How many findings the "Start here" block shows at most. */
export const TOP_FINDINGS_MAX = 3;

/** The fields the ranking reads; callers' rows carry more and are returned as-is. */
export type RankableFinding = {
  id: string;
  severity: Severity;
  findingType: FindingType;
  createdAt: Date;
};

const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const LANE_ORDER: Record<string, number> = Object.fromEntries(LANES.map((l, i) => [l.key, i]));

/** 0 for a malicious finding, 1 otherwise (malicious sorts first). */
function maliciousRank(type: FindingType): number {
  return type === "MALICIOUS_SCRIPT" ? 0 : 1;
}

/**
 * The ranking WITHOUT the tie-break (steps 1-4 of the file header): 0 when two
 * findings are equally important by type and severity. Rows of one
 * (findingType, severity) group always compare 0 here.
 */
export function compareFindingClass(
  a: Pick<RankableFinding, "findingType" | "severity">,
  b: Pick<RankableFinding, "findingType" | "severity">,
): number {
  const ca = CONSEQUENCE_MAP[a.findingType];
  const cb = CONSEQUENCE_MAP[b.findingType];
  return (
    maliciousRank(a.findingType) - maliciousRank(b.findingType) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    URGENCY_RANK[ca.urgency] - URGENCY_RANK[cb.urgency] ||
    LANE_ORDER[ca.primary] - LANE_ORDER[cb.primary]
  );
}

/**
 * Total, deterministic importance order (see the file header). Ids are
 * unique, so no two distinct rows compare equal.
 */
export function compareFindingImportance(a: RankableFinding, b: RankableFinding): number {
  return (
    compareFindingClass(a, b) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The `max` most important findings, with the diversity rule from the file
 * header. Does not mutate the input; returns the caller's objects.
 */
export function pickTopFindings<T extends RankableFinding>(
  candidates: readonly T[],
  max: number = TOP_FINDINGS_MAX,
): T[] {
  const remaining = [...candidates].sort(compareFindingImportance);
  const picked: T[] = [];
  const pickedTypes = new Set<FindingType>();

  while (picked.length < max && remaining.length > 0) {
    let index = 0;
    const best = remaining[0];
    if (best.findingType !== "MALICIOUS_SCRIPT" && pickedTypes.has(best.findingType)) {
      const alternative = remaining.findIndex(
        (c) =>
          c.findingType !== "MALICIOUS_SCRIPT" &&
          !pickedTypes.has(c.findingType) &&
          c.severity === best.severity,
      );
      if (alternative !== -1) index = alternative;
    }
    const [next] = remaining.splice(index, 1);
    picked.push(next);
    pickedTypes.add(next.findingType);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Presentation (shared by the scan page and Home)
// ---------------------------------------------------------------------------

/** The serializable row the "Start here" block renders. */
export type TopFindingView = {
  id: string;
  severity: Severity;
  /** Primary consequence lane (Home's lane "Start here" chip follows the first row). */
  lane: LaneKey;
  typeLabel: string;
  /** Where it lives: a theme file (and line), an admin resource, or the storefront. */
  location: string;
  /** One plain line on what it costs the merchant. */
  cost: string;
  /** Where "See how to fix" goes on the scan page. */
  href: string;
};

/** The finding fields toTopFindingView reads. */
export type TopFindingSource = RankableFinding & { filename: string; lineNumber: number };

/**
 * One plain line on what a finding costs: its primary lane's "so what" copy
 * (finding-consequence LANES). Malicious code gets its own line, since the
 * privacy lane's "a removed app is still collecting data" undersells an attack.
 */
export function findingCostLine(findingType: FindingType): string {
  if (findingType === "MALICIOUS_SCRIPT") {
    return "This code can steal shopper data or send your customers to other sites.";
  }
  return soWhatForLane(CONSEQUENCE_MAP[findingType].primary);
}

/** Merchant-facing location: theme file (with line), admin resource, or storefront. */
export function findingLocation(finding: TopFindingSource): string {
  if (isAdminResourceFinding(finding.findingType)) {
    return adminResourceLocatorLabel(finding.findingType, finding.filename);
  }
  if (isStorefrontFinding(finding.findingType)) {
    return "Your storefront's script tags";
  }
  return finding.lineNumber > 0
    ? `${finding.filename}, line ${finding.lineNumber}`
    : finding.filename;
}

/** DOM id of a finding's row on the scan page (the "See how to fix" target). */
export function findingAnchorId(id: string): string {
  return `finding-${id}`;
}

/**
 * Where a top finding links on the scan page:
 *   - Malicious: its row in the security alert (every plan).
 *   - Free (`fullList` false): its preview row, on the same unfiltered page.
 *   - Standard / Professional: the full list filtered to its type, so the row
 *     is on the first page unless 50+ findings of that type rank above it by
 *     the list's own order.
 */
export function topFindingHref(
  scanId: string,
  finding: { id: string; findingType: FindingType },
  fullList: boolean,
): string {
  const hash = `#${findingAnchorId(finding.id)}`;
  if (!fullList || finding.findingType === "MALICIOUS_SCRIPT") {
    return `/app/scans/${scanId}${hash}`;
  }
  return `/app/scans/${scanId}?type=${encodeURIComponent(finding.findingType)}${hash}`;
}

/** Build the block's rows. `fullList` is true when the plan shows the full list. */
export function toTopFindingViews(
  scanId: string,
  findings: readonly TopFindingSource[],
  fullList: boolean,
): TopFindingView[] {
  return findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    lane: CONSEQUENCE_MAP[f.findingType].primary,
    typeLabel: findingTypeLabel(f.findingType),
    location: findingLocation(f),
    cost: findingCostLine(f.findingType),
    href: topFindingHref(scanId, f, fullList),
  }));
}
