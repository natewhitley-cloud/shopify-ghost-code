/**
 * Severity classification for scan findings.
 *
 * Default severity is derived from FindingType, with two nuance rules that
 * can downgrade severity based on code context:
 *   1. Any finding whose code snippet is entirely within a Liquid comment
 *      block is downgraded to LOW (dead code, not executed).
 *   2. A GHOST_STYLE finding with `media="print"` only is downgraded to LOW
 *      (no visible or performance impact for normal page loads).
 */

import { FindingType, Severity } from "@prisma/client";

// ---------------------------------------------------------------------------
// Default mapping (used as the base before nuance adjustments)
// ---------------------------------------------------------------------------

const DEFAULT_SEVERITY: Record<FindingType, Severity> = {
  [FindingType.GHOST_SCRIPT]: Severity.HIGH,
  [FindingType.GHOST_STYLE]: Severity.MEDIUM,
  [FindingType.GHOST_SNIPPET]: Severity.MEDIUM,
  [FindingType.GHOST_SECTION]: Severity.LOW,
  [FindingType.ORPHAN_ASSET]: Severity.LOW,
};

// ---------------------------------------------------------------------------
// Nuance detectors
// ---------------------------------------------------------------------------

/**
 * Returns true if codeSnippet appears to be wrapped in a Liquid comment block.
 *
 * We check for both `{%- comment -%}` (whitespace-stripping) and `{% comment %}`.
 * The snippet only needs to contain a comment opener — this is sufficient
 * because the scan engine extracts per-line snippets that include surrounding
 * context.
 */
function isInsideLiquidComment(codeSnippet: string): boolean {
  // Matches {% comment %} or {%- comment -%} (with optional whitespace / dashes)
  return /\{%-?\s*comment\s*-?%\}/.test(codeSnippet);
}

/**
 * Returns true if a `<link>` stylesheet tag has media="print" as its only
 * media query, meaning it only applies during printing and has no impact on
 * normal page rendering or performance.
 *
 * Matches patterns like:
 *   <link rel="stylesheet" media="print" href="...">
 *   <link href="..." media='print' rel="stylesheet">
 */
function isPrintOnlyStylesheet(codeSnippet: string): boolean {
  return /media\s*=\s*["']print["']/i.test(codeSnippet) &&
    !/media\s*=\s*["'](?!print["'])/.test(codeSnippet);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the severity of a finding, applying nuance rules on top of the
 * default type-based mapping.
 *
 * @param findingType  The category of ghost code detected.
 * @param codeSnippet  The extracted code context for the finding.
 */
export function classifySeverity(
  findingType: FindingType,
  codeSnippet: string,
): Severity {
  // Liquid comment blocks: anything inside is dead code — downgrade to LOW.
  if (isInsideLiquidComment(codeSnippet)) {
    return Severity.LOW;
  }

  // Print-only stylesheets have no page-load impact — downgrade to LOW.
  if (findingType === FindingType.GHOST_STYLE && isPrintOnlyStylesheet(codeSnippet)) {
    return Severity.LOW;
  }

  return DEFAULT_SEVERITY[findingType];
}
