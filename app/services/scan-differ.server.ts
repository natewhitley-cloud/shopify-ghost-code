/**
 * Scan diffing engine.
 *
 * Compares two sets of findings (current vs previous scan) and categorises
 * each finding as new, resolved, or unchanged.
 *
 * Fingerprinting uses a simple djb2-style string hash over the three fields
 * that uniquely identify a finding's location and kind.  No crypto is needed
 * because this is only ever used for equality comparison within the same shop.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal finding shape required for diffing. */
export interface DiffableFinding {
  filename: string;
  findingType: string;
  codeSnippet: string;
  severity: string;
  appName: string | null;
  description: string;
}

export interface ScanDiff {
  newFindings: Array<{
    filename: string;
    findingType: string;
    severity: string;
    appName: string | null;
    description: string;
  }>;
  resolvedFindings: Array<{
    filename: string;
    findingType: string;
    severity: string;
    appName: string | null;
    description: string;
  }>;
  unchangedCount: number;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Produce a stable numeric fingerprint for a finding.
 *
 * Uses a djb2 hash over the concatenation of the three fields that together
 * uniquely locate a finding: filename, findingType, and the code snippet.
 * The result is converted to an unsigned 32-bit hex string for readability
 * and to avoid negative-number edge cases.
 */
export function fingerprintFinding(
  filename: string,
  findingType: string,
  codeSnippet: string,
): string {
  const raw = `${filename}\0${findingType}\0${codeSnippet}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    // djb2: hash = ((hash << 5) + hash) + charCode
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Core diff function
// ---------------------------------------------------------------------------

/**
 * Diff two sets of scan findings.
 *
 * A finding is considered:
 *   - **new**       if its fingerprint exists in `currentFindings` but not `previousFindings`
 *   - **resolved**  if its fingerprint exists in `previousFindings` but not `currentFindings`
 *   - **unchanged** if its fingerprint exists in both sets
 *
 * When the same fingerprint occurs multiple times in one set (duplicate findings
 * within a scan), each occurrence is counted independently.  In practice the
 * scan engine should not produce true duplicates within a single scan, but we
 * handle the case explicitly to avoid silent under-counting.
 *
 * Un-audited categories (LOG-4):
 *   `opts.skippedCategories` is the set of FindingType categories the CURRENT
 *   scan did NOT audit because their optional scope was not granted. Prior
 *   findings in those categories are excluded entirely from the diff — they are
 *   neither "resolved" (we did not re-check them, so we cannot claim they are
 *   gone) nor "unchanged". Without this guard, a missing optional scope would
 *   silently turn every prior finding in that category into a false "resolved".
 */
export function diffScans(
  currentFindings: DiffableFinding[],
  previousFindings: DiffableFinding[],
  opts?: { skippedCategories?: Iterable<string> },
): ScanDiff {
  // Drop prior findings whose category was not audited this run so they can
  // never be miscounted as resolved. Current findings only ever exist for
  // audited categories, so no symmetric filter is needed on `currentFindings`.
  const skipped = opts?.skippedCategories ? new Set(opts.skippedCategories) : null;
  const effectivePrevious =
    skipped && skipped.size > 0
      ? previousFindings.filter((f) => !skipped.has(f.findingType))
      : previousFindings;

  // Build a multiset (Map<fingerprint, count>) for the previous findings so
  // we can handle duplicates correctly.
  const previousCounts = new Map<string, number>();
  for (const f of effectivePrevious) {
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet);
    previousCounts.set(fp, (previousCounts.get(fp) ?? 0) + 1);
  }

  const newFindings: ScanDiff["newFindings"] = [];
  let unchangedCount = 0;

  // Track which previous fingerprints we have "consumed" to identify resolved ones.
  const remainingPrevious = new Map<string, number>(previousCounts);

  for (const f of currentFindings) {
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet);
    const prevCount = remainingPrevious.get(fp) ?? 0;

    if (prevCount > 0) {
      // This finding existed before — it is unchanged.
      unchangedCount++;
      // Decrement so that duplicate current findings beyond the previous count
      // are treated as new.
      remainingPrevious.set(fp, prevCount - 1);
    } else {
      // No matching previous finding — this is new.
      newFindings.push({
        filename: f.filename,
        findingType: f.findingType,
        severity: f.severity,
        appName: f.appName,
        description: f.description,
      });
    }
  }

  // Any previous findings that were not consumed are resolved.
  const resolvedFindings: ScanDiff["resolvedFindings"] = [];
  for (const f of effectivePrevious) {
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet);
    const remaining = remainingPrevious.get(fp) ?? 0;
    if (remaining > 0) {
      resolvedFindings.push({
        filename: f.filename,
        findingType: f.findingType,
        severity: f.severity,
        appName: f.appName,
        description: f.description,
      });
      // Consume one unit so each resolved finding is reported exactly once.
      remainingPrevious.set(fp, remaining - 1);
    }
  }

  return { newFindings, resolvedFindings, unchangedCount };
}
