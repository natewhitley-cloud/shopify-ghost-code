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
  [FindingType.GHOST_HREFLANG]: Severity.HIGH,
  [FindingType.ORPHAN_ASSET]: Severity.LOW,
  [FindingType.DUPLICATE_META]: Severity.MEDIUM,
  [FindingType.GHOST_JSON_LD]: Severity.MEDIUM,
  [FindingType.GHOST_TEXT]: Severity.LOW,
  // GHOST_TRANSLATION is informational only: there is no reliable signal that
  // translation content is genuinely orphaned (translations use Shopify-standard
  // keys, carry no provenance, and translation apps leave no theme artifacts).
  // It surfaces content for the merchant to review, so it is always LOW and is
  // never escalated by any nuance rule below.
  [FindingType.GHOST_TRANSLATION]: Severity.LOW,
  [FindingType.SETTINGS_DRIFT]: Severity.LOW,
  [FindingType.GHOST_PIXEL]: Severity.HIGH,
  [FindingType.JSON_LD_CONFLICT]: Severity.HIGH,
  [FindingType.JSON_LD_PRICE_CONFLICT]: Severity.HIGH,
  [FindingType.GHOST_LAYOUT]: Severity.MEDIUM,
  [FindingType.GHOST_TAG]: Severity.LOW,
  [FindingType.GHOST_PRICE]: Severity.HIGH,
  [FindingType.GHOST_PAGE]: Severity.MEDIUM,
  [FindingType.GHOST_METAFIELD]: Severity.LOW,
  [FindingType.GHOST_REDIRECT]: Severity.MEDIUM,
  [FindingType.GHOST_ROBOTS]: Severity.HIGH,
  [FindingType.GHOST_CANONICAL]: Severity.HIGH,
  [FindingType.GHOST_TITLE]: Severity.HIGH,
  [FindingType.GHOST_OG]: Severity.MEDIUM,
  [FindingType.GHOST_PRECONNECT]: Severity.MEDIUM,
  [FindingType.GHOST_FONT]: Severity.MEDIUM,
  [FindingType.GHOST_AJAX]: Severity.HIGH,
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
  return (
    /media\s*=\s*["']print["']/i.test(codeSnippet) &&
    !/media\s*=\s*["'](?!print["'])/.test(codeSnippet)
  );
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
 * @param description  The finding's description text (used for type-specific nuance).
 */
export function classifySeverity(
  findingType: FindingType,
  codeSnippet: string,
  description?: string,
): Severity {
  // Liquid comment blocks: anything inside is dead code — downgrade to LOW.
  if (isInsideLiquidComment(codeSnippet)) {
    return Severity.LOW;
  }

  // Print-only stylesheets have no page-load impact — downgrade to LOW.
  if (findingType === FindingType.GHOST_STYLE && isPrintOnlyStylesheet(codeSnippet)) {
    return Severity.LOW;
  }

  // GHOST_TITLE with page_title in description still renders something useful — downgrade to MEDIUM.
  if (findingType === FindingType.GHOST_TITLE && description && /page_title/.test(description)) {
    return Severity.MEDIUM;
  }

  // GHOST_OG with og:image in description is the most visible social sharing failure — upgrade to HIGH.
  if (findingType === FindingType.GHOST_OG && description && /og:image/.test(description)) {
    return Severity.HIGH;
  }

  return DEFAULT_SEVERITY[findingType];
}
