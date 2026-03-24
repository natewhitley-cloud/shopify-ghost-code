import { FindingType, ScanStatus, Severity } from "@prisma/client";

import db from "../db.server";

/**
 * Shape of a finding before it has a DB id.
 * All fields correspond 1:1 with the Finding model — scanId is passed
 * separately to keep the batch API ergonomic.
 */
export type CreateFindingInput = {
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  findingType: FindingType;
  severity: Severity;
  appName?: string;
  description: string;
};

/**
 * Batch-insert findings for a completed scan.
 * Uses createMany for a single round-trip; skipDuplicates is left false
 * because the scan engine should never produce true duplicates within one scan.
 */
export async function createFindings(scanId: string, findings: CreateFindingInput[]) {
  if (findings.length === 0) return { count: 0 };

  return db.finding.createMany({
    data: findings.map((f) => ({ ...f, scanId })),
  });
}

/**
 * Return findings for a scan with optional filtering by severity and/or type.
 * Results are ordered by severity (HIGH first) then filename for consistent display.
 * Returns an empty array (not null) when no findings match.
 */
export async function getFindingsForScan(
  scanId: string,
  filters?: { severity?: Severity; findingType?: FindingType },
) {
  return db.finding.findMany({
    where: {
      scanId,
      ...(filters?.severity !== undefined ? { severity: filters.severity } : {}),
      ...(filters?.findingType !== undefined ? { findingType: filters.findingType } : {}),
    },
    // Prisma sorts enums by declaration order in the schema, not alphabetically.
    // The Severity enum is declared as HIGH, MEDIUM, LOW — so "asc" produces
    // HIGH → MEDIUM → LOW, which is the correct display order (most severe first).
    // If the schema enum order ever changes this sort will silently break; keep
    // the declaration order in sync with this comment.
    orderBy: [{ severity: "asc" }, { filename: "asc" }],
  });
}

/**
 * Group findings by severity and return counts.
 * Prisma groupBy is used for a single aggregation query.
 */
export async function countFindingsBySeverity(scanId: string) {
  const rows = await db.finding.groupBy({
    by: ["severity"],
    where: { scanId },
    _count: { severity: true },
  });

  // Normalise into a plain object so callers don't need to know the groupBy shape.
  const counts: Record<Severity, number> = {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };
  for (const row of rows) {
    counts[row.severity] = row._count.severity;
  }
  return counts;
}

/**
 * Summary aggregate for a scan: total count + breakdown by both axes.
 * Executed as two parallel queries to minimise latency.
 */
export async function getFindingSummary(scanId: string) {
  const [bySeverity, byType] = await Promise.all([
    db.finding.groupBy({
      by: ["severity"],
      where: { scanId },
      _count: { severity: true },
    }),
    db.finding.groupBy({
      by: ["findingType"],
      where: { scanId },
      _count: { findingType: true },
    }),
  ]);

  const severityCounts: Record<Severity, number> = {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };
  for (const row of bySeverity) {
    severityCounts[row.severity] = row._count.severity;
  }

  const typeCounts: Record<FindingType, number> = {
    [FindingType.GHOST_SCRIPT]: 0,
    [FindingType.GHOST_STYLE]: 0,
    [FindingType.GHOST_SNIPPET]: 0,
    [FindingType.GHOST_SECTION]: 0,
    [FindingType.GHOST_HREFLANG]: 0,
    [FindingType.ORPHAN_ASSET]: 0,
    [FindingType.DUPLICATE_META]: 0,
    [FindingType.GHOST_JSON_LD]: 0,
    [FindingType.GHOST_TEXT]: 0,
    [FindingType.GHOST_TRANSLATION]: 0,
    [FindingType.SETTINGS_DRIFT]: 0,
    [FindingType.GHOST_PIXEL]: 0,
    [FindingType.JSON_LD_CONFLICT]: 0,
    [FindingType.GHOST_LAYOUT]: 0,
    [FindingType.GHOST_TAG]: 0,
    [FindingType.GHOST_PRICE]: 0,
    [FindingType.GHOST_PAGE]: 0,
    [FindingType.GHOST_METAFIELD]: 0,
    [FindingType.GHOST_REDIRECT]: 0,
    [FindingType.GHOST_ROBOTS]: 0,
    [FindingType.GHOST_CANONICAL]: 0,
    [FindingType.GHOST_TITLE]: 0,
    [FindingType.GHOST_OG]: 0,
    [FindingType.GHOST_PRECONNECT]: 0,
  };
  for (const row of byType) {
    typeCounts[row.findingType] = row._count.findingType;
  }

  const total =
    severityCounts[Severity.HIGH] + severityCounts[Severity.MEDIUM] + severityCounts[Severity.LOW];

  return { total, bySeverity: severityCounts, byType: typeCounts };
}

/**
 * Return the single highest-severity finding for a scan.
 * Uses Prisma enum sort order (HIGH → MEDIUM → LOW declared in schema) so
 * ascending sort gives the highest-severity row first.
 * Returns null when the scan has no findings.
 */
export async function getHighestSeverityFinding(scanId: string) {
  return db.finding.findFirst({
    where: { scanId },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Return the count of distinct filenames in a scan's findings.
 * Used to normalize the Health Score deduction so large themes are not
 * penalized more than small ones simply because they have more files.
 *
 * Returns 0 when the scan has no findings (e.g. a clean theme).
 * The caller (health score computation) handles the 0-file edge case.
 */
export async function getDistinctFileCount(scanId: string): Promise<number> {
  const result = await db.finding.findMany({
    where: { scanId },
    select: { filename: true },
    distinct: ["filename"],
  });
  return result.length;
}

/**
 * Atomically persist findings and mark a scan COMPLETED in a single transaction.
 *
 * Why a transaction is required:
 *   createFindings and updateScanStatus are two separate writes. If findings are
 *   inserted but the status update fails (network blip, DB error), Inngest will
 *   retry the step and createFindings will run again — producing duplicate rows,
 *   since the Finding table has no unique constraint per scan. Wrapping both in
 *   $transaction makes the step idempotency boundary identical to the DB commit
 *   boundary: either both writes land or neither does, so a retry is always safe.
 *
 * Empty-findings case:
 *   When findings is empty we still update status to COMPLETED (with count 0)
 *   so the scan is never left stuck in IN_PROGRESS.
 *
 * Idempotency guard:
 *   A deleteMany is issued before createMany so that Inngest retries are safe.
 *   If the step commits but Inngest doesn't acknowledge the result, the retry
 *   will delete any previously-created findings and re-insert them, producing
 *   the same final state instead of duplicates.
 */
export async function completeScanWithFindings(scanId: string, findings: CreateFindingInput[]) {
  const now = new Date();

  return db.$transaction([
    // Idempotency guard: clear any findings from a previous partial attempt.
    db.finding.deleteMany({ where: { scanId } }),
    ...(findings.length > 0
      ? [
          db.finding.createMany({
            data: findings.map((f) => ({ ...f, scanId })),
          }),
        ]
      : []),
    db.scan.update({
      where: { id: scanId },
      data: {
        status: ScanStatus.COMPLETED,
        completedAt: now,
        findingCount: findings.length,
      },
    }),
  ]);
}
