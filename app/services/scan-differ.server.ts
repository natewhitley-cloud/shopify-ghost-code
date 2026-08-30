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

import { CROSS_FILE_FINDING_TYPES } from "../lib/finding-classification";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal finding shape required for diffing. */
export interface DiffableFinding {
  filename: string;
  findingType: string;
  codeSnippet: string;
  /**
   * 1-based line number of the matched line within the source file, or 0 for
   * synthetic findings (bulk redirects, pages, metafields) whose snippet is not
   * drawn from a file. Used by the fingerprint to locate the matched line inside
   * the stored multi-line `codeSnippet` (LOG-10). Not displayed by the differ.
   */
  lineNumber: number;
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
 * Matches the volatile leading count in a bulk-redirect snippet's first line,
 * e.g. "84 redirects under /collections:" → capture group "redirects under
 * /collections:". The count and the sample paths that follow change every time
 * a single redirect is added under the same prefix, but the prefix-based
 * identity ("redirects under <prefix>") is stable. Scoped narrowly to the
 * bulk-redirect shape so it never strips a leading number from an unrelated
 * matched line (which would risk collapsing genuinely distinct findings).
 *
 * See redirect-detector.server.ts (Strategy 2 / bulk pattern).
 */
const BULK_REDIRECT_COUNT_RE = /^\d+\s+(redirects?\s+under\s+.+)$/i;

/**
 * Reduce a stored display snippet to the stable identity of the matched line,
 * so the fingerprint survives edits that don't touch the finding itself (LOG-10).
 *
 * Two instabilities motivated this:
 *   1. buildSnippet (scan-engine.server.ts) stores the matched line PLUS one
 *      line of context before and after. Editing an unrelated adjacent line
 *      changed the stored snippet, flipping an untouched finding to
 *      resolved + new on the next diff.
 *   2. The bulk-redirect detector embeds a volatile count and sample paths in
 *      the snippet ("<N> redirects under <prefix>:\n  <samples>"). Adding one
 *      redirect under the same prefix changed the count and samples, flipping
 *      the same persistent pattern to resolved + new.
 *
 * Normalization:
 *   - Extract ONLY the matched line. Within a buildSnippet snippet the matched
 *     line sits at index 1 when there is a leading context line (lineNumber >= 2)
 *     and at index 0 otherwise (lineNumber 0 or 1). This drops the adjacent
 *     context lines (instability #1) and, for the multi-line synthetic snippets
 *     (bulk redirect, page, metafield — all lineNumber 0), drops the trailing
 *     sample/body lines (instability #2). Falls back to the first line if that
 *     index is absent (e.g. a snippet truncated to a single line by the 300-char
 *     cap).
 *   - Collapse internal whitespace runs and trim, so a pure reindentation of the
 *     matched line does not churn.
 *   - Strip the leading volatile count from the bulk-redirect shape, leaving the
 *     stable prefix-based identity.
 *
 * Distinct findings stay distinct: different matched lines (URLs, snippet names,
 * meta properties, namespace.key pairs) and different redirect prefixes all
 * normalize to different strings.
 */
export function normalizeForFingerprint(codeSnippet: string, lineNumber: number): string {
  const snippetLines = codeSnippet.split("\n");
  const matchedIndex = lineNumber >= 2 ? 1 : 0;
  const matchedLine = snippetLines[matchedIndex] ?? snippetLines[0] ?? "";

  const collapsed = matchedLine.replace(/\s+/g, " ").trim();

  const bulkRedirect = BULK_REDIRECT_COUNT_RE.exec(collapsed);
  return bulkRedirect ? bulkRedirect[1] : collapsed;
}

/**
 * Produce a stable numeric fingerprint for a finding.
 *
 * Uses a djb2 hash over the concatenation of the three fields that together
 * uniquely identify a finding: filename, findingType, and a NORMALIZED matched
 * line derived from the stored snippet and its line number (see
 * normalizeForFingerprint). The full display `codeSnippet` is intentionally NOT
 * hashed — it carries adjacent context and volatile counts that change without
 * the finding changing (LOG-10). The result is converted to an unsigned 32-bit
 * hex string for readability and to avoid negative-number edge cases.
 */
export function fingerprintFinding(
  filename: string,
  findingType: string,
  codeSnippet: string,
  lineNumber: number,
): string {
  const matched = normalizeForFingerprint(codeSnippet, lineNumber);
  const raw = `${filename}\0${findingType}\0${matched}`;
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
 *
 * Unscanned oversized files (gc-06e.19):
 *   `opts.skippedFiles` is the set of theme file paths the CURRENT scan did NOT
 *   scan because they exceeded the per-file size cap. Only the PER-FILE
 *   detectors are skipped for such a file, so its per-file prior findings are
 *   excluded for the same reason as skipped categories — an unre-checked
 *   per-file finding is unknown, not fixed. The CROSS-FILE passes (Pass 2
 *   ORPHAN_ASSET, Pass 4 GHOST_LAYOUT — see CROSS_FILE_FINDING_TYPES) still run
 *   over an oversized file, so cross-file findings attributed to that file ARE
 *   still computed in the current scan and therefore diff normally: they are NOT
 *   excluded by the skipped-file filter. Excluding them would misreport a
 *   still-present cross-file finding as "new" every rescan and silently drop a
 *   genuine resolution.
 */
export function diffScans(
  currentFindings: DiffableFinding[],
  previousFindings: DiffableFinding[],
  opts?: { skippedCategories?: Iterable<string>; skippedFiles?: Iterable<string> },
): ScanDiff {
  // Drop prior findings whose category was not audited, or whose file was not
  // scanned (oversized), this run so they can never be miscounted as resolved.
  // The oversized-file skip only invalidates PER-FILE detector findings: a
  // cross-file finding type (CROSS_FILE_FINDING_TYPES — ORPHAN_ASSET,
  // GHOST_LAYOUT) is STILL computed for a skipped file by Pass 2 / Pass 4, so it
  // must diff normally and is NOT excluded by the skipped-file filter.
  // Current findings only ever exist for audited categories, and for scanned
  // files or the cross-file passes, so no symmetric filter is needed on
  // `currentFindings`.
  const skippedCats = opts?.skippedCategories ? new Set(opts.skippedCategories) : null;
  const skippedFiles = opts?.skippedFiles ? new Set(opts.skippedFiles) : null;
  const hasCatFilter = skippedCats !== null && skippedCats.size > 0;
  const hasFileFilter = skippedFiles !== null && skippedFiles.size > 0;
  const effectivePrevious =
    hasCatFilter || hasFileFilter
      ? previousFindings.filter(
          (f) =>
            !(hasCatFilter && skippedCats!.has(f.findingType)) &&
            !(
              hasFileFilter &&
              skippedFiles!.has(f.filename) &&
              !CROSS_FILE_FINDING_TYPES.has(f.findingType)
            ),
        )
      : previousFindings;

  // Build a multiset (Map<fingerprint, count>) for the previous findings so
  // we can handle duplicates correctly.
  const previousCounts = new Map<string, number>();
  for (const f of effectivePrevious) {
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
    previousCounts.set(fp, (previousCounts.get(fp) ?? 0) + 1);
  }

  const newFindings: ScanDiff["newFindings"] = [];
  let unchangedCount = 0;

  // Track which previous fingerprints we have "consumed" to identify resolved ones.
  const remainingPrevious = new Map<string, number>(previousCounts);

  for (const f of currentFindings) {
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
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
    const fp = fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
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
