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
 *   DUPLICATE_LIBRARY — cross-file: the same public-CDN JS library loaded at two
 *                    or more distinct MAJOR versions across the theme (e.g.
 *                    Swiper v8 in one file and v11 in another)
 */

import { FindingType, Severity } from "@prisma/client";

import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromHrefLang,
  identifyAppFromJsonLd,
  identifyAppFromTextFragment,
  resolveAttribution,
} from "./app-lookup.server";
import { analyzeFileReferences } from "./file-reference-analyzer.server";
import { classifySeverity } from "./severity-classifier.server";
import { AI_CRAWLER_USER_AGENTS } from "../data/ai-crawlers.server";
import { matchMaliciousDomain } from "../data/malicious-domains.server";
import { isBenignLibrary, parseLibrary } from "../lib/library-matcher.server";
import { MAX_FINDINGS_PER_FILE_PER_TYPE } from "../lib/scan-limits";
import { hostnameFromUrl } from "../lib/url.server";
import type { CreateFindingInput } from "../models/finding.server";
import type { ThirdPartyDomainRef } from "../models/scan-domain.server";

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

/** A scannable file skipped because it exceeded the per-file size cap. */
export type SkippedFile = { filename: string; size: number };

/**
 * Mutable counter threaded through the unknown-resource collectors so the number
 * of benign public-CDN libraries / web fonts they DROP (via isBenignLibrary,
 * gc-tus A1) can be tallied for scan-time telemetry WITHOUT a second pass over
 * the file. The collectors' return value (the emitted unknowns) is unchanged; the
 * count rides alongside so callers that don't care (e.g. unit tests) can ignore
 * it by not passing a counter.
 */
export type BenignSkipCounter = { count: number };

/**
 * A compact record of an UNSIGNED static Product JSON-LD block, extracted during
 * the worker theme scan so the (much later, scope-gated) live-price audit can
 * correlate it against the LIVE product price without re-shipping theme file
 * contents between Inngest steps (gc-47c.10).
 *
 * Why this exists: the worker scan returns only COUNTS from its Inngest step
 * (theme file bodies blow past the 4MB step-output limit), yet the live-price
 * audit needs each static block's price/availability/identity to compare. This
 * list is tiny (a handful of products per theme) so it CAN cross the step
 * boundary. Each entry is self-contained — it carries a pre-built codeSnippet so
 * the audit step, which no longer has the file body, can still emit a normal
 * finding.
 *
 * Only blocks with a resolvable identity (handle or sku) AND something to compare
 * (a price or an availability) are recorded; anything ambiguous is dropped here
 * so it can never become a false positive downstream.
 */
export type StaticProductCandidate = {
  filename: string;
  lineNumber: number;
  /** Pre-built code snippet (bounded, ~3 lines) so the audit step can emit a finding without the file body. */
  codeSnippet: string;
  /** Product handle parsed from a `/products/{handle}` url, lower-cased. */
  handle?: string;
  /** Variant SKU, when the block carries one (identifies a specific variant). */
  sku?: string;
  /** Static advertised price, normalized to a trimmed string (number-or-string). */
  staticPrice?: string;
  /** Static price currency (ISO code), when present. */
  staticPriceCurrency?: string;
  /** Static availability with the schema.org URL prefix stripped (e.g. "InStock"). */
  staticAvailability?: string;
};

export type ScanResult = {
  findings: CreateFindingInput[];
  unknownScripts: UnknownExternalResource[];
  // Scannable files skipped by the per-file detectors because their content
  // exceeded MAX_SCANNABLE_FILE_BYTES. Surfaced so the caller can log the skip
  // (no silent drops). Optional for backward compatibility with ScanResult
  // literals in tests; scanThemeFiles always populates it (possibly empty).
  skippedFiles?: SkippedFile[];
  // Compact list of unsigned static Product JSON-LD candidates for the live-price
  // audit (gc-47c.10). Optional for backward compatibility with ScanResult
  // literals in tests; scanThemeFiles always populates it (possibly empty).
  staticProductCandidates?: StaticProductCandidate[];
  // Count of benign public-CDN libraries / web fonts the unknown-resource
  // collectors suppressed (gc-tus A1). Surfaced so the worker can emit an ops
  // signal (no silent drop) — NOT persisted to a DB column. Optional for
  // backward compatibility with ScanResult literals in tests; scanThemeFiles
  // always populates it (possibly 0).
  benignLibrarySkips?: number;
  // Every non-Shopify third-party host the theme references, deduped per host
  // across every surface (script/stylesheet/preconnect/dns_prefetch/font/ajax),
  // classified matched-app / benign-lib / neither (flywheel candidate). Persisted
  // as ScanDomain rows (Feature 1 of the scan-observability spec). Small (bounded
  // by distinct-host count) so it safely crosses the Inngest step boundary.
  // Optional for backward compatibility with ScanResult literals in tests;
  // scanThemeFiles always populates it (possibly empty).
  thirdPartyDomains?: ThirdPartyDomainRef[];
  // Per finding type: how many files hit MAX_FINDINGS_PER_FILE_PER_TYPE this
  // scan (gc-ypk), so a cap hit is observable (scan_signal + logger.warn), never
  // silent. Telemetry ONLY: it is NOT a skipped category. Empty on real themes.
  // Optional for backward compatibility with ScanResult literals in tests;
  // scanThemeFiles always populates it (possibly empty).
  findingCapHits?: Partial<Record<FindingType, number>>;
};

// ---------------------------------------------------------------------------
// File-size guard + ReDoS-safe tag extraction
// ---------------------------------------------------------------------------

/**
 * Maximum size (in characters) of a single scannable file that the per-file
 * regex detectors will process (gc-06e.2).
 *
 * Real Shopify theme Liquid files (templates/, sections/, snippets/, layout/,
 * blocks/) are well under this: Dawn's largest Liquid file is ~70 KB, and even
 * page-builder apps rarely emit a single Liquid file past a few hundred KB.
 * 1 MB is a deliberately generous ceiling — large enough that no legitimate
 * theme asset is ever dropped, small enough to bound worst-case detector cost
 * on a pathological/oversized file. Files above the cap are skipped for the
 * per-file detectors and reported in ScanResult.skippedFiles (no silent drop).
 */
export const MAX_SCANNABLE_FILE_BYTES = 1_000_000;

/**
 * Lowercase one UTF-16 code unit for comparison against a lowercase ASCII
 * character, or -1 if it can never equal one. Besides A-Z, the only code unit
 * whose toLowerCase() is a single ASCII char is U+212A KELVIN SIGN ("k");
 * tests/services/scan-engine-casefold.test.ts pins that exhaustively.
 */
function lowerForAscii(code: number): number {
  if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
  return code === 0x212a ? 107 : -1;
}

/**
 * `haystack.toLowerCase().indexOf(lowerNeedle, from)`, but the result is an
 * offset in `haystack` itself (gc-8jd). toLowerCase is not length-preserving:
 * U+0130 (İ) becomes "i" + U+0307 (the only such code point), so offsets taken
 * from the lowercased copy drift one unit per İ and slicing the original with
 * them drops or mis-cuts every later match. Comparing unit by unit keeps the
 * offsets exact and matches the old result on any input without an İ (İ
 * itself never equals an ASCII char, just as "i̇" never matched before).
 *
 * `lowerNeedle` must be lowercase ASCII (tag prefixes, domain names). Linear
 * in haystack length times needle length; needles here are short constants.
 */
export function indexOfIgnoreCase(haystack: string, lowerNeedle: string, from = 0): number {
  const last = haystack.length - lowerNeedle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < lowerNeedle.length; j++) {
      if (lowerForAscii(haystack.charCodeAt(i + j)) !== lowerNeedle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Extract complete HTML tags (`<link ...>`, `<meta ...>`, `<script ...>`) from
 * `content` in a single linear left-to-right pass, returning each tag's text and
 * its byte offset in `content`.
 *
 * This is the ReDoS-safe substitute for scanning the whole file with a
 * `<tag[^>]+ ... [^>]* ...>` regex. Those adjacent `[^>]` quantifiers force the
 * engine to re-scan a tag's interior from every `<tag` start position — O(n^2),
 * effectively a process hang, on pathological input such as thousands of
 * unterminated `<link` fragments. Locating each tag with indexOf and slicing to
 * the next `>` is O(n) and never backtracks. Detectors then match their
 * attribute patterns against each tag with execTagPattern, which is linear
 * even when one tag is huge (running the regexes on the tag text was not:
 * gc-t7x).
 *
 * Semantics match the previous whole-content regexes exactly:
 *   - The prefix match is case-insensitive and NOT word-boundary anchored, so a
 *     `<link[^>]+` pattern and `<linkfoo ...>` are both captured (as before).
 *   - A `<tag` with no following `>` yields no tag — the old regex could not
 *     complete a match without its trailing `[^>]*>` either.
 *   - Tags are non-overlapping and left-to-right, mirroring the global regex's
 *     lastIndex advancement, so per-tag matching reproduces the original set of
 *     matches and their offsets. (The one theoretical divergence — a raw `>`
 *     inside a quoted attribute value — does not occur in real theme markup and
 *     is not something the old `[^>]` structural quantifiers tolerated either.)
 *
 * Exported for tests (the native/fallback search paths must agree).
 */
export function extractTags(
  content: string,
  tagPrefix: string,
): Array<{ tag: string; offset: number }> {
  const tags: Array<{ tag: string; offset: number }> = [];
  const needle = tagPrefix.toLowerCase();
  // Fast path: when lowercasing preserves the length (only U+0130 changes it),
  // every offset in the lowercased copy is an offset in `content`, so native
  // indexOf is exact. It also agrees with indexOfIgnoreCase on the one non-A-Z
  // unit that lowercases to ASCII (U+212A Kelvin -> "k"). Otherwise fall back
  // to the unit-wise scan (gc-8jd).
  const lower = content.toLowerCase();
  const lengthPreserved = lower.length === content.length;
  let from = 0;
  for (;;) {
    const start = lengthPreserved
      ? lower.indexOf(needle, from)
      : indexOfIgnoreCase(content, needle, from);
    if (start === -1) break;
    const close = content.indexOf(">", start + needle.length);
    if (close === -1) break; // unterminated tag — no complete match possible
    tags.push({ tag: content.slice(start, close + 1), offset: start });
    from = close + 1;
  }
  return tags;
}

// Attribute sub-pattern pieces shared by the tag patterns below.
const ATTR_EQ = "\\s*=\\s*";
const QUOTED_VALUE = `["']([^"']+)["']`;
const SRC_URL_ATTR = `src${ATTR_EQ}["']((https?:)?\\/\\/[^"']+)["']`;
const HREF_URL_ATTR = `href${ATTR_EQ}["']((https?:)?\\/\\/[^"']+)["']`;

/** A gap between tag-pattern parts: `[^>]+`, `[^>]*`, or (first gap only) `\s+[^>]*`. */
type TagGap = "[^>]+" | "[^>]*" | "\\s+[^>]*";

/**
 * One alternative of a tag attribute pattern, i.e. the regex
 *   tag + steps.map((s) => s.gap + s.attr).join("") + "[^>]*>"
 * with flags "gi". Every `attr` must match in exactly one way (one length) at a
 * given position and never span a `>`, which holds for the `name\s*=\s*"..."`
 * shaped attribute sub-patterns used here.
 */
interface TagPatternAlt {
  tag: "<link" | "<meta" | "<script";
  steps: Array<{ gap: TagGap; attr: string }>;
}

/** Compiled form of a tag attribute pattern (alternatives tried in order). */
interface TagPattern {
  alts: Array<{
    /** First position the alternative can start at: the tag (plus whitespace). */
    start: RegExp;
    tagLength: number;
    steps: Array<{ gapMin: number; find: RegExp; at: RegExp; groups: number }>;
  }>;
  source: string;
}

function tagPattern(alts: TagPatternAlt[]): TagPattern {
  // execTagPattern relies on every alternative starting at the same position.
  const opening = (alt: TagPatternAlt) => alt.tag + alt.steps[0].gap;
  if (alts.some((alt) => opening(alt) !== opening(alts[0]))) {
    throw new Error("tagPattern alternatives must share their tag and first gap");
  }
  return {
    alts: alts.map((alt) => ({
      start: new RegExp(alt.steps[0].gap === "\\s+[^>]*" ? `${alt.tag}(?=\\s)` : alt.tag, "i"),
      tagLength: alt.tag.length,
      steps: alt.steps.map(({ gap, attr }) => ({
        gapMin: gap === "[^>]*" ? 0 : 1,
        find: new RegExp(attr, "gi"),
        at: new RegExp(attr, "iy"),
        groups: new RegExp(`${attr}|`).exec("")!.length - 1,
      })),
    })),
    source: alts
      .map((alt) => alt.tag + alt.steps.map((s) => s.gap + s.attr).join("") + "[^>]*>")
      .join("|"),
  };
}

/**
 * Exactly what `new RegExp(pattern.source, "gi").exec(tag)` returns for a tag
 * from extractTags, in linear time (gc-t7x). Such a tag's only `>` is its last
 * char, so every `[^>]` gap spans anything inside it. The regex backtracks
 * quadratically there: from every inner `<link` start, and for each candidate
 * position of an early attribute it rescans for the later ones (a single
 * 1 MB `<link rel="stylesheet" ...` tag took minutes).
 *
 * Why this evaluation is identical:
 *   - Greedy gaps make the regex place each attribute at its RIGHTMOST
 *     workable position, working back from the end: the last attribute at its
 *     last match (ending before the `>`), each earlier one at its last match
 *     that ends early enough for the next attribute after the gap's minimum.
 *     Those positions do not depend on where the match starts.
 *   - A later start only raises the lowest allowed first-attribute position,
 *     so if the earliest start (the tag itself, or for `\s+` the first
 *     `<meta` + whitespace) fails, every start fails; if it succeeds, the
 *     regex matches there, running to the final `>`.
 *   - Alternatives share their opening, so the first one that succeeds wins.
 * Each attribute's candidates come from one forward scan (restarting one char
 * after each hit so overlapping candidates are seen), so the work is linear.
 */
export function execTagPattern(tag: string, pattern: TagPattern): RegExpExecArray | null {
  const groups: Array<string | undefined> = [];
  let matched: { start: number; captures: Array<string | undefined> } | null = null;

  for (const alt of pattern.alts) {
    const altGroups = alt.steps.reduce((n, s) => n + s.groups, 0);
    if (matched !== null) {
      groups.push(...new Array<undefined>(altGroups));
      continue;
    }

    // Earliest start of this alternative.
    let start = alt.start.exec(tag)?.index ?? -1;

    // Place attributes right to left at their rightmost workable positions.
    const positions: number[] = [];
    let maxEnd = tag.length - 1; // the last attribute must end before the `>`
    for (let i = alt.steps.length - 1; i >= 0 && start !== -1; i--) {
      const step = alt.steps[i];
      let best = -1;
      step.find.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = step.find.exec(tag)) !== null) {
        if (hit.index + hit[0].length <= maxEnd) best = hit.index;
        step.find.lastIndex = hit.index + 1;
      }
      if (best === -1) {
        start = -1;
        break;
      }
      positions[i] = best;
      maxEnd = best - step.gapMin;
    }
    const firstAllowed = start + alt.tagLength + alt.steps[0].gapMin;
    if (start === -1 || positions[0] < firstAllowed) {
      groups.push(...new Array<undefined>(altGroups));
      continue;
    }

    const captures: Array<string | undefined> = [];
    alt.steps.forEach((step, i) => {
      step.at.lastIndex = positions[i];
      captures.push(...step.at.exec(tag)!.slice(1));
    });
    matched = { start, captures };
    groups.push(...captures);
  }

  if (matched === null) return null;
  return Object.assign([tag.slice(matched.start), ...groups] as string[], {
    index: matched.start,
    input: tag,
    groups: undefined,
  }) as RegExpExecArray;
}

/**
 * Linear replacement for a whole-content `/OPEN[^>]*>([\s\S]*?)CLOSE/gi` scan
 * (gc-t7x), e.g. `<title ...>inner</title>`. Returns each block's start offset
 * and inner text, in the same order and with the same values as that regex.
 *
 * The regex is quadratic when blocks are unterminated: from EVERY `OPEN` start
 * it rescans to EOF looking for `>` or `CLOSE` (1 MB of `<title>` took ~40s,
 * past the scan worker timeout). Here each attempt is resolved with forward
 * searches that never revisit text:
 *   - `openRe` must match its prefix in exactly one way (a literal such as
 *     `<title`, or tokens separated by `\s` runs that are followed by a
 *     non-space literal), so the regex's `[^>]*>` can only end at the first `>`
 *     after the prefix and its lazy body only at the first `CLOSE` after that.
 *   - If that `>` or `CLOSE` is missing, every later `OPEN` fails too (its `>`
 *     is the same one or later, and so is its `CLOSE`), so the regex could not
 *     match again: stop.
 *   - After a match, scanning resumes after `CLOSE`, exactly like the regex's
 *     lastIndex, so the searched spans are disjoint and the total work is O(n).
 * Both regexes must carry the /g flag (lastIndex is set here before each use).
 */
function extractTagBlocks(
  content: string,
  openRe: RegExp,
  closeRe: RegExp,
): Array<{ offset: number; inner: string }> {
  const blocks: Array<{ offset: number; inner: string }> = [];
  openRe.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(content)) !== null) {
    const gt = content.indexOf(">", open.index + open[0].length);
    if (gt === -1) break;
    closeRe.lastIndex = gt + 1;
    const close = closeRe.exec(content);
    if (close === null) break;
    blocks.push({ offset: open.index, inner: content.slice(gt + 1, close.index) });
    openRe.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

/**
 * The [start, end) span of every Liquid output token in `text`: the matches of
 * /\{\{[^}]*\}\}/g, found in linear time (gc-t7x). That regex rescans to the
 * next `}` from every `{{`, so a `{{{{...` flood with no `}}` is quadratic.
 * Every `{{` before a given `}` shares that `}` as its first one, so when the
 * `}` is not followed by another `}` they all fail together and the scan skips
 * past it; with no `}` left, nothing later can match.
 */
function liquidOutputSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("{{", from);
    if (open === -1) break;
    const close = text.indexOf("}", open + 2);
    if (close === -1) break;
    if (text[close + 1] === "}") {
      spans.push([open, close + 2]);
      from = close + 2;
    } else {
      from = close + 1;
    }
  }
  return spans;
}

/** Every Liquid output token in `text`, identical to `text.match(/\{\{[^}]*\}\}/g) ?? []`. */
function liquidOutputTokens(text: string): string[] {
  return liquidOutputSpans(text).map(([start, end]) => text.slice(start, end));
}

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

/**
 * Returns true for Liquid files in directories the scan engine should process.
 * Skips assets (binary/JS/CSS files), config, and locales — these are handled
 * differently or deferred to later tickets.
 *
 * Scannable directories: templates/, sections/, snippets/, layout/, blocks/
 * (OS 2.0 / Horizon theme blocks render on the storefront like sections, so app
 * leftovers pasted into them get the full detector suite — gc-zfl).
 */
export function isScannableFile(filename: string): boolean {
  if (!filename.endsWith(".liquid")) return false;

  const SCANNABLE_PREFIXES = ["templates/", "sections/", "snippets/", "layout/", "blocks/"];
  return SCANNABLE_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

/**
 * Returns true for theme files that get ONLY the MALICIOUS_SCRIPT pass (gc-3pd):
 * places injected payloads live that the full Liquid detector suite never sees.
 *
 *   - templates/**.json, sections/**.json — Custom Liquid block code is stored as
 *     (escaped) JSON strings in JSON templates and section groups.
 *   - config/settings_data.json — theme settings can carry raw HTML/URLs.
 *   - assets/*.js, assets/*.mjs, assets/*.liquid (e.g. theme.js.liquid) — injected
 *     loaders are commonly appended to asset JS.
 *   - locales/*.json — `*_html` keys render unescaped, so they can carry markup.
 *
 * Deliberately excluded: CSS (cannot execute script; a CSS `url()` to a listed
 * host is not the skimmer/loader threat this list tracks),
 * config/settings_schema.json (developer-owned schema), and blocks/*.liquid
 * (full suite via isScannableFile since gc-zfl). Disjoint from isScannableFile
 * by construction (the only .liquid files admitted here live under assets/,
 * which is not a scannable prefix), so no file is scanned twice.
 */
export function isMaliciousScanOnlyFile(filename: string): boolean {
  if (filename === "config/settings_data.json") return true;
  if (filename.startsWith("assets/")) {
    return filename.endsWith(".js") || filename.endsWith(".mjs") || filename.endsWith(".liquid");
  }
  if (filename.startsWith("locales/")) return filename.endsWith(".json");
  return (
    (filename.startsWith("templates/") || filename.startsWith("sections/")) &&
    filename.endsWith(".json")
  );
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

// Per-file line index (single-entry cache). scanThemeFiles processes each file's
// detectors synchronously before moving on, so every lineNumberAtOffset /
// buildSnippet / lines call within a file shares one index — turning the former
// O(N) re-splits and O(offset) newline scans into O(1)/O(log N) (gc-06e.8).
let _cachedContent: string | null = null;
let _cachedLineStarts: number[] = [];
let _cachedSplitLines: string[] = [];

function lineIndexFor(content: string): { lineStarts: number[]; splitLines: string[] } {
  if (content !== _cachedContent) {
    _cachedContent = content;
    _cachedSplitLines = content.split("\n");
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    _cachedLineStarts = starts;
  }
  // Adopt this string object: after a by-value hit (a byte-identical file, e.g.
  // the same block shipped under several names) later calls with it take V8's
  // same-object fast path instead of a full character compare on every call.
  _cachedContent = content;
  return { lineStarts: _cachedLineStarts, splitLines: _cachedSplitLines };
}

/** Split file content into lines, preserving 1-based line numbers. */
function lines(content: string): Array<{ lineNumber: number; text: string }> {
  const { splitLines } = lineIndexFor(content);
  return splitLines.map((text, i) => ({ lineNumber: i + 1, text }));
}

/**
 * Build a short context snippet: the matched line plus up to one line of
 * surrounding context (capped at 300 chars) to give developers enough signal
 * without storing huge blobs.
 */
export function buildSnippet(content: string, lineNumber: number): string {
  const { splitLines } = lineIndexFor(content);
  const start = Math.max(0, lineNumber - 2); // 0-indexed, one line before
  const end = Math.min(splitLines.length, lineNumber + 1); // one line after
  // Same result as `splitLines.slice(start, end).join("\n").slice(0, 300)`, but
  // copies at most 300 chars per line: joining a long (minified, up to 1 MB)
  // line for every finding on it made many findings on one line quadratic
  // (gc-t7x). Truncating each piece to the cap cannot change the first 300
  // chars of the concatenation.
  const picked = splitLines.slice(start, end);
  let snippet = "";
  for (let i = 0; i < picked.length && snippet.length < 300; i++) {
    snippet += (i > 0 ? "\n" : "") + picked[i].slice(0, 300);
  }
  return snippet.slice(0, 300);
}

/**
 * Per-line memo of identifyAppFromCode over a line's buildSnippet (gc-ypk).
 * buildSnippet depends only on the line, so every tag on one line gets the same
 * attribution; memoizing keeps a flood of tags packed on one long line from
 * paying the (dominant) attribution cost once per tag. Create one per file.
 */
function lineAppNamer(): (lineNumber: number, codeSnippet: string) => string | undefined {
  const byLine = new Map<number, string | undefined>();
  return (lineNumber, codeSnippet) => {
    if (!byLine.has(lineNumber)) {
      byLine.set(lineNumber, identifyAppFromCode(codeSnippet) ?? undefined);
    }
    return byLine.get(lineNumber);
  };
}

/**
 * Returns a Set of 1-based line numbers that fall inside Liquid comment blocks
 * or LiquidDoc `{% doc %}` blocks. Includes the opener line, all body lines, and
 * the closing line, so callers can uniformly skip any line in the set. Doc
 * bodies (e.g. an `@example {% render 'x' %}`) never render, so they get the
 * same line-granular treatment; the two states are tracked independently so
 * the comment semantics below are unchanged.
 *
 * Approximation: skipping is line-granular, so when live code shares a line with
 * {% endcomment %} the whole line is skipped. Code BEFORE the endcomment on that
 * line is genuinely commented (correctly skipped); code AFTER it is live but gets
 * skipped too. This is the majority behavior across all comment-aware detectors —
 * they all include the endcomment line in the skip set — so it is intentional and
 * uniform rather than per-detector drift.
 *
 * Used by the comment-aware detectors (snippets, sections, hreflang, canonical,
 * title, og, preconnect, font, ajax, duplicate-meta) to avoid false positives
 * from commented-out code. Some of those detectors layer additional skip logic
 * (conditional-line skipping or depth tracking) that differs between them and
 * therefore stays inline rather than being unified here.
 */
function buildCommentSkipLines(content: string): Set<number> {
  if (content !== _commentSkipContent) {
    _commentSkipLines = computeCommentSkipLines(content);
  }
  // Adopt this string object for the same-object fast path (see lineIndexFor).
  _commentSkipContent = content;
  // A fresh copy every call: detectGhostPreconnect add()s its conditional lines
  // to the returned set, which must not leak into other detectors.
  return new Set(_commentSkipLines);
}

// Single-entry cache for buildCommentSkipLines, same pattern as lineIndexFor:
// ~11 comment-aware detectors ask for the set of the same file in a row.
let _commentSkipContent: string | null = null;
let _commentSkipLines: Set<number> = new Set();

function computeCommentSkipLines(content: string): Set<number> {
  const skipLines = new Set<number>();
  let insideComment = false;
  let insideDoc = false;
  for (const { lineNumber, text } of lines(content)) {
    if (/\{%-?\s*comment\s*-?%\}/.test(text)) insideComment = true;
    if (/\{%-?\s*doc\s*-?%\}/.test(text)) insideDoc = true;
    if (insideComment || insideDoc) skipLines.add(lineNumber);
    if (/\{%-?\s*endcomment\s*-?%\}/.test(text)) insideComment = false;
    if (/\{%-?\s*enddoc\s*-?%\}/.test(text)) insideDoc = false;
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

// Matches <script src="https://..." or <script src='//...'> (external URLs):
// /<script[^>]+src\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>/gi, evaluated on
// one extracted tag by execTagPattern (linear, gc-t7x).
const SCRIPT_SRC_TAG = tagPattern([
  { tag: "<script", steps: [{ gap: "[^>]+", attr: SRC_URL_ATTR }] },
]);

export function detectGhostScripts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Isolate each <script ...> tag first (linear, non-backtracking), then apply
  // SCRIPT_SRC_TAG to the bounded tag text. Multi-line tags like:
  //   <script
  //     src="https://static.klaviyo.com/...">
  // are still matched because a tag spans to its closing `>`. lineNumberAtOffset
  // maps the match position back to a line.
  for (const { tag, offset } of extractTags(file.content, "<script")) {
    const match = execTagPattern(tag, SCRIPT_SRC_TAG);
    if (!match) continue;

    const url = match[1];
    const contentApp = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
    // Preserve original skip: the filename override only REFINES a real content
    // match (tracker → owning app), it never manufactures a finding from the
    // filename alone. Otherwise a broad filePattern (e.g. EComposer's ecom-*)
    // would flag an unrelated external URL even when that app is still installed.
    if (!contentApp) continue;
    const resolved = resolveAttribution(contentApp, file.filename);
    if (!resolved.appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_SCRIPT, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_SCRIPT,
      severity,
      appName: resolved.appName,
      description: resolved.overriddenTracker
        ? `External script left by ${resolved.appName} (loads ${resolved.overriddenTracker})`
        : `External script from ${resolved.appName} (${url})`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_STYLE
// ---------------------------------------------------------------------------

// Matches <link ... rel="stylesheet" ... href="https://...">
// Order of attributes may vary — we capture the href value separately.
// Groups 1/2 when rel comes first, 3/4 when href comes first (see tagPattern).
const LINK_STYLESHEET_TAG = tagPattern([
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["']stylesheet["']` },
      { gap: "[^>]*", attr: HREF_URL_ATTR },
    ],
  },
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: HREF_URL_ATTR },
      { gap: "[^>]*", attr: `rel${ATTR_EQ}["']stylesheet["']` },
    ],
  },
]);

export function detectGhostStyles(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Isolate each <link ...> tag first (linear, non-backtracking), then apply
  // LINK_STYLESHEET_TAG to the bounded tag text. Multi-line tags like:
  //   <link
  //     rel="stylesheet"
  //     href="https://cdn.judge.me/...">
  // are still matched. lineNumberAtOffset maps the match position back to a line.
  for (const { tag, offset } of extractTags(file.content, "<link")) {
    const match = execTagPattern(tag, LINK_STYLESHEET_TAG);
    if (!match) continue;

    // Group 1 captures href when rel comes first; group 3 when href comes first.
    const url = match[1] ?? match[3];
    if (!url) continue;

    const contentApp = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
    // Preserve original skip: the filename override only REFINES a real content
    // match (tracker → owning app), it never manufactures a finding from the
    // filename alone. Otherwise a broad filePattern (e.g. EComposer's ecom-*)
    // would flag an unrelated external URL even when that app is still installed.
    if (!contentApp) continue;
    const resolved = resolveAttribution(contentApp, file.filename);
    if (!resolved.appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + match.index);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.GHOST_STYLE, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.GHOST_STYLE,
      severity,
      appName: resolved.appName,
      description: resolved.overriddenTracker
        ? `External stylesheet left by ${resolved.appName} (loads ${resolved.overriddenTracker})`
        : `External stylesheet from ${resolved.appName} (${url})`,
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
const HREFLANG_TAG_1 = tagPattern([
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["']alternate["']` },
      { gap: "[^>]+", attr: `hreflang${ATTR_EQ}${QUOTED_VALUE}` },
      { gap: "[^>]*", attr: `href${ATTR_EQ}${QUOTED_VALUE}` },
    ],
  },
]);
const HREFLANG_TAG_2 = tagPattern([
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["']alternate["']` },
      { gap: "[^>]+", attr: `href${ATTR_EQ}${QUOTED_VALUE}` },
      { gap: "[^>]*", attr: `hreflang${ATTR_EQ}${QUOTED_VALUE}` },
    ],
  },
]);

export function detectGhostHrefLang(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Isolate each <link ...> tag first (linear, non-backtracking), then apply the
  // hreflang patterns to the bounded tag text. Multi-line <link> tags are still
  // matched. lineNumberAtOffset maps each match offset back to a 1-based line.
  // Two passes preserve the original finding order (all pattern-1 hits, then all
  // pattern-2 hits) before the dedup filter below.
  const linkTags = extractTags(file.content, "<link");

  // Pattern 1: hreflang before href — groups: [1]=lang, [2]=href
  for (const { tag, offset } of linkTags) {
    const match = execTagPattern(tag, HREFLANG_TAG_1);
    if (!match) continue;

    const lang = match[1];
    const href = match[2];
    const appName = identifyAppFromHrefLang(href);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + match.index);
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
  for (const { tag, offset } of linkTags) {
    const match = execTagPattern(tag, HREFLANG_TAG_2);
    if (!match) continue;

    const href = match[1];
    const lang = match[2];
    const appName = identifyAppFromHrefLang(href);
    if (!appName) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + match.index);
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
  // A tag that matches both HREFLANG_TAG_1 and HREFLANG_TAG_2 (different attribute
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
const META_TAG = tagPattern([
  {
    tag: "<meta",
    steps: [{ gap: "\\s+[^>]*", attr: `(?:name|property)${ATTR_EQ}${QUOTED_VALUE}` }],
  },
]);

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

export function detectDuplicateMetaTags(
  file: ThemeFile,
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
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

    // Isolate each <meta ...> tag first (linear, non-backtracking), then apply
    // META_TAG to the bounded tag text.
    for (const { tag } of extractTags(text, "<meta")) {
      const match = execTagPattern(tag, META_TAG);
      if (!match) continue;

      const attrValue = match[1].toLowerCase();

      // Skip properties that are intentionally repeatable per the OG spec
      if (REPEATABLE_META_PROPS.has(attrValue)) continue;

      if (!occurrences.has(attrValue)) {
        occurrences.set(attrValue, []);
      }
      occurrences.get(attrValue)!.push({ lineNumber, text });
    }
  }

  // The 2nd+ occurrence of each duplicated meta tag, in emission order (grouped
  // by tag). Cheap: the per-finding cost (snippet + attribution) comes below.
  const duplicates: Array<{
    attrValue: string;
    firstLine: number;
    entry: { lineNumber: number; text: string };
  }> = [];
  for (const [attrValue, entries] of occurrences) {
    for (let i = 1; i < entries.length; i++) {
      duplicates.push({ attrValue, firstLine: entries[0].lineNumber, entry: entries[i] });
    }
  }

  // Early exit (gc-ypk): emission is grouped by tag, not line order, so when
  // over `limit` pick the first `limit` duplicates by line (stable sort, the
  // caller's cap order) and only build findings for those, in emission order.
  let selected = duplicates;
  if (duplicates.length > limit) {
    const keep = new Set(
      [...duplicates].sort((a, b) => a.entry.lineNumber - b.entry.lineNumber).slice(0, limit),
    );
    selected = duplicates.filter((d) => keep.has(d));
  }

  // Emit findings for the selected duplicates
  const appNameByLine = new Map<number, string | null>();
  for (const { attrValue, firstLine, entry } of selected) {
    const codeSnippet = buildSnippet(file.content, entry.lineNumber);
    const severity = classifySeverity(FindingType.DUPLICATE_META, codeSnippet);

    // Attempt app attribution from the full meta tag text — optional.
    // Memoized per line: entry.text is the whole line, and re-scanning a long
    // line for every duplicate on it was quadratic (gc-t7x).
    let appName = appNameByLine.get(entry.lineNumber);
    if (appName === undefined) {
      appName = identifyAppFromCode(entry.text) ?? null;
      appNameByLine.set(entry.lineNumber, appName);
    }

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

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_JSON_LD
// ---------------------------------------------------------------------------

// `<script type="application/ld+json">...</script>` delimiters for
// extractTagBlocks (linear; the old whole-content
// /<script\s+type...["'][^>]*>([\s\S]*?)<\/script>/gi scan was quadratic on
// unterminated blocks, gc-t7x). The open prefix can only match one way (each
// \s run is followed by a fixed non-space literal), as extractTagBlocks needs.
const JSON_LD_OPEN_RE = /<script\s+type\s*=\s*["']application\/ld\+json["']/gi;
const JSON_LD_CLOSE_RE = /<\/script>/gi;

/** Every `<script type="application/ld+json">` block: start offset + raw content. */
function extractJsonLdBlocks(content: string): Array<{ offset: number; inner: string }> {
  return extractTagBlocks(content, JSON_LD_OPEN_RE, JSON_LD_CLOSE_RE);
}

// Regex to detect app-only @type values that Shopify themes never inject natively.
const APP_ONLY_TYPE_RE =
  /["']@type["']\s*:\s*["'](FAQPage|AggregateRating|Review|BreadcrumbList|LocalBusiness)["']/;

// Regex to detect Liquid template tags ({{ or {%).
const LIQUID_TAG_RE = /\{\{|\{%/;

/**
 * Compute the 1-based line number where `offset` falls within `content`.
 */
export function lineNumberAtOffset(content: string, offset: number): number {
  const { lineStarts } = lineIndexFor(content);
  const target = Math.min(offset, content.length);
  // largest i with lineStarts[i] <= target; line = i + 1
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

export function detectGhostJsonLd(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { offset, inner: blockContent } of extractJsonLdBlocks(file.content)) {
    // Skip blocks containing Liquid template tags — these are native theme
    // blocks rendered by the theme engine, not orphaned static injections.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset);
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
// Detector: JSON_LD_INVALID (malformed static JSON-LD)
// ---------------------------------------------------------------------------

/**
 * Emit one JSON_LD_INVALID finding per STATIC `application/ld+json` block whose
 * raw content fails `JSON.parse`.
 *
 * Why this matters: search engines and AI answer/shopping agents discard a
 * malformed structured-data block wholesale, so any product/page relying on it
 * silently becomes invisible to those consumers — a real, silent AEO failure the
 * other JSON-LD detectors quietly skip past.
 *
 * Scope decisions (mirrors detectGhostJsonLd, which shares the block extractor):
 *   - LIQUID-TEMPLATED BLOCKS ARE EXCLUDED. A block containing Liquid (`{{`/`{%`)
 *     is rendered by the theme engine, so its RAW (pre-render) form legitimately
 *     is not valid JSON. Reuses the exact same `LIQUID_TAG_RE` predicate the
 *     existing JSON-LD detectors use — inventing a second predicate would risk
 *     the two drifting apart (a false-positive on every Liquid-driven schema).
 *   - EMPTY / WHITESPACE-ONLY BLOCKS ARE SKIPPED. An empty `<script ld+json>` has
 *     no structured data to discard, so flagging it would be noise, not signal.
 *   - Fires only when `JSON.parse` throws on the raw static block content.
 *
 * Theme-file only, NO scope gate, ALL plans — a pure static theme-file signal.
 */
export function detectInvalidJsonLd(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { offset, inner: blockContent } of extractJsonLdBlocks(file.content)) {
    // Liquid-templated blocks are rendered server-side; their raw form isn't
    // meant to be valid JSON. Same predicate as detectGhostJsonLd.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    // An empty/whitespace-only block carries no data to lose — not a defect.
    if (blockContent.trim().length === 0) continue;

    try {
      JSON.parse(blockContent);
      continue; // parses cleanly — nothing to report
    } catch {
      // Falls through to emit the finding below.
    }

    const lineNumber = lineNumberAtOffset(file.content, offset);
    const codeSnippet = buildSnippet(file.content, lineNumber);
    const severity = classifySeverity(FindingType.JSON_LD_INVALID, codeSnippet);

    findings.push({
      filename: file.filename,
      lineNumber,
      codeSnippet,
      findingType: FindingType.JSON_LD_INVALID,
      severity,
      appName: undefined,
      description:
        "JSON-LD block is not valid JSON and will be ignored by search + AI shopping agents",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: MALICIOUS_SCRIPT (known-malicious domain references)
// ---------------------------------------------------------------------------

// Any absolute or protocol-relative URL host. Deliberately NOT limited to
// `<script src>`: injected loaders often build the URL in inline JS
// (`s.src = "https://..."`) or preload it via `<link>`. Tolerates an optional
// userinfo prefix (`https://x@host`), underscores, and a trailing FQDN dot.
// Every quantifier is bounded by a disjoint delimiter, so matching stays linear
// on pathological 1MB single-line files (covered by a test).
const URL_HOST_RE = /(?:https?:)?\/\/(?:[^\s/@"'<>]+@)?([a-z0-9_-]+(?:\.[a-z0-9_-]+)+\.?)/gi;

// Liquid tokenizer/parser patterns, mirrored from the Liquid 5.8.1 gem
// (tokenizer.rb, block_body.rb). Whitespace is Ruby's ASCII-only `\s`
// ([ \t\n\v\f\r]), never JS `\s` (which also matches NBSP etc.), and tag names
// compare case-SENSITIVELY, exactly as Liquid does.
//   - text runs to the next `{{` or `{%`;
//   - LIQUID_TAG_HEAD_RE: gem `FullToken`, the tag name right after a token's
//     leading `{%` (trailing markup is ignored, so `{% endcomment x %}` closes);
//   - LIQUID_INNER_TAG_NAME_RE: gem `FullTokenPossiblyInvalid`, the name after the
//     LAST `{%` inside a token (used by raw/doc/comment-raw to find their closer).
const LIQUID_TOKEN_START_RE = /\{[{%]/g;
const LIQUID_TAG_HEAD_RE = /\{%-?[ \t\n\v\f\r]*(#|\w+)[ \t\n\v\f\r]*/y;
const LIQUID_INNER_TAG_NAME_RE = /-?[ \t\n\v\f\r]*(\w+)/y;
// Blocks whose body is literal (never parsed), closed by `end<name>`. `raw` is
// core Liquid; `javascript`/`schema`/`stylesheet` are Shopify tags whose bodies
// Shopify does not render as Liquid. Treating a body as literal never blanks
// anything, so an over-broad entry here can only fail toward reporting.
const LIQUID_LITERAL_BLOCKS = new Set(["raw", "javascript", "schema", "stylesheet"]);

// Slash encodings decoded before URL matching: any run of backslashes before `/`
// (JSON `\/`, double-escaped `\\/`, `\\\/`); before the JS/JSON unicode
// escape `u002f` (`\u002f`, `\u002F`, `\\u002f`); before the JS hex escape
// `x2f` (`\x2f`, `\x2F`, `\\x2f`); before the legacy octal escape `57` or
// `057` (sloppy-mode JS; no lookahead, because real JS reads at most two digits
// after a 4-7 lead and three after a 0-3 lead, so `\577` is "/7" and `\0057`
// is not a slash: the leading `0?` admits exactly one zero); or before the JS
// code-point escape `u{2f}`
// (`\u{2f}`, `\u{002f}` or any number of leading zeros, `\u{2F}`,
// `\\u{2f}`); or HTML entities `&#47;` / `&#x2F;`
// (optional leading zeros, optional `;`), plus the named entity `&sol;` (HTML
// matches named references case-sensitively and this one only with its `;`).
// No `i` flag, and no `(?-i:)` modifier group (a SyntaxError before Node 23):
// the case-insensitive parts use explicit classes, which also accept an
// uppercase `U` or `X`, neither of which is a real escape (real JS leaves
// `\U002f` / `\X2f` as literal text): that can only fail toward reporting, so
// it is accepted deliberately rather than special-cased away. The `(?<!\\)`
// lookbehind lets a backslash run start a match only at its first char, so a
// huge run that is not followed by a decodable form is scanned once, not once
// per backslash (linear); a `\x` or `\u` flood fails after a constant
// lookahead per position. The code-point escape's leading-zero run is an
// unbounded `0*` because real JS accepts any number of leading zeros there
// (`\u{000002f}` is "/"). That stays linear: the same lookbehind means an
// attempt can only start at the first backslash of a run, so each zero run is
// walked by at most one attempt (plus its backtrack), even when unterminated.
const ENCODED_SLASH_RE =
  /(?<!\\)\\+(?:\/|[uU]002[fF]|[xX]2[fF]|0?57|[uU]\{0*2[fF]\})|&#0*47(?![0-9]);?|&#[xX]0*2[fF](?![0-9a-fA-F]);?|&sol;/g;

// Chars on either side of the matched domain kept in the stored snippet. The
// row UI previews the first 80 chars, so the domain must start within them.
const MALICIOUS_SNIPPET_LEAD = 40;
const MALICIOUS_SNIPPET_MAX = 300;

/**
 * Offset one past the end of the Liquid variable token starting at `start`
 * (content[start..start+1] === "{{"), mirroring the gem's next_variable_token:
 * it ends at `}}` or a lone `}`, and a `{%` inside it swallows everything up to
 * the next `%}`. An unclosed variable token consumes the rest of the source.
 */
function liquidVariableTokenEnd(
  content: string,
  start: number,
  findTagClose: (from: number) => number,
): number {
  const n = content.length;
  let p = start + 2;
  if (p >= n) return n;
  let a: string | undefined = content[p++];
  for (;;) {
    while (a !== undefined && a !== "}" && a !== "{") a = p < n ? content[p++] : undefined;
    if (a === undefined || p >= n) return n;
    const b = content[p++];
    if (a === "}") return b === "}" ? p : p - 1;
    if (a === "{" && b === "%") {
      const close = findTagClose(p);
      return close < 0 ? p : close + 2;
    }
    a = b;
  }
}

/**
 * Blank out Liquid comment and doc blocks while preserving length and every
 * newline, so line numbers still map 1:1 to the original file. Unlike the shared
 * line-granular buildCommentSkipLines, live code sharing a line with a comment
 * stays visible: a minified one-line theme with any comment in it must not evade
 * detection.
 *
 * A single linear walk over Liquid's own token stream (gem 5.8.1 semantics):
 *   - a tag token runs from `{%` to the FIRST `%}`; so `{% # {% comment %}` is
 *     one inline comment, and `#` comments never open a block;
 *   - `comment` nests (depth-counted) and closes on `endcomment` with any trailing
 *     markup; a `raw` inside it is consumed up to its `endraw`;
 *   - `doc` closes on `enddoc` and ignores everything else inside it;
 *   - literal blocks (`raw`, Shopify `javascript`/`schema`/`stylesheet`) are
 *     output verbatim: never blanked, and comment tags inside them are text.
 * Only comment/doc bodies (and their tags) are blanked. Anything Liquid would
 * reject (unterminated block, `raw`/`doc` with arguments, nested `doc`, an
 * unterminated `{%`) stops the walk and leaves the rest live: fail toward
 * reporting.
 */
export function blankLiquidComments(content: string): string {
  // `%}` lookups only move forward; cache the last hit and the first miss so an
  // unterminated `{%` flood stays linear.
  let lastClose = -1;
  let noCloseFrom = Infinity;
  const findTagClose = (from: number): number => {
    if (lastClose >= from) return lastClose;
    if (from >= noCloseFrom) return -1;
    const close = content.indexOf("%}", from);
    if (close < 0) noCloseFrom = from;
    else lastClose = close;
    return close;
  };
  // Gem FullToken: tag name at the token's leading `{%` (null for `{{` tokens).
  // `markupEmpty` is true when nothing but an optional `-` follows the name.
  const tagHead = (start: number, end: number) => {
    if (content[start + 1] !== "%") return null;
    LIQUID_TAG_HEAD_RE.lastIndex = start;
    const m = LIQUID_TAG_HEAD_RE.exec(content);
    if (!m) return null;
    const rest = LIQUID_TAG_HEAD_RE.lastIndex;
    return {
      name: m[1],
      markupEmpty: rest === end - 2 || (rest === end - 3 && content[rest] === "-"),
    };
  };
  // Gem FullTokenPossiblyInvalid: name after the last `{%` (followed by a word)
  // inside a token that ends with `%}`.
  const innerTagName = (start: number, end: number): string | null => {
    if (end - start < 4 || content[end - 2] !== "%" || content[end - 1] !== "}") return null;
    for (let q = end - 3; q >= start; q--) {
      if (content[q] !== "{" || content[q + 1] !== "%") continue;
      LIQUID_INNER_TAG_NAME_RE.lastIndex = q + 2;
      const m = LIQUID_INNER_TAG_NAME_RE.exec(content);
      if (m) return m[1];
    }
    return null;
  };

  const blanked: Array<[number, number]> = [];
  let state: "live" | "literal" | "comment" | "commentRaw" | "doc" = "live";
  let literalCloser = "";
  let depth = 0;
  let blockStart = 0;
  let pos = 0;
  walk: for (;;) {
    LIQUID_TOKEN_START_RE.lastIndex = pos;
    const found = LIQUID_TOKEN_START_RE.exec(content);
    if (!found) break;
    const start = found.index;
    let end: number;
    if (content[start + 1] === "%") {
      const close = findTagClose(start + 2);
      // Unterminated `{%`: no `%}` follows, so no block can open or close.
      if (close < 0) break;
      end = close + 2;
    } else {
      end = liquidVariableTokenEnd(content, start, findTagClose);
    }
    pos = end;

    switch (state) {
      case "live": {
        const head = tagHead(start, end);
        if (!head) break;
        if (head.name === "comment") {
          state = "comment";
          depth = 1;
          blockStart = start;
        } else if (head.name === "doc") {
          if (!head.markupEmpty) break walk; // Liquid: syntax error
          state = "doc";
          blockStart = start;
        } else if (LIQUID_LITERAL_BLOCKS.has(head.name)) {
          if (head.name === "raw" && !head.markupEmpty) break walk; // Liquid: syntax error
          state = "literal";
          literalCloser = `end${head.name}`;
        }
        break;
      }
      case "literal":
        if (innerTagName(start, end) === literalCloser) state = "live";
        break;
      case "doc": {
        const name = innerTagName(start, end);
        if (name === "doc") break walk; // Liquid: nested doc is a syntax error
        if (name === "enddoc") {
          blanked.push([blockStart, end]);
          state = "live";
        }
        break;
      }
      case "commentRaw":
        if (innerTagName(start, end) === "endraw") state = "comment";
        break;
      case "comment": {
        const name = tagHead(start, end)?.name;
        if (name === "raw") state = "commentRaw";
        else if (name === "comment") depth++;
        else if (name === "endcomment" && --depth === 0) {
          blanked.push([blockStart, end]);
          state = "live";
        }
        break;
      }
    }
  }

  let out = "";
  let from = 0;
  for (const [a, b] of blanked) {
    out += content.slice(from, a) + content.slice(a, b).replace(/[^\n]/g, " ");
    from = b;
  }
  return out + content.slice(from);
}

/**
 * Emit one MALICIOUS_SCRIPT finding per (line, distinct domain) for every live
 * theme reference to a domain on the curated KNOWN_MALICIOUS_DOMAINS list.
 *
 *   - Liquid comment and doc blocks are ignored, but ONLY in `.liquid` files (incl.
 *     `assets/*.js.liquid`), the only files Liquid renders. Elsewhere (asset
 *     JS, JSON templates/sections, settings_data, locales) `{% comment %}` is
 *     literal text an attacker can wrap around live code, so nothing is blanked.
 *     Trade-off: a commented-out reference inside a JSON Custom Liquid string is
 *     still reported (safer direction: a leftover reference is worth removing).
 *     Code outside a comment on the same line is never skipped.
 *   - Encoded slashes (`https:\/\/host`, `\\/`, `&#47;`, `&#x2F;`, `&sol;`) are decoded
 *     before matching.
 *   - Other inert forms (HTML/JS comments) are still reported: a leftover
 *     malicious reference is worth removing, and the description says
 *     "references", not "loads".
 *   - The snippet is centred on the matched domain so the row preview shows it.
 *   - Severity is ALWAYS HIGH, set directly rather than via classifySeverity
 *     (whose comment-context downgrade does not apply: comments are excluded).
 *
 * Theme-file only, NO scope gate, ALL plans.
 */
export function detectMaliciousScripts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const originalLines = file.content.split("\n");
  const scanLines = (
    file.filename.endsWith(".liquid") ? blankLiquidComments(file.content) : file.content
  ).split("\n");

  scanLines.forEach((rawText, i) => {
    const text = rawText.replace(ENCODED_SLASH_RE, "/");
    const seen = new Set<string>();
    URL_HOST_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_HOST_RE.exec(text)) !== null) {
      const hit = matchMaliciousDomain(match[1]);
      if (!hit || seen.has(hit.domain)) continue;
      seen.add(hit.domain);

      const lineNumber = i + 1;
      const original = originalLines[i];
      // Search the blanked (same length as original) but undecoded line so the
      // snippet centres on the first LIVE occurrence, not one in a comment.
      const at = indexOfIgnoreCase(rawText, hit.domain);
      const from = Math.max(0, at - MALICIOUS_SNIPPET_LEAD);
      findings.push({
        filename: file.filename,
        lineNumber,
        codeSnippet:
          at === -1
            ? buildSnippet(file.content, lineNumber)
            : original.slice(from, from + MALICIOUS_SNIPPET_MAX),
        findingType: FindingType.MALICIOUS_SCRIPT,
        severity: Severity.HIGH,
        appName: undefined,
        description: `References known-malicious domain ${hit.domain} (${hit.note}), likely injected code. Your theme may be compromised`,
      });
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: JSON_LD_CONFLICT
// ---------------------------------------------------------------------------

/**
 * A single schema.org node: an object carrying its own `@type`. Real SEO-app
 * output nests nodes in several shapes (bare object, `@graph` wrapper, top-level
 * array), so we flatten every block into a list of nodes before comparing.
 */
interface JsonLdNode {
  lineNumber: number;
  /** Canonical JSON of just this node (stable key order) for equality checks. */
  rawContent: string;
  /**
   * The comparable Offer fields for this node (price, availability, etc.),
   * pulled at extraction time so a conflicting pair can be diffed cheaply.
   */
  offer: OfferFields;
}

/**
 * The subset of schema.org Offer fields an AI shopping agent would quote to a
 * shopper. When two same-@type nodes disagree here, the merchant-facing finding
 * names the exact field(s): this is the highest-signal JSON-LD conflict Ghost
 * Code can report (an agent could quote the wrong price or wrong stock status).
 * Values are normalized to trimmed strings so numeric vs string prices compare.
 */
interface OfferFields {
  price?: string;
  priceCurrency?: string;
  availability?: string;
  priceValidUntil?: string;
}

/**
 * Recursively sort object keys so two semantically identical nodes serialize to
 * the same string regardless of the source key order — makes dedup reliable.
 */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Normalize a node's `@type` into a stable string grouping key.
 *
 * - A string `@type` is used as-is.
 * - An array `@type` (e.g. `["Product","Thing"]`) uses its FIRST string element.
 *   schema.org convention lists the most specific/primary type first, so this is
 *   deterministic and groups `["Product","Thing"]` with a plain `"Product"` node.
 * - Anything else yields `null` (not a node we can group).
 */
function normalizeAtType(atType: unknown): string | null {
  if (typeof atType === "string") return atType;
  if (Array.isArray(atType)) {
    const first = atType.find((t) => typeof t === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

/**
 * Flatten a parsed JSON-LD block into its member nodes. Handles the three common
 * real-world shapes: a bare object with `@type`, a `{"@graph":[...]}` wrapper
 * whose members carry the `@type`s, and a top-level array of nodes. Comparison
 * is node-level (not whole-block) so two `@graph` blocks differing in one node
 * are still caught.
 */
function extractJsonLdNodes(parsed: unknown): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) consider(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const graph = obj["@graph"];
    if (Array.isArray(graph)) {
      for (const item of graph) consider(item);
    }
    if (normalizeAtType(obj["@type"]) !== null) {
      nodes.push(obj);
    }
  };
  consider(parsed);
  return nodes;
}

/** Normalize an Offer scalar to a trimmed string so `19.99` (number) and
 * `"19.99"` (string) compare equal. Non-scalars yield undefined. */
function normalizeOfferValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Strip a leading `https://schema.org/` (or http) prefix from an availability
 * value so the message shows `InStock`, not the full URL. */
function stripSchemaOrgPrefix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/^https?:\/\/schema\.org\//i, "");
}

/**
 * Pull the comparable Offer fields off a node. Offers live at `node.offers` as a
 * single object OR an array, or the node itself may BE an Offer (its own `@type`
 * is "Offer"), in which case the fields sit on the node directly. When multiple
 * offers are present we deliberately compare only the FIRST one: keeps the diff
 * deterministic and avoids combinatorial pairing.
 */
function extractOfferFields(node: Record<string, unknown>): OfferFields {
  let source: Record<string, unknown> | null = null;

  if (normalizeAtType(node["@type"]) === "Offer") {
    source = node;
  } else {
    const offers = node["offers"];
    if (Array.isArray(offers)) {
      // First offer only (deterministic, avoids N-way pairing).
      const first = offers.find((o) => o !== null && typeof o === "object" && !Array.isArray(o));
      source = (first as Record<string, unknown>) ?? null;
    } else if (offers !== null && typeof offers === "object") {
      source = offers as Record<string, unknown>;
    }
  }

  if (!source) return {};

  return {
    price: normalizeOfferValue(source["price"]),
    priceCurrency: normalizeOfferValue(source["priceCurrency"]),
    availability: stripSchemaOrgPrefix(normalizeOfferValue(source["availability"])),
    priceValidUntil: normalizeOfferValue(source["priceValidUntil"]),
  };
}

const OFFER_FIELD_LABELS: Array<[keyof OfferFields, string]> = [
  ["price", "price"],
  ["priceCurrency", "priceCurrency"],
  ["availability", "availability"],
  ["priceValidUntil", "priceValidUntil"],
];

/**
 * Build a clause naming each Offer field that differs between two nodes, e.g.
 * `offer price differs (19.99 vs 24.99)`. A field is only reported when BOTH
 * sides carry a value and they disagree: a field present on one side only is not
 * a clear price/stock contradiction worth surfacing. Returns "" when nothing
 * differs (caller then keeps the generic conflict wording).
 */
function describeOfferDiff(a: OfferFields, b: OfferFields): string {
  const parts: string[] = [];
  for (const [key, label] of OFFER_FIELD_LABELS) {
    const av = a[key];
    const bv = b[key];
    if (av !== undefined && bv !== undefined && av !== bv) {
      parts.push(`offer ${label} differs (${av} vs ${bv})`);
    }
  }
  return parts.join(", ");
}

/**
 * Detect conflicting JSON-LD blocks — multiple schema.org nodes with the same
 * @type but different data in the same file.
 *
 * This happens when multiple SEO/review apps each inject their own schema markup
 * and one gets uninstalled but its markup persists. Google may drop rich results
 * entirely when it sees conflicting JSON-LD for the same @type.
 */
export function detectJsonLdConflicts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Collect all JSON-LD nodes (flattened across @graph wrappers, top-level
  // arrays, and array @types), grouped by normalized @type across the whole file.
  const nodesByType = new Map<string, JsonLdNode[]>();

  for (const { offset, inner: blockContent } of extractJsonLdBlocks(file.content)) {
    // Skip blocks containing Liquid template tags — these are dynamically
    // rendered and may produce different output at runtime.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    // Try to parse the JSON — may be an object, an @graph wrapper, or an array.
    let parsed: unknown;
    try {
      parsed = JSON.parse(blockContent);
    } catch {
      continue; // Malformed JSON — skip gracefully
    }

    const lineNumber = lineNumberAtOffset(file.content, offset);

    for (const node of extractJsonLdNodes(parsed)) {
      const typeKey = normalizeAtType(node["@type"]);
      if (typeKey === null) continue;
      const rawContent = JSON.stringify(canonicalizeJson(node));
      if (!nodesByType.has(typeKey)) {
        nodesByType.set(typeKey, []);
      }
      nodesByType.get(typeKey)!.push({ lineNumber, rawContent, offer: extractOfferFields(node) });
    }
  }

  // For each @type with 2+ nodes, compare all pairs. Each node is checked against
  // every earlier node so a genuine difference between ANY two is caught (not
  // just differences from node[0]). A node identical to some earlier node is a
  // duplicate, not a conflict, so it is skipped. To avoid N-squared spam we emit
  // at most one finding per node, referencing the earliest node it conflicts with.
  for (const [atType, nodes] of nodesByType) {
    if (nodes.length < 2) continue;

    // The earliest node that differs is nodes[0] unless the node equals nodes[0];
    // then it is the first node that differs from nodes[0] (every node before
    // it equals nodes[0], hence this node). Tracking that index keeps this O(n)
    // instead of rescanning all earlier nodes per node (quadratic when a file
    // repeats one block thousands of times, gc-t7x).
    const head = nodes[0].rawContent;
    let firstDiffFromHead = nodes.findIndex((n) => n.rawContent !== head);
    if (firstDiffFromHead === -1) firstDiffFromHead = nodes.length;

    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i];

      let conflictsWith: JsonLdNode | null = null;
      if (node.rawContent !== head) conflictsWith = nodes[0];
      else if (firstDiffFromHead < i) conflictsWith = nodes[firstDiffFromHead];
      // No earlier node differs — this node is an exact duplicate, not a conflict.
      if (!conflictsWith) continue;

      const codeSnippet = buildSnippet(file.content, node.lineNumber);
      const severity = classifySeverity(FindingType.JSON_LD_CONFLICT, codeSnippet);

      // Try app attribution
      const appName =
        identifyAppFromJsonLd(node.rawContent) ?? identifyAppFromCode(node.rawContent) ?? undefined;

      // When the disagreement is in an Offer field, ENRICH this single finding
      // to name the field(s) and both values (highest-signal conflict: an AI
      // agent could quote the wrong price/stock). We do NOT emit a separate
      // finding, so the generic conflict gc-47c.9 already reports is not
      // double-counted. Non-offer differences (e.g. aggregateRating only) leave
      // the generic wording untouched.
      const offerClause = describeOfferDiff(conflictsWith.offer, node.offer);
      const description =
        `Conflicting JSON-LD "@type": "${atType}" (conflicts with block on line ${conflictsWith.lineNumber})` +
        (offerClause ? `: ${offerClause}` : "");

      findings.push({
        filename: file.filename,
        lineNumber: node.lineNumber,
        codeSnippet,
        findingType: FindingType.JSON_LD_CONFLICT,
        severity,
        appName,
        description,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Extraction: static Product JSON-LD candidates (for the live-price audit)
// ---------------------------------------------------------------------------

/**
 * Pull the resolvable product identity off a Product node. We only trust the two
 * keys that map deterministically to a live Shopify product:
 *   - `handle`  parsed from a `/products/{handle}` url (Product.url), lower-cased.
 *   - `sku`     the variant SKU (on the Product node or its first Offer).
 *
 * `mpn`, `@id`, and `name` are deliberately NOT used: an mpn is a manufacturer
 * part number (not a Shopify SKU), `@id` is an arbitrary IRI, and `name` is not a
 * unique key — resolving on any of them risks matching the WRONG product and
 * emitting a false price conflict.
 */
function extractProductIdentity(node: Record<string, unknown>): {
  handle?: string;
  sku?: string;
} {
  let handle: string | undefined;
  const url = normalizeOfferValue(node["url"]);
  if (url) {
    const m = /\/products\/([^/?#]+)/.exec(url);
    if (m) handle = m[1].toLowerCase();
  }

  let sku = normalizeOfferValue(node["sku"]);
  if (sku === undefined) {
    const offers = node["offers"];
    const first = Array.isArray(offers)
      ? offers.find((o) => o !== null && typeof o === "object" && !Array.isArray(o))
      : offers;
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      sku = normalizeOfferValue((first as Record<string, unknown>)["sku"]);
    }
  }

  return { handle, sku };
}

/** Shopify's maximum handle / SKU length; bounds each static candidate string. */
const MAX_CANDIDATE_FIELD_LENGTH = 255;

function truncateCandidateField(value: string | undefined): string | undefined {
  return value?.slice(0, MAX_CANDIDATE_FIELD_LENGTH);
}

/**
 * Extract UNSIGNED static Product JSON-LD blocks as compact candidates for the
 * live-price audit (gc-47c.10). A candidate is recorded only when the block is:
 *   - static (no Liquid tags — a Liquid block is theme-rendered, not stale),
 *   - UNSIGNED (no app signature — signed blocks are GHOST_JSON_LD, handled by
 *     detectGhostJsonLd; this is the "legitimate static JSON-LD" that detector
 *     deliberately skips),
 *   - a Product node with a resolvable identity (handle or sku), AND
 *   - carries something comparable (a price or an availability).
 *
 * Anything ambiguous or unresolvable is dropped HERE so it can never reach the
 * audit as a false positive.
 */
export function extractStaticProductCandidates(file: ThemeFile): StaticProductCandidate[] {
  const candidates: StaticProductCandidate[] = [];

  for (const { offset, inner: blockContent } of extractJsonLdBlocks(file.content)) {
    // Liquid blocks are dynamically rendered by the theme engine — not stale
    // static injections. Mirrors both JSON-LD detectors.
    if (LIQUID_TAG_RE.test(blockContent)) continue;

    // Signed blocks are orphaned-app markup handled by detectGhostJsonLd. We only
    // want the unsigned "legitimate static JSON-LD" it skips.
    if (identifyAppFromJsonLd(blockContent)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(blockContent);
    } catch {
      continue; // Malformed JSON — skip gracefully
    }

    const lineNumber = lineNumberAtOffset(file.content, offset);

    for (const node of extractJsonLdNodes(parsed)) {
      if (normalizeAtType(node["@type"]) !== "Product") continue;

      const { handle, sku } = extractProductIdentity(node);
      if (handle === undefined && sku === undefined) continue; // unresolvable → skip

      const offer = extractOfferFields(node);
      if (offer.price === undefined && offer.availability === undefined) continue; // nothing to compare

      // Every string crosses the Inngest step boundary (4 MB limit), so each is
      // truncated to Shopify's 255-char handle/SKU maximum (gc-4ce): 500
      // candidates with 9 KB SKUs otherwise produced ~4.7 MB of step output.
      candidates.push({
        filename: file.filename,
        lineNumber,
        codeSnippet: buildSnippet(file.content, lineNumber),
        handle: truncateCandidateField(handle),
        sku: truncateCandidateField(sku),
        staticPrice: truncateCandidateField(offer.price),
        staticPriceCurrency: truncateCandidateField(offer.priceCurrency),
        staticAvailability: truncateCandidateField(offer.availability),
      });
    }
  }

  return candidates;
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

          // Every TRACKING_PATTERNS entry is a tracker by definition, so the
          // file-owner app (if any) always wins over the tracker attribution.
          const resolved = resolveAttribution(appName, file.filename, {
            contentIsTracker: true,
          });

          const codeSnippet = buildSnippet(file.content, lineNumber);
          const severity = classifySeverity(FindingType.GHOST_PIXEL, codeSnippet);

          findings.push({
            filename: file.filename,
            lineNumber,
            codeSnippet,
            findingType: FindingType.GHOST_PIXEL,
            severity,
            // `appName` (the TRACKING_PATTERNS entry) is always defined here, so
            // resolved.appName is never null; coalesce to satisfy the type.
            appName: resolved.appName ?? appName,
            description: resolved.overriddenTracker
              ? `Inline tracking pixel left by ${resolved.appName} (calls ${resolved.overriddenTracker})`
              : `Inline tracking pixel from ${appName} (${tracker})`,
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
 * `name` attribute values recognized by META_ROBOTS_TAG: the generic `robots`
 * directive plus every maintained AI-crawler UA name. Orphaned AI-crawler
 * meta directives (e.g. `<meta name="GPTBot" content="noindex">`) are the
 * same failure mode as an orphaned `name="robots"` tag — an uninstalled app
 * left a restrictive directive behind — so they reuse the GHOST_ROBOTS
 * finding rather than a new finding type.
 */
const META_ROBOTS_NAME_RE = ["robots", ...AI_CRAWLER_USER_AGENTS].join("|");

/**
 * Matches <meta name="robots|<AI crawler>" content="..."> with either
 * attribute ordering:
 *   - name before content
 *   - content before name
 * Captures the content attribute value for directive analysis.
 */
const META_ROBOTS_TAG = tagPattern([
  {
    tag: "<meta",
    steps: [
      { gap: "\\s+[^>]*", attr: `name${ATTR_EQ}["'](?:${META_ROBOTS_NAME_RE})["']` },
      { gap: "[^>]*", attr: `content${ATTR_EQ}${QUOTED_VALUE}` },
    ],
  },
  {
    tag: "<meta",
    steps: [
      { gap: "\\s+[^>]*", attr: `content${ATTR_EQ}${QUOTED_VALUE}` },
      { gap: "[^>]*", attr: `name${ATTR_EQ}["'](?:${META_ROBOTS_NAME_RE})["']` },
    ],
  },
]);

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
export function detectGhostRobots(
  file: ThemeFile,
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    // Skip lines with Liquid conditionals — these are theme-native logic
    if (LIQUID_CONDITIONAL_RE.test(text)) continue;

    // Isolate each <meta ...> tag first (linear, non-backtracking), then apply
    // META_ROBOTS_TAG to the bounded tag text.
    for (const { tag } of extractTags(text, "<meta")) {
      const match = execTagPattern(tag, META_ROBOTS_TAG);
      if (!match) continue;

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
      // Early exit (gc-ypk): emission is in line order, so the first `limit`
      // findings are the first `limit` by line.
      if (findings.length >= limit) return findings;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Collector: unknown external scripts (unrecognized CDN URLs)
// ---------------------------------------------------------------------------

// Shopify-owned base domains. A hostname is first-party if it equals one of
// these or is a subdomain of it. Single source of truth for both the
// unknown-script/stylesheet collectors and the ghost-preconnect detector, so the
// .com/.net variants can never drift apart again (gc-06e.6).
const SHOPIFY_BASE_DOMAINS = [
  "shopify.com",
  "shopifycdn.com",
  "shopifycdn.net",
  "myshopify.com",
  "shopifysvc.com",
];

/**
 * Returns true if the hostname is a Shopify-owned domain or a subdomain of one.
 * Uses an exact-or-dot-boundary check so lookalikes (e.g. "evilshopify.com",
 * "notshopifycdn.net") are NOT treated as first-party.
 */
function isShopifyDomain(hostname: string): boolean {
  return SHOPIFY_BASE_DOMAINS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function collectUnknownScripts(
  file: ThemeFile,
  benignSkips?: BenignSkipCounter,
): UnknownExternalResource[] {
  const unknowns: UnknownExternalResource[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    for (const { tag } of extractTags(text, "<script")) {
      const match = execTagPattern(tag, SCRIPT_SRC_TAG);
      if (!match) continue;

      const url = match[1];
      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (appName) continue; // Already identified — skip

      // Filter out first-party Shopify CDN URLs that are not app artifacts
      const hostname = hostnameFromUrl(url);
      if (hostname === null) continue; // Malformed URL — skip
      if (isShopifyDomain(hostname)) continue;
      // Known-malicious hosts are reported as MALICIOUS_SCRIPT findings; never
      // route them into the flywheel, which asks the merchant to name the app.
      if (matchMaliciousDomain(hostname)) continue;

      // Drop benign public-CDN libraries / web fonts (not orphaned app code)
      if (isBenignLibrary(url)) {
        if (benignSkips) benignSkips.count++;
        continue;
      }

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

export function collectUnknownStylesheets(
  file: ThemeFile,
  benignSkips?: BenignSkipCounter,
): UnknownExternalResource[] {
  const unknowns: UnknownExternalResource[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    for (const { tag } of extractTags(text, "<link")) {
      const match = execTagPattern(tag, LINK_STYLESHEET_TAG);
      if (!match) continue;

      const url = match[1] ?? match[3];
      if (!url) continue;

      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (appName) continue; // Already identified — skip

      // Filter out first-party Shopify CDN URLs
      const hostname = hostnameFromUrl(url);
      if (hostname === null) continue; // Malformed URL — skip
      if (isShopifyDomain(hostname)) continue;
      // Known-malicious hosts are reported as MALICIOUS_SCRIPT findings; never
      // route them into the flywheel, which asks the merchant to name the app.
      if (matchMaliciousDomain(hostname)) continue;

      // Drop benign public-CDN libraries / web fonts (not orphaned app code)
      if (isBenignLibrary(url)) {
        if (benignSkips) benignSkips.count++;
        continue;
      }

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
// Collector: third-party domain graph (Feature 1 of scan-observability spec)
// ---------------------------------------------------------------------------

/** The surfaces a third-party host can be referenced from (ScanDomain.sources). */
type DomainSource = "script" | "stylesheet" | "preconnect" | "dns_prefetch" | "font" | "ajax";

/**
 * Opener of a `@font-face { ... }` block; fontFaceBlocks isolates each complete
 * block to bound URL extraction to the font surface. Module-scope /g regex.
 */
const FONT_FACE_OPEN_RE = /@font-face\s*\{/gi;

/**
 * Every complete `@font-face { ... }` block, identical to the matches of
 * /@font-face\s*\{[^}]*\}/gi but linear (gc-t7x): that regex rescans to EOF
 * from every opener when no `}` follows (1 MB of openers: minutes). A block
 * ends at the first `}` after its `{`; with none left, no later opener can
 * complete either, so the scan stops.
 */
function fontFaceBlocks(content: string): string[] {
  const blocks: string[] = [];
  FONT_FACE_OPEN_RE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = FONT_FACE_OPEN_RE.exec(content)) !== null) {
    const close = content.indexOf("}", open.index + open[0].length);
    if (close === -1) break;
    blocks.push(content.slice(open.index, close + 1));
    FONT_FACE_OPEN_RE.lastIndex = close + 1;
  }
  return blocks;
}

/**
 * Pieces of the former FONT_FACE_SRC_URL_RE,
 * /url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)["']?\s*\)/gi, which extracted each
 * absolute or protocol-relative `url(...)` target in a `@font-face` block. The
 * prefix (group 1 = its `(https?:)?//` part) and the URL body each match in
 * exactly one way at a position, so fontFaceSrcUrls can evaluate them in order.
 */
const FONT_URL_PREFIX_RE = /url\(\s*["']?((?:https?:)?\/\/)/gi;
const FONT_URL_BODY_RE = /[^"')\s]+/y;
const FONT_URL_TAIL_RE = /["']?\s*\)/y;

/**
 * The `url(...)` targets of a `@font-face` block, identical to the group-1
 * captures of the former FONT_FACE_SRC_URL_RE but linear (gc-t7x). The regex
 * rescanned the URL body from every `url(` start: a block holding 1 MB of
 * unterminated `url(//a` took minutes. When the tail after a body fails, a
 * `url(` start inside that body is followed by body chars (never whitespace or
 * a quote), so its own body ends at the same place and fails the same way. The
 * one exception is a `url(` ending exactly at the body end, whose `\s*` can
 * run on past it, so the scan resumes 4 chars before the body end.
 */
function fontFaceSrcUrls(block: string): string[] {
  const urls: string[] = [];
  FONT_URL_PREFIX_RE.lastIndex = 0;
  let prefix: RegExpExecArray | null;
  while ((prefix = FONT_URL_PREFIX_RE.exec(block)) !== null) {
    const prefixEnd = prefix.index + prefix[0].length;
    FONT_URL_BODY_RE.lastIndex = prefixEnd;
    if (!FONT_URL_BODY_RE.test(block)) {
      FONT_URL_PREFIX_RE.lastIndex = prefix.index + 1;
      continue;
    }
    const bodyEnd = FONT_URL_BODY_RE.lastIndex;
    FONT_URL_TAIL_RE.lastIndex = bodyEnd;
    if (FONT_URL_TAIL_RE.test(block)) {
      urls.push(block.slice(prefixEnd - prefix[1].length, bodyEnd));
      FONT_URL_PREFIX_RE.lastIndex = FONT_URL_TAIL_RE.lastIndex;
    } else {
      FONT_URL_PREFIX_RE.lastIndex = Math.max(prefix.index + 1, bodyEnd - "url(".length);
    }
  }
  return urls;
}

/**
 * Collect every NON-Shopify third-party host a single theme file references,
 * across the same surfaces the ghost detectors read: `<script src>`,
 * `<link rel=stylesheet href>`, `<link rel=preconnect|dns-prefetch href>`,
 * `@font-face` src URLs + font-service `<link>` tags, and fetch/XHR/jQuery-AJAX
 * URL literals.
 *
 * DRY: reuses the SAME host/domain predicates the collectors and detectors
 * already use — `hostnameFromUrl`, `isShopifyDomain`, `identifyAppFromUrl` /
 * `identifyAppFromCode`, `isBenignLibrary`, `isSharedCdnDomain` — so domain logic
 * is never duplicated. Classification per host:
 *   - matched (`matched=true` + `appName`) when the URL resolves to a known app;
 *   - else benign (`benign=true`) when it is a known benign public CDN / web-font
 *     host (`isBenignLibrary` OR `isSharedCdnDomain`);
 *   - else neither — a flywheel candidate (the proprietary long tail).
 * Shopify first-party hosts and malformed URLs are skipped (never persisted).
 *
 * Per host within THIS file: unions the source surfaces, sums `refCount` (one per
 * reference). A single physical `<link>` tag contributes AT MOST one surface
 * (precedence stylesheet > preconnect > dns-prefetch > font), so a tag that
 * matches several `<link>` regexes is not double-counted. Aggregation ACROSS
 * files happens in `scanThemeFiles`.
 */
export function collectThirdPartyDomains(file: ThemeFile): ThirdPartyDomainRef[] {
  const byHost = new Map<
    string,
    {
      sources: Set<DomainSource>;
      refCount: number;
      matched: boolean;
      appName: string | null;
      benign: boolean;
    }
  >();

  const record = (rawUrl: string | undefined | null, source: DomainSource) => {
    if (!rawUrl) return;
    const hostname = hostnameFromUrl(rawUrl);
    if (hostname === null) return; // malformed URL — skip
    if (isShopifyDomain(hostname)) return; // first-party — never persisted

    let entry = byHost.get(hostname);
    if (!entry) {
      const appName = identifyAppFromUrl(rawUrl) ?? identifyAppFromCode(rawUrl);
      const matched = appName !== null;
      const benign = !matched && (isBenignLibrary(rawUrl) || isSharedCdnDomain(hostname));
      entry = {
        sources: new Set<DomainSource>(),
        refCount: 0,
        matched,
        appName: matched ? appName : null,
        benign,
      };
      byHost.set(hostname, entry);
    } else if (!entry.matched) {
      // A later reference on the same host may carry app-identifying context the
      // first did not (e.g. a different URL that resolves to a known app). Upgrade
      // to matched — a matched host is never also benign.
      const appName = identifyAppFromUrl(rawUrl) ?? identifyAppFromCode(rawUrl);
      if (appName !== null) {
        entry.matched = true;
        entry.appName = appName;
        entry.benign = false;
      }
    }
    entry.sources.add(source);
    entry.refCount += 1;
  };

  // <script src>
  for (const { tag } of extractTags(file.content, "<script")) {
    const m = execTagPattern(tag, SCRIPT_SRC_TAG);
    if (m) record(m[1], "script");
  }

  // <link> tags: record AT MOST ONE surface per physical tag, precedence
  // stylesheet > preconnect > dns-prefetch > font. A single tag can match more
  // than one of these regexes (e.g. a Google Fonts stylesheet href also matches
  // FONT_LINK_TAG), so without this precedence a tag would double-count refCount
  // and emit a spurious `font` source. `continue` after the first surface that
  // records prevents that.
  for (const { tag } of extractTags(file.content, "<link")) {
    const styleMatch = execTagPattern(tag, LINK_STYLESHEET_TAG);
    if (styleMatch) {
      record(styleMatch[1] ?? styleMatch[3], "stylesheet");
      continue;
    }

    const preMatch = execTagPattern(tag, PRECONNECT_TAG);
    if (preMatch) {
      const relType = preMatch[1] ?? preMatch[4];
      const href = preMatch[2] ?? preMatch[3];
      // `preload` is outside the domain-graph source taxonomy — skip it (no
      // record, no `continue`), so a preload tag falls through to the font
      // check below, as it did before this precedence guard.
      if (relType === "preconnect") {
        record(href, "preconnect");
        continue;
      } else if (relType === "dns-prefetch") {
        record(href, "dns_prefetch");
        continue;
      }
    }

    const fontLinkMatch = execTagPattern(tag, FONT_LINK_TAG);
    if (fontLinkMatch) record(fontLinkMatch[1] ?? fontLinkMatch[2], "font");
  }

  // @font-face src url()s — bound extraction to each font-face block.
  for (const block of fontFaceBlocks(file.content)) {
    for (const url of fontFaceSrcUrls(block)) record(url, "font");
  }

  // fetch() / jQuery AJAX / XMLHttpRequest URL literals.
  for (const re of [FETCH_RE, JQUERY_AJAX_RE, XHR_OPEN_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.content)) !== null) {
      record(m[1], "ajax");
    }
  }

  return [...byHost.entries()].map(([domain, e]) => ({
    domain,
    sources: [...e.sources].sort(),
    refCount: e.refCount,
    matched: e.matched,
    appName: e.appName,
    benign: e.benign,
  }));
}

// ---------------------------------------------------------------------------
// Detector: DUPLICATE_LIBRARY
// ---------------------------------------------------------------------------

/**
 * Cross-file detector: flags when the SAME public-CDN JavaScript library is
 * loaded at two or more DISTINCT MAJOR versions across the theme (e.g. Swiper
 * v8 in one file and Swiper v11 in another). Duplicate/conflicting copies bloat
 * page weight and can break at runtime when two majors fight over the same
 * global. Emits ONE DUPLICATE_LIBRARY finding per conflicting library.
 *
 * IMPORTANT — reads RAW script URLs, not the post-suppression unknownScripts
 * array: the unknown-script collectors DROP benign libraries via isBenignLibrary
 * (gc-tus A1), so a library that appears there would be invisible to a detector
 * that consumed that array. This pass therefore re-extracts external <script>
 * src URLs directly from each file's content and parses them with parseLibrary.
 *
 * Scope (v1): public-CDN URLs only (jsdelivr / unpkg / cdnjs) — parseLibrary
 * returns null for everything else, so asset_url-hosted copies are out of scope.
 * Not flagged: a single library, two libraries each seen once, the same major
 * in multiple files, or two copies of the identical version. Only a genuine
 * MAJOR-version split counts as a conflict.
 *
 * Floating dist-tags (gc-tus.12): `swiper@latest` / `@next` / `@beta` / ...
 * (the closed list in parseLibrary) have no known major (the CDN resolves them
 * at load time). Each distinct tag counts as its own version, so a tag next to
 * a pinned major, or two different tags, is flagged (two copies loaded); the
 * SAME tag twice is one version and is not, matching identical pinned
 * versions. When the match DEPENDS on a tag (fewer than two distinct pinned
 * majors), the tag may resolve to the same major, so it is only a possible
 * duplicate: severity LOW and "may be loaded more than once" wording (owner
 * decision 1A). Two or more distinct pinned majors are a proven conflict and
 * keep the default severity and conflict wording even when a tag is also
 * present. Range-likes (`^1`, `~2`, `3`) count by their major.
 *
 * Size-guard-skipped files ARE scanned here (gc-tus.11), like the other
 * cross-file passes. DUPLICATE_LIBRARY is in CROSS_FILE_FINDING_TYPES, so the
 * differ keeps diffing it when its anchor file is size-skipped; if this pass
 * dropped oversized files, a still-present conflict anchored in (or relying
 * on a copy in) a file that grew past the cap would read as a false
 * "resolved". Keeping them is safe because the pass is linear: one line split,
 * extractTags (indexOf), execTagPattern (gc-t7x) and a URL parse per tag, with
 * tags disjoint — pinned on >1 MB adversarial files in
 * tests/services/scan-engine-redos.server.test.ts.
 */
export function detectDuplicateLibraries(files: ThemeFile[]): CreateFindingInput[] {
  // library name -> (version label -> first place that version was seen). The
  // label is `v<major>` for a pinned major or `@<tag>` for a floating dist-tag.
  const byLibrary = new Map<
    string,
    Map<string, { major: number | null; file: ThemeFile; lineNumber: number }>
  >();

  for (const file of files) {
    for (const { lineNumber, text } of lines(file.content)) {
      for (const { tag } of extractTags(text, "<script")) {
        const match = execTagPattern(tag, SCRIPT_SRC_TAG);
        if (!match) continue;

        const lib = parseLibrary(match[1]);
        if (lib === null) continue;

        let versions = byLibrary.get(lib.name);
        if (!versions) {
          versions = new Map();
          byLibrary.set(lib.name, versions);
        }
        const label = lib.major === null ? `@${lib.tag}` : `v${lib.major}`;
        // Keep the FIRST occurrence of each version for stable attribution.
        if (!versions.has(label)) versions.set(label, { major: lib.major, file, lineNumber });
      }
    }
  }

  const findings: CreateFindingInput[] = [];

  for (const [name, versions] of byLibrary) {
    if (versions.size < 2) continue; // single version = no conflict

    // Pinned majors ascending, then floating tags alphabetically (deterministic).
    const sorted = [...versions.entries()].sort(([labelA, a], [labelB, b]) => {
      if (a.major !== null && b.major !== null) return a.major - b.major;
      if (a.major !== null) return -1;
      if (b.major !== null) return 1;
      return labelA < labelB ? -1 : 1;
    });
    // Attribute the finding to the lowest-major (else first-tag) occurrence.
    const anchor = sorted[0][1];

    const detail = sorted.map(([label, v]) => `${label} (${v.file.filename})`).join(", ");
    const codeSnippet = buildSnippet(anchor.file.content, anchor.lineNumber);
    const hasFloatingTag = sorted.some(([, v]) => v.major === null);
    const pinnedMajors = sorted.filter(([, v]) => v.major !== null).length;
    // Only a tag makes this a match: the versions may all resolve the same.
    const possibleDuplicate = hasFloatingTag && pinnedMajors < 2;

    let description: string;
    if (possibleDuplicate) {
      description =
        `Library "${name}" may be loaded more than once (possible duplicate copies): ${detail}. ` +
        "A floating tag like @latest resolves when the page loads, so its version is unknown";
    } else if (hasFloatingTag) {
      description =
        `Library "${name}" is loaded at ${sorted.length} conflicting versions: ${detail}. ` +
        "Floating tags like @latest resolve when the page loads, so their major is unknown; " +
        "each distinct tag is counted as a separate copy";
    } else {
      description = `Library "${name}" is loaded at ${sorted.length} conflicting major versions: ${detail}`;
    }

    findings.push({
      filename: anchor.file.filename,
      lineNumber: anchor.lineNumber,
      codeSnippet,
      findingType: FindingType.DUPLICATE_LIBRARY,
      severity: possibleDuplicate
        ? Severity.LOW
        : classifySeverity(FindingType.DUPLICATE_LIBRARY, codeSnippet),
      description,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Cross-file anchor selection
// ---------------------------------------------------------------------------

/** A place a cross-file signal was seen: candidate anchor for its finding. */
type AnchorLocation = { file: ThemeFile; lineNumber: number };

/**
 * Folder priority for cross-file finding anchors. The anchor's filename + line
 * feed the scan-differ fingerprint, so it must not depend on input order (a
 * moved anchor reads as "resolved" + "new" and breaks INSTANCE-scope ignores).
 * layout/sections/snippets/templates keep their historical alphabetical order;
 * blocks/ (scannable since gc-zfl) slots in before templates/ so adding blocks
 * never moves an existing anchor off layout/sections/snippets.
 */
const ANCHOR_FOLDER_PRIORITY = ["layout/", "sections/", "snippets/", "blocks/", "templates/"];

function anchorFolderRank(filename: string): number {
  const rank = ANCHOR_FOLDER_PRIORITY.findIndex((prefix) => filename.startsWith(prefix));
  return rank === -1 ? ANCHOR_FOLDER_PRIORITY.length : rank;
}

/**
 * Total order over anchor candidates: folder priority, then filename (plain
 * code-unit comparison, locale-independent), then line. Negative = `a` first.
 */
function compareAnchorLocations(a: AnchorLocation, b: AnchorLocation): number {
  const rankDiff = anchorFolderRank(a.file.filename) - anchorFolderRank(b.file.filename);
  if (rankDiff !== 0) return rankDiff;
  if (a.file.filename !== b.file.filename) return a.file.filename < b.file.filename ? -1 : 1;
  return a.lineNumber - b.lineNumber;
}

/** Store `loc` under `key` unless an equal-or-better anchor is already there. */
function keepBestAnchor<K>(map: Map<K, AnchorLocation>, key: K, loc: AnchorLocation): void {
  const current = map.get(key);
  if (!current || compareAnchorLocations(loc, current) < 0) map.set(key, loc);
}

/**
 * Entries sorted by anchor order, ties (same file + line) broken by key so the
 * description is input-order independent too. The first entry is the anchor.
 */
function sortedByAnchor(map: Map<string, AnchorLocation>): Array<[string, AnchorLocation]> {
  return [...map.entries()].sort(
    ([keyA, a], [keyB, b]) => compareAnchorLocations(a, b) || (keyA < keyB ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------
// Detector: DUPLICATE_TRACKER
// ---------------------------------------------------------------------------

/**
 * Analytics / pixel platforms this detector recognizes, each with a ReDoS-safe
 * matcher (anchored, bounded quantifiers, no nested quantifiers) and the capture
 * group that carries the platform ID (0 = whole match).
 *
 *   - Google Analytics 4  — `G-XXXX` in gtag('config','G-…') or gtag/js?id=G-….
 *   - Google Tag Manager  — `GTM-XXXX` in gtm.js?id=GTM-… or an inline 'GTM-…'.
 *   - Meta (Facebook) Pixel — the numeric id from fbq('init','<digits>').
 *   - Universal Analytics — legacy `UA-XXXX-Y`.
 *   - TikTok Pixel        — the id from ttq.load('<id>').
 */
const TRACKER_PLATFORMS: ReadonlyArray<{
  name: string;
  regex: RegExp;
  idGroup: number;
  context?: RegExp;
}> = [
  {
    name: "Google Analytics 4",
    regex: /\bG-[A-Z0-9]{4,15}\b/g,
    idGroup: 0,
    context: /gtag|googletagmanager|google-analytics|gtag\/js/i,
  },
  {
    name: "Google Tag Manager",
    regex: /\bGTM-[A-Z0-9]{4,10}\b/g,
    idGroup: 0,
    context: /googletagmanager|gtm\.js|dataLayer/i,
  },
  { name: "Meta Pixel", regex: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/gi, idGroup: 1 },
  {
    name: "Universal Analytics",
    regex: /\bUA-\d{4,10}-\d{1,4}\b/g,
    idGroup: 0,
    context: /google-analytics|analytics\.js|_gaq|gtag|\bga\s*\(/i,
  },
  { name: "TikTok Pixel", regex: /ttq\.load\(\s*['"]([A-Z0-9]{6,30})['"]/gi, idGroup: 1 },
];

/**
 * Cross-file detector: flags when the SAME analytics/pixel platform is configured
 * with two or more DISTINCT IDs across the theme (e.g. GA4 wired to two different
 * measurement IDs). Genuine double-count / split-reporting conflict.
 *
 * HIGH PRECISION — distinct IDs only: a single ID, or the same ID repeated across
 * files, is normal and never flagged. Emits ONE DUPLICATE_TRACKER finding per
 * platform that has >= 2 distinct IDs, anchored at the platform's best location
 * by compareAnchorLocations (folder priority, not input order).
 *
 * Theme-file content only. Runtime/app-injected pixels (Web Pixels, GTM-runtime
 * containers) are out of scope — this reads what is statically written in theme
 * files, mirroring detectDuplicateLibraries.
 */
export function detectDuplicateTrackers(files: ThemeFile[]): CreateFindingInput[] {
  // platform name -> (distinct id -> best anchor location of that id)
  const byPlatform = new Map<string, Map<string, AnchorLocation>>();

  for (const file of files) {
    if (!isScannableFile(file.filename)) continue;
    const commentSkip = buildCommentSkipLines(file.content);
    for (const { lineNumber, text } of lines(file.content)) {
      if (commentSkip.has(lineNumber)) continue;
      for (const platform of TRACKER_PLATFORMS) {
        // Bare-ID platforms (GA4/GTM/UA) additionally require tracker context on
        // the SAME line so a stray `G-…`/`GTM-…`/`UA-…` in copy is not counted.
        if (platform.context && !platform.context.test(text)) continue;
        platform.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = platform.regex.exec(text)) !== null) {
          const id = match[platform.idGroup];
          if (!id) continue;

          let ids = byPlatform.get(platform.name);
          if (!ids) {
            ids = new Map();
            byPlatform.set(platform.name, ids);
          }
          keepBestAnchor(ids, id, { file, lineNumber });
        }
      }
    }
  }

  const findings: CreateFindingInput[] = [];

  for (const platform of TRACKER_PLATFORMS) {
    const ids = byPlatform.get(platform.name);
    if (!ids || ids.size < 2) continue; // one distinct id = normal, no conflict

    const sorted = sortedByAnchor(ids);
    const anchor = sorted[0][1];
    const detail = sorted.map(([id, loc]) => `${id} (${loc.file.filename})`).join(", ");
    const codeSnippet = buildSnippet(anchor.file.content, anchor.lineNumber);
    const severity = classifySeverity(FindingType.DUPLICATE_TRACKER, codeSnippet);

    findings.push({
      filename: anchor.file.filename,
      lineNumber: anchor.lineNumber,
      codeSnippet,
      findingType: FindingType.DUPLICATE_TRACKER,
      severity,
      description: `${platform.name} is configured with ${ids.size} different IDs: ${detail}. If this is not intentional, events may double-count or split across properties.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: OVERLAPPING_CHAT_WIDGET
// ---------------------------------------------------------------------------

/**
 * Chat-widget platforms this detector recognizes, each by a set of unambiguous
 * host / global-object signatures. String signatures are matched case-insensitively
 * (against a lowercased line); the lone RegExp signature (`zE(`) is boundary-aware
 * so it does not fire on innocuous calls like `resize(` or `size(`.
 *
 * HubSpot is intentionally excluded — its script host overlaps with its analytics
 * and CRM bundles, so presence does not reliably prove a chat widget (FP risk).
 */
const CHAT_WIDGET_PLATFORMS: ReadonlyArray<{
  name: string;
  signatures: ReadonlyArray<string | RegExp>;
}> = [
  { name: "Intercom", signatures: ["widget.intercom.io", "intercomsettings", "window.intercom"] },
  { name: "Drift", signatures: ["js.driftt.com", "drift.load"] },
  { name: "Tidio", signatures: ["code.tidio.co"] },
  { name: "Zendesk Chat", signatures: ["static.zdassets.com", "$zopim", /\bzE\s*\(/] },
  { name: "Gorgias", signatures: ["config.gorgias.chat"] },
  { name: "Tawk.to", signatures: ["embed.tawk.to", "tawk_api"] },
  { name: "Crisp", signatures: ["client.crisp.chat"] },
  { name: "LiveChat", signatures: ["cdn.livechatinc.com"] },
  { name: "Olark", signatures: ["static.olark.com"] },
];

/**
 * Cross-file detector: flags when two or more DISTINCT chat-widget platforms are
 * present anywhere in the theme (two chat bubbles = a conflict shoppers see, plus
 * duplicated widget weight and split chat sessions).
 *
 * One platform, even if referenced on many lines/files, is never flagged. Emits
 * ONE OVERLAPPING_CHAT_WIDGET finding, anchored at the best location of any
 * detected platform by compareAnchorLocations (folder priority, not input order).
 *
 * Theme-file content only, mirroring detectDuplicateLibraries.
 */
export function detectOverlappingChatWidgets(files: ThemeFile[]): CreateFindingInput[] {
  // platform name -> best anchor location where that platform was detected
  const bestSeen = new Map<string, AnchorLocation>();

  for (const file of files) {
    if (!isScannableFile(file.filename)) continue;
    const commentSkip = buildCommentSkipLines(file.content);
    // Lines are ascending, so a platform's first hit in a file is that file's
    // best location for it; later lines of the same file can be skipped.
    const foundInFile = new Set<string>();
    for (const { lineNumber, text } of lines(file.content)) {
      if (commentSkip.has(lineNumber)) continue;
      const lower = text.toLowerCase();
      for (const platform of CHAT_WIDGET_PLATFORMS) {
        if (foundInFile.has(platform.name)) continue;
        const hit = platform.signatures.some((sig) =>
          typeof sig === "string" ? lower.includes(sig) : sig.test(text),
        );
        if (!hit) continue;
        foundInFile.add(platform.name);
        keepBestAnchor(bestSeen, platform.name, { file, lineNumber });
      }
    }
  }

  if (bestSeen.size < 2) return []; // one (or zero) platform = no conflict

  const sorted = sortedByAnchor(bestSeen);
  const anchor = sorted[0][1];
  const detail = sorted.map(([name, loc]) => `${name} (${loc.file.filename})`).join(", ");
  const codeSnippet = buildSnippet(anchor.file.content, anchor.lineNumber);
  const severity = classifySeverity(FindingType.OVERLAPPING_CHAT_WIDGET, codeSnippet);

  return [
    {
      filename: anchor.file.filename,
      lineNumber: anchor.lineNumber,
      codeSnippet,
      findingType: FindingType.OVERLAPPING_CHAT_WIDGET,
      severity,
      description: `${bestSeen.size} chat widgets are loaded at once: ${detail} — shoppers may see conflicting chat bubbles.`,
    },
  ];
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
export function detectSettingsDrift(
  files: ThemeFile[],
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
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
    // Early exit (gc-ypk): every finding is on line 1 of settings_data.json, so
    // the first `limit` in (deterministic) key order are the first by line.
    if (findings.length >= limit) break;
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
const CANONICAL_TAG = tagPattern([
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["']canonical["']` },
      { gap: "[^>]*", attr: `href${ATTR_EQ}["']([^"']*)["']` },
    ],
  },
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `href${ATTR_EQ}["']([^"']*)["']` },
      { gap: "[^>]*", attr: `rel${ATTR_EQ}["']canonical["']` },
    ],
  },
]);

/**
 * Known safe Shopify-native Liquid variables used in canonical hrefs.
 * These resolve to valid URLs and should not trigger an "unresolved variable" finding.
 *
 * This is the head of the former SAFE_CANONICAL_VARS_RE,
 * /\{\{\s*(canonical_url|request\.path|shop\.url|page_url|url)\s*(\|[^}]*)?\}\}/,
 * whose optional filter chain and closing `}}` hasSafeCanonicalVar checks
 * separately (that regex rescanned the filter chain from every `{{`: gc-t7x).
 */
const SAFE_CANONICAL_VAR_HEAD_RE =
  /\{\{\s*(?:canonical_url|request\.path|shop\.url|page_url|url)\s*/y;

/**
 * Same result as the former SAFE_CANONICAL_VARS_RE.test(href), in linear time.
 * A match is a `{{`, the head above, then either `}}` or `|` and a filter chain
 * up to `}}`, with no `}` before the closing `}}`. So it starts at some `{{`
 * inside a Liquid output token (liquidOutputSpans) and ends at that token's
 * `}}`: after the head, the next char must be the token's closing `}` or a `|`.
 * Each head test stops at the first char that is neither whitespace nor part of
 * a name, and the head holds no `{`, so the next `{{` tried lies past it: the
 * total work stays linear.
 */
function hasSafeCanonicalVar(href: string): boolean {
  for (const [start, end] of liquidOutputSpans(href)) {
    for (let open = start; open !== -1 && open < end - 2; open = href.indexOf("{{", open + 1)) {
      SAFE_CANONICAL_VAR_HEAD_RE.lastIndex = open;
      if (!SAFE_CANONICAL_VAR_HEAD_RE.test(href)) continue;
      const next = SAFE_CANONICAL_VAR_HEAD_RE.lastIndex;
      if (next === end - 2 || href[next] === "|") return true;
    }
  }
  return false;
}

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
export function detectGhostCanonical(
  file: ThemeFile,
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Collect all canonical occurrences for duplicate detection
  const allCanonicals: Array<{ lineNumber: number; href: string }> = [];

  // Precompute the lines to skip from a single line pass, then run CANONICAL_TAG
  // against the FULL file content so multi-line / prettier-wrapped tags like:
  //   <link
  //     rel="canonical"
  //     href="">
  // are matched. lineNumberAtOffset maps each match offset back to a line, and
  // a match is skipped if its start line falls inside a {% comment %} block or
  // contains a Liquid conditional — preserving the prior per-line semantics.
  // CANONICAL_TAG is a single regex (rel-first | href-first alternation), so each
  // tag yields exactly one match — no double-count risk.
  const commentSkipLines = buildCommentSkipLines(file.content);
  const conditionalLines = new Set<number>();
  for (const { lineNumber, text } of lines(file.content)) {
    if (LIQUID_CONDITIONAL_RE.test(text)) conditionalLines.add(lineNumber);
  }

  // Isolate each <link ...> tag first (linear, non-backtracking), then apply
  // CANONICAL_TAG to the bounded tag text. Multi-line / prettier-wrapped tags are
  // still matched. lineNumberAtOffset maps each match offset back to a line.
  for (const { tag, offset } of extractTags(file.content, "<link")) {
    const collectMatch = execTagPattern(tag, CANONICAL_TAG);
    if (!collectMatch) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + collectMatch.index);
    if (commentSkipLines.has(lineNumber)) continue; // inside {% comment %} block
    if (conditionalLines.has(lineNumber)) continue; // theme-native conditional logic

    // Group 1 captures href when rel comes first; group 2 when href comes first.
    const href = collectMatch[1] ?? collectMatch[2] ?? "";
    allCanonicals.push({ lineNumber, href });
  }

  // Track which lines already have a finding to avoid double-reporting
  const reportedLines = new Set<number>();

  const appNameAt = lineAppNamer();

  // Early exit (gc-ypk). Every line holding a canonical other than the first
  // yields at least one finding: a check 1-3 hit, or else check 5 flags each of
  // its canonicals as a duplicate. So once `limit` such lines have been fully
  // examined, `limit` findings are guaranteed on them and nothing on a later
  // line can rank in the first `limit` by line (the caller sorts by line,
  // stable, and truncates): stop at that line boundary. Stopping only at a
  // boundary keeps reportedLines (keyed by line) complete for every examined
  // line, so check 5 below stays exact for them.
  let dupLineBound = Number.POSITIVE_INFINITY;
  let emittingLines = 0;
  for (let i = 0; i < allCanonicals.length; i++) {
    const newLine = i > 0 && allCanonicals[i].lineNumber !== allCanonicals[i - 1].lineNumber;
    if (newLine && emittingLines >= limit) {
      dupLineBound = allCanonicals[i].lineNumber;
      break;
    }
    if (i === 1 || newLine) emittingLines++;
    const { lineNumber, href } = allCanonicals[i];
    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Check 1: Empty or whitespace-only href
    if (/^\s*$/.test(href)) {
      const appName = appNameAt(lineNumber, codeSnippet);
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
    if (liquidOutputSpans(href).length > 0 && !hasSafeCanonicalVar(href)) {
      const appName = appNameAt(lineNumber, codeSnippet);
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
    const appName = appNameAt(lineNumber, codeSnippet);
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
    let duplicates = 0;
    for (let i = 1; i < allCanonicals.length && duplicates < limit; i++) {
      const { lineNumber } = allCanonicals[i];
      if (lineNumber >= dupLineBound) break;
      if (reportedLines.has(lineNumber)) continue; // Already reported for another reason

      const codeSnippet = buildSnippet(file.content, lineNumber);
      const appName = appNameAt(lineNumber, codeSnippet);
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
      duplicates++;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_TITLE
// ---------------------------------------------------------------------------

/**
 * `<title>...</title>` delimiters for extractTagBlocks (the inner content may
 * span lines). Module-scope /g regexes; extractTagBlocks sets lastIndex itself.
 */
const TITLE_OPEN_RE = /<title/gi;
const TITLE_CLOSE_RE = /<\/title>/gi;

/**
 * Matches an `<svg ...>` open tag or `</svg>` close tag. The lookahead stops
 * custom elements such as `<svg-icon>` from matching. Group 1 is "/" on close.
 * `[^<>]*` (not `[^>]*`) ends each attempt at the next `<`, so a flood of
 * unterminated `<svg ` opens stays linear instead of rescanning to EOF.
 */
const SVG_TAG_RE = /<(\/?)svg(?=[\s/>])[^<>]*>/gi;

/**
 * Returns merged, start-sorted [start, end) offset ranges covered by closed
 * `<svg>...</svg>` elements. A `<title>` inside an SVG is the graphic's
 * accessible name, not the document title, so GHOST_TITLE ignores it.
 *
 * Only matched pairs count: an unclosed `<svg>` is malformed markup and covers
 * nothing, so a genuine document title after it is still inspected. One regex
 * pass plus a sort over the (few) SVG ranges keeps this linear in file size.
 */
function closedSvgRanges(content: string): Array<[number, number]> {
  const openStack: number[] = [];
  const ranges: Array<[number, number]> = [];
  let tag: RegExpExecArray | null;
  SVG_TAG_RE.lastIndex = 0;
  while ((tag = SVG_TAG_RE.exec(content)) !== null) {
    if (tag[1] !== "/") {
      openStack.push(tag.index);
      continue;
    }
    const openOffset = openStack.pop();
    if (openOffset !== undefined) ranges.push([openOffset, tag.index + tag[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

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
  // Theme section/block objects (settings the merchant edits in the editor)
  "section(?:\\.\\w+)*",
  "block(?:\\.\\w+)*",
  // A quoted locale key through the translation filter renders theme locale
  // text, e.g. stock gift_card: {{ 'gift_cards.issued.title' | t: value: ... }}
  // The lookahead only requires the FIRST filter to be t/translate (the shared
  // filter-chain suffix consumes its arguments); the trailing word boundary
  // stops `t` matching an app filter like `| toxicapp_title`.
  "(?:'[^'}]*'|\"[^\"}]*\")(?=\\s*\\|\\s*(?:t|translate)\\b)",
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
 *   - Skips <title> elements inside a closed <svg> (accessible icon names)
 */
export function detectGhostTitle(
  file: ThemeFile,
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const isLayoutFile = file.filename.startsWith("layout/");
  const contentLines = file.content.split("\n");

  // Build a set of line numbers inside Liquid comment blocks (shared helper)
  const commentedLines = buildCommentSkipLines(file.content);

  // Collect all title occurrences for duplicate detection
  const allTitles: Array<{
    lineNumber: number;
    innerContent: string;
    offset: number;
  }> = [];

  // Titles arrive in increasing offset order, so one forward-moving cursor over
  // the sorted SVG ranges answers "inside an SVG?" in linear total time.
  const svgRanges = closedSvgRanges(file.content);
  let svgCursor = 0;

  // Per-line memo: many titles packed on one long line must not re-test it.
  const conditionalLine = new Map<number, boolean>();

  for (const { offset, inner: innerContent } of extractTagBlocks(
    file.content,
    TITLE_OPEN_RE,
    TITLE_CLOSE_RE,
  )) {
    // Skip SVG accessible-name titles (not document titles)
    while (svgCursor < svgRanges.length && svgRanges[svgCursor][1] <= offset) svgCursor++;
    if (svgCursor < svgRanges.length && svgRanges[svgCursor][0] <= offset) continue;

    const matchLineNumber = lineNumberAtOffset(file.content, offset);

    // Skip titles inside Liquid comment blocks
    if (commentedLines.has(matchLineNumber)) continue;

    // Skip titles inside Liquid conditionals
    let isConditional = conditionalLine.get(matchLineNumber);
    if (isConditional === undefined) {
      isConditional = LIQUID_CONDITIONAL_RE.test(contentLines[matchLineNumber - 1] ?? "");
      conditionalLine.set(matchLineNumber, isConditional);
    }
    if (isConditional) continue;

    allTitles.push({
      lineNumber: matchLineNumber,
      innerContent,
      offset,
    });
  }

  // Track which entries already have a finding to avoid double-reporting
  const reportedIndices = new Set<number>();

  const appNameAt = lineAppNamer();

  // Early exit (gc-ypk). Every title after the first yields exactly one finding
  // (a check 1-3 hit, or else check 4 flags it as a duplicate). So once more
  // than `limit` titles have been examined, `limit` findings are guaranteed on
  // their lines and nothing on a LATER line can rank in the first `limit` by
  // line (the caller sorts by line, stable, and truncates): stop at the next
  // line boundary (ties on one line keep emission order, so the whole line must
  // be examined). Check 4 then visits only the examined titles, whose
  // reportedIndices are complete, and stops after `limit` duplicates.
  let examined = allTitles.length;
  for (let i = 0; i < allTitles.length; i++) {
    if (i > limit && allTitles[i].lineNumber !== allTitles[i - 1].lineNumber) {
      examined = i;
      break;
    }
    const { lineNumber, innerContent } = allTitles[i];
    const codeSnippet = buildSnippet(file.content, lineNumber);

    // Check 1: Empty or whitespace-only title content (layout files only)
    if (/^\s*$/.test(innerContent) && isLayoutFile) {
      const appName = appNameAt(lineNumber, codeSnippet);
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
    const allVarsInTitle = liquidOutputTokens(innerContent);
    if (allVarsInTitle.length > 0) {
      // If ALL Liquid vars in the title are safe, skip
      const hasUnsafeVar = allVarsInTitle.some((v) => !SAFE_TITLE_VARS_RE.test(v));

      if (hasUnsafeVar) {
        const appName = appNameAt(lineNumber, codeSnippet);
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
    const appName = appNameAt(lineNumber, codeSnippet);
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
    let duplicates = 0;
    for (let i = 1; i < examined && duplicates < limit; i++) {
      if (reportedIndices.has(i)) continue; // Already reported for another reason

      const { lineNumber } = allTitles[i];
      const codeSnippet = buildSnippet(file.content, lineNumber);
      const appName = appNameAt(lineNumber, codeSnippet);
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
      duplicates++;
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
const OG_META_TAG = tagPattern([
  {
    tag: "<meta",
    steps: [
      {
        gap: "\\s+[^>]*",
        attr: `(?:property${ATTR_EQ}["'](og:[^"']+)["']|name${ATTR_EQ}["'](twitter:[^"']+)["'])`,
      },
    ],
  },
]);

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
export function detectGhostOg(
  file: ThemeFile,
  limit = Number.POSITIVE_INFINITY,
): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  const contentLines = file.content.split("\n");

  // Build a set of line numbers inside Liquid comment blocks (shared helper)
  const commentedLines = buildCommentSkipLines(file.content);
  const conditionalLine = new Map<number, boolean>();

  // Isolate each <meta ...> tag first (linear, non-backtracking), then apply
  // OG_META_TAG to the bounded tag text. lineNumberAtOffset maps the match offset
  // back to a line.
  for (const { tag, offset } of extractTags(file.content, "<meta")) {
    // Early exit (gc-ypk): tags arrive in offset (= line) order, so the first
    // `limit` findings are the first `limit` by line.
    if (findings.length >= limit) break;
    const match = execTagPattern(tag, OG_META_TAG);
    if (!match) continue;

    // Group 1 captures og:* via property, group 2 captures twitter:* via name
    const property = match[1] ?? match[2];
    if (!property) continue;

    const matchLineNumber = lineNumberAtOffset(file.content, offset + match.index);

    // Skip OG tags inside Liquid comment blocks
    if (commentedLines.has(matchLineNumber)) continue;

    // Skip OG tags inside Liquid conditionals (memoized per line: many tags on
    // one long line must not re-test it, gc-t7x)
    let isConditional = conditionalLine.get(matchLineNumber);
    if (isConditional === undefined) {
      isConditional = LIQUID_CONDITIONAL_RE.test(contentLines[matchLineNumber - 1] ?? "");
      conditionalLine.set(matchLineNumber, isConditional);
    }
    if (isConditional) continue;

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
    const allVars = liquidOutputTokens(contentValue);
    if (allVars.length > 0) {
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
 * reversed attribute order (href before rel). Evaluated per tag by
 * execTagPattern.
 */
const PRECONNECT_TAG = tagPattern([
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["'](preconnect|dns-prefetch|preload)["']` },
      { gap: "[^>]+", attr: `href${ATTR_EQ}${QUOTED_VALUE}` },
    ],
  },
  {
    tag: "<link",
    steps: [
      { gap: "[^>]+", attr: `href${ATTR_EQ}${QUOTED_VALUE}` },
      { gap: "[^>]+", attr: `rel${ATTR_EQ}["'](preconnect|dns-prefetch|preload)["']` },
    ],
  },
]);

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

  // Isolate each <link ...> tag first (linear, non-backtracking), then apply
  // PRECONNECT_TAG to the bounded tag text. Multi-line <link> tags (e.g. from
  // Prettier-formatted theme files) are still matched. lineNumberAtOffset maps
  // each match offset back to a 1-based line number for skip-set checking.
  for (const { tag, offset } of extractTags(file.content, "<link")) {
    const match = execTagPattern(tag, PRECONNECT_TAG);
    if (!match) continue;

    const lineNumber = lineNumberAtOffset(file.content, offset + match.index);
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
 * The `font-family` declaration of the former FONT_FACE_RE,
 * /@font-face\s*\{[^}]*font-family\s*:\s*["']?([^"';}\n]+)["']?/gi (whose
 * opener is FONT_FACE_OPEN_RE), as a sticky matcher, plus its keyword.
 */
const FONT_FAMILY_DECL_RE = /font-family\s*:\s*["']?([^"';}\n]+)["']?/iy;
const FONT_FAMILY_WORD_RE = /font-family/gi;

/**
 * The declared font families of the `@font-face` rules in `text`, identical to
 * the group-1 captures of the former FONT_FACE_RE but linear (gc-t7x).
 *
 * For an opener ending at `e`, the regex's greedy `[^}]*` runs to the next `}`
 * (or the end) at `c` and backtracks, so it matches the RIGHTMOST position in
 * [e, c) where the declaration matches, then resumes after that declaration.
 * The regex redid that scan for every opener: quadratic on a flood of openers
 * in one brace-free run. Here the rightmost declaration before each `c` is
 * found once and memoized: later openers have a larger `e`, so the answer for
 * them is the same declaration if it starts at or after their `e`, else none.
 */
function fontFaceFamilies(text: string): string[] {
  const families: string[] = [];
  const keywords: number[] = [];
  FONT_FAMILY_WORD_RE.lastIndex = 0;
  let word: RegExpExecArray | null;
  while ((word = FONT_FAMILY_WORD_RE.exec(text)) !== null) keywords.push(word.index);

  // `}` lookups only move forward; cache the last hit and the first miss.
  let lastBrace = -1;
  let noBraceFrom = Infinity;
  const regionEnd = (from: number): number => {
    if (lastBrace >= from) return lastBrace;
    if (from >= noBraceFrom) return text.length;
    const brace = text.indexOf("}", from);
    if (brace === -1) {
      noBraceFrom = from;
      return text.length;
    }
    lastBrace = brace;
    return brace;
  };
  const rightmostDecl = new Map<number, { at: number; family: string; end: number } | null>();

  FONT_FACE_OPEN_RE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = FONT_FACE_OPEN_RE.exec(text)) !== null) {
    const e = open.index + open[0].length;
    const c = regionEnd(e);
    if (!rightmostDecl.has(c)) {
      // Last keyword before c, then walk left while still inside [e, c).
      let lo = 0;
      let hi = keywords.length - 1;
      let k = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (keywords[mid] < c) {
          k = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      let found: { at: number; family: string; end: number } | null = null;
      for (; k >= 0 && keywords[k] >= e; k--) {
        FONT_FAMILY_DECL_RE.lastIndex = keywords[k];
        const decl = FONT_FAMILY_DECL_RE.exec(text);
        if (decl) {
          found = { at: keywords[k], family: decl[1], end: FONT_FAMILY_DECL_RE.lastIndex };
          break;
        }
      }
      rightmostDecl.set(c, found);
    }
    const decl = rightmostDecl.get(c);
    if (decl && decl.at >= e) {
      families.push(decl.family);
      FONT_FACE_OPEN_RE.lastIndex = decl.end;
    } else {
      FONT_FACE_OPEN_RE.lastIndex = open.index + 1;
    }
  }
  return families;
}

/**
 * Matches <link> tags loading from font services (Google Fonts, etc.).
 * Handles both attribute orderings (href before rel and rel before href).
 * Evaluated per tag by execTagPattern.
 *
 * The catch-all alternative used to be `["'](https?:\/\/[^"']*font[^"']*)["']`.
 * With no closing quote, that regex rescanned to the end of the tag for every
 * `font` in the value (a 1 MB href took > 25s). The value runs to the first
 * quote either way, so a lookahead that finds `font` before that quote in one
 * forward scan, followed by a plain `[^"']*` capture, accepts exactly the same
 * values and captures the same text.
 */
const FONT_LINK_TAG = tagPattern([
  {
    tag: "<link",
    steps: [
      {
        gap: "[^>]+",
        attr: `href${ATTR_EQ}["'](https?:\\/\\/fonts\\.googleapis\\.com\\/[^"']+)["']`,
      },
    ],
  },
  {
    tag: "<link",
    steps: [
      {
        gap: "[^>]+",
        attr: `href${ATTR_EQ}["'](?=https?:\\/\\/[^"']*?font)(https?:\\/\\/[^"']*)["']`,
      },
    ],
  },
]);

/**
 * Every tag attribute pattern, exported so tests can pin each one's regex
 * source to the regex it replaced and check execTagPattern against that regex.
 */
export const TAG_PATTERNS = {
  SCRIPT_SRC_TAG,
  LINK_STYLESHEET_TAG,
  HREFLANG_TAG_1,
  HREFLANG_TAG_2,
  META_TAG,
  META_ROBOTS_TAG,
  CANONICAL_TAG,
  OG_META_TAG,
  PRECONNECT_TAG,
  FONT_LINK_TAG,
};

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

  // Comment-line tracking is delegated to the shared helper so Font skips the
  // same lines as every other comment-aware detector. Previously this detector's
  // inline loop `continue`d on the endcomment branch, so it OVER-skipped a
  // stray/opener-less `{% endcomment %}` line — a false negative that swallowed
  // real ghost-font content sharing that line. buildCommentSkipLines only skips
  // lines that OPEN a comment or sit INSIDE one, so a stray endcomment line is
  // scanned; Font now correctly scans it too, matching all other detectors.
  const commentSkipLines = buildCommentSkipLines(file.content);

  for (const { lineNumber, text } of lines(file.content)) {
    if (commentSkipLines.has(lineNumber)) continue;

    // Skip lines with Liquid conditionals — these are theme-native logic
    if (LIQUID_CONDITIONAL_RE.test(text)) continue;

    // Check for @font-face declarations
    for (const family of fontFaceFamilies(text)) {
      const codeSnippet = buildSnippet(file.content, lineNumber);

      // Only flag if we can attribute to a known app
      const appName = identifyAppFromCode(codeSnippet) ?? undefined;
      if (!appName) continue;

      const fontFamily = family.trim();
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

    // Check for font service <link> tags — isolate each <link ...> tag first
    // (linear, non-backtracking), then apply FONT_LINK_TAG to the bounded tag.
    for (const { tag } of extractTags(text, "<link")) {
      const linkMatch = execTagPattern(tag, FONT_LINK_TAG);
      if (!linkMatch) continue;

      const href = linkMatch[1] ?? linkMatch[2];
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
 *     layout/, blocks/) and emits GHOST_SCRIPT, GHOST_STYLE, GHOST_SNIPPET,
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
 *   Pass 5 — cross-file duplicate-library / tracker / chat-widget detection:
 *     Re-extracts external <script> src URLs from RAW file content across all
 *     files and flags any public-CDN library loaded at two or more distinct
 *     MAJOR versions (e.g. Swiper v8 + v11).  Emits one DUPLICATE_LIBRARY
 *     finding per conflicting library.  Also flags any analytics platform
 *     configured with two or more distinct IDs (DUPLICATE_TRACKER) and any two
 *     or more distinct chat-widget platforms present at once
 *     (OVERLAPPING_CHAT_WIDGET).
 *
 * Returns all findings (all passes) ready for createFindings().
 */
/**
 * The first `n` findings by line: a stable sort by lineNumber (ties keep their
 * emission order), then truncate. This is the cap order (gc-ypk): a
 * deterministic function of the file content, so rescans of an unchanged file
 * keep the same findings and their fingerprints.
 */
function firstFindingsByLine(findings: CreateFindingInput[], n: number): CreateFindingInput[] {
  return [...findings].sort((a, b) => a.lineNumber - b.lineNumber).slice(0, n);
}

/**
 * The `limit` passed to detectors that can stop early (gc-ypk). One past the cap,
 * so a detector returning more than the cap proves the file really exceeded it
 * (a file with exactly MAX_FINDINGS_PER_FILE_PER_TYPE findings is not a cap hit).
 */
const EARLY_EXIT_LIMIT = MAX_FINDINGS_PER_FILE_PER_TYPE + 1;

export function scanThemeFiles(files: ThemeFile[]): ScanResult {
  const findings: CreateFindingInput[] = [];
  const unknownScripts: UnknownExternalResource[] = [];
  const skippedFiles: SkippedFile[] = [];
  const staticProductCandidates: StaticProductCandidate[] = [];
  // Per-file third-party domain refs, merged per host after the pass (Feature 1).
  const thirdPartyDomainRefs: ThirdPartyDomainRef[] = [];
  // Tally benign public-CDN libraries / web fonts dropped by the collectors so
  // the drop is observable (surfaced by the worker as an ops signal, gc-tus A2).
  const benignSkips: BenignSkipCounter = { count: 0 };

  // Per-file, per-type finding cap (gc-ypk). A tag-dense file can emit tens of
  // thousands of findings of one type at tens of µs each, enough across a few
  // files to hit the scan worker timeout. Keep the first
  // MAX_FINDINGS_PER_FILE_PER_TYPE by line and count the hit (telemetry only,
  // NOT a skipped category). Each detector emits exactly one finding type, so
  // one detector call is one (file, type). Detectors with a `limit` parameter
  // stop early (bounding the work, not just the output); the rest are cheap per
  // finding and are truncated here. MALICIOUS_SCRIPT is never passed through
  // this: the security alert is shown in full on all plans, and its detector is
  // linear and cheap per finding.
  //
  // Known, accepted edge case: in an over-cap file, an edit that shifts which
  // findings are the first N (e.g. a new line near the top) pushes a
  // still-present finding past the cap, and the differ reports it "resolved"
  // (and a later edit can bring it back as "new"). Accepted because it needs a
  // file with more than 200 findings of one type (prod max is ~26 per SCAN, so
  // orders of magnitude below), and the proper fix means persisting the capped
  // (file, type) pairs so the differ can exclude them like a skipped category.
  const findingCapHits: Partial<Record<FindingType, number>> = {};
  const capped = (detected: CreateFindingInput[]): CreateFindingInput[] => {
    if (detected.length <= MAX_FINDINGS_PER_FILE_PER_TYPE) return detected;
    const type = detected[0].findingType;
    findingCapHits[type] = (findingCapHits[type] ?? 0) + 1;
    return firstFindingsByLine(detected, MAX_FINDINGS_PER_FILE_PER_TYPE);
  };

  // Pass 1: per-file ghost code detection
  for (const file of files) {
    const scannable = isScannableFile(file.filename);

    // File-size guard (gc-06e.2): a single oversized scannable file is anomalous
    // (real theme Liquid files are far under MAX_SCANNABLE_FILE_BYTES) and would
    // let a pathological blob dominate detector cost. Skip the per-file detectors
    // for it and record the skip so the caller logs it — never a silent drop. The
    // cross-file passes below still include the file (they are linear; Pass 5's
    // duplicate-library scan is pinned on >1 MB input, gc-tus.11).
    // Because those passes still emit for a skipped file, the differ must NOT
    // treat a skipped file's cross-file findings as unre-checked — the set of
    // cross-file types lives in CROSS_FILE_FINDING_TYPES (finding-classification);
    // update it when adding a new cross-file pass (Pass 2 / Pass 4 below).
    const oversized = scannable && file.content.length > MAX_SCANNABLE_FILE_BYTES;
    if (oversized) {
      skippedFiles.push({ filename: file.filename, size: file.content.length });
    }

    // Malicious-domain-only pass: (a) non-Liquid files that can still carry
    // injected code (gc-3pd) and (b) oversized scannable files, so padding a file
    // past the cap cannot hide a malicious alert (gc-qqt). The detector is linear
    // (safe on unbounded input); no other detector runs on these files, and the
    // differ exempts MALICIOUS_SCRIPT from its skipped-file exclusion
    // (SIZE_SKIP_STILL_SCANNED_FINDING_TYPES in finding-classification).
    if (oversized || isMaliciousScanOnlyFile(file.filename)) {
      findings.push(...detectMaliciousScripts(file));
      continue;
    }
    if (!scannable) continue;

    findings.push(...capped(detectGhostScripts(file)));
    findings.push(...capped(detectGhostStyles(file)));
    findings.push(...capped(detectGhostSnippets(file)));
    findings.push(...capped(detectGhostSections(file)));
    findings.push(...capped(detectGhostHrefLang(file)));
    findings.push(...capped(detectDuplicateMetaTags(file, EARLY_EXIT_LIMIT)));
    findings.push(...capped(detectGhostJsonLd(file)));
    findings.push(...capped(detectInvalidJsonLd(file)));
    findings.push(...detectMaliciousScripts(file)); // uncapped, see findingCapHits
    findings.push(...capped(detectJsonLdConflicts(file)));
    findings.push(...capped(detectGhostTextFragments(file)));
    findings.push(...capped(detectGhostPixels(file)));
    findings.push(...capped(detectGhostRobots(file, EARLY_EXIT_LIMIT)));
    findings.push(...capped(detectGhostCanonical(file, EARLY_EXIT_LIMIT)));
    findings.push(...capped(detectGhostTitle(file, EARLY_EXIT_LIMIT)));
    findings.push(...capped(detectGhostOg(file, EARLY_EXIT_LIMIT)));
    findings.push(...capped(detectGhostPreconnect(file)));
    findings.push(...capped(detectGhostFont(file)));
    findings.push(...capped(detectGhostAjax(file)));

    // Collect unrecognized external resources (benign libraries are dropped and
    // counted into benignSkips rather than emitted).
    unknownScripts.push(...collectUnknownScripts(file, benignSkips));
    unknownScripts.push(...collectUnknownStylesheets(file, benignSkips));

    // Collect the full third-party domain graph (Feature 1). Unlike the unknown-
    // resource collectors this keeps EVERY non-Shopify host — matched-to-app,
    // benign, and unknown — for the signature flywheel + market intel.
    thirdPartyDomainRefs.push(...collectThirdPartyDomains(file));

    // Collect unsigned static Product JSON-LD blocks for the live-price audit
    // (gc-47c.10). No findings are emitted here — the (scope+flag-gated) audit
    // step compares these against LIVE product prices later.
    staticProductCandidates.push(...extractStaticProductCandidates(file));
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

  // Pass 3: settings data drift detection. The only cross-file pass that can
  // emit unbounded findings (one per stale section key in settings_data.json,
  // all attributed to that one file), so it takes the same cap. The other
  // cross-file passes emit at most one finding per theme file (orphan, layout)
  // or per catalog entry (duplicate library / tracker / chat widget).
  findings.push(...capped(detectSettingsDrift(files, EARLY_EXIT_LIMIT)));

  // Pass 4: page builder layout detection
  findings.push(...detectGhostLayouts(files));

  // Pass 5: cross-file duplicate-library detection (reads RAW script URLs, not
  // the suppression-filtered unknownScripts array — see detectDuplicateLibraries).
  findings.push(...detectDuplicateLibraries(files));

  // Pass 5 (cont.): cross-file tracker / chat-widget conflict detection. Both are
  // cross-file, distinct-signal-only detectors attributed to a first-seen theme
  // file (see CROSS_FILE_FINDING_TYPES in finding-classification).
  findings.push(...detectDuplicateTrackers(files));
  findings.push(...detectOverlappingChatWidgets(files));

  // Aggregate the third-party domain refs per host across all files: union the
  // source surfaces, sum refCount. A matched host wins over benign (matched
  // carries an appName and is never also benign); the first non-null appName is
  // kept for a host matched in more than one file.
  const domainAgg = new Map<
    string,
    {
      sources: Set<string>;
      refCount: number;
      matched: boolean;
      appName: string | null;
      benign: boolean;
    }
  >();
  for (const ref of thirdPartyDomainRefs) {
    let e = domainAgg.get(ref.domain);
    if (!e) {
      e = { sources: new Set(), refCount: 0, matched: false, appName: null, benign: false };
      domainAgg.set(ref.domain, e);
    }
    for (const s of ref.sources) e.sources.add(s);
    e.refCount += ref.refCount;
    if (ref.matched) {
      e.matched = true;
      if (e.appName === null) e.appName = ref.appName;
    }
    if (ref.benign) e.benign = true;
  }
  const thirdPartyDomains: ThirdPartyDomainRef[] = [...domainAgg.entries()].map(([domain, e]) => ({
    domain,
    sources: [...e.sources].sort(),
    refCount: e.refCount,
    matched: e.matched,
    appName: e.matched ? e.appName : null,
    benign: e.matched ? false : e.benign,
  }));

  return {
    findings,
    unknownScripts,
    skippedFiles,
    staticProductCandidates,
    benignLibrarySkips: benignSkips.count,
    thirdPartyDomains,
    findingCapHits,
  };
}
