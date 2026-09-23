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
 *   - JSON_LD_PRICE_CONFLICT — a static JSON-LD price/availability disagrees with
 *                        live product data; a structural comparison, not an
 *                        app-signature match.
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
 *   - GHOST_TAG / GHOST_PAGE / GHOST_METAFIELD — fire on a LOOSE prefix/namespace
 *                        match (product tag, page handle, or metafield namespace).
 *                        The prefix can collide with a merchant's own tag/page/
 *                        metafield, so a positive match does not prove the source
 *                        is an uninstalled app. Surfaced as "Heuristic" so a
 *                        false positive does not inherit an unearned "High
 *                        confidence" badge.
 */
const HEURISTIC_FINDING_TYPES = new Set([
  "ORPHAN_ASSET",
  "DUPLICATE_META",
  "JSON_LD_CONFLICT",
  "JSON_LD_PRICE_CONFLICT",
  "GHOST_JSON_LD",
  "SETTINGS_DRIFT",
  "GHOST_LAYOUT",
  "GHOST_ROBOTS",
  "GHOST_CANONICAL",
  "GHOST_TITLE",
  "GHOST_OG",
  "GHOST_REDIRECT",
  "GHOST_TRANSLATION",
  "GHOST_TAG",
  "GHOST_PAGE",
  "GHOST_METAFIELD",
  // DUPLICATE_LIBRARY — cross-file structural inference (the same JS library is
  // loaded by two or more theme files); no positive app-signature match, so it
  // is surfaced as "Heuristic" pending merchant review.
  "DUPLICATE_LIBRARY",
  // DANGLING_REFERENCE — a static theme reference to a shop entity whose
  // existence is checked against the Admin API, not matched against a known-app
  // signature. No app-attribution axis applies, so it lands in HEURISTIC. (The
  // heuristic/signature split is about app-attribution, not certainty; existence
  // here is Admin-verified and high-certainty — see gc-m4h spike risk R3.)
  "DANGLING_REFERENCE",
  // CHECKOUT_SUNSET — a STRUCTURAL match on the presence + content of a specific
  // theme file (`layout/checkout.liquid`), not a positive known-app signature.
  // The heuristic/signature split is about app-attribution: this finding has no
  // app-attribution axis (it names no app), so it lands in HEURISTIC, mirroring
  // DANGLING_REFERENCE. (Certainty is high — the file's existence is directly
  // observed — but that is orthogonal to the confidence-tier axis.)
  "CHECKOUT_SUNSET",
  // JSON_LD_INVALID — a deterministic `JSON.parse` failure on a static JSON-LD
  // block, not a positive known-app signature. Like DANGLING_REFERENCE and
  // CHECKOUT_SUNSET it has no app-attribution axis (it names no app), so it
  // lands in HEURISTIC on the documented app-attribution split. (Certainty is
  // high — a malformed block is unambiguously broken — but that is orthogonal to
  // the confidence-tier axis.)
  "JSON_LD_INVALID",
  // DUPLICATE_TRACKER / OVERLAPPING_CHAT_WIDGET — cross-file structural inference
  // (the same analytics platform configured with distinct IDs, or two distinct
  // chat-widget platforms, across theme files); no positive app-signature match,
  // so they are surfaced as "Heuristic" pending merchant review, mirroring
  // DUPLICATE_LIBRARY.
  "DUPLICATE_TRACKER",
  "OVERLAPPING_CHAT_WIDGET",
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
  "GHOST_PRICE",
  // MALICIOUS_SCRIPT — emits only on a positive match against the curated
  // KNOWN_MALICIOUS_DOMAINS list (a signature match, just not an app one).
  "MALICIOUS_SCRIPT",
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

// ---------------------------------------------------------------------------
// Cross-file vs per-file detection (gc-06e.19)
// ---------------------------------------------------------------------------

/**
 * Finding types emitted by the CROSS-FILE passes of the scan engine
 * (scanThemeFiles in scan-engine.server.ts):
 *
 *   - ORPHAN_ASSET — Pass 2 (analyzeFileReferences over ALL Liquid files).
 *   - GHOST_LAYOUT — Pass 4 (detectGhostLayouts over ALL layout files).
 *   - DUPLICATE_LIBRARY, DUPLICATE_TRACKER, OVERLAPPING_CHAT_WIDGET — Pass 5.
 *     detectDuplicateLibraries deliberately includes size-skipped files
 *     (gc-tus.11) so its findings stay diffable here.
 *
 * These passes run over every file regardless of the per-file size cap
 * (MAX_SCANNABLE_FILE_BYTES). The oversized-file guard in Pass 1 only skips the
 * PER-FILE detectors; the cross-file passes still compute findings for an
 * oversized file (attributed to that file's own filename).
 *
 * The differ (scan-differ.server.ts) uses this set so that when a file is
 * skipped-for-size in the current scan, only its PER-FILE prior findings are
 * excluded from the diff — cross-file findings for that file were still
 * computed and must diff normally.
 *
 * NOTE: Pass 3 (SETTINGS_DRIFT) is also cross-file, but it is always attributed
 * to config/settings_data.json (a non-scannable JSON file that never enters the
 * per-file size-skip path), so it is intentionally NOT included here — the
 * skipped-file filter can never reach a SETTINGS_DRIFT finding.
 *
 * If a future cross-file pass emits a NEW finding type attributed to the file it
 * scans, add that type here so the differ keeps diffing it across size skips.
 */
export const CROSS_FILE_FINDING_TYPES = new Set([
  "ORPHAN_ASSET",
  "GHOST_LAYOUT",
  "DUPLICATE_LIBRARY",
  "DUPLICATE_TRACKER",
  "OVERLAPPING_CHAT_WIDGET",
]);

/**
 * PER-FILE finding types whose detector still runs on a size-skipped file
 * (gc-qqt): scanThemeFiles runs detectMaliciousScripts on every oversized
 * scannable file so padding a file past MAX_SCANNABLE_FILE_BYTES cannot hide a
 * malicious alert. Like CROSS_FILE_FINDING_TYPES, these are recomputed for a
 * skipped file every scan, so the differ must diff them normally rather than
 * exclude them as unre-checked (which would misreport a still-present finding
 * as "new" every rescan and hide its genuine resolution).
 *
 * CHECKOUT_SUNSET (gc-4yg) belongs here too: detectCheckoutSunset runs outside
 * scanThemeFiles and still emits its presence finding for a checkout.liquid
 * over the cap, the same file the scanner reports as skipped.
 */
export const SIZE_SKIP_STILL_SCANNED_FINDING_TYPES = new Set([
  "MALICIOUS_SCRIPT",
  "CHECKOUT_SUNSET",
]);

// ---------------------------------------------------------------------------
// Theme-file-backed vs Admin-resource findings (gc-3on)
// ---------------------------------------------------------------------------

/**
 * FindingTypes whose `filename` is a REAL theme file path editable in the
 * Shopify theme code editor (e.g. `sections/foo.liquid`, `assets/bar.js`,
 * `config/settings_data.json`). Only these get an "Open in theme editor"
 * deep-link on the scan-detail findings table.
 *
 * Basis — VERIFIED against the detectors:
 *   - Every type emitted by the theme-file scan engine (scan-engine.server.ts)
 *     is attributed to `file.filename`, the theme file it scanned. That covers
 *     GHOST_SCRIPT/STYLE/SNIPPET/SECTION/HREFLANG/TEXT/PIXEL/ROBOTS/CANONICAL/
 *     TITLE/OG/PRECONNECT/FONT/AJAX, DUPLICATE_META, DUPLICATE_LIBRARY,
 *     GHOST_JSON_LD, JSON_LD_CONFLICT, GHOST_LAYOUT, ORPHAN_ASSET, and
 *     SETTINGS_DRIFT (config/settings_data.json — a real, editable theme file).
 *   - JSON_LD_PRICE_CONFLICT — built from `extractStaticProductCandidates(file)`,
 *     so its filename is the theme file that held the static JSON-LD.
 *   - DANGLING_REFERENCE — one finding per DanglingRefOccurrence, whose filename
 *     is the theme file + line where the broken reference literally appears.
 */
const THEME_FILE_FINDING_TYPES = new Set([
  "GHOST_SCRIPT",
  "GHOST_STYLE",
  "GHOST_SNIPPET",
  "GHOST_SECTION",
  "GHOST_HREFLANG",
  "GHOST_TEXT",
  "GHOST_PIXEL",
  "GHOST_ROBOTS",
  "GHOST_CANONICAL",
  "GHOST_TITLE",
  "GHOST_OG",
  "GHOST_PRECONNECT",
  "GHOST_FONT",
  "GHOST_AJAX",
  "DUPLICATE_META",
  "DUPLICATE_LIBRARY",
  "GHOST_JSON_LD",
  "JSON_LD_CONFLICT",
  "JSON_LD_PRICE_CONFLICT",
  // JSON_LD_INVALID — attributed to the theme file whose static JSON-LD block
  // failed to parse, so it gets an "Open in theme editor" deep-link.
  "JSON_LD_INVALID",
  // MALICIOUS_SCRIPT — anchored to the theme file carrying the injected line, so
  // it gets an "Open in theme editor" deep-link.
  "MALICIOUS_SCRIPT",
  "GHOST_LAYOUT",
  "ORPHAN_ASSET",
  "SETTINGS_DRIFT",
  "DANGLING_REFERENCE",
  // CHECKOUT_SUNSET — attributed to `layout/checkout.liquid`, a real, editable
  // theme file, so it gets an "Open in theme editor" deep-link.
  "CHECKOUT_SUNSET",
  // DUPLICATE_TRACKER / OVERLAPPING_CHAT_WIDGET — each anchored to the first-seen
  // theme file where the tracker/widget appears, so both get an "Open in theme
  // editor" deep-link, mirroring DUPLICATE_LIBRARY.
  "DUPLICATE_TRACKER",
  "OVERLAPPING_CHAT_WIDGET",
]);

/**
 * FindingTypes whose `filename` is a SYNTHETIC locator for an Admin API resource
 * (product, page, redirect, metafield, translation), NOT a theme file. These
 * must NOT get a theme-editor link — deep-linking `?key=products/123` would 404
 * in the code editor. They are the target of the gc-7h9 Admin-resource
 * fast-follow (which will deep-link to the resource's admin page instead).
 *
 * Basis — VERIFIED against the detectors:
 *   - GHOST_PAGE       → `pages/{handle}`                    (page-detector)
 *   - GHOST_REDIRECT   → `redirects/{id}` / `redirects/bulk` (redirect-detector)
 *   - GHOST_PRICE      → `products/{id}`                     (price-detector)
 *   - GHOST_TAG        → `products/{id}`                     (product-tag-detector)
 *   - GHOST_METAFIELD  → `products/{id}/metafields`          (metafield-detector)
 *   - GHOST_TRANSLATION→ `translations/{locale}/{resource}`  (translation-detector)
 *
 * NOTE: the gc-3on brief cited GHOST_TAG as a "theme-code" type, but the
 * product-tag detector attributes it to `products/{id}` — a product resource,
 * not a theme file — so it is EXCLUDED here (code is authoritative).
 */
const ADMIN_RESOURCE_FINDING_TYPES = new Set([
  "GHOST_PAGE",
  "GHOST_REDIRECT",
  "GHOST_PRICE",
  "GHOST_TAG",
  "GHOST_METAFIELD",
  "GHOST_TRANSLATION",
]);

/**
 * Returns true if the finding's `filename` is a theme file editable in the
 * Shopify theme code editor, so the row can offer an "Open in theme editor"
 * deep-link.
 *
 * Unknown/unclassified types default to FALSE: it is safer to omit a link for an
 * untriaged new type than to emit one that deep-links to a non-theme locator and
 * 404s. The paired THEME_FILE/ADMIN_RESOURCE sets partition every FindingType
 * enum member; a drift test guards that partition as the enum grows.
 *
 * Pure function of findingType — no database lookup required.
 */
export function isThemeFileFinding(findingType: string): boolean {
  return THEME_FILE_FINDING_TYPES.has(findingType);
}

/**
 * Returns true if the finding's `filename` is a SYNTHETIC Admin-resource locator
 * (product / page / redirect / metafield / translation), so the row can offer a
 * deep-link to that resource's best-available admin/storefront surface instead of
 * a theme-editor link (gc-7h9). Exact inverse of isThemeFileFinding over the
 * enum: the two sets partition every FindingType, so a finding gets at most one
 * link. Unknown/unclassified types default to FALSE — safer to omit a link for an
 * untriaged new type than to deep-link a locator we cannot map.
 *
 * Pure function of findingType — no database lookup required.
 */
export function isAdminResourceFinding(findingType: string): boolean {
  return ADMIN_RESOURCE_FINDING_TYPES.has(findingType);
}

/**
 * Exposed for the drift-guard test: the two curated sets that partition the
 * FindingType enum by whether the finding's filename is a theme file. Not for
 * rendering — use isThemeFileFinding() there.
 */
export const THEME_FILE_TYPE_SETS = {
  themeFile: THEME_FILE_FINDING_TYPES,
  adminResource: ADMIN_RESOURCE_FINDING_TYPES,
} as const;
