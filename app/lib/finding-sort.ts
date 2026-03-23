/**
 * Sorting utilities for scan findings.
 *
 * Provides a consistent severity-first ordering: HIGH → MEDIUM → LOW,
 * with secondary sorts by findingType, filename, and lineNumber.
 */

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Sort an array of findings in-place by severity (HIGH first), then by
 * findingType alphabetically, then by filename, then by lineNumber.
 */
export function sortFindingsBySeverity(
  findings: Array<{
    severity: string;
    findingType: string;
    filename: string;
    lineNumber: number;
  }>,
): void {
  if (!findings || findings.length === 0) return;
  findings.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    const typeDiff = a.findingType.localeCompare(b.findingType);
    if (typeDiff !== 0) return typeDiff;
    const fileDiff = a.filename.localeCompare(b.filename);
    if (fileDiff !== 0) return fileDiff;
    return a.lineNumber - b.lineNumber;
  });
}

/**
 * Sort an array of diff findings (which lack lineNumber) in-place by
 * severity, then findingType, then filename.
 */
export function sortDiffFindingsBySeverity(
  findings: Array<{
    severity: string;
    findingType: string;
    filename: string;
  }>,
): void {
  if (!findings || findings.length === 0) return;
  findings.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    const typeDiff = a.findingType.localeCompare(b.findingType);
    if (typeDiff !== 0) return typeDiff;
    return a.filename.localeCompare(b.filename);
  });
}
