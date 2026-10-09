/**
 * "Start here" top findings (gc-bn0x): the bounded reads behind the pure
 * ranking in app/lib/top-findings.ts, shared by the scan page and Home.
 *
 * Plan safety: a plan that shows every finding in full (Standard and
 * Professional) ranks over the whole scan. Free ranks ONLY over what Free
 * already shows in full: its preview rows (app/lib/free-preview.ts) plus the
 * malicious findings, which are shown in full on every plan. So a Free shop's
 * top 3 are always a subset of what its scan page shows, and the block can
 * never reveal a hidden finding.
 *
 * Ignores: a shop with ignores passes `keptFindings` (the scan's non-ignored
 * findings, already read by the summary), so ignored findings never reach the
 * ranking and the scan's findings are never read twice. A shop without
 * ignores (keptFindings null) uses the bounded reads below.
 *
 * Cost, full-list plans without ignores: ONE (findingType, severity) groupBy
 * over the scanId index, then one `take <= 3` read per planned group (see
 * planTopFindingReads; typically 1 to 4, in parallel). Free without ignores:
 * the preview's own bounded reads (at most one per non-empty (lane, urgency)
 * bucket) plus, only when the scan has malicious findings, one `take 3`
 * malicious read. A caller that already has those rows passes them in
 * and nothing is read.
 */
import type { FindingType, Severity } from "@prisma/client";

import type { FindingRow } from "./finding-aggregation.server";
import { getFreePreviewFindings } from "./free-preview.server";
import { compareFindingClass, pickTopFindings, TOP_FINDINGS_MAX } from "../lib/top-findings";
import { getTopFindingsInGroup, getTypeSeverityCountsForScan } from "../models/finding.server";

/** One (findingType, severity) group's row count. */
export type GroupCount = { findingType: FindingType; severity: Severity; count: number };

/** One bounded read: the first `take` rows of a (findingType, severity) group. */
export type GroupRead = { findingType: FindingType; severity: Severity; take: number };

const LEVELS = ["MALICIOUS", "HIGH", "MEDIUM", "LOW"] as const;

function levelOf(g: GroupCount): (typeof LEVELS)[number] {
  return g.findingType === "MALICIOUS_SCRIPT" ? "MALICIOUS" : g.severity;
}

/**
 * Which group reads are enough to reproduce pickTopFindings over the WHOLE
 * scan, from counts alone.
 *
 * Why it is exact:
 *   - pickTopFindings never lets a lower level displace a higher one
 *     (malicious, then HIGH, MEDIUM, LOW), so how many picks come from each
 *     level depends only on the counts: drain the levels in order.
 *   - Inside one group every row has the same class, so the group's rows are
 *     picked in its own (createdAt, id) order: its first `p` rows suffice when
 *     `p` picks come from its level.
 *   - In a level with `p` picks, the best remaining row is always inside the
 *     best classes holding `p` rows, and the diversity swap takes the best row
 *     of a not-yet-picked type; at most 2 types are picked before any slot, so
 *     the best classes holding 3 distinct types always contain it. Reading
 *     every group of those classes (a prefix in class order) therefore
 *     contains every row the pick can take. Malicious rows are never swapped,
 *     so their level only needs `p` rows.
 *
 * tests/services/top-findings.server.test.ts checks this against a brute
 * force pick over randomized scans.
 */
export function planTopFindingReads(
  counts: readonly GroupCount[],
  max: number = TOP_FINDINGS_MAX,
): GroupRead[] {
  const reads: GroupRead[] = [];
  let slotsLeft = max;
  for (const level of LEVELS) {
    if (slotsLeft <= 0) break;
    const groups = counts
      .filter((g) => g.count > 0 && levelOf(g) === level)
      .sort(compareFindingClass);
    const levelRows = groups.reduce((sum, g) => sum + g.count, 0);
    const picks = Math.min(slotsLeft, levelRows);
    if (picks === 0) continue;
    slotsLeft -= picks;

    let rows = 0;
    const types = new Set<FindingType>();
    for (let i = 0; i < groups.length; ) {
      const enough = rows >= picks && (level === "MALICIOUS" || types.size >= max);
      if (enough) break;
      // Take the whole class (every group tied with groups[i]) at once.
      let j = i;
      while (j < groups.length && compareFindingClass(groups[j], groups[i]) === 0) {
        const g = groups[j];
        reads.push({
          findingType: g.findingType,
          severity: g.severity,
          take: Math.min(g.count, picks),
        });
        rows += g.count;
        types.add(g.findingType);
        j += 1;
      }
      i = j;
    }
  }
  return reads;
}

/**
 * The scan's top findings over EVERY non-ignored finding (full-list plans).
 * `keptFindings` non-null: the shop has ignores and these are the kept rows
 * (no query). Null: the bounded counts-then-groups reads.
 */
export async function getFullListTopFindings(
  scanId: string,
  keptFindings: readonly FindingRow[] | null,
): Promise<FindingRow[]> {
  if (keptFindings !== null) return pickTopFindings(keptFindings);
  const reads = planTopFindingReads(await getTypeSeverityCountsForScan(scanId));
  if (reads.length === 0) return [];
  const rows = await Promise.all(
    reads.map((r) => getTopFindingsInGroup(scanId, r.findingType, r.severity, r.take)),
  );
  return pickTopFindings(rows.flat());
}

/**
 * The scan's top findings for a Free shop: ranked only over the Free preview
 * rows and the scan's non-ignored malicious findings (both shown in full on
 * Free). Pass `loaded` when the caller already read both (the scan page);
 * otherwise they are read here, bounded (see the file header).
 *
 * `byType` is the ignore-filtered summary aggregate the preview formula uses.
 */
export async function getFreeTopFindings(
  scanId: string,
  byType: Partial<Record<FindingType, number>>,
  keptFindings: readonly FindingRow[] | null,
  loaded?: { preview: readonly FindingRow[]; malicious: readonly FindingRow[] },
): Promise<FindingRow[]> {
  if (loaded) return pickTopFindings([...loaded.malicious, ...loaded.preview]);

  const malicious = async (): Promise<FindingRow[]> => {
    if (keptFindings !== null) {
      return keptFindings.filter((f) => f.findingType === "MALICIOUS_SCRIPT");
    }
    if ((byType.MALICIOUS_SCRIPT ?? 0) === 0) return [];
    return getTopFindingsInGroup(scanId, "MALICIOUS_SCRIPT", null, TOP_FINDINGS_MAX);
  };

  const [preview, maliciousRows] = await Promise.all([
    getFreePreviewFindings(scanId, byType, keptFindings),
    malicious(),
  ]);
  return pickTopFindings([...maliciousRows, ...preview]);
}
