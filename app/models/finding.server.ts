import { FindingType, Severity } from "@prisma/client";
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
export async function createFindings(
  scanId: string,
  findings: CreateFindingInput[],
) {
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
      ...(filters?.severity !== undefined
        ? { severity: filters.severity }
        : {}),
      ...(filters?.findingType !== undefined
        ? { findingType: filters.findingType }
        : {}),
    },
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
    [FindingType.ORPHAN_ASSET]: 0,
  };
  for (const row of byType) {
    typeCounts[row.findingType] = row._count.findingType;
  }

  const total =
    severityCounts[Severity.HIGH] +
    severityCounts[Severity.MEDIUM] +
    severityCounts[Severity.LOW];

  return { total, bySeverity: severityCounts, byType: typeCounts };
}
