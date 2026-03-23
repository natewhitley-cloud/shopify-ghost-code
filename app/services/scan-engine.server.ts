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
 */

import { FindingType } from "@prisma/client";

import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromHrefLang,
  identifyAppFromJsonLd,
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
 *     GHOST_SECTION, GHOST_HREFLANG, DUPLICATE_META, and GHOST_JSON_LD findings.
 *
 *   Pass 2 — cross-file orphan detection (new):
 *     Runs the file reference analyzer over all Liquid files (not just
 *     scannable ones) to find snippets that are never referenced by any
 *     template, section, layout, or other snippet.  Emits ORPHAN_ASSET
 *     findings for each unreferenced snippet file.
 *
 * Returns all findings (both passes) ready for createFindings().
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

  return { findings, unknownScripts };
}
