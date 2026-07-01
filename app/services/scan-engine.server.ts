/**
 * Ghost code detection engine.
 *
 * Scans a set of theme files (Liquid templates and assets) for remnants of
 * uninstalled Shopify apps.  Returns an array of CreateFindingInput objects
 * ready to be persisted via createFindings() in the finding model.
 *
 * Detection categories:
 *   GHOST_SCRIPT   — <script src="..."> pointing to an external app CDN
 *   GHOST_STYLE    — <link rel="stylesheet"> pointing to an external app CDN
 *   GHOST_SNIPPET  — {% render %} / {% include %} referencing a known app snippet
 *   GHOST_SECTION  — {% section %} referencing a known app section
 *   GHOST_HREFLANG — <link rel="alternate" hreflang="..."> left by translation apps
 *   ORPHAN_ASSET   — snippet files that exist in the theme but are never referenced
 *                    by any template, section, layout, or other snippet
 *   DUPLICATE_META — multiple <meta> tags with the same name or property attribute
 *                    in a single file (e.g. stacked SEO apps)
 *   GHOST_JSON_LD  — orphaned <script type="application/ld+json"> blocks left by
 *                    review, FAQ, or SEO apps after uninstall
 *   JSON_LD_CONFLICT — multiple <script type="application/ld+json"> blocks with
 *                    the same @type but different data in a single file (e.g.
 *                    conflicting Product schema from two SEO/review apps)
 *   GHOST_TEXT     — persistent UI text fragments (widget placeholders, trust
 *                    badges, data attributes) left in Liquid markup by
 *                    uninstalled apps
 *   SETTINGS_DRIFT — stale section references in config/settings_data.json
 *                    that point to section types whose .liquid files no
 *                    longer exist in the theme
 *   GHOST_PIXEL    — inline tracking pixel code (fbq, gtag, ttq, etc.) left
 *                    in <script> blocks by uninstalled tracking/analytics apps
 *   GHOST_LAYOUT   — orphaned layout files (e.g. theme.pagefly.liquid) left
 *                    by page builder apps after uninstall
 *   GHOST_ROBOTS   — orphaned <meta name="robots" content="noindex/nofollow">
 *                    directives injected by SEO apps into theme files
 *   GHOST_CANONICAL— orphaned <link rel="canonical"> overrides left by SEO apps
 *                    after uninstall (empty href, unresolved Liquid vars,
 *                    duplicates, or app-attributed canonicals)
 *   GHOST_TITLE    — orphaned <title> tag overrides left by SEO apps after
 *                    uninstall (empty titles in layout files, unresolved
 *                    Liquid vars, duplicates, or app-attributed titles)
 *   GHOST_OG       — orphaned Open Graph (og:*) and Twitter Card (twitter:*)
 *                    meta tags with empty/broken content values or app
 *                    attribution from uninstalled social/SEO apps
 *   GHOST_REDIRECT — orphaned URL redirects left by SEO apps (detected via
 *                    separate API-based redirect-detector service)
 *   GHOST_PRECONNECT — orphaned <link rel="preconnect|dns-prefetch|preload">
 *                    hints pointing to known app CDN domains, wasting browser
 *                    connection slots after the app is uninstalled
 *   GHOST_FONT     — orphaned @font-face declarations or font service <link>
 *                    tags left by uninstalled apps, causing wasted downloads
 *                    and CLS from font-display issues
 *   GHOST_AJAX     — orphaned fetch()/XMLHttpRequest/jQuery AJAX calls to
 *                    defunct app servers, wasting network requests and leaking
 *                    data to third-party domains
 */

import { FindingType } from "@prisma/client";

import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromHrefLang,
  identifyAppFromJsonLd,
  identifyAppFromTextFragment,
} from "./app-lookup.server";
import { analyzeFileReferences } from "./file-reference-analyzer.server";
import { classifySeverity } from "./severity-classifier.server";
import { hostnameFromUrl } from "../lib/url.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeFile = { filename: string; content: string };

export type UnknownExternalResource = {
  filename: string;
  lineNumber: number;
  url: string;
  resourceType: "script" | "stylesheet";
  codeSnippet: string;
};

export type ScanResult = {
  findings: CreateFindingInput[];
  unknownScripts: UnknownExternalResource[];
};

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

/**
 * Returns true for Liquid files in directories the scan engine should process.
 * Skips assets (binary/JS/CSS files), config, and locales — these are handled
 * differently or deferred to later tickets.
 *
 * Scannable directories: templates/, sections/, snippets/, layout/
 */
export function isScannableFile(filename: string): boolean {
  if (!filename.endsWith(".liquid")) return false;

  const SCANNABLE_PREFIXES = ["templates/", "sections/", "snippets/", "layout/"];
  return SCANNABLE_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

/** Split file content into lines, preserving 1-based line numbers. */
function lines(content: string): Array<{ lineNumber: number; text: string }> {
  return content.split("\n").map((text, i) => ({ lineNumber: i + 1, text }));
}

/**
 * Build a short context snippet: the matched line plus up to one line of
 * surrounding context (capped at 300 chars) to give developers enough signal
 * without storing huge blobs.
 */
function buildSnippet(content: string, lineNumber: number): string {
  const allLines = content.split("\n");
  const start = Math.max(0, lineNumber - 2); // 0-indexed, one line before
  const end = Math.min(allLines.length, lineNumber + 1); // one line after
  return allLines.slice(start, end).join("\n").slice(0, 300);
}

/**
 * Returns a Set of 1-based line numbers that fall inside Liquid comment blocks.
 * Includes the {% comment %} opener line, all body lines, and the {% endcomment %}
 * closing line, so callers can uniformly skip any line in the set.
 *
 * Used by detectGhostSnippets, detectGhostPreconnect, and detectDuplicateMetaTags
 * to avoid false positives from commented-out code. Each of those detectors has
 * additional skip logic (conditional-line skipping or depth tracking) that differs
 * between them and therefore stays inline rather than being unified here.
 */
function buildCommentSkipLines(content: string): Set<number> {
  const skipLines = new Set<number>();
  let insideComment = false;
  for (const { lineNumber, text } of lines(content)) {
    if (/\{%-?\s*comment\s*-?%\}/.test(text)) insideComment = true;
    if (insideComment) skipLines.add(lineNumber);
    if (/\{%-?\s*endcomment\s*-?%\}/.test(text)) insideComment = false;
  }
  return skipLines;
}

// Matches an always-false conditional opener: {% if false %} or {% unless true %}.
// Requires the tag to close immediately after the literal (optionally with a
// whitespace-control dash), so it does NOT match reachable conditionals like
// {% if false_flag %} (different variable) or {% if false or x %} (compound).
const ALWAYS_FALSE_CONDITIONAL_RE = /\{%-?\s*(?:if\s+false|unless\s+true)\s*-?%\}/;

// Conditional block openers / closers (global, for counting multiple per line).
// `if`, `unless`, and `case` increase nesting depth; their `end*` counterparts
// decrease it. `elsif`/`else` do not change depth — they switch branches.
const CONDITIONAL_OPEN_RE = /\{%-?\s*(?:if|unless|case)\b/g;
const CONDITIONAL_CLOSE_RE = /\{%-?\s*(?:endif|endunless|endcase)\b/g;
const CONDITIONAL_ELSE_RE = /\{%-?\s*(?:else|elsif)\b/;

/**
 * Returns a Set of 1-based line numbers that fall inside an always-false Liquid
 * conditional block ({% if false %}…{% endif %} or {% unless true %}…{% endunless %}).
 * Mirrors buildCommentSkipLines so callers can uniformly skip unreachable lines.
 *
 * Code guarded by such a conditional never renders, so a section/snippet tag
 * nested inside it is dead code, not an active ghost reference, and must not be
 * flagged. Handles nested conditionals (depth tracking), whitespace-control tags
 * ({%- -%}), and stops suppression at an {% else %}/{% elsif %} on the always-false
 * block's own level — the alternate branch IS reachable. Conditionals that are
 * not always-false (e.g. {% if foo %}) are left untouched so their contents are
 * still scanned.
 */
function buildAlwaysFalseConditionalSkipLines(content: string): Set<number> {
  const skipLines = new Set<number>();

  // Running nesting depth across all conditionals. When we enter an always-false
  // block we remember the depth at which it opened; every line stays suppressed
  // until the depth falls back below that level (the matching end* tag).
  let depth = 0;
  let suppressFromDepth: number | null = null;

  for (const { lineNumber, text } of lines(content)) {
    const wasSuppressed = suppressFromDepth !== null;
    const opens = (text.match(CONDITIONAL_OPEN_RE) ?? []).length;
    const closes = (text.match(CONDITIONAL_CLOSE_RE) ?? []).length;

    depth += opens;

    // Begin suppression when an always-false opener appears and we are not
    // already inside an unreachable block (an inner always-false inside an
    // already-suppressed block adds nothing).
    const opensAlwaysFalse = ALWAYS_FALSE_CONDITIONAL_RE.test(text);
    if (opensAlwaysFalse && suppressFromDepth === null) {
      suppressFromDepth = depth;
    }

    let lineSuppressed = wasSuppressed || (opensAlwaysFalse && suppressFromDepth !== null);

    // An {% else %}/{% elsif %} belonging to the always-false block itself (same
    // nesting level) switches to a reachable branch: stop suppressing from here.
    if (wasSuppressed && depth === suppressFromDepth && CONDITIONAL_ELSE_RE.test(text)) {
      suppressFromDepth = null;
      lineSuppressed = false;
    }

    if (lineSuppressed) skipLines.add(lineNumber);

    depth -= closes;
    if (depth < 0) depth = 0;
    if (suppressFromDepth !== null && depth < suppressFromDepth) {
      suppressFromDepth = null;
    }
  }

  return skipLines;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_SCRIPT
// ---------------------------------------------------------------------------

// Matches <script src="https://..." or <script src='//...'> (external URLs)
// IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0 before
// each use to avoid stale state between calls. See each detector function below.
const SCRIPT_SRC_RE = /<script[^>]+src\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>/gi;

export function detectGhostScripts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Run against full file content so multi-line tags like:
  //   <script
  //     src="https://static.klaviyo.com/...">
  // are matched. lineNumberAtOffset maps the match position back to a line.
  let match: RegExpExecArray | null;
  SCRIPT_SRC_RE.lastIndex = 0;

  while ((match = SCRIPT_SRC_RE.exec(file.content)) !== null) {
    const url = match[1];
    const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_SCRIPT, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_SCRIPT,
      severity,
      appName,
      description: `External script from ${appName} (${url})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_STYLE
// ---------------------------------------------------------------------------

// Matches <link ... rel="stylesheet" ... href="https://...">
// Order of attributes may vary — we capture the href value separately.
const LINK_STYLESHEET_RE =
  /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi;

export function detectGhostStyles(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Run against full file content so multi-line tags like:
  //   <link
  //     rel="stylesheet"
  //     href="https://cdn.judge.me/...">
  // are matched. lineNumberAtOffset maps the match position back to a line.
  let match: RegExpExecArray | null;
  LINK_STYLESHEET_RE.lastIndex = 0;

  while ((match = LINK_STYLESHEET_RE.exec(file.content)) !== null) {
    // Group 1 captures href when rel comes first; group 3 when href comes first.
    const url = match[1] ?? match[3];
    if (!url) continue;

    const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_STYLE, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_STYLE,
      severity,
      appName,
      description: `External stylesheet from ${appName} (${url})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_SNIPPET
// ---------------------------------------------------------------------------

// Matches {% render 'name' %}, {% render "name" %}, {% include 'name' %}, {% include "name" %}
// Also handles optional whitespace-stripping dashes: {%- render ... -%}
// Run against the FULL file content so multi-line tags are matched.
const RENDER_RE = /\{%-?\s*(?:render|include)\s+["']([^"']+)["']/gi;

// Matches bare render/include inside {% liquid %} blocks, where each statement
// appears at the start of a line without tag delimiters:
//   {% liquid
//     render 'snippet-name'
//   %}
// The ^ anchor with /m flag restricts matches to line starts (after optional
// whitespace), avoiding false matches against arbitrary text containing "render".
// Does NOT overlap with RENDER_RE because RENDER_RE requires a preceding {%.
const RENDER_LIQUID_BLOCK_RE = /^[ \t]*(?:render|include)\s+["']([^"']+)["']/gim;

export function detectGhostSnippets(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Precompute lines inside Liquid comment blocks so bare `render 'app-snippet'`
  // statements inside {% comment %} blocks are not flagged as GHOST_SNIPPET.
  const commentSkipLines = buildCommentSkipLines(file.content);

  // Precompute lines inside always-false conditionals ({% if false %} /
  // {% unless true %}) so dead-code render/include statements are not flagged.
  const alwaysFalseSkipLines = buildAlwaysFalseConditionalSkipLines(file.content);

  const processSnippetMatch = (snippetName: string, matchIndex: number) => {
    const lineNumber = lineNumberAtOffset(file.content, matchIndex);
    if (commentSkipLines.has(lineNumber)) return; // inside {% comment %} block
    if (alwaysFalseSkipLines.has(lineNumber)) return; // inside always-false conditional

    const appName = identifyAppFromSnippetName(snippetName);
    if (!appName) return;

    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_SNIPPET, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_SNIPPET,
      severity,
      appName,
      description: `Liquid render/include of known ${appName} snippet '${snippetName}'`,
    });
  };

  // Standard form: {% render 'name' %} — may span multiple lines.
  // Record the full byte range of each match so the bare-form pass below can
  // skip RENDER_LIQUID_BLOCK_RE hits that fall inside an already-claimed tag
  // (e.g. the `render 'x'` keyword on line 2 of a multi-line {%- render ... -%}).
  const claimedRanges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  RENDER_RE.lastIndex = 0;
  while ((match = RENDER_RE.exec(file.content)) !== null) {
    claimedRanges.push([match.index, match.index + match[0].length]);
    processSnippetMatch(match[1], match.index);
  }

  // Bare form: render 'name' at line start inside {% liquid %} blocks.
  // Skip any match whose offset falls inside a range already claimed by RENDER_RE
  // to prevent a multi-line {% render %} tag from producing two findings.
  RENDER_LIQUID_BLOCK_RE.lastIndex = 0;
  while ((match = RENDER_LIQUID_BLOCK_RE.exec(file.content)) !== null) {
    const offset = match.index;
    const insideTaggedForm = claimedRanges.some(([start, end]) => offset > start && offset < end);
    if (insideTaggedForm) continue;
    processSnippetMatch(match[1], offset);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_SECTION
// ---------------------------------------------------------------------------

// Matches {% section 'name' %} or {% section "name" %}
const SECTION_RE = /\{%-?\s*section\s+["']([^"']+)["']/gi;

export function detectGhostSections(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Precompute lines to skip from a single lines() pass, then run SECTION_RE
  // against the FULL file content so multi-line tags like:
  //   {%-
  //     section 'pagefly-head'
  //   -%}
  // are matched. lineNumberAtOffset maps each match offset back to a line, and
  // a match is skipped if its start line falls inside a {% comment %} block or
  // contains a Liquid conditional — avoiding false positives from commented-out
  // or conditionally-rendered section references. SECTION_RE is a single regex,
  // so each tag yields exactly one match — no double-count risk.
  const commentSkipLines = buildCommentSkipLines(file.content);
  const conditionalLines = new Set<number>();
  for (const { lineNumber, text } of lines(file.content)) {
    if (LIQUID_CONDITIONAL_RE.test(text)) conditionalLines.add(lineNumber);
  }

  let match: RegExpExecArray | null;
  SECTION_RE.lastIndex = 0;

  while ((match = SECTION_RE.exec(file.content)) !== null) {
    const lineNumber = lineNumberAtOffset(file.content, match.index);
    if (commentSkipLines.has(lineNumber)) continue; // inside {% comment %} block
    if (conditionalLines.has(lineNumber)) continue; // theme-native conditional logic

    const sectionName = match[1];
    const appName = identifyAppFromSnippetName(sectionName);
    if (!appName) continue;

    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_SECTION, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_SECTION,
      severity,
      appName,
      description: `Liquid section reference to known ${appName} section '${sectionName}'`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_HREFLANG
// ---------------------------------------------------------------------------

// Matches <link ... rel="alternate" ... hreflang="xx" ... href="..." ...>
// Handles both attribute orderings: hreflang before href and href before hreflang.
const HREFLANG_RE_1 =
  /<link[^>]+rel\s*=\s*["']alternate["'][^>]+hreflang\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
const HREFLANG_RE_2 =
  /<link[^>]+rel\s*=\s*["']alternate["'][^>]+href\s*=\s*["']([^"']+)["'][^>]*hreflang\s*=\s*["']([^"']+)["'][^>]*>/gi;

export function detectGhostHrefLang(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Run against full file content so multi-line <link> tags are matched.
  // lineNumberAtOffset maps each match offset back to a 1-based line number.
  let match: RegExpExecArray | null;

  // Pattern 1: hreflang before href — groups: [1]=lang, [2]=href
  HREFLANG_RE_1.lastIndex = 0;
  while ((match = HREFLANG_RE_1.exec(file.content)) !== null) {
    const lang = match[1];
    const href = match[2];
    const appName = identifyAppFromHrefLang(href);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_HREFLANG, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_HREFLANG,
      severity,
      appName,
      description: `Orphaned hreflang tag for "${lang}" from ${appName} (${href})`,
    });
  }

  // Pattern 2: href before hreflang — groups: [1]=href, [2]=lang
  HREFLANG_RE_2.lastIndex = 0;
  while ((match = HREFLANG_RE_2.exec(file.content)) !== null) {
    const href = match[1];
    const lang = match[2];
    const appName = identifyAppFromHrefLang(href);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_HREFLANG, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_HREFLANG,
      severity,
      appName,
      description: `Orphaned hreflang tag for "${lang}" from ${appName} (${href})`,
    });
  }

  // Deduplicate findings from overlapping regex patterns.
  // A tag that matches both HREFLANG_RE_1 and HREFLANG_RE_2 (different attribute
  // orderings) would otherwise produce two findings for the same location.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.filename}:${f.lineNumber}:${f.appName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Detector: DUPLICATE_META
// ---------------------------------------------------------------------------

// Matches <meta ... name="X" ...> or <meta ... property="X" ...>
// Captures the name/property attribute value regardless of attribute order.
const META_TAG_RE = /<meta\s+[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * OG / structured-data properties that the Open Graph spec explicitly allows to
 * repeat within a single page (e.g. multiple images, multiple article tags).
 * Repeating these is intentional and must NOT be flagged as a duplicate.
 *
 * Sources: ogp.me §Array properties; article.tag, book.tag spec.
 */
const REPEATABLE_META_PROPS = new Set([
  // og:image and all its structured sub-properties (one set per image)
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "og:image:type",
  "og:image:width",
  "og:image:height",
  "og:image:alt",
  // og:video and structured sub-properties
  "og:video",
  "og:video:url",
  "og:video:secure_url",
  "og:video:type",
  "og:video:width",
  "og:video:height",
  // og:audio and structured sub-properties
  "og:audio",
  "og:audio:secure_url",
  "og:audio:type",
  // Alternate locales
  "og:locale:alternate",
  // Content tags (explicitly repeatable per spec)
  "article:tag",
  "book:tag",
]);

export function detectDuplicateMetaTags(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Build a map of (name/property value) → array of occurrences.
  // Only count meta tags that are NOT inside Liquid comment blocks and NOT
  // inside Liquid conditional blocks (if/unless/case…endif). Tags inside
  // conditional branches render exclusively at runtime (e.g. og:type varies
  // by template), so they must not be counted as duplicates of each other.
  const occurrences = new Map<string, Array<{ lineNumber: number; text: string }>>();

  // Precompute lines inside Liquid comment blocks via shared helper.
  // Conditional-depth tracking differs from sibling detectors (it uses a depth
  // counter for nested if/unless/case rather than a flat line-skip set), so it
  // stays inline below rather than being unified into buildCommentSkipLines.
  const commentSkipLines = buildCommentSkipLines(file.content);
  let conditionalDepth = 0;

  for (const { lineNumber, text } of lines(file.content)) {
    // --- Comment block tracking ---
    if (commentSkipLines.has(lineNumber)) continue;

    // --- Conditional block depth tracking ---
    // Opening tags increment depth; closing tags decrement. The depth check
    // runs AFTER updating depth so the `{% if %}` line itself is also skipped
    // (LIQUID_CONDITIONAL_RE catches it if the meta is on the same line as if).
    if (/\{%-?\s*(?:if|unless|case)\b/.test(text)) conditionalDepth++;
    if (/\{%-?\s*(?:endif|endunless|endcase)\b/.test(text)) {
      conditionalDepth = Math.max(0, conditionalDepth - 1);
    }

    // Skip lines inside a conditional block, or lines that contain a
    // conditional keyword (handles the single-line `{% if %}...<meta>...{% endif %}` pattern)
    if (conditionalDepth > 0 || LIQUID_CONDITIONAL_RE.test(text)) continue;

    let match: RegExpExecArray | null;
    META_TAG_RE.lastIndex = 0;

    while ((match = META_TAG_RE.exec(text)) !== null) {
      const attrValue = match[1].toLowerCase();

      // Skip properties that are intentionally repeatable per the OG spec
      if (REPEATABLE_META_PROPS.has(attrValue)) continue;

      if (!occurrences.has(attrValue)) {
        occurrences.set(attrValue, []);
      }
      occurrences.get(attrValue)!.push({ lineNumber, text });
    }
  }

  // Emit findings for the 2nd+ occurrence of each duplicated meta tag
  for (const [attrValue, entries] of occurrences) {
    if (entries.length < 2) continue;

    const firstLine = entries[0].lineNumber;

    for (let i = 1; i < entries.length; i++) {
      const entry = entries[i];
      const codeSnippet = buildSnippet(file.content, entry.lineNumber);
      const severity = classifySeverity(FindingType.DUPLICATE_META, codeSnippet);

      // Attempt app attribution from the full meta tag text — optional
      const appName = identifyAppFromCode(entry.text) ?? null;

      findings.push({
        filename: file.filename,
        lineNumber: entry.lineNumber,
        codeSnippet,
        findingType: FindingType.DUPLICATE_META,
        severity,
        appName: appName ?? undefined,
        description: `Duplicate meta tag '${attrValue}' — also found on line ${firstLine}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_JSON_LD
// ---------------------------------------------------------------------------

// Multiline regex to extract <script type="application/ld+json">...</script> blocks.
const JSON_LD_BLOCK_RE =
  /<script\s+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Regex to detect app-only @type values that Shopify themes never inject natively.
const APP_ONLY_TYPE_RE =
  /["']@type["']\s*:\s*["'](FAQPage|AggregateRating|Review|BreadcrumbList|LocalBusiness)["']/;

// Regex to detect Liquid template tags ({{ or {%).
const LIQUID_TAG_RE = /\{\{|\{%/;

/**
 * Compute the 1-based line number where `offset` falls within `content`.
 */
function lineNumberAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export function detectGhostJsonLd(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  let match: RegExpExecArray | null;
  JSON_LD_BLOCK_RE.lastIndex = 0;

  while ((match = JSON_LD_BLOCK_RE.exec(file.content)) !== null) {
    const blockContent = match[1];

    // Skip blocks containing Liquid template tags — these are native theme
    // blocks rendered by the theme engine, not orphaned static injections.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Try app attribution via signature patterns first.
    const appName = identifyAppFromJsonLd(blockContent);
    if (appName) {
      const severity = classifySeverity(FindingType.GHOST_JSON_LD, codeSnippet);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_JSON_LD,
        severity,
        appName,
        description: `Orphaned JSON-LD schema markup from ${appName}`,
      });
      continue;
    }

    // Check for app-only @type values that Shopify themes don't inject natively.
    const typeMatch = APP_ONLY_TYPE_RE.exec(blockContent);
    if (typeMatch) {
      const typeName = typeMatch[1];
      const severity = classifySeverity(FindingType.GHOST_JSON_LD, codeSnippet);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_JSON_LD,
        severity,
        appName: undefined,
        description: `Orphaned JSON-LD schema with app-only @type "${typeName}" — likely left by an uninstalled app`,
      });
      continue;
    }

    // No app match and no app-only @type — skip (legitimate static JSON-LD).
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: JSON_LD_CONFLICT
// ---------------------------------------------------------------------------

/**
 * Detect conflicting JSON-LD blocks — multiple <script type="application/ld+json">
 * blocks with the same @type but different data in the same file.
 *
 * This happens when multiple SEO/review apps each inject their own schema markup
 * and one gets uninstalled but its markup persists. Google may drop rich results
 * entirely when it sees conflicting JSON-LD for the same @type.
 */
export function detectJsonLdConflicts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Collect all JSON-LD blocks with their parsed @type and content
  const blocksByType = new Map<string, Array<{ lineNumber: number; rawContent: string }>>();

  JSON_LD_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = JSON_LD_BLOCK_RE.exec(file.content)) !== null) {
    const blockContent = match[1];

    // Skip blocks containing Liquid template tags — these are dynamically
    // rendered and may produce different output at runtime.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    // Try to parse the JSON and extract @type
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(blockContent);
    } catch {
      continue; // Malformed JSON — skip gracefully
    }

    const atType = parsed["@type"];
    if (typeof atType !== "string") continue;

    const lineNumber = lineNumberAtOffset(file.content, match.index);

    if (!blocksByType.has(atType)) {
      blocksByType.set(atType, []);
    }
    blocksByType.get(atType)!.push({ lineNumber, rawContent: blockContent });
  }

  // For each @type with 2+ occurrences, compare blocks and emit conflicts
  for (const [atType, blocks] of blocksByType) {
    if (blocks.length < 2) continue;

    const firstBlock = blocks[0];

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];

      // If content is identical (after trimming whitespace), skip — these are
      // duplicates, not conflicts. The existing DUPLICATE handling catches those.
      if (firstBlock.rawContent.trim() === block.rawContent.trim()) continue;

      const codeSnippet = buildSnippet(file.content, block.lineNumber);
      const severity = classifySeverity(FindingType.JSON_LD_CONFLICT, codeSnippet);

      // Try app attribution
      const appName =
        identifyAppFromJsonLd(block.rawContent) ??
        identifyAppFromCode(block.rawContent) ??
        undefined;

      findings.push({
        filename: file.filename,
        lineNumber: block.lineNumber,
        codeSnippet,
        findingType: FindingType.JSON_LD_CONFLICT,
        severity,
        appName,
        description: `Conflicting JSON-LD "@type": "${atType}" — conflicts with block on line ${firstBlock.lineNumber}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_TEXT
// ---------------------------------------------------------------------------

export function detectGhostTextFragments(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    // Skip lines that other detectors already handle
    if (/<script[\s>]/i.test(text) || /\{%-?\s*(?:render|include|section)\s+/i.test(text)) continue;

    const appName = identifyAppFromTextFragment(text);
    if (!appName) continue;

    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_TEXT, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_TEXT,
      severity,
      appName,
      description: `Orphaned UI widget markup from ${appName}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_PIXEL
// ---------------------------------------------------------------------------

/**
 * Known inline tracking function patterns with their app attribution.
 * Each entry maps a regex (matching function calls in inline <script> blocks)
 * to the app that typically injects it.
 */
const TRACKING_PATTERNS: Array<{ pattern: RegExp; appName: string; tracker: string }> = [
  { pattern: /\bfbq\s*\(/, appName: "Facebook Pixel", tracker: "fbq" },
  { pattern: /\bgtag\s*\(/, appName: "Google Analytics", tracker: "gtag" },
  { pattern: /\b_gaq\.push\s*\(/, appName: "Google Analytics (Legacy)", tracker: "_gaq" },
  {
    pattern: /\bga\s*\(\s*['"](?:send|create|require)['"]/,
    appName: "Google Analytics (Universal)",
    tracker: "ga",
  },
  { pattern: /\b_taq\.push\s*\(/, appName: "Tealium", tracker: "_taq" },
  { pattern: /\bttq\.\w+\s*\(/, appName: "TikTok Pixel", tracker: "ttq" },
  { pattern: /\bpintrk\s*\(/, appName: "Pinterest Tag", tracker: "pintrk" },
  { pattern: /\btwq\s*\(/, appName: "Twitter/X Pixel", tracker: "twq" },
  { pattern: /\bsnaptr\s*\(/, appName: "Snapchat Pixel", tracker: "snaptr" },
  { pattern: /\bobApi\s*\(/, appName: "Outbrain", tracker: "obApi" },
  { pattern: /\brdt\s*\(/, appName: "Reddit Pixel", tracker: "rdt" },
  { pattern: /\bklarnaOsm\b/, appName: "Klarna", tracker: "klarnaOsm" },
];

/**
 * Detect inline tracking pixel code left by uninstalled tracking/analytics apps.
 *
 * Scans for known tracking function calls (fbq, gtag, ttq, etc.) inside
 * <script> blocks. Deduplicates by tracker name per file — multiple calls to
 * the same tracker (e.g. fbq('init') + fbq('track')) produce only one finding.
 */
export function detectGhostPixels(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const seenTrackers = new Set<string>();

  let insideScript = false;

  for (const { lineNumber, text } of lines(file.content)) {
    // Track whether we're inside a <script> block.
    // A line can contain both an opening and closing tag (single-line scripts).
    if (/<script[\s>]/i.test(text)) {
      insideScript = true;
    }

    if (insideScript) {
      for (const { pattern, appName, tracker } of TRACKING_PATTERNS) {
        if (seenTrackers.has(tracker)) continue;
        if (pattern.test(text)) {
          seenTrackers.add(tracker);

          const codeSnippet = buildSnippet(file.content, lineNumber);
          const severity = classifySeverity(FindingType.GHOST_PIXEL, codeSnippet);

          findings.push({
            filename: file.filename,
            lineNumber,
            codeSnippet,
            findingType: FindingType.GHOST_PIXEL,
            severity,
            appName,
            description: `Inline tracking pixel from ${appName} (${tracker})`,
          });
        }
      }
    }

    if (/<\/script>/i.test(text)) {
      insideScript = false;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_ROBOTS
// ---------------------------------------------------------------------------

/**
 * Matches <meta name="robots" content="..."> with either attribute ordering:
 *   - name before content
 *   - content before name
 * Captures the content attribute value for directive analysis.
 */
const META_ROBOTS_RE =
  /<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>|<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']robots["'][^>]*>/gi;

/**
 * Restrictive robots directives that can harm SEO when left orphaned.
 */
const RESTRICTIVE_DIRECTIVES = /\b(noindex|nofollow|none)\b/i;

/**
 * Liquid conditional patterns — lines containing these are theme-native logic
 * and should not be flagged as ghost code.
 */
const LIQUID_CONDITIONAL_RE = /\{%-?\s*(if|unless|elsif)\b/;

/**
 * Detect orphaned <meta name="robots"> tags with restrictive directives
 * (noindex, nofollow, none) that may have been injected by SEO apps.
 *
 * Skips tags that appear on lines with Liquid conditionals, since those
 * represent intentional theme logic (e.g. noindex on 404 pages).
 */
export function detectGhostRobots(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    // Skip lines with Liquid conditionals — these are theme-native logic
    if (LIQUID_CONDITIONAL_RE.test(text)) continue;

    let match: RegExpExecArray | null;
    META_ROBOTS_RE.lastIndex = 0;

    while ((match = META_ROBOTS_RE.exec(text)) !== null) {
      // Group 1 captures content when name comes first; group 2 when content comes first.
      const contentValue = match[1] ?? match[2];
      if (!contentValue) continue;

      // Only flag restrictive directives
      if (!RESTRICTIVE_DIRECTIVES.test(contentValue)) continue;

      const codeSnippet = buildSnippet(file.content, lineNumber);

      // Try app attribution from surrounding code context
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;

      const severity = classifySeverity(FindingType.GHOST_ROBOTS, codeSnippet);

      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_ROBOTS,
        severity,
        appName,
        description: `Orphaned meta robots directive "${contentValue}" — may block search engine indexing`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Collector: unknown external scripts (unrecognized CDN URLs)
// ---------------------------------------------------------------------------

const SHOPIFY_FIRST_PARTY_RE = /\.(shopify\.com|shopifycdn\.com|myshopify\.com)$/;

export function collectUnknownScripts(file: ThemeFile): UnknownExternalResource[] {
  const unknowns: UnknownExternalResource[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    SCRIPT_SRC_RE.lastIndex = 0;

    while ((match = SCRIPT_SRC_RE.exec(text)) !== null) {
      const url = match[1];
      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (appName) continue; // Already identified — skip

      // Filter out first-party Shopify CDN URLs that are not app artifacts
      const hostname = hostnameFromUrl(url);
      if (hostname === null) continue; // Malformed URL — skip
      if (SHOPIFY_FIRST_PARTY_RE.test(hostname)) continue;

      unknowns.push({
        filename: file.filename,
        lineNumber,
        url,
        resourceType: "script",
        codeSnippet: buildSnippet(file.content, lineNumber),
      });
    }
  }

  return unknowns;
}

// ---------------------------------------------------------------------------
// Collector: unknown external stylesheets (unrecognized CDN URLs)
// ---------------------------------------------------------------------------

export function collectUnknownStylesheets(file: ThemeFile): UnknownExternalResource[] {
  const unknowns: UnknownExternalResource[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    LINK_STYLESHEET_RE.lastIndex = 0;

    while ((match = LINK_STYLESHEET_RE.exec(text)) !== null) {
      const url = match[1] ?? match[3];
      if (!url) continue;

      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (appName) continue; // Already identified — skip

      // Filter out first-party Shopify CDN URLs
      const hostname = hostnameFromUrl(url);
      if (hostname === null) continue; // Malformed URL — skip
      if (SHOPIFY_FIRST_PARTY_RE.test(hostname)) continue;

      unknowns.push({
        filename: file.filename,
        lineNumber,
        url,
        resourceType: "stylesheet",
        codeSnippet: buildSnippet(file.content, lineNumber),
      });
    }
  }

  return unknowns;
}

// ---------------------------------------------------------------------------
// Detector: SETTINGS_DRIFT
// ---------------------------------------------------------------------------

/**
 * Shopify built-in section group types that don't have corresponding .liquid
 * files in the sections/ directory. These are virtual section containers
 * managed by the theme editor, not real section files.
 */
const BUILTIN_SECTION_TYPES = new Set([
  "header-group",
  "footer-group",
  "aside",
  "overlay-group",
  "custom-section-group",
]);

/**
 * Cross-file detector: finds stale section references in settings_data.json
 * that point to section types whose .liquid files no longer exist in the theme.
 *
 * When apps add sections to a theme, they create entries in settings_data.json.
 * After uninstall, the section files are removed but settings_data.json entries
 * often persist — these are "settings data drift."
 */
export function detectSettingsDrift(files: ThemeFile[]): CreateFindingInput[] {
  const settingsFile = files.find((f) => f.filename === "config/settings_data.json");
  if (!settingsFile) return [];

  let settingsData: Record<string, unknown>;
  try {
    settingsData = JSON.parse(settingsFile.content);
  } catch {
    return []; // Malformed JSON — skip gracefully
  }

  // Only process the "current" key (active theme configuration)
  const current = settingsData.current;
  if (!current || typeof current !== "object") return [];

  const sections = (current as Record<string, unknown>).sections;
  if (!sections || typeof sections !== "object") return [];

  // Build a set of existing section filenames for fast lookup
  const existingSectionTypes = new Set<string>();
  for (const file of files) {
    const match = file.filename.match(/^sections\/(.+)\.liquid$/);
    if (match) {
      existingSectionTypes.add(match[1]);
    }
  }

  const findings: CreateFindingInput[] = [];
  const sectionEntries = sections as Record<string, unknown>;

  for (const [sectionKey, sectionValue] of Object.entries(sectionEntries)) {
    if (!sectionValue || typeof sectionValue !== "object") continue;

    const sectionType = (sectionValue as Record<string, unknown>).type;
    if (typeof sectionType !== "string") continue;

    // Skip Shopify built-in section types
    if (BUILTIN_SECTION_TYPES.has(sectionType)) continue;

    // Skip if the section file exists in the theme
    if (existingSectionTypes.has(sectionType)) continue;

    // Extract a code snippet from the settings_data.json entry
    const entryJson = JSON.stringify({ [sectionKey]: sectionValue }, null, 2);
    const codeSnippet = entryJson.slice(0, 300);

    // Try app attribution via snippet name lookup
    const appName = identifyAppFromSnippetName(sectionType);

    const severity = classifySeverity(FindingType.SETTINGS_DRIFT, codeSnippet);

    const description = appName
      ? `Stale settings_data.json reference to "${sectionType}" section from ${appName} — section file no longer exists`
      : `Stale settings_data.json reference to "${sectionType}" section — section file no longer exists (may be from an uninstalled app or a manually removed section)`;

    findings.push({
      filename: settingsFile.filename,
      lineNumber: 1,
      codeSnippet,
      findingType: FindingType.SETTINGS_DRIFT,
      severity,
      appName: appName ?? undefined,
      description,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_LAYOUT
// ---------------------------------------------------------------------------

/**
 * Legitimate layout filenames that Shopify themes use natively.
 * Any layout file not in this set is a candidate for ghost layout detection.
 */
const LEGITIMATE_LAYOUTS = new Set(["theme.liquid", "password.liquid", "checkout.liquid"]);

/**
 * Local lookup map for page builder apps that create layout files with the
 * `theme.{appname}.liquid` naming convention. Used when identifyAppFromSnippetName
 * and identifyAppFromCode don't catch the attribution from the filename alone.
 */
const LAYOUT_FILENAME_APP_MAP: Record<string, string> = {
  pagefly: "PageFly",
  gempages: "GemPages",
  shogun: "Shogun",
  zipify: "Zipify Pages",
  ecomsolid: "EComSolid",
};

/**
 * Cross-file detector: finds orphaned layout files left by page builder apps.
 *
 * Standard Shopify themes only have `layout/theme.liquid`, `layout/password.liquid`,
 * and optionally `layout/checkout.liquid` (Shopify Plus). Page builder apps create
 * alternate layouts like `layout/theme.pagefly.liquid` which persist after uninstall.
 *
 * Attribution strategy (tried in order):
 *   1. Extract the stem from `theme.{stem}.liquid` and check LAYOUT_FILENAME_APP_MAP
 *   2. Try identifyAppFromSnippetName on the full filename stem (without path/extension)
 *   3. Try identifyAppFromCode on the file content
 *
 * A finding is emitted if the file is attributed to an app OR if the filename
 * matches the `theme.*.liquid` pattern (strong signal of app origin). Files that
 * match neither are skipped — they could be custom merchant layouts.
 */
export function detectGhostLayouts(files: ThemeFile[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const file of files) {
    // Only process layout/*.liquid files
    if (!file.filename.startsWith("layout/") || !file.filename.endsWith(".liquid")) continue;

    // Extract just the filename without the directory prefix
    const basename = file.filename.replace(/^layout\//, "");

    // Skip legitimate Shopify layout files
    if (LEGITIMATE_LAYOUTS.has(basename)) continue;

    // Determine if this matches the theme.*.liquid app layout pattern
    const themeLayoutMatch = basename.match(/^theme\.(.+)\.liquid$/);
    const isAppLayoutPattern = themeLayoutMatch !== null;

    // Also check for gem-*.liquid pattern (GemPages alternate naming)
    const isGemPattern = /^gem-.+\.liquid$/.test(basename);

    // Try attribution: filename-based lookup first
    let appName: string | undefined;

    if (themeLayoutMatch) {
      const stem = themeLayoutMatch[1].toLowerCase();
      appName = LAYOUT_FILENAME_APP_MAP[stem];
    }

    // Try identifyAppFromSnippetName on the filename stem (without extension)
    if (!appName) {
      const filenameStem = basename.replace(/\.liquid$/, "");
      appName = identifyAppFromSnippetName(filenameStem) ?? undefined;
    }

    // Try identifyAppFromCode on file content for broader matching
    if (!appName) {
      appName = identifyAppFromCode(file.content) ?? undefined;
    }

    // For gem-*.liquid pattern, default to GemPages if not otherwise attributed
    if (!appName && isGemPattern) {
      appName = "GemPages";
    }

    // Only emit a finding if attributed OR if it matches the theme.*.liquid pattern
    if (!appName && !isAppLayoutPattern && !isGemPattern) continue;

    const codeSnippet = file.content.slice(0, 300);
    const severity = classifySeverity(FindingType.GHOST_LAYOUT, codeSnippet);

    const description = appName
      ? `Orphaned layout file from ${appName}`
      : "Orphaned app layout file — likely left by an uninstalled page builder";

    findings.push({
      filename: file.filename,
      lineNumber: 1,
      codeSnippet,
      findingType: FindingType.GHOST_LAYOUT,
      severity,
      appName,
      description,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_CANONICAL
// ---------------------------------------------------------------------------

/**
 * Matches <link rel="canonical" href="..."> with either attribute ordering:
 *   - rel before href
 *   - href before rel
 * Captures the href value for analysis.
 */
const CANONICAL_RE =
  /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>|<link[^>]+href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*>/gi;

/**
 * Known safe Shopify-native Liquid variables used in canonical hrefs.
 * These resolve to valid URLs and should not trigger an "unresolved variable" finding.
 */
const SAFE_CANONICAL_VARS_RE =
  /\{\{\s*(canonical_url|request\.path|shop\.url|page_url|url)\s*(\|[^}]*)?\}\}/;

/**
 * Matches any Liquid variable expression in a string.
 */
const LIQUID_VAR_RE = /\{\{[^}]*\}\}/;

/**
 * Matches a plain absolute URL with a valid-looking domain.
 */
const ABSOLUTE_URL_RE = /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * Detect orphaned <link rel="canonical"> overrides left by SEO apps.
 *
 * Trigger conditions:
 *   1. Empty or whitespace-only href
 *   2. Unresolved Liquid variables in href (excluding safe Shopify vars)
 *   3. Duplicate canonical tags in the same file (flag 2nd+)
 *   4. App-attributed canonical via identifyAppFromCode()
 *
 * False positive boundaries:
 *   - Skips native {{ canonical_url }} pattern
 *   - Skips canonicals inside Liquid conditionals
 *   - Skips single valid hardcoded URLs (unless app-attributed)
 */
export function detectGhostCanonical(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Collect all canonical occurrences for duplicate detection
  const allCanonicals: Array<{ lineNumber: number; href: string }> = [];

  // Precompute the lines to skip from a single line pass, then run CANONICAL_RE
  // against the FULL file content so multi-line / prettier-wrapped tags like:
  //   <link
  //     rel="canonical"
  //     href="">
  // are matched. lineNumberAtOffset maps each match offset back to a line, and
  // a match is skipped if its start line falls inside a {% comment %} block or
  // contains a Liquid conditional — preserving the prior per-line semantics.
  // CANONICAL_RE is a single regex (rel-first | href-first alternation), so each
  // tag yields exactly one match — no double-count risk.
  const commentSkipLines = buildCommentSkipLines(file.content);
  const conditionalLines = new Set<number>();
  for (const { lineNumber, text } of lines(file.content)) {
    if (LIQUID_CONDITIONAL_RE.test(text)) conditionalLines.add(lineNumber);
  }

  let collectMatch: RegExpExecArray | null;
  CANONICAL_RE.lastIndex = 0;
  while ((collectMatch = CANONICAL_RE.exec(file.content)) !== null) {
    const lineNumber = lineNumberAtOffset(file.content, collectMatch.index);
    if (commentSkipLines.has(lineNumber)) continue; // inside {% comment %} block
    if (conditionalLines.has(lineNumber)) continue; // theme-native conditional logic

    // Group 1 captures href when rel comes first; group 2 when href comes first.
    const href = collectMatch[1] ?? collectMatch[2] ?? "";
    allCanonicals.push({ lineNumber, href });
  }

  // Track which lines already have a finding to avoid double-reporting
  const reportedLines = new Set<number>();

  for (let i = 0; i < allCanonicals.length; i++) {
    const { lineNumber, href } = allCanonicals[i];
    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Check 1: Empty or whitespace-only href
    if (/^\s*$/.test(href)) {
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const severity = classifySeverity(FindingType.GHOST_CANONICAL, codeSnippet);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_CANONICAL,
        severity,
        appName,
        description: "Empty canonical href — may cause search engines to index wrong URL variant",
      });
      reportedLines.add(lineNumber);
      continue;
    }

    // Check 2: Unresolved Liquid variables in href
    if (LIQUID_VAR_RE.test(href) && !SAFE_CANONICAL_VARS_RE.test(href)) {
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const severity = classifySeverity(FindingType.GHOST_CANONICAL, codeSnippet);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_CANONICAL,
        severity,
        appName,
        description: `Unresolved Liquid variable in canonical href "${href}"`,
      });
      reportedLines.add(lineNumber);
      continue;
    }

    // Check 3: App-attributed canonical (even if href looks valid)
    const appName = identifyAppFromCode(codeSnippet) ?? undefined;
    if (appName) {
      const severity = classifySeverity(FindingType.GHOST_CANONICAL, codeSnippet);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_CANONICAL,
        severity,
        appName,
        description: `App-attributed canonical tag from ${appName}`,
      });
      reportedLines.add(lineNumber);
      continue;
    }

    // Check 4 (false positive boundary): Single valid hardcoded URL — skip
    if (ABSOLUTE_URL_RE.test(href)) continue;
  }

  // Check 5: Duplicate canonical tags — flag 2nd+ occurrence
  if (allCanonicals.length > 1) {
    const firstLine = allCanonicals[0].lineNumber;
    for (let i = 1; i < allCanonicals.length; i++) {
      const { lineNumber } = allCanonicals[i];
      if (reportedLines.has(lineNumber)) continue; // Already reported for another reason

      const codeSnippet = buildSnippet(file.content, lineNumber);
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const severity = classifySeverity(FindingType.GHOST_CANONICAL, codeSnippet);

      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_CANONICAL,
        severity,
        appName,
        description: `Duplicate canonical tag — also found on line ${firstLine}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_TITLE
// ---------------------------------------------------------------------------

/**
 * Matches <title>...</title> tags, capturing the inner content (may span lines).
 */
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/gi;

/**
 * Build a "safe Liquid variable" matcher for a single `{{ ... }}` expression.
 *
 * Each entry in `tokens` is a regex fragment describing an allowed leading
 * variable; the expression may end with an arbitrary filter chain. We only ever
 * call `.test()` on the result, so the groups are non-capturing.
 *
 *   buildSafeVarRe(["page_title", "shop(?:\\.\\w+)*"])
 *     matches:  {{ page_title }}   {{ shop.name | escape }}
 */
function buildSafeVarRe(tokens: string[]): RegExp {
  return new RegExp(`\\{\\{\\s*(?:${tokens.join("|")})(?:\\s*\\|[^}]*)?\\s*\\}\\}`);
}

/**
 * Native Shopify global Liquid objects. Any sub-property of these is real,
 * theme-rendered data (e.g. `shop.name`, `product.featured_image`,
 * `cart.currency.iso_code`, `request.origin`) — never orphaned app code.
 * `(?:\.\w+)*` covers the bare object plus arbitrarily nested properties.
 *
 * Shared by the GHOST_TITLE and GHOST_OG safe-variable allowlists so the two
 * detectors stay in sync as Shopify's free reference themes evolve.
 */
const SHOPIFY_GLOBAL_OBJECTS = [
  "shop",
  "product",
  "collection",
  "article",
  "blog",
  "page",
  "cart",
  "request",
  "settings",
  "media",
].map((object) => `${object}(?:\\.\\w+)*`);

/**
 * Known safe Liquid variables that legitimately appear inside stock-theme
 * `<title>` blocks (Dawn, Sense, Refresh, Craft, Spotlight all share the same
 * markup). These resolve to valid values and must not trigger a finding.
 *
 * Dawn's title block, for reference:
 *   {{ page_title }}
 *   {%- if current_tags %} ... {{ current_tags | join: ', ' }}{% endif -%}
 *   {%- if current_page != 1 %} ... Page {{ current_page }}{% endif -%}
 *   {%- unless page_title contains shop.name %} ... {{ shop.name }}{% endunless -%}
 */
const SAFE_TITLE_VARS_RE = buildSafeVarRe([
  // Per-page SEO globals Shopify injects on every request
  "page_title",
  "page_description",
  // Pagination / tag context used by stock theme title blocks
  "current_tags",
  "current_page",
  // Template name + Online Store header injection
  "template",
  "content_for_\\w+",
  // Native Shopify objects (any property): shop.name, product.title, ...
  ...SHOPIFY_GLOBAL_OBJECTS,
]);

/**
 * Detect orphaned <title> tag overrides left by SEO apps.
 *
 * Trigger conditions:
 *   1. Empty or whitespace-only title content (layout files only)
 *   2. Unresolved Liquid variables (excluding safe Shopify vars)
 *   3. App-attributed title via identifyAppFromCode()
 *   4. Multiple title tags in same file (flag 2nd+)
 *
 * False positive boundaries:
 *   - Skips native Dawn title containing page_title
 *   - Skips titles inside Liquid conditionals
 *   - Skips empty titles in non-layout files
 */
export function detectGhostTitle(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const isLayoutFile = file.filename.startsWith("layout/");
  const contentLines = file.content.split("\n");

  // Build a set of line numbers inside Liquid comment blocks
  const commentedLines = new Set<number>();
  let insideComment = false;
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (/\{%-?\s*comment\s*-?%\}/.test(line)) insideComment = true;
    if (insideComment) commentedLines.add(i + 1); // 1-indexed
    if (/\{%-?\s*endcomment\s*-?%\}/.test(line)) insideComment = false;
  }

  // Collect all title occurrences for duplicate detection
  const allTitles: Array<{
    lineNumber: number;
    innerContent: string;
    offset: number;
  }> = [];

  let match: RegExpExecArray | null;
  TITLE_TAG_RE.lastIndex = 0;

  while ((match = TITLE_TAG_RE.exec(file.content)) !== null) {
    const innerContent = match[1];
    const matchLineNumber = lineNumberAtOffset(file.content, match.index);

    // Skip titles inside Liquid comment blocks
    if (commentedLines.has(matchLineNumber)) continue;

    // Skip titles inside Liquid conditionals
    const matchLine = contentLines[matchLineNumber - 1] ?? "";
    if (LIQUID_CONDITIONAL_RE.test(matchLine)) continue;

    allTitles.push({
      lineNumber: matchLineNumber,
      innerContent,
      offset: match.index,
    });
  }

  // Track which entries already have a finding to avoid double-reporting
  const reportedIndices = new Set<number>();

  for (let i = 0; i < allTitles.length; i++) {
    const { lineNumber, innerContent } = allTitles[i];
    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Check 1: Empty or whitespace-only title content (layout files only)
    if (/^\s*$/.test(innerContent) && isLayoutFile) {
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const description =
        "Empty title tag — search engines will display the URL instead of a descriptive title";
      const severity = classifySeverity(FindingType.GHOST_TITLE, codeSnippet, description);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_TITLE,
        severity,
        appName,
        description,
      });
      reportedIndices.add(i);
      continue;
    }

    // Check 2: Unresolved Liquid variables in title
    // Extract all {{ ... }} expressions and check if any are NOT safe
    if (LIQUID_VAR_RE.test(innerContent)) {
      // If ALL Liquid vars in the title are safe, skip
      const allVarsInTitle = innerContent.match(/\{\{[^}]*\}\}/g) ?? [];
      const hasUnsafeVar = allVarsInTitle.some((v) => !SAFE_TITLE_VARS_RE.test(v));

      if (hasUnsafeVar) {
        const appName = identifyAppFromCode(codeSnippet) ?? undefined;
        const description = `Unresolved Liquid variable in title tag`;
        const severity = classifySeverity(FindingType.GHOST_TITLE, codeSnippet, description);
        findings.push({
          filename: file.filename,
          lineNumber,
          codeSnippet,
          findingType: FindingType.GHOST_TITLE,
          severity,
          appName,
          description,
        });
        reportedIndices.add(i);
        continue;
      }
    }

    // Check 3: App-attributed title (even if content looks valid)
    const appName = identifyAppFromCode(codeSnippet) ?? undefined;
    if (appName) {
      const description = `App-attributed title tag from ${appName}`;
      const severity = classifySeverity(FindingType.GHOST_TITLE, codeSnippet, description);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_TITLE,
        severity,
        appName,
        description,
      });
      reportedIndices.add(i);
      continue;
    }
  }

  // Check 4: Duplicate title tags — flag 2nd+ occurrence
  if (allTitles.length > 1) {
    const firstLine = allTitles[0].lineNumber;
    for (let i = 1; i < allTitles.length; i++) {
      if (reportedIndices.has(i)) continue; // Already reported for another reason

      const { lineNumber } = allTitles[i];
      const codeSnippet = buildSnippet(file.content, lineNumber);
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const description = `Duplicate title tag — also found on line ${firstLine}`;
      const severity = classifySeverity(FindingType.GHOST_TITLE, codeSnippet, description);

      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_TITLE,
        severity,
        appName,
        description,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_OG
// ---------------------------------------------------------------------------

/**
 * Matches <meta> tags with property="og:*" or name="twitter:*".
 * Captures the OG/Twitter property name.
 */
const OG_META_RE =
  /<meta\s+[^>]*(?:property\s*=\s*["'](og:[^"']+)["']|name\s*=\s*["'](twitter:[^"']+)["'])[^>]*>/gi;

/**
 * Extracts the content attribute value from a meta tag.
 */
const META_CONTENT_RE = /content\s*=\s*["']([^"']*)["']/i;

/**
 * High-value OG/Twitter properties worth flagging when empty.
 * Low-impact properties (og:locale, og:site_name, fb:app_id, twitter:site,
 * twitter:creator) are intentionally excluded to avoid false positives.
 */
const HIGH_VALUE_OG_PROPERTIES = new Set([
  "og:title",
  "og:description",
  "og:image",
  "og:url",
  "og:type",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "twitter:card",
]);

/**
 * Known safe Liquid variables that legitimately appear inside stock-theme
 * Open Graph / Twitter meta tags. Mirrors Shopify's free reference themes
 * (Dawn, Sense, Refresh, Craft, Spotlight), whose shared `meta-tags.liquid`
 * computes local `og_*` assigns and renders native objects + `page_image`.
 *
 * Reference (Dawn snippets/meta-tags.liquid):
 *   assign og_title = page_title | default: shop.name
 *   assign og_url = canonical_url | default: request.origin
 *   assign og_description = page_description | default: shop.description ...
 *   <meta property="og:url" content="{{ og_url }}">
 *   <meta property="og:image" content="http:{{ page_image | image_url }}">
 *   <meta property="og:image:width" content="{{ page_image.width }}">
 *   <meta property="og:price:amount" content="{{ product.price | ... }}">
 *   <meta name="twitter:site" content="{{ settings.social_twitter_link | ... }}">
 */
const SAFE_OG_VARS_RE = buildSafeVarRe([
  // Per-page SEO globals Shopify injects on every request
  "page_title",
  "page_description",
  "page_image(?:\\.\\w+)*", // page_image, page_image.width, page_image.height
  "canonical_url",
  "current_tags",
  "current_page",
  "template",
  "content_for_\\w+",
  // Local assigns computed in stock meta-tags.liquid
  "og_title",
  "og_url",
  "og_type",
  "og_description",
  // Native Shopify objects (any property): shop.name, product.featured_image, ...
  ...SHOPIFY_GLOBAL_OBJECTS,
]);

/**
 * OG-specific safe filter patterns: a `{{ ... }}` expression whose value flows
 * through one of these filters is native theme output and must not be flagged,
 * even when the leading variable is not in SAFE_OG_VARS_RE.
 *
 * The translation (`t`/`translate`) and `default` filters are critical: stock
 * themes localize meta text and always supply a fallback, so the rendered value
 * is never empty/broken — the exact failure mode this detector targets.
 *
 * Note on over-correction: only filters with no useful argument-less abuse are
 * listed, and the trailing `\b` stops short alternatives (e.g. `t`) from
 * matching inside an unrelated app filter name (e.g. `| toxicapp_meta`).
 */
const SAFE_OG_FILTER_RE =
  /\|\s*(?:img_url|img_tag|image_url|asset_url|asset_img_url|strip_html|escape|truncate|truncatewords|t|translate|default|money|money_with_currency|money_without_currency)\b/;

/**
 * Detect orphaned Open Graph and Twitter Card meta tags left by social/SEO apps.
 *
 * Trigger conditions:
 *   1. Empty or whitespace-only content on high-value OG/Twitter properties
 *   2. Unresolved Liquid variables in content (excluding safe Shopify vars)
 *   3. App-attributed OG tags via identifyAppFromCode()
 *
 * False positive boundaries:
 *   - Skips native Shopify OG patterns using safe variables
 *   - Skips OG tags inside Liquid conditionals or comments
 *   - Skips low-impact empty properties (og:locale, og:site_name, etc.)
 *   - Does NOT re-detect duplicates (handled by DUPLICATE_META)
 */
export function detectGhostOg(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const contentLines = file.content.split("\n");

  // Build a set of line numbers inside Liquid comment blocks
  const commentedLines = new Set<number>();
  let insideComment = false;
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (/\{%-?\s*comment\s*-?%\}/.test(line)) insideComment = true;
    if (insideComment) commentedLines.add(i + 1); // 1-indexed
    if (/\{%-?\s*endcomment\s*-?%\}/.test(line)) insideComment = false;
  }

  let match: RegExpExecArray | null;
  OG_META_RE.lastIndex = 0;

  while ((match = OG_META_RE.exec(file.content)) !== null) {
    // Group 1 captures og:* via property, group 2 captures twitter:* via name
    const property = match[1] ?? match[2];
    if (!property) continue;

    const matchLineNumber = lineNumberAtOffset(file.content, match.index);

    // Skip OG tags inside Liquid comment blocks
    if (commentedLines.has(matchLineNumber)) continue;

    const matchLine = contentLines[matchLineNumber - 1] ?? "";

    // Skip OG tags inside Liquid conditionals
    if (LIQUID_CONDITIONAL_RE.test(matchLine)) continue;

    const fullTag = match[0];
    const contentMatch = META_CONTENT_RE.exec(fullTag);
    const contentValue = contentMatch ? contentMatch[1] : "";

    const codeSnippet = buildSnippet(file.content, matchLineNumber);

    // Check 1: Empty or whitespace-only content on high-value properties
    if (/^\s*$/.test(contentValue) && HIGH_VALUE_OG_PROPERTIES.has(property)) {
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      const description = `Empty ${property} meta tag — social platforms will use fallback or show nothing`;
      const severity = classifySeverity(FindingType.GHOST_OG, codeSnippet, description);
      findings.push({
        filename: file.filename,
        lineNumber: matchLineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_OG,
        severity,
        appName,
        description,
      });
      continue;
    }

    // Check 2: Unresolved Liquid variables in content
    if (LIQUID_VAR_RE.test(contentValue)) {
      const allVars = contentValue.match(/\{\{[^}]*\}\}/g) ?? [];
      const hasUnsafeVar = allVars.some(
        (v) => !SAFE_OG_VARS_RE.test(v) && !SAFE_OG_FILTER_RE.test(v),
      );

      if (hasUnsafeVar) {
        const appName = identifyAppFromCode(codeSnippet) ?? undefined;
        const description = `Unresolved Liquid variable in ${property} content`;
        const severity = classifySeverity(FindingType.GHOST_OG, codeSnippet, description);
        findings.push({
          filename: file.filename,
          lineNumber: matchLineNumber,
          codeSnippet,
          findingType: FindingType.GHOST_OG,
          severity,
          appName,
          description,
        });
        continue;
      }
    }

    // Check 3: App-attributed OG tag (even if content looks valid)
    const appName = identifyAppFromCode(codeSnippet) ?? undefined;
    if (appName) {
      const description = `App-attributed ${property} meta tag from ${appName}`;
      const severity = classifySeverity(FindingType.GHOST_OG, codeSnippet, description);
      findings.push({
        filename: file.filename,
        lineNumber: matchLineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_OG,
        severity,
        appName,
        description,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_PRECONNECT
// ---------------------------------------------------------------------------

/**
 * Matches <link rel="preconnect|dns-prefetch|preload" href="..."> and the
 * reversed attribute order (href before rel).
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const PRECONNECT_RE =
  /<link[^>]+rel\s*=\s*["'](preconnect|dns-prefetch|preload)["'][^>]+href\s*=\s*["']([^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["'](preconnect|dns-prefetch|preload)["'][^>]*>/gi;

/**
 * Shopify-owned domains that should never be flagged as ghost preconnect hints.
 */
const SHOPIFY_DOMAINS = ["cdn.shopify.com", "cdn.shopifycdn.net", "monorail-edge.shopifysvc.com"];

/**
 * Major shared CDNs commonly used by themes directly — not app-specific.
 */
const SHARED_CDN_DOMAINS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
];

/**
 * Returns true if the given hostname matches a Shopify-owned domain or
 * a *.myshopify.com subdomain.
 */
function isShopifyDomain(hostname: string): boolean {
  if (SHOPIFY_DOMAINS.includes(hostname)) return true;
  if (hostname.endsWith(".myshopify.com")) return true;
  return false;
}

/**
 * Returns true if the given hostname matches a major shared CDN.
 */
function isSharedCdnDomain(hostname: string): boolean {
  return SHARED_CDN_DOMAINS.includes(hostname);
}

/**
 * Detect orphaned <link rel="preconnect|dns-prefetch|preload"> hints pointing
 * to known app CDN domains. After an app is uninstalled, these waste browser
 * connection slots on defunct domains.
 *
 * Detection rules:
 *   1. Match <link rel="preconnect|dns-prefetch|preload" href="..."> tags
 *   2. Extract the domain from the href
 *   3. Cross-reference against cdnDomains from APP_SIGNATURES
 *   4. Also use identifyAppFromCode() on surrounding snippet for attribution
 *
 * False positive boundaries:
 *   - Skips Shopify-owned domains (cdn.shopify.com, cdn.shopifycdn.net, etc.)
 *   - Skips major shared CDNs (Google Fonts, cdnjs, jsdelivr)
 *   - Skips lines inside Liquid conditionals or comment blocks
 *   - Skips unknown domains not in app signatures
 */
export function detectGhostPreconnect(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Precompute which line numbers to skip (inside comment blocks or on
  // conditional lines) so we can run the regex against the full file content
  // and still honour the same false-positive boundaries as before.
  // Comment-line tracking is delegated to the shared helper; conditional-line
  // tracking differs from detectDuplicateMetaTags (flat line skip vs depth
  // counter) so it stays inline here.
  const skipLines = buildCommentSkipLines(file.content);
  for (const { lineNumber, text } of lines(file.content)) {
    if (LIQUID_CONDITIONAL_RE.test(text)) skipLines.add(lineNumber);
  }

  // Run against full file content so multi-line <link> tags (e.g. from
  // Prettier-formatted theme files) are matched. lineNumberAtOffset maps each
  // match offset back to a 1-based line number for skip-set checking.
  let match: RegExpExecArray | null;
  PRECONNECT_RE.lastIndex = 0;

  while ((match = PRECONNECT_RE.exec(file.content)) !== null) {
    const lineNumber = lineNumberAtOffset(file.content, match.index);
    if (skipLines.has(lineNumber)) continue;

    // Group 2 captures href when rel comes first; group 3 when href comes first.
    const href = match[2] ?? match[3];
    if (!href) continue;

    const hostname = hostnameFromUrl(href);
    if (!hostname) continue;

    // Skip Shopify-owned domains
    if (isShopifyDomain(hostname)) continue;

    // Skip major shared CDNs
    if (isSharedCdnDomain(hostname)) continue;

    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Cross-reference against known app CDN domains
    const appName = identifyAppFromUrl(href) ?? identifyAppFromCode(codeSnippet) ?? undefined;

    // Only flag if we can attribute to a known app
    if (!appName) continue;

    const relType = match[1] ?? match[4]; // "preconnect", "dns-prefetch", or "preload"
    const severity = classifySeverity(FindingType.GHOST_PRECONNECT, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_PRECONNECT,
      severity,
      appName,
      description: `Orphaned ${relType} hint to ${appName} CDN (${hostname})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_FONT
// ---------------------------------------------------------------------------

/**
 * Matches @font-face declarations in inline styles.
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const FONT_FACE_RE = /@font-face\s*\{[^}]*font-family\s*:\s*["']?([^"';}\n]+)["']?/gi;

/**
 * Matches <link> tags loading from font services (Google Fonts, etc.).
 * Handles both attribute orderings (href before rel and rel before href).
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const FONT_LINK_RE =
  /<link[^>]+href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["'](https?:\/\/[^"']*font[^"']*)["'][^>]*>/gi;

/**
 * Detect orphaned font declarations left by uninstalled apps.
 *
 * Detection rules:
 *   1. @font-face declarations in inline <style> blocks whose surrounding
 *      code context can be attributed to a known app
 *   2. <link> tags loading Google Fonts or other font service URLs that can
 *      be attributed to a known app via surrounding code context
 *
 * False positive boundaries:
 *   - Only flags when app-attributed (no unknown font flagging)
 *   - Skips lines inside Liquid conditionals or comment blocks
 */
export function detectGhostFont(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  let insideComment = false;

  for (const { lineNumber, text } of lines(file.content)) {
    // Track Liquid comment blocks
    if (/\{%-?\s*comment\s*-?%\}/.test(text)) insideComment = true;
    if (/\{%-?\s*endcomment\s*-?%\}/.test(text)) {
      insideComment = false;
      continue;
    }
    if (insideComment) continue;

    // Skip lines with Liquid conditionals — these are theme-native logic
    if (LIQUID_CONDITIONAL_RE.test(text)) continue;

    // Check for @font-face declarations
    let match: RegExpExecArray | null;
    FONT_FACE_RE.lastIndex = 0;

    while ((match = FONT_FACE_RE.exec(text)) !== null) {
      const codeSnippet = buildSnippet(file.content, lineNumber);

      // Only flag if we can attribute to a known app
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      if (!appName) continue;

      const fontFamily = match[1]?.trim();
      const severity = classifySeverity(FindingType.GHOST_FONT, codeSnippet);

      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_FONT,
        severity,
        appName,
        description: `Orphaned @font-face declaration for "${fontFamily}" from ${appName}`,
      });
    }

    // Check for font service <link> tags
    FONT_LINK_RE.lastIndex = 0;

    while ((match = FONT_LINK_RE.exec(text)) !== null) {
      const href = match[1] ?? match[2];
      if (!href) continue;

      const codeSnippet = buildSnippet(file.content, lineNumber);

      // Cross-reference against known app CDN domains + code context
      const appName = identifyAppFromUrl(href) ?? identifyAppFromCode(codeSnippet) ?? undefined;
      if (!appName) continue;

      const severity = classifySeverity(FindingType.GHOST_FONT, codeSnippet);

      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet,
        findingType: FindingType.GHOST_FONT,
        severity,
        appName,
        description: `Orphaned font link to ${appName} (${href})`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_AJAX
// ---------------------------------------------------------------------------

/**
 * Matches fetch() calls with URL strings.
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const FETCH_RE = /fetch\s*\(\s*["'](https?:\/\/[^"']+)["']/gi;

/**
 * Matches jQuery AJAX patterns: $.ajax({url: "..."}), $.get("..."), $.post("...")
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const JQUERY_AJAX_RE =
  /\$\s*\.\s*(?:ajax|get|post|getJSON)\s*\(\s*(?:\{\s*url\s*:\s*)?["'](https?:\/\/[^"']+)["']/gi;

/**
 * Matches XMLHttpRequest .open() calls with URL strings.
 * IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0
 * before each use.
 */
const XHR_OPEN_RE = /\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["'](https?:\/\/[^"']+)["']/gi;

/**
 * Detect orphaned AJAX/fetch calls to defunct app servers left by uninstalled apps.
 *
 * Detection rules:
 *   1. fetch("https://...") calls pointing to known app API domains
 *   2. $.ajax / $.get / $.post jQuery patterns pointing to known app domains
 *   3. XMLHttpRequest .open() calls pointing to known app domains
 *
 * False positive boundaries:
 *   - Skips Shopify-owned domains (cdn.shopify.com, etc.)
 *   - Skips lines inside Liquid conditionals or comment blocks
 *   - Only flags if the target URL can be attributed to a known app
 */
export function detectGhostAjax(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Precompute the lines to skip from a single line pass, then run each pattern
  // against the FULL file content so multi-line / prettier-wrapped calls like:
  //   fetch(
  //     "https://cdn.judge.me/api/reviews"
  //   )
  // are matched. lineNumberAtOffset maps each match offset back to a line, and a
  // match is skipped if its start line falls inside a {% comment %} block or
  // contains a Liquid conditional — preserving the prior per-line semantics.
  // The three patterns target distinct syntaxes (fetch / jQuery / XHR) so they
  // never match the same token — no double-count risk.
  const commentSkipLines = buildCommentSkipLines(file.content);
  const conditionalLines = new Set<number>();
  for (const { lineNumber, text } of lines(file.content)) {
    if (LIQUID_CONDITIONAL_RE.test(text)) conditionalLines.add(lineNumber);
  }

  // Helper to process a matched URL at a given byte offset.
  const processUrl = (url: string, offset: number, pattern: string) => {
    const lineNumber = lineNumberAtOffset(file.content, offset);
    if (commentSkipLines.has(lineNumber)) return; // inside {% comment %} block
    if (conditionalLines.has(lineNumber)) return; // theme-native conditional logic

    const hostname = hostnameFromUrl(url);
    if (!hostname) return;

    // Skip Shopify-owned domains
    if (isShopifyDomain(hostname)) return;

    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Cross-reference against known app CDN domains + code context
    const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(codeSnippet) ?? undefined;
    if (!appName) return;

    const severity = classifySeverity(FindingType.GHOST_AJAX, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_AJAX,
      severity,
      appName,
      description: `Orphaned ${pattern} call to ${appName} API (${hostname})`,
    });
  };

  let match: RegExpExecArray | null;

  // Check fetch() calls
  FETCH_RE.lastIndex = 0;
  while ((match = FETCH_RE.exec(file.content)) !== null) {
    processUrl(match[1], match.index, "fetch");
  }

  // Check jQuery AJAX patterns
  JQUERY_AJAX_RE.lastIndex = 0;
  while ((match = JQUERY_AJAX_RE.exec(file.content)) !== null) {
    processUrl(match[1], match.index, "jQuery AJAX");
  }

  // Check XMLHttpRequest .open() calls
  XHR_OPEN_RE.lastIndex = 0;
  while ((match = XHR_OPEN_RE.exec(file.content)) !== null) {
    processUrl(match[1], match.index, "XMLHttpRequest");
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scan a set of theme files for ghost code from uninstalled apps.
 *
 * Performs two passes over the provided files:
 *
 *   Pass 1 — per-file pattern detection:
 *     Processes only scannable Liquid files (templates/, sections/, snippets/,
 *     layout/) and emits GHOST_SCRIPT, GHOST_STYLE, GHOST_SNIPPET,
 *     GHOST_SECTION, GHOST_HREFLANG, DUPLICATE_META, GHOST_JSON_LD,
 *     JSON_LD_CONFLICT, GHOST_TEXT, GHOST_PIXEL, GHOST_ROBOTS,
 *     GHOST_CANONICAL, GHOST_TITLE, GHOST_OG, GHOST_PRECONNECT, GHOST_FONT,
 *     and GHOST_AJAX findings.
 *
 *   Pass 2 — cross-file orphan detection:
 *     Runs the file reference analyzer over all Liquid files (not just
 *     scannable ones) to find snippets that are never referenced by any
 *     template, section, layout, or other snippet.  Emits ORPHAN_ASSET
 *     findings for each unreferenced snippet file.
 *
 *   Pass 3 — settings data drift detection:
 *     Parses config/settings_data.json and checks each section reference
 *     against the theme's actual section files.  Emits SETTINGS_DRIFT
 *     findings for stale references to missing section types.
 *
 *   Pass 4 — page builder layout detection:
 *     Scans layout/ directory for orphaned layout files left by page builder
 *     apps (PageFly, GemPages, Shogun, etc.).  Emits GHOST_LAYOUT findings
 *     for files that match known app patterns or the theme.*.liquid naming
 *     convention.
 *
 * Returns all findings (all passes) ready for createFindings().
 */
export function scanThemeFiles(files: ThemeFile[]): ScanResult {
  const findings: CreateFindingInput[] = [];
  const unknownScripts: UnknownExternalResource[] = [];

  // Pass 1: per-file ghost code detection
  for (const file of files) {
    if (!isScannableFile(file.filename)) continue;

    findings.push(...detectGhostScripts(file));
    findings.push(...detectGhostStyles(file));
    findings.push(...detectGhostSnippets(file));
    findings.push(...detectGhostSections(file));
    findings.push(...detectGhostHrefLang(file));
    findings.push(...detectDuplicateMetaTags(file));
    findings.push(...detectGhostJsonLd(file));
    findings.push(...detectJsonLdConflicts(file));
    findings.push(...detectGhostTextFragments(file));
    findings.push(...detectGhostPixels(file));
    findings.push(...detectGhostRobots(file));
    findings.push(...detectGhostCanonical(file));
    findings.push(...detectGhostTitle(file));
    findings.push(...detectGhostOg(file));
    findings.push(...detectGhostPreconnect(file));
    findings.push(...detectGhostFont(file));
    findings.push(...detectGhostAjax(file));

    // Collect unrecognized external resources
    unknownScripts.push(...collectUnknownScripts(file));
    unknownScripts.push(...collectUnknownStylesheets(file));
  }

  // Pass 2: cross-file orphan snippet detection
  // analyzeFileReferences expects { key, value } — adapt from { filename, content }.
  const fileReferenceInput = files.map((f) => ({
    key: f.filename,
    value: f.content,
  }));

  const orphans = analyzeFileReferences(fileReferenceInput);

  for (const orphan of orphans) {
    // Extract the bare snippet name from the filename (e.g. "snippets/klaviyo-form.liquid" → "klaviyo-form")
    // and attempt app attribution. Stock theme snippets (icon-cart, icon-zoom, etc.)
    // won't match any known app and are filtered out — they aren't ghost code.
    const baseName = orphan.filename.replace(/^snippets\//, "").replace(/\.liquid$/, "");
    const appName = identifyAppFromSnippetName(baseName);
    if (!appName) continue;

    const severity = classifySeverity(FindingType.ORPHAN_ASSET, "");
    findings.push({
      filename: orphan.filename,
      lineNumber: 1,
      codeSnippet: "",
      findingType: FindingType.ORPHAN_ASSET,
      severity,
      appName,
      description: orphan.reason,
    });
  }

  // Pass 3: settings data drift detection
  findings.push(...detectSettingsDrift(files));

  // Pass 4: page builder layout detection
  findings.push(...detectGhostLayouts(files));

  return { findings, unknownScripts };
}
