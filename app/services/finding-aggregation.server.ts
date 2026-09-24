/**
 * Ignored-finding aggregation choke point (E2.2, gc-57t).
 *
 * A merchant can suppress false-positive findings at two granularities (E2.1):
 *   - INSTANCE: one specific finding, keyed by its `fingerprintFinding(...)` hex.
 *   - APP: every finding attributed to an app, keyed by `Finding.appName`.
 *
 * `getIgnoredFindingsForShop` (models/ignored-finding.server) reads both key
 * sets in one query. This module is the SINGLE place that decides whether a
 * given finding is suppressed, so every aggregation/report path excludes the
 * same findings the same way:
 *
 *   - `filterIgnoredFindings` — the pure choke point. Partitions a findings
 *     array into `{ kept, ignored }`. Consumed by the scan-diff route (both the
 *     current AND previous finding sets) so an ignored finding never counts as
 *     "new" or "resolved".
 *   - `getFilteredFindingSummary` — the aggregate choke point. Loads a scan's
 *     findings once, filters them, and rolls the KEPT set up into the same
 *     `{ total, bySeverity, byType }` shape as `getFindingSummary`. Total +
 *     per-severity counts, the health score (computed from `bySeverity`), and
 *     the consequence lanes (computed from `byType`) therefore all drop ignored
 *     findings in lockstep.
 *
 * The fingerprint is a computed djb2 hash, NOT a stored column, so an INSTANCE
 * ignore cannot be pushed into SQL — the findings must be materialized and
 * fingerprinted in JS. Both entry points short-circuit when the shop has no
 * suppressions: `filterIgnoredFindings` returns the input untouched (and never
 * fingerprints), and `getFilteredFindingSummary` delegates to the lean
 * `getFindingSummary` groupBy — so shops without ignores pay zero extra cost.
 *
 * Composition with the differ's existing exclusions: `filterIgnoredFindings`
 * removes findings from BOTH the current and previous sets BEFORE they reach
 * `diffScans`, while the differ's own unaudited-category (LOG-4, gc-11f) /
 * `skippedFiles` (gc-06e.19) filters remove from the previous set INSIDE
 * `diffScans`. All three are monotonic removals, so they compose without
 * conflict regardless of order.
 *
 * The `ignored` partition is returned (not discarded) so the future E2.3
 * management view can list what a merchant has suppressed and offer an
 * un-ignore affordance without re-querying.
 */

import type { FindingType, Severity } from "@prisma/client";

import { fingerprintFinding } from "./scan-differ.server";
import {
  createZeroSeverityCounts,
  createZeroTypeCounts,
  getFindingsForScan,
  getFindingSummary,
} from "../models/finding.server";
import type { ShopIgnores } from "../models/ignored-finding.server";

/** Minimal finding shape needed to decide suppression. */
export interface IgnorableFinding {
  filename: string;
  findingType: string;
  codeSnippet: string;
  lineNumber: number;
  appName: string | null;
}

/**
 * True iff `finding` is suppressed for a shop: its `appName` is APP-ignored, OR
 * its computed fingerprint is INSTANCE-ignored. The cheap appName check runs
 * first so an APP-ignored finding never has to be fingerprinted.
 */
export function isFindingIgnored(finding: IgnorableFinding, ignores: ShopIgnores): boolean {
  if (finding.appName !== null && ignores.appNames.has(finding.appName)) return true;
  const fingerprint = fingerprintFinding(
    finding.filename,
    finding.findingType,
    finding.codeSnippet,
    finding.lineNumber,
  );
  return ignores.fingerprints.has(fingerprint);
}

/**
 * Partition findings into the `kept` set (surfaced in aggregates/reports) and
 * the `ignored` set (suppressed). Pure — no DB, no mutation of the input.
 *
 * Short-circuits when the shop has no suppressions: returns the input array as
 * `kept` without fingerprinting anything, so the common no-ignore case is free.
 */
export function filterIgnoredFindings<T extends IgnorableFinding>(
  findings: T[],
  ignores: ShopIgnores,
): { kept: T[]; ignored: T[] } {
  if (ignores.fingerprints.size === 0 && ignores.appNames.size === 0) {
    return { kept: findings, ignored: [] };
  }

  const kept: T[] = [];
  const ignored: T[] = [];
  for (const finding of findings) {
    if (isFindingIgnored(finding, ignores)) {
      ignored.push(finding);
    } else {
      kept.push(finding);
    }
  }
  return { kept, ignored };
}

/**
 * Aggregate a scan's findings with ignored findings excluded, in the same
 * `{ total, bySeverity, byType }` shape as `getFindingSummary`.
 *
 * Fast path: when the shop has no suppressions, delegate to the lean
 * `getFindingSummary` groupBy (no full findings load). Otherwise materialize the
 * scan's findings, drop the ignored ones, and roll the kept set up in JS —
 * unavoidable because the INSTANCE fingerprint is not a queryable column.
 */
export async function getFilteredFindingSummary(
  scanId: string,
  ignores: ShopIgnores,
): Promise<{
  total: number;
  bySeverity: Record<Severity, number>;
  byType: Record<FindingType, number>;
}> {
  if (ignores.fingerprints.size === 0 && ignores.appNames.size === 0) {
    return getFindingSummary(scanId);
  }

  const findings = await getFindingsForScan(scanId);
  const { kept } = filterIgnoredFindings(findings, ignores);

  const bySeverity = createZeroSeverityCounts();
  const byType = createZeroTypeCounts();
  for (const finding of kept) {
    bySeverity[finding.severity] += 1;
    byType[finding.findingType] += 1;
  }
  const total = bySeverity.HIGH + bySeverity.MEDIUM + bySeverity.LOW;

  return { total, bySeverity, byType };
}
