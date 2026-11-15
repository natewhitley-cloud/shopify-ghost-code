/**
 * The status bar's "Since your last scan" line on plans with scan diffing
 * (gc-np1d.6, Nathan decision 3A, 2026-11-15). It replaces the removed summary
 * tiles' "+N new / -M resolved". Null when there is no diff to show (no earlier
 * scan, a plan without diffing, not loaded yet) or nothing changed.
 */
export function sinceLastScanLine(
  diff: {
    newFindings: readonly unknown[];
    resolvedFindings: readonly unknown[];
  } | null,
): string | null {
  if (!diff) return null;
  const added = diff.newFindings.length;
  const fixed = diff.resolvedFindings.length;
  if (added === 0 && fixed === 0) return null;
  return `Since your last scan: ${added} new, ${fixed} fixed.`;
}

/**
 * The diff to show for `scanId` (audit M1): only one the diff route answered
 * for this scan. Moving to another scan on the same route keeps the component
 * (and the fetcher's old data until the new load lands), so without this the
 * status bar and the "New" badges would show the previous scan's diff.
 */
export function diffForScan<D>(
  scanId: string,
  data: { scanId?: string; scanDiff: D | null } | undefined,
): D | null {
  if (!data || data.scanId !== scanId) return null;
  return data.scanDiff ?? null;
}
