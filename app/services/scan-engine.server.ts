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
 *
 * Cross-file reference checking (ORPHAN_ASSET) is deferred to ticket .26.
 */

import { FindingType } from "@prisma/client";
import type { CreateFindingInput } from "../models/finding.server";
import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
} from "./app-lookup.server";
import { classifySeverity } from "./severity-classifier.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeFile = { filename: string; content: string };

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

  const SCANNABLE_PREFIXES = [
    "templates/",
    "sections/",
    "snippets/",
    "layout/",
  ];
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
  const start = Math.max(0, lineNumber - 2);         // 0-indexed, one line before
  const end = Math.min(allLines.length, lineNumber + 1); // one line after
  return allLines.slice(start, end).join("\n").slice(0, 300);
}

// ---------------------------------------------------------------------------
// Detector: GHOST_SCRIPT
// ---------------------------------------------------------------------------

// Matches <script src="https://..." or <script src='//...'> (external URLs)
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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scan a set of theme files for ghost code from uninstalled apps.
 *
 * Only processes scannable Liquid files (templates/, sections/, snippets/,
 * layout/).  Returns findings ready for createFindings().
 *
 * Note: ORPHAN_ASSET detection requires cross-file analysis and is deferred
 * to ticket .26.
 */
export function scanThemeFiles(files: ThemeFile[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const file of files) {
    if (!isScannableFile(file.filename)) continue;

    findings.push(...detectGhostScripts(file));
    findings.push(...detectGhostStyles(file));
    findings.push(...detectGhostSnippets(file));
    findings.push(...detectGhostSections(file));
  }

  return findings;
}
