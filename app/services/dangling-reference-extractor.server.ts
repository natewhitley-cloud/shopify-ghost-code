// ---------------------------------------------------------------------------
// Static extractor: DANGLING_REFERENCE candidates (gc-m4h.3)
// ---------------------------------------------------------------------------
//
// PURE, side-effect-free. Scans theme Liquid/HTML template content and extracts
// candidate hardcoded references to shop entities (product / collection / page).
// It does NOT touch the Admin API, DB, or network — existence resolution is a
// separate bead (gc-m4h.4) and worker wiring is gc-m4h.5.
//
// Patterns (spike §A, P1–P6). v1 scope is product / collection / page ONLY;
// menu (`linklists`, P7) and blogs are deferred to v2.
//   P1 href="/products/<handle>"        → product
//   P2 href="/collections/<handle>"     → collection (ignore /collections/all;
//                                         for /collections/{c}/products/{p} the
//                                         anchored match reads the collection
//                                         segment only)
//   P3 href="/pages/<handle>"           → page
//   P4 all_products['<handle>']         → product
//   P5 collections['<handle>']          → collection
//   P6 pages['<handle>']                → page
//
// FP discipline (spike §B, FP-CRITICAL): only fully-literal references survive.
// A Liquid-interpolated URL (`/products/{{ product.handle }}`, `{{ product.url }}`,
// `{{ routes.* }}`) or a variable/filter bracket key
// (`collections[section.settings.collection]`, `all_products[product.handle]`)
// must NEVER be flagged.

import { buildSnippet, isScannableFile, type ThemeFile } from "./scan-engine.server";

export type DanglingEntityType = "product" | "collection" | "page";

/** One hardcoded reference at a specific file + line. Findings are 1:1 with these. */
export interface DanglingRefOccurrence {
  entityType: DanglingEntityType;
  /** Normalized (lower-cased, suffix-stripped) entity handle. */
  handle: string;
  filename: string;
  lineNumber: number;
  /** buildSnippet() evidence — the offending line plus one line of context. */
  snippet: string;
}

/** A distinct (entityType, handle) pair — the unit the Admin-API resolver looks up once. */
export interface DistinctDanglingHandle {
  entityType: DanglingEntityType;
  handle: string;
}

/**
 * Result of a scan. `occurrences` preserves every per-file/per-line hit (one
 * finding each, including repeats of the same handle). `distinctHandles` is the
 * de-duplicated `(entityType, handle)` view for the resolver, so the Admin API is
 * queried once per distinct entity rather than once per occurrence.
 */
export interface DanglingReferenceCandidates {
  occurrences: DanglingRefOccurrence[];
  distinctHandles: DistinctDanglingHandle[];
}

// A literal Shopify handle: lower-case, starts alphanumeric, then alphanumeric or
// hyphen. This single test rejects every dynamic form the FP rules forbid —
// anything containing `{{`, `{%`, `}`, `.`, `|`, whitespace, or uppercase fails.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

// Presence of a Liquid tag ANYWHERE in an href value ⇒ theme-rendered, not a
// static literal. Mirrors extractStaticProductCandidates' LIQUID_TAG_RE drop.
const LIQUID_INTERP_RE = /\{\{|\{%/;

// Captures each href attribute's value (the char class stops at the first quote
// of either kind, so mismatched-quote spans are naturally bounded).
const HREF_RE = /href\s*=\s*["']([^"']*)["']/gi;

// Strips a leading locale segment (`/en`, `/fr-ca`, ...) ONLY when it directly
// precedes one of our known entity prefixes, so `/en/products/x` resolves to the
// real handle instead of reading `en` as a literal handle. Anchored + lookahead
// so it can never eat a genuine `/products` segment. (Spike §G secondary risk c.)
const LOCALE_PREFIX_RE = /^\/[a-z]{2}(?:-[a-z]{2})?(?=\/(?:products|collections|pages)\/)/;

// Anchored URL path match: the entity prefix must be at the START of the (locale-
// stripped) href value. Anchoring is what makes /collections/{c}/products/{p}
// yield the collection segment only — the embedded /products/ is not at offset 0.
const URL_PATH_RE = /^\/(products|collections|pages)\/([^/?#]+)/;

// Shopify AJAX endpoint suffixes on a product/collection URL (`/products/x.js`,
// `/collections/y.json`). Stripped before handle validation (spike §A P1 note).
const URL_SUFFIX_RE = /\.(?:js|json)$/;

// Liquid object lookup by a QUOTED string literal. The `['"][a-z0-9-]+['"]` key
// class is the whole FP guard for P4–P6: a variable/filter key
// (`collections[section.settings.collection]`, `all_products[product.handle]`,
// `pages[template.suffix]`) has no quotes / contains a `.` and simply never
// matches. Global — a line may carry several lookups.
const OBJECT_LOOKUP_RE = /\b(all_products|collections|pages)\[\s*['"]([a-z0-9-]+)['"]\s*\]/g;

const URL_SEGMENT_TO_TYPE: Record<string, DanglingEntityType> = {
  products: "product",
  collections: "collection",
  pages: "page",
};

const OBJECT_TO_TYPE: Record<string, DanglingEntityType> = {
  all_products: "product",
  collections: "collection",
  pages: "page",
};

// Reserved collection URL — /collections/all is Shopify's built-in "all products"
// route, never a merchant-created handle, so it is never dangling.
const RESERVED_COLLECTION_HANDLES = new Set(["all"]);

/**
 * Extract dangling-reference candidates from a set of theme files.
 *
 * File scope is enforced defensively via `isScannableFile` (templates/, sections/,
 * snippets/, layout/ `.liquid` only) so the extractor is correct even if called
 * with an unfiltered file list; assets/, config/, and locales/ are dropped. The
 * scan loop already applies the same filter upstream, so this is belt-and-braces.
 */
export function extractDanglingReferences(files: ThemeFile[]): DanglingReferenceCandidates {
  const occurrences: DanglingRefOccurrence[] = [];

  for (const file of files) {
    if (!isScannableFile(file.filename)) continue;
    collectFromFile(file, occurrences);
  }

  return { occurrences, distinctHandles: distinctFrom(occurrences) };
}

function collectFromFile(file: ThemeFile, out: DanglingRefOccurrence[]): void {
  const fileLines = file.content.split("\n");

  for (let i = 0; i < fileLines.length; i++) {
    const lineNumber = i + 1;
    const text = fileLines[i];

    // P1–P3: URL-path references in href attributes.
    HREF_RE.lastIndex = 0;
    let hrefMatch: RegExpExecArray | null;
    while ((hrefMatch = HREF_RE.exec(text)) !== null) {
      const value = hrefMatch[1];

      // Any Liquid interpolation in the href ⇒ dynamic; never flag.
      if (LIQUID_INTERP_RE.test(value)) continue;

      const stripped = value.replace(LOCALE_PREFIX_RE, "");
      const pathMatch = URL_PATH_RE.exec(stripped);
      if (!pathMatch) continue;

      const entityType = URL_SEGMENT_TO_TYPE[pathMatch[1]];
      const handle = pathMatch[2].replace(URL_SUFFIX_RE, "").toLowerCase();
      if (!HANDLE_RE.test(handle)) continue;
      if (entityType === "collection" && RESERVED_COLLECTION_HANDLES.has(handle)) continue;

      out.push({
        entityType,
        handle,
        filename: file.filename,
        lineNumber,
        snippet: buildSnippet(file.content, lineNumber),
      });
    }

    // P4–P6: Liquid object lookups by a quoted string literal.
    OBJECT_LOOKUP_RE.lastIndex = 0;
    let objMatch: RegExpExecArray | null;
    while ((objMatch = OBJECT_LOOKUP_RE.exec(text)) !== null) {
      const entityType = OBJECT_TO_TYPE[objMatch[1]];
      const handle = objMatch[2].toLowerCase();
      if (!HANDLE_RE.test(handle)) continue; // rejects e.g. a leading hyphen

      out.push({
        entityType,
        handle,
        filename: file.filename,
        lineNumber,
        snippet: buildSnippet(file.content, lineNumber),
      });
    }
  }
}

/** De-duplicate occurrences into distinct (entityType, handle) pairs, first-seen order. */
function distinctFrom(occurrences: DanglingRefOccurrence[]): DistinctDanglingHandle[] {
  const seen = new Set<string>();
  const distinct: DistinctDanglingHandle[] = [];
  for (const occ of occurrences) {
    const key = `${occ.entityType} ${occ.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ entityType: occ.entityType, handle: occ.handle });
  }
  return distinct;
}
