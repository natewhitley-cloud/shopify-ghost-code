// ---------------------------------------------------------------------------
// Detector: LIQUID_ERROR_RENDERED — a missing-snippet Liquid error printed on
// the homepage, CORROBORATED by the theme's own files (gc-i6du)
// ---------------------------------------------------------------------------
//
// PURE, side-effect-free. No Admin API, DB, or network access. Three parts:
//   - buildMissingSnippetIndex(files, otherFilenames): runs in the scan's
//     fetch-and-scan step, where the theme files are in memory. Lists the
//     snippets the theme RENDERS but does NOT CONTAIN, with the files that
//     render them. Small and bounded, so it can cross the step boundary (theme
//     files cannot).
//   - extractRenderedLiquidErrors(html): runs INSIDE the storefront fetcher on
//     the homepage HTML it already holds. Returns only parsed parts (template,
//     line, snippet name). The HTML never leaves the fetcher.
//   - detectLiquidErrors(errors, index): a finding ONLY where both agree.
//
// Why corroboration. Page text alone cannot be trusted: a blog excerpt, a
// review, a tutorial or an FAQ can print the exact words of a Liquid error. A
// blind test of a text-only detector scored 0.74 precision, which is not good
// enough for a finding that tells a merchant their store is broken. So a
// finding now needs ALL of:
//   1. the homepage prints `Could not find asset snippets/<name>.liquid`, in
//      the form Liquid::Error#to_s produces:
//          Liquid error (sections/header line 12): Could not find asset snippets/<name>.liquid
//          Liquid error: Could not find asset snippets/<name>.liquid
//   2. `snippets/<name>.liquid` does NOT exist in the scanned (published) theme;
//   3. a theme file renders it (`{% render 'name' %}`, `{% include "name" %}`,
//      `{%- render 'name' -%}`, or `render 'name'` inside `{% liquid %}`) in
//      Liquid that RUNS: a render inside a comment, `{% raw %}`, `{% schema %}`
//      or `{% doc %}` never executes, so it cannot print the error and does
//      not count (blankNonExecutingLiquid);
//   4. when the error names a file, THAT file is one the index lists as
//      rendering it.
// With 2-4 true, Shopify does print that error wherever the file is rendered,
// so the page text is confirmed by the theme rather than believed.
//
// Everything else is dropped silently, on purpose: every other Liquid error
// (syntax errors, "divided by 0", memory limits, app-block errors under
// shopify://apps/...) and every uncorroborated match. A missed error is
// acceptable here; a false one is not.
//
// What is kept. Nothing from the page is stored as-is. The finding's text is
// REBUILT by us in a fixed shape from three parsed parts, each restricted to
// [A-Za-z0-9._/-] and bounded: the template path, the line number (digits) and
// the snippet name. No text that follows the error on the page can reach the
// database, a log or a later reader (so no shopper text, and nothing a page
// could plant for a model to read). Control, bidi and zero-width characters
// are stripped as well, although the character classes already exclude them.
//
// Where a match is read. Only text nodes outside these are scanned: tags and
// their attributes, comments, <script>, <style>, <textarea>, <title>, <iframe>,
// <noscript>, <template>, <code>, <pre>, <samp>, <kbd>, <blockquote>, <q>,
// <del>, <svg>, <select>, <option>. These are cheap extra guards (quoted
// examples, non-rendered content); corroboration is the real one.
//
// "On the homepage", not "shoppers see": the error is in the page, but it can
// sit inside a closed menu, a drawer or a hidden element. The copy says so.

import { FindingType, Severity } from "@prisma/client";

import { identifyAppFromSnippetName } from "./app-lookup.server";
import type { CreateFindingInput } from "../models/finding.server";

/** Synthetic locator for every LIQUID_ERROR_RENDERED finding (not a theme file). */
export const LIQUID_ERROR_FINDING_FILENAME = "storefront/homepage";

/** A snippet name longer than this is not read (no real snippet is). */
export const MAX_SNIPPET_NAME_CHARS = 100;
/** A template path longer than this is not read. */
export const MAX_TEMPLATE_PATH_CHARS = 120;
/** At most this many findings per scan. */
export const MAX_LIQUID_ERRORS = 10;
/** At most this many distinct candidates are read from a page (before corroboration). */
export const MAX_LIQUID_ERROR_CANDIDATES = 50;
/** At most this many "Liquid error" occurrences are examined per page. */
export const MAX_LIQUID_ERROR_MATCHES = 200;
/** Same cap as every other finding's snippet (the privacy policy's stated limit). */
export const MAX_LIQUID_ERROR_SNIPPET_CHARS = 300;

/**
 * Missing snippets kept in the index, and rendering files kept per snippet.
 * Worst case across the step boundary: 50 snippets x 50 paths of at most ~130
 * characters, about 350 KB (see the step-output budget in scan-theme.ts).
 */
export const MAX_MISSING_SNIPPETS = 50;
export const MAX_RENDERING_FILES = 50;
/** A theme file longer than this is not searched for render tags (bounded work). */
export const MAX_RENDER_SCAN_FILE_CHARS = 1_000_000;

/** A missing-snippet error read from the homepage: parsed parts only. */
export interface RenderedLiquidError {
  /** Theme file Liquid names, without ".liquid" (e.g. "sections/header"), or null. */
  template: string | null;
  /** The line number Liquid gives, or null. */
  line: number | null;
  /** The snippet named in "Could not find asset snippets/<name>.liquid". */
  snippet: string;
}

/** A snippet the theme renders but does not contain. */
export interface MissingSnippetRender {
  snippet: string;
  /** Theme files (without ".liquid") that render it, sorted, at most MAX_RENDERING_FILES. */
  renderedIn: string[];
}

/** What buildMissingSnippetIndex returns. */
export interface MissingSnippetIndex {
  /** At most MAX_MISSING_SNIPPETS entries, sorted by snippet name. */
  renders: MissingSnippetRender[];
  /**
   * True when the theme has more missing snippets than `renders` lists, so a
   * real error naming one past the cut would go unconfirmed. The scan records
   * the check as capped (partly checked), never as clean.
   */
  capped: boolean;
}

// ---------------------------------------------------------------------------
// Text safety
// ---------------------------------------------------------------------------

/**
 * Control characters (C0, DEL, C1), zero-width and directional marks, bidi
 * overrides / isolates and the BOM. None can reach a stored string: a NUL
 * would be rejected by Postgres, and the others can hide or reorder text.
 */
const UNSAFE_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Remove control, bidi and zero-width characters. */
export function stripUnsafeChars(value: string): string {
  return value.replace(UNSAFE_CHARS_RE, "");
}

// ---------------------------------------------------------------------------
// Theme side: snippets rendered but missing
// ---------------------------------------------------------------------------

type ThemeFileLike = { filename: string; content: string };

const SNIPPET_FILE_RE = /^snippets\/([A-Za-z0-9._-]{1,100})\.liquid$/;
const LIQUID_FILE_RE =
  /^(?:layout|templates|sections|snippets|blocks)\/[A-Za-z0-9._/-]{1,120}\.liquid$/;

/**
 * `{% render 'name' %}` / `{% include "name" %}` (with or without the `-`
 * whitespace control), or a bare `render 'name'` at the start of a line (a
 * statement inside `{% liquid %}`). Whitespace runs are bounded so a flood of
 * spaces cannot make the search slow. The name is a literal in the restricted
 * charset; a variable (`render snippet_name`) never matches.
 */
const RENDER_TAG_RE =
  /(?:\{%-?[ \t\r\n]{0,200}|^[ \t]{0,200})(?:render|include)[ \t\r\n]{1,200}["']([A-Za-z0-9._-]{1,100})["']/gim;

// --- Liquid that never runs ---

/** What a blanked range is replaced with (see blankNonExecutingLiquid). */
export const BLANKED_LIQUID = "#";

/** Blocks whose body is not parsed: the FIRST closing tag ends them. */
const RAW_BLOCK_END: Readonly<Record<string, string>> = {
  raw: "endraw",
  schema: "endschema",
  doc: "enddoc",
};

/** No tag name read here is longer (the longest is "endcomment"). */
const MAX_TAG_NAME_CHARS = 16;

function isLiquidSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 // _
  );
}

/** The word starting at `from` (not past `to`), cut at MAX_TAG_NAME_CHARS + 1. */
function wordAt(content: string, from: number, to: number): string {
  let end = from;
  while (end < to && end - from <= MAX_TAG_NAME_CHARS && isWordChar(content.charCodeAt(end))) end++;
  return content.slice(from, end);
}

type LiquidTag = {
  /** The tag's name ("comment", "render"...), "#" for an inline comment, or "". */
  name: string;
  /** Index of the tag's `{%`. */
  start: number;
  /** Index just past the name. */
  nameEnd: number;
  /** Index just past the tag's `%}`. */
  end: number;
};

/**
 * The first `{% ... %}` tag at or after `from`, as Liquid's tokenizer cuts it
 * (from `{%` to the first `%}`), or null when no complete tag is left. Names
 * are case-sensitive, as in Liquid. Callers always resume at `end`, and a
 * missing `%}` ends the walk for good, so a whole file is one forward pass.
 */
function nextLiquidTag(content: string, from: number): LiquidTag | null {
  const start = content.indexOf("{%", from);
  if (start === -1) return null;
  const close = content.indexOf("%}", start + 2);
  if (close === -1) return null;
  let at = start + 2;
  if (at < close && content[at] === "-") at++;
  while (at < close && isLiquidSpace(content.charCodeAt(at))) at++;
  if (at < close && content[at] === "#") {
    return { name: "#", start, nameEnd: at + 1, end: close + 2 };
  }
  const name = wordAt(content, at, close);
  return { name, start, nameEnd: at + name.length, end: close + 2 };
}

/**
 * Index just past the tag that closes the block whose opening tag ended at
 * `from`, or the end of the file when it is never closed. `nests` is the
 * `comment` rule of current Liquid: a `comment` inside it must be closed
 * first, and an `endcomment` inside a `raw` block inside it does not count.
 */
function endOfLiquidBlock(content: string, from: number, endName: string, nests: boolean): number {
  let depth = 1;
  let pos = from;
  for (;;) {
    const tag = nextLiquidTag(content, pos);
    if (!tag) return content.length;
    pos = tag.end;
    if (tag.name === endName) {
      if (--depth === 0) return pos;
    } else if (nests && tag.name === "comment") depth++;
    else if (nests && tag.name === "raw") pos = endOfLiquidBlock(content, pos, "endraw", false);
  }
}

/**
 * Inside one `{% liquid %}` tag (`from`..`to`), where each line is a
 * statement: call `blank` for every line from a bare `comment` statement to
 * its `endcomment` (nesting respected). One never closed runs to the end of
 * the tag. The line ends are found by a walk bounded at `to`, never by a
 * search that could run to the end of the file once per tag.
 */
function blankLiquidTagCommentLines(
  content: string,
  from: number,
  to: number,
  blank: (start: number, end: number) => void,
): void {
  let depth = 0;
  let lineStart = from;
  while (lineStart < to) {
    let lineEnd = lineStart;
    while (lineEnd < to && content.charCodeAt(lineEnd) !== 10) lineEnd++;
    let at = lineStart;
    while (at < lineEnd && isLiquidSpace(content.charCodeAt(at))) at++;
    const statement = wordAt(content, at, lineEnd);
    if (statement === "comment") depth++;
    if (depth > 0) blank(lineStart, lineEnd);
    if (statement === "endcomment" && depth > 0) depth--;
    lineStart = lineEnd + 1;
  }
}

/**
 * `content` with the Liquid that never executes taken out, so a render tag
 * inside it cannot corroborate an error:
 *   - `{% comment %}...{% endcomment %}` (nested comments respected);
 *   - `{% raw %}`, `{% schema %}` and `{% doc %}` blocks, each ended by its
 *     FIRST closing tag;
 *   - an inline comment tag, `{% # ... %}`;
 *   - inside `{% liquid %}`, the lines from a bare `comment` statement to its
 *     `endcomment`. (A `# ...` line there needs nothing: it does not start
 *     with `render`, so RENDER_TAG_RE never reads it.)
 * With or without the `-` whitespace control, and with any whitespace inside
 * the tag. A block that is never closed is blanked to the end of the file, for
 * all four block types alike: Liquid would reject such a file rather than run
 * what follows.
 *
 * Each range is replaced by ONE BLANKED_LIQUID character, not removed and not
 * turned into whitespace: the text on either side is never joined into a tag
 * that was not there, and what follows a comment does not become the start of
 * a line (RENDER_TAG_RE reads a line-leading `render 'x'` as a statement).
 *
 * Linear: one forward pass over the tags (nextLiquidTag), no regex.
 */
export function blankNonExecutingLiquid(content: string): string {
  const kept: string[] = [];
  let keptFrom = 0;
  const blank = (start: number, end: number): void => {
    kept.push(content.slice(keptFrom, start), BLANKED_LIQUID);
    keptFrom = end;
  };

  let pos = 0;
  for (;;) {
    const tag = nextLiquidTag(content, pos);
    if (!tag) break;
    pos = tag.end;
    if (tag.name === "#") blank(tag.start, tag.end);
    else if (tag.name === "liquid") {
      blankLiquidTagCommentLines(content, tag.nameEnd, tag.end - 2, blank);
    } else if (tag.name === "comment") {
      pos = endOfLiquidBlock(content, tag.end, "endcomment", true);
      blank(tag.start, pos);
    } else if (Object.hasOwn(RAW_BLOCK_END, tag.name)) {
      pos = endOfLiquidBlock(content, tag.end, RAW_BLOCK_END[tag.name], false);
      blank(tag.start, pos);
    }
  }
  return keptFrom === 0 ? content : kept.join("") + content.slice(keptFrom);
}

/**
 * The snippets a theme renders but does not contain, with the files that
 * render them. Deterministic (sorted) and bounded: at most
 * MAX_MISSING_SNIPPETS snippets (`capped` says when there were more), each
 * with at most MAX_RENDERING_FILES files. Only a render in Liquid that runs is
 * counted (blankNonExecutingLiquid).
 *
 * `otherFilenames`: theme files that exist but are not in `files` because
 * their body was not returned as text (theme-fetcher drops those). A snippet
 * among them EXISTS, so it is never listed as missing.
 */
export function buildMissingSnippetIndex(
  files: readonly ThemeFileLike[],
  otherFilenames: readonly string[] = [],
): MissingSnippetIndex {
  const existing = new Set<string>();
  for (const file of files) {
    const snippet = SNIPPET_FILE_RE.exec(file.filename);
    if (snippet) existing.add(snippet[1]);
  }
  for (const filename of otherFilenames) {
    const snippet = SNIPPET_FILE_RE.exec(filename);
    if (snippet) existing.add(snippet[1]);
  }

  const renderedIn = new Map<string, Set<string>>();
  for (const file of files) {
    if (!LIQUID_FILE_RE.test(file.filename)) continue;
    if (file.content.length > MAX_RENDER_SCAN_FILE_CHARS) continue;
    const path = file.filename.slice(0, -".liquid".length);
    for (const match of blankNonExecutingLiquid(file.content).matchAll(RENDER_TAG_RE)) {
      const name = match[1].endsWith(".liquid") ? match[1].slice(0, -".liquid".length) : match[1];
      if (name.length === 0 || existing.has(name)) continue;
      let paths = renderedIn.get(name);
      if (!paths) renderedIn.set(name, (paths = new Set()));
      paths.add(path);
    }
  }

  const renders = [...renderedIn.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_MISSING_SNIPPETS)
    .map(([snippet, paths]) => ({
      snippet,
      renderedIn: [...paths].sort().slice(0, MAX_RENDERING_FILES),
    }));
  return { renders, capped: renderedIn.size > MAX_MISSING_SNIPPETS };
}

// ---------------------------------------------------------------------------
// Page side: visible text walker
// ---------------------------------------------------------------------------

/**
 * Elements whose content is raw text to the HTML parser: the FIRST closing tag
 * ends them, whatever is inside (a `<script>` cannot nest).
 */
const RAW_TEXT_ELEMENTS = ["script", "style", "textarea", "title", "iframe", "noscript"];
/**
 * Elements skipped with their whole subtree, nesting respected (a `<code>`
 * inside a `<code>` does not end the outer one).
 */
const NESTING_ELEMENTS = [
  "code",
  "pre",
  "samp",
  "kbd",
  "blockquote",
  "q",
  "del",
  "svg",
  "select",
  "option",
  "template",
];

/**
 * Per skipped element: a case-insensitive search for its tags on the ORIGINAL
 * string (never a lower-cased copy: 'İ' lower-cases to two code units, so
 * offsets taken from one string are wrong in the other), with a tag-name
 * boundary so `</code-block>` does not close `<code>`.
 */
type SkipRule = { tags: RegExp; nests: boolean };
const SKIPPED: ReadonlyMap<string, SkipRule> = new Map<string, SkipRule>([
  ...RAW_TEXT_ELEMENTS.map((name): [string, SkipRule] => [
    name,
    { tags: new RegExp(`<(/)${name}(?=[\\s>/])`, "gi"), nests: false },
  ]),
  ...NESTING_ELEMENTS.map((name): [string, SkipRule] => [
    name,
    { tags: new RegExp(`<(/?)${name}(?=[\\s>/])`, "gi"), nests: true },
  ]),
]);

/**
 * Index just past the `>` closing the tag that starts at `lt`. A quote only
 * opens an attribute value right after `=` (as in an HTML parser), so a stray
 * quote (`class="a""`) cannot swallow the tags that follow.
 */
function endOfTag(html: string, lt: number): number {
  let quote = "";
  let afterEquals = false;
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === ">") return i + 1;
    if (ch === "=") afterEquals = true;
    else if (afterEquals && (ch === '"' || ch === "'")) {
      quote = ch;
      afterEquals = false;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") afterEquals = false;
  }
  return html.length;
}

/**
 * The lower-cased element name of the tag at `lt` ("" for a closing tag etc.).
 * Hyphens and colons are part of the name, so `<code-block>` is not `<code>`.
 */
function openingTagName(html: string, lt: number): string {
  let end = lt + 1;
  while (end < html.length && end - lt <= 16 && /[a-zA-Z0-9:-]/.test(html[end])) end++;
  return html.slice(lt + 1, end).toLowerCase();
}

/** Index just past the end of the skipped element whose open tag ended at `from`. */
function endOfSkippedElement(html: string, from: number, rule: SkipRule): number {
  let depth = 1;
  rule.tags.lastIndex = from;
  for (;;) {
    const tag = rule.tags.exec(html);
    if (!tag) return html.length; // never closed: nothing after it is read
    if (tag[1] === "/") {
      if (--depth === 0) return endOfTag(html, tag.index);
    } else if (rule.nests) depth++;
  }
}

/**
 * Call `onText(start, end)` for every run of readable text in `html`, in
 * order. One forward pass: the walk always resumes past what it consumed.
 */
function forEachVisibleText(html: string, onText: (start: number, end: number) => void): void {
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      onText(pos, html.length);
      return;
    }
    if (lt > pos) onText(pos, lt);

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      pos = close === -1 ? html.length : close + 3;
      continue;
    }
    const next = html[lt + 1];
    // A `<` that does not start a tag (e.g. "a < b") is text; step past it.
    if (next === undefined || !/[a-zA-Z/!?]/.test(next)) {
      pos = lt + 1;
      continue;
    }
    const tagEnd = endOfTag(html, lt);
    const rule = SKIPPED.get(openingTagName(html, lt));
    pos = rule ? endOfSkippedElement(html, tagEnd, rule) : tagEnd;
  }
}

// ---------------------------------------------------------------------------
// Page side: missing-snippet errors
// ---------------------------------------------------------------------------

/** Every rendered error starts with this (case-sensitive, as Liquid prints it). */
const NEEDLE = "Liquid error";

/**
 * The whole error, anchored (sticky) where NEEDLE was found:
 *   Liquid error[ (<template> line <n>)]: Could not find asset snippets/<name>[.liquid]
 * The template and the name are restricted to [A-Za-z0-9._/-] and bounded, so
 * what is captured can only ever be a path, a number and a file name. The
 * name must END the error: it is followed by whitespace, a tag or the end of
 * the page, so a name with any other character in it is not read in part.
 * An app-block path (shopify://apps/...) has a colon and so never matches.
 */
const MISSING_SNIPPET_ERROR_RE =
  /Liquid error(?: \((?:([A-Za-z0-9._/-]{1,120}) )?line (\d{1,7})\))?: Could not find asset snippets\/([A-Za-z0-9._-]{1,100}?)(?:\.liquid)?(?=[ \t\r\n<]|$)/y;

function withoutLiquidExtension(path: string): string {
  return path.endsWith(".liquid") ? path.slice(0, -".liquid".length) : path;
}

/**
 * Read the missing-snippet Liquid errors printed in `html`'s readable text.
 *
 * These are CANDIDATES: nothing here is a finding until detectLiquidErrors
 * confirms it against the theme. At most MAX_LIQUID_ERROR_CANDIDATES distinct
 * (template, snippet) pairs, in page order; the same pair at another line
 * number is the same candidate (the first line number is kept).
 */
export function extractRenderedLiquidErrors(html: string): RenderedLiquidError[] {
  const found = new Map<string, RenderedLiquidError>();
  // ONE forward cursor over the page's occurrences of NEEDLE. Searching from
  // each text run instead would rescan the page once per run (quadratic), and
  // the fetch timeout cannot interrupt a synchronous scan. -1 = none left.
  let nextAt = html.indexOf(NEEDLE);
  if (nextAt === -1) return [];
  let examined = 0;
  let done = false;

  forEachVisibleText(html, (start, end) => {
    if (done || nextAt === -1) return;
    // Occurrences inside skipped content (scripts, tags, comments) are passed.
    if (nextAt < start) nextAt = html.indexOf(NEEDLE, start);
    while (nextAt !== -1 && nextAt < end) {
      const at = nextAt;
      nextAt = html.indexOf(NEEDLE, at + NEEDLE.length);
      if (++examined > MAX_LIQUID_ERROR_MATCHES) {
        done = true;
        return;
      }
      MISSING_SNIPPET_ERROR_RE.lastIndex = at;
      const match = MISSING_SNIPPET_ERROR_RE.exec(html);
      // The whole error must sit inside this one text run.
      if (!match || MISSING_SNIPPET_ERROR_RE.lastIndex > end) continue;

      const template = match[1] ? withoutLiquidExtension(match[1]) : null;
      const snippet = match[3];
      const key = `${template ?? ""}|${snippet}`;
      if (found.has(key)) continue;
      found.set(key, {
        template,
        line: match[2] === undefined ? null : Number.parseInt(match[2], 10),
        snippet,
      });
      if (found.size >= MAX_LIQUID_ERROR_CANDIDATES) {
        done = true;
        return;
      }
    }
  });

  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Findings: page and theme must agree
// ---------------------------------------------------------------------------

/** The error as Liquid prints it, rebuilt from the parsed parts (fixed shape). */
export function liquidErrorText(error: RenderedLiquidError): string {
  const location =
    error.line === null ? "" : ` (${error.template ? `${error.template} ` : ""}line ${error.line})`;
  return `Liquid error${location}: Could not find asset snippets/${error.snippet}.liquid`;
}

/**
 * The finding's stable identity, stored as line 1 of `codeSnippet` (the differ
 * fingerprints only the first snippet line for `lineNumber: 1`, and the scan
 * page shows the start of the snippet). No line number in it, so editing the
 * file above the broken line does not turn one error into "fixed" plus "new".
 */
function identityLine(error: RenderedLiquidError): string {
  const where = error.template ? ` in ${error.template}` : "";
  return `Liquid error${where}: Could not find asset snippets/${error.snippet}.liquid`;
}

/** Merchant copy. Consequence first, no em dashes (house style). */
function describe(error: RenderedLiquidError, file: string, appName: string | null): string {
  const what = appName
    ? `${file}.liquid still renders ${appName}'s snippet "${error.snippet}", which no longer exists in your theme`
    : `${file}.liquid renders the snippet "${error.snippet}", which no longer exists in your theme, usually because it was removed with an app`;
  return `Your homepage prints a Liquid error. ${what}, so Shopify prints the error in its place. It can be inside a menu, a drawer or a hidden section, so you may not see it at first glance.`;
}

/**
 * Whether the theme confirms `error`, and the file to point the merchant at.
 * Null = not confirmed (the candidate is dropped).
 */
function corroboratingFile(
  error: RenderedLiquidError,
  missing: ReadonlyMap<string, MissingSnippetRender>,
): string | null {
  // (2) + (3): the snippet is absent from the theme and something renders it.
  const entry = missing.get(error.snippet);
  if (!entry || entry.renderedIn.length === 0) return null;
  if (error.template === null) return entry.renderedIn[0];
  // (4): the file the error names must be one the index lists. A name that is
  // not listed is dropped even when more than MAX_RENDERING_FILES files render
  // the snippet: accepting it there would accept any template name at all.
  return entry.renderedIn.includes(error.template) ? error.template : null;
}

/**
 * Findings for the page's missing-snippet errors that the theme confirms: one
 * per (template, snippet), at most MAX_LIQUID_ERRORS. A candidate the theme
 * does not confirm yields nothing. An app is named when the snippet matches a
 * signature (the scanner's snippet-name matcher).
 */
export function detectLiquidErrors(
  errors: readonly RenderedLiquidError[],
  missingSnippets: readonly MissingSnippetRender[],
): CreateFindingInput[] {
  const missing = new Map(missingSnippets.map((entry) => [entry.snippet, entry]));
  const findings: CreateFindingInput[] = [];
  for (const error of errors) {
    if (findings.length >= MAX_LIQUID_ERRORS) break;
    const file = corroboratingFile(error, missing);
    if (file === null) continue;
    const appName = identifyAppFromSnippetName(error.snippet);
    findings.push({
      filename: LIQUID_ERROR_FINDING_FILENAME,
      lineNumber: 1,
      // Line 1 = the stable identity (fingerprinted, no line number); line 2 =
      // the error as Liquid prints it. Both are rebuilt from the parsed parts.
      codeSnippet:
        `${stripUnsafeChars(identityLine(error))}\n${stripUnsafeChars(liquidErrorText(error))}`.slice(
          0,
          MAX_LIQUID_ERROR_SNIPPET_CHARS,
        ),
      findingType: FindingType.LIQUID_ERROR_RENDERED,
      severity: Severity.HIGH,
      appName: appName ?? undefined,
      description: stripUnsafeChars(describe(error, file, appName)),
    });
  }
  return findings;
}
