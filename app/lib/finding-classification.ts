/**
 * Finding classification utilities.
 *
 * Pure functions that classify findings based on their type. These are
 * client-safe (no .server.ts suffix) and have no external dependencies.
 */

/**
 * Finding types that always produce visible elements in the storefront —
 * things shoppers can see and interact with.
 */
const VISUAL_FINDING_TYPES = new Set([
  "GHOST_SECTION",
  "GHOST_SNIPPET",
  "GHOST_TEXT",
  "GHOST_PRICE",
  "GHOST_PAGE",
  "GHOST_LAYOUT",
  "GHOST_FONT",
]);

/**
 * Returns true if the given finding type produces visible elements in the
 * storefront (content shoppers can see), false for invisible code such as
 * head scripts, tracking pixels, metafields, SEO tags, and structured data.
 *
 * This is a pure function of findingType — no database lookup required.
 */
export function hasVisualImpact(findingType: string): boolean {
  return VISUAL_FINDING_TYPES.has(findingType);
}

// ---------------------------------------------------------------------------
// Detection confidence tier
// ---------------------------------------------------------------------------

/**
 * A finding's detection confidence, derived purely from its type:
 *
 *   - "signature": the detector emits ONLY when the code/resource matches a
 *     curated known-app signature (a CDN domain, snippet/section/tag/handle/
 *     namespace pattern, tracking-function identifier, or a discount-app
 *     metafield). The defect claim IS the match, so the false-positive rate is
 *     low. Surfaced to merchants as "High confidence".
 *
 *   - "heuristic": the detector emits on a STRUCTURAL inference — an
 *     unreferenced file, a duplicate/conflicting/empty/stale/bulk pattern, an
 *     app-only schema @type, a naming convention, or informational review
 *     content — none of which require a positive app-signature match. These are
 *     structurally more false-positive-prone, so they are surfaced as
 *     "Heuristic" to invite merchant review before acting.
 *
 * The split is derived from how each type is actually detected in
 * scan-engine.server.ts and the Admin-API detectors (product-tag / page /
 * metafield / price / redirect / translation), NOT from the type name.
 */
export type FindingConfidence = "signature" | "heuristic";

/**
 * Types whose emission is driven by a STRUCTURAL inference rather than a
 * positive app-signature match, and are therefore more false-positive-prone.
 *
 * Basis (verified against the detectors):
 *   - ORPHAN_ASSET     — cross-file "this snippet is never referenced" analysis;
 *                        misses dynamic {% render var %} references.
 *   - DUPLICATE_META   — two <meta> tags share a name/property; app attribution
 *                        is optional.
 *   - JSON_LD_CONFLICT — two JSON-LD blocks share an @type with differing data;
 *                        app attribution optional.
 *   - GHOST_JSON_LD    — can fire purely on an app-only @type (FAQPage, Review,
 *                        …) with no app match.
 *   - SETTINGS_DRIFT   — settings_data.json references a section file that no
 *                        longer exists; app attribution optional.
 *   - GHOST_LAYOUT     — can fire on the theme.*.liquid / gem-*.liquid naming
 *                        convention alone, with no app match.
 *   - GHOST_ROBOTS     — fires on any restrictive robots directive; app
 *                        attribution optional.
 *   - GHOST_CANONICAL / GHOST_TITLE / GHOST_OG — fire on empty / unresolved-
 *                        Liquid-variable / duplicate markup; app attribution
 *                        optional.
 *   - GHOST_REDIRECT   — bulk-threshold strategy fires on 50+ redirects under a
 *                        prefix with no app attribution.
 *   - GHOST_TRANSLATION — informational only; the detector explicitly cannot
 *                        prove the content is orphaned.
 */
const HEURISTIC_FINDING_TYPES = new Set([
  "ORPHAN_ASSET",
  "DUPLICATE_META",
  "JSON_LD_CONFLICT",
  "GHOST_JSON_LD",
  "SETTINGS_DRIFT",
  "GHOST_LAYOUT",
  "GHOST_ROBOTS",
  "GHOST_CANONICAL",
  "GHOST_TITLE",
  "GHOST_OG",
  "GHOST_REDIRECT",
  "GHOST_TRANSLATION",
]);

/**
 * Types whose emission REQUIRES a positive match against a curated known-app
 * signature, so the detection is high confidence.
 *
 * Basis (verified against the detectors — each has an `if (!appName) continue`
 * guard or an equivalent required match):
 *   - GHOST_SCRIPT / GHOST_STYLE   — external URL matches a known app CDN.
 *   - GHOST_SNIPPET / GHOST_SECTION — Liquid name matches a known app snippet.
 *   - GHOST_HREFLANG               — hreflang href matches a translation app.
 *   - GHOST_TEXT                   — markup matches a known app text fragment.
 *   - GHOST_PIXEL                  — inline tracker matches a known function
 *                                    identifier table (fbq, gtag, ttq, …).
 *   - GHOST_PRECONNECT / GHOST_FONT / GHOST_AJAX — resource/call attributed to
 *                                    a known app CDN/domain.
 *   - GHOST_TAG / GHOST_PAGE / GHOST_METAFIELD — product tag / page handle /
 *                                    metafield namespace matches a known app.
 *   - GHOST_PRICE                  — compare-at residue corroborated by a known
 *                                    discount-app metafield signature.
 */
const SIGNATURE_FINDING_TYPES = new Set([
  "GHOST_SCRIPT",
  "GHOST_STYLE",
  "GHOST_SNIPPET",
  "GHOST_SECTION",
  "GHOST_HREFLANG",
  "GHOST_TEXT",
  "GHOST_PIXEL",
  "GHOST_PRECONNECT",
  "GHOST_FONT",
  "GHOST_AJAX",
  "GHOST_TAG",
  "GHOST_PAGE",
  "GHOST_METAFIELD",
  "GHOST_PRICE",
]);

/**
 * Returns the detection confidence tier for a finding type.
 *
 * Unknown/unclassified types default to "heuristic": it is safer to under-claim
 * confidence than to badge an untriaged new type as high confidence. The paired
 * SIGNATURE/HEURISTIC sets partition every FindingType enum member; a drift test
 * guards that partition as the enum grows.
 *
 * This is a pure function of findingType — no database lookup required.
 */
export function getFindingConfidence(findingType: string): FindingConfidence {
  return SIGNATURE_FINDING_TYPES.has(findingType) ? "signature" : "heuristic";
}

/**
 * Exposed for the drift-guard test: the two curated sets that partition the
 * FindingType enum by detection confidence. Not for rendering — use
 * getFindingConfidence() there.
 */
export const CONFIDENCE_TYPE_SETS = {
  signature: SIGNATURE_FINDING_TYPES,
  heuristic: HEURISTIC_FINDING_TYPES,
} as const;
