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
 *   GHOST_REDIRECT — orphaned URL redirects left by SEO apps (detected via
 *                    separate API-based redirect-detector service)
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

// ---------------------------------------------------------------------------
// Detector: GHOST_SCRIPT
// ---------------------------------------------------------------------------

// Matches <script src="https://..." or <script src='//...'> (external URLs)
// IMPORTANT: Module-scope regex with /g flag — MUST reset lastIndex = 0 before
// each use to avoid stale state between calls. See each detector function below.
const SCRIPT_SRC_RE = /<script[^>]+src\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>/gi;

export function detectGhostScripts(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    SCRIPT_SRC_RE.lastIndex = 0;

    while ((match = SCRIPT_SRC_RE.exec(text)) !== null) {
      const url = match[1];
      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (!appName) continue;

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

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    LINK_STYLESHEET_RE.lastIndex = 0;

    while ((match = LINK_STYLESHEET_RE.exec(text)) !== null) {
      // Group 1 captures href when rel comes first; group 3 when href comes first.
      const url = match[1] ?? match[3];
      if (!url) continue;

      const appName = identifyAppFromUrl(url) ?? identifyAppFromCode(url);
      if (!appName) continue;

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
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: GHOST_SNIPPET
// ---------------------------------------------------------------------------

// Matches {% render 'name' %}, {% render "name" %}, {% include 'name' %}, {% include "name" %}
// Also handles optional whitespace-stripping dashes: {%- render ... -%}
const RENDER_RE = /\{%-?\s*(?:render|include)\s+["']([^"']+)["']/gi;

export function detectGhostSnippets(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    RENDER_RE.lastIndex = 0;

    while ((match = RENDER_RE.exec(text)) !== null) {
      const snippetName = match[1];
      const appName = identifyAppFromSnippetName(snippetName);
      if (!appName) continue;

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
    }
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

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    SECTION_RE.lastIndex = 0;

    while ((match = SECTION_RE.exec(text)) !== null) {
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

  for (const { lineNumber, text } of lines(file.content)) {
    // Pattern 1: hreflang before href — groups: [1]=lang, [2]=href
    let match: RegExpExecArray | null;
    HREFLANG_RE_1.lastIndex = 0;

    while ((match = HREFLANG_RE_1.exec(text)) !== null) {
      const lang = match[1];
      const href = match[2];
      const appName = identifyAppFromHrefLang(href);
      if (!appName) continue;

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

    while ((match = HREFLANG_RE_2.exec(text)) !== null) {
      const href = match[1];
      const lang = match[2];
      const appName = identifyAppFromHrefLang(href);
      if (!appName) continue;

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
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector: DUPLICATE_META
// ---------------------------------------------------------------------------

// Matches <meta ... name="X" ...> or <meta ... property="X" ...>
// Captures the name/property attribute value regardless of attribute order.
const META_TAG_RE = /<meta\s+[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*>/gi;

export function detectDuplicateMetaTags(file: ThemeFile): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Build a map of (name/property value) → array of occurrences
  const occurrences = new Map<string, Array<{ lineNumber: number; text: string }>>();

  for (const { lineNumber, text } of lines(file.content)) {
    let match: RegExpExecArray | null;
    META_TAG_RE.lastIndex = 0;

    while ((match = META_TAG_RE.exec(text)) !== null) {
      const attrValue = match[1].toLowerCase();
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
      try {
        const hostname = new URL(url).hostname;
        if (SHOPIFY_FIRST_PARTY_RE.test(hostname)) continue;
      } catch {
        continue; // Malformed URL — skip
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
      try {
        const hostname = new URL(url).hostname;
        if (SHOPIFY_FIRST_PARTY_RE.test(hostname)) continue;
      } catch {
        continue; // Malformed URL — skip
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
 *     JSON_LD_CONFLICT, GHOST_TEXT, GHOST_PIXEL, and GHOST_ROBOTS findings.
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
