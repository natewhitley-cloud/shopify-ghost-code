// ---------------------------------------------------------------------------
// Detector: LIQUID_ERROR_RENDERED — Liquid errors shoppers can read (gc-i6du)
// ---------------------------------------------------------------------------
//
// PURE, side-effect-free. Two halves:
//   - extractRenderedLiquidErrors(html): runs INSIDE the storefront fetcher on
//     the homepage HTML it already holds in memory, and returns only small
//     bounded records (the error text, where Liquid says it came from, the
//     missing snippet name). The HTML never leaves the fetcher.
//   - detectLiquidErrors(errors): turns those records into findings and names
//     the app when a missing snippet matches a signature.
// No Admin API, DB, or network access.
//
// What Shopify prints. Liquid renders a failed tag or filter IN PLACE as text,
// built by Liquid::Error#to_s:
//     Liquid error: <message>
//     Liquid error (line 12): <message>
//     Liquid error (sections/header line 12): <message>
//     Liquid syntax error (snippets/price line 4): <message>
// i.e. "Liquid error" or "Liquid syntax error", an optional "(<template> line
// <n>)" where <template> is the theme file path WITHOUT ".liquid", then ": "
// and the message. The classic app leftover is a `render` of a snippet the app
// deleted on uninstall:
//     Liquid error (layout/theme line 309): Could not find asset snippets/preloaderapp.liquid
// (the exact strings merchants post in the Shopify community, see
// docs/marketing-plan.md "Liquid error threads").
//
// Patterns chosen, and why (false positives matter more than recall here: a
// wrong "your shoppers see an error" is worse than a missed one):
//   A. LOCATED form, any message: `Liquid [syntax ]error (<template> line N): `
//      or `(line N): `. The parenthesised location is Liquid's own; prose about
//      Liquid does not contain it.
//   B. BARE form, ONLY for a missing snippet:
//      `Liquid error: Could not find asset snippets/<name>`. A bare
//      "Liquid error: ..." with any other message is skipped: without the
//      location it is indistinguishable from a sentence in a blog post or a
//      product description.
//   Both are case-sensitive ("Liquid" capitalised, as Liquid prints it).
//
// Where a match counts. Only VISIBLE TEXT is scanned: the page is walked once
// and everything a shopper cannot read is skipped:
//   - <script> and <style> bodies (JS strings, JSON blobs such as product or
//     section data, CSS);
//   - HTML comments;
//   - tags themselves, quote-aware, so an error inside an attribute value
//     (alt="Liquid error ...") is not text;
//   - <code>, <pre>, <textarea>, <template>, <noscript>: where a tutorial or a
//     blog post QUOTES an error, and content that is not rendered as page text.
// Two more guards for writing ABOUT errors (a theme shop's blog excerpt on its
// homepage) that sits in plain paragraph text:
//   - a match directly preceded by a quotation mark is a quote;
//   - a match preceded, on the same line of the same text run, by
//     PROSE_LEAD_WORDS or more words is mid-sentence ("Merchants often report
//     Liquid error (...)"). A rendered error replaces a tag, so it normally
//     starts its text run or follows a short label ("Price: "). Cost: an error
//     printed in the middle of a long sentence is missed.
//
// Not detected, on purpose: "translation missing: en.some.key". Shopify prints
// that for a locale key the theme lacks, which is almost always the theme's
// own gap (a theme update, a custom section, a new language), not something an
// app left behind, and a key name cannot be matched to an app signature. It
// would be a theme-QA finding, outside "what old apps left behind".
//
// Privacy: only the matched error text (decoded, whitespace-collapsed, at most
// MAX_LIQUID_ERROR_TEXT_CHARS) is kept. No surrounding markup, no page text.

import { FindingType, Severity } from "@prisma/client";

import { identifyAppFromSnippetName } from "./app-lookup.server";
import type { CreateFindingInput } from "../models/finding.server";

/** Synthetic locator for every LIQUID_ERROR_RENDERED finding (not a theme file). */
export const LIQUID_ERROR_FINDING_FILENAME = "storefront/homepage";

/** The stored error text is cut to this many characters. */
export const MAX_LIQUID_ERROR_TEXT_CHARS = 200;
/** The stored snippet (identity line + error text) is cut to this, like every finding's. */
export const MAX_LIQUID_ERROR_SNIPPET_CHARS = 300;
/** At most this many distinct errors are kept per page (in page order). */
export const MAX_LIQUID_ERRORS = 10;
/** At most this many matches are examined per page (bounds the work). */
export const MAX_LIQUID_ERROR_MATCHES = 200;

/** One distinct Liquid error read from the homepage. Small and bounded. */
export interface RenderedLiquidError {
  /** The error as rendered, decoded and whitespace-collapsed, <= 200 chars. */
  text: string;
  /**
   * The message alone (no "Liquid error (... line N): " prefix), <= 200 chars.
   * Kept apart from `text` so a finding's identity never depends on the line
   * number, not even through where a long error is cut.
   */
  message: string;
  /** "syntax" for "Liquid syntax error", else "error". */
  kind: "error" | "syntax";
  /** Theme file Liquid names, without ".liquid" (e.g. "layout/theme"), or null. */
  template: string | null;
  /** Snippet name from "Could not find asset snippets/<name>.liquid", or null. */
  missingSnippet: string | null;
}

/** Every rendered error starts with this (case-sensitive, as Liquid prints it). */
const NEEDLE = "Liquid ";

/** Elements whose content is never visible page text (see the header). */
const SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "code",
  "pre",
  "textarea",
  "template",
  "noscript",
]);

/**
 * `Liquid error` / `Liquid syntax error`, then either a location in
 * parentheses (pattern A) or nothing (pattern B, restricted below), then `: `.
 * The location is `line N` or `<folder>/<file> line N`. Sticky: only ever
 * tried at an index where the literal "Liquid " was already found, so it never
 * scans. The message is read separately, by index.
 */
const ERROR_HEAD_RE =
  /Liquid (syntax )?error(?: \((?:([a-z_]{1,20}\/[\w.-]{1,100}) )?line (\d{1,7})\))?: /y;

/** The one message accepted without a location (pattern B), and the snippet it names. */
const MISSING_SNIPPET_RE =
  /^Could not find asset snippets\/([\w.-]{1,100}?)(?:\.liquid)?(?![\w.-])/;

/** A quotation mark (raw or as an entity) right before the match = a quote. */
const QUOTED_BEFORE_RE = /(?:["'`‘“«]|&quot;|&#0?34;|&#0?39;|&#x27;|&[lr][sd]quo;|&laquo;)$/i;

const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|#0?39|#x27|#0?34);/gi;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&nbsp;": " ",
  "&#39;": "'",
  "&#039;": "'",
  "&#x27;": "'",
  "&#34;": '"',
  "&#034;": '"',
};

/** This many words before a match, on its own line, make it prose (see header). */
export const PROSE_LEAD_WORDS = 4;
/** How far back the prose check looks. */
const PROSE_LEAD_CHARS = 200;

/** True when `lead` (the text before a match) reads as the start of a sentence. */
function isProseLead(lead: string): boolean {
  const line = lead.slice(lead.lastIndexOf("\n") + 1);
  let words = 0;
  for (const token of line.split(/\s+/)) {
    if (/[A-Za-z]{2,}/.test(token) && ++words >= PROSE_LEAD_WORDS) return true;
  }
  return false;
}

/** Decode the few entities an error message can carry; collapse whitespace. */
function cleanText(raw: string): string {
  return raw
    .replace(ENTITY_RE, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** Index just past the `>` closing the tag that starts at `lt`, quote-aware. */
function endOfTag(html: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  return html.length;
}

/**
 * The lower-cased element name of the tag at `lt` ("" for a closing tag etc.).
 * Hyphens and colons are part of the name, so a custom element such as
 * `<code-block>` or `<template-list>` is not mistaken for `<code>` / `<template>`.
 */
function openingTagName(html: string, lt: number): string {
  let end = lt + 1;
  while (end < html.length && end - lt <= 16 && /[a-zA-Z0-9:-]/.test(html[end])) end++;
  return html.slice(lt + 1, end).toLowerCase();
}

/**
 * Call `onText(start, end)` for every run of visible text in `html`, in order.
 * One forward pass: each character is visited a bounded number of times (the
 * close-tag search for a skipped element starts where the open tag ended and
 * the walk resumes after it), so it is linear in the page size.
 */
function forEachVisibleText(html: string, onText: (start: number, end: number) => void): void {
  const lower = html.toLowerCase();
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
    const name = openingTagName(html, lt);
    if (SKIPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, tagEnd);
      pos = close === -1 ? html.length : endOfTag(html, close);
      continue;
    }
    pos = tagEnd;
  }
}

/**
 * Read the rendered Liquid errors a shopper can see in `html`.
 *
 * Returns at most MAX_LIQUID_ERRORS distinct errors, in page order. Two errors
 * are the same when their kind, template and message match: the line number is
 * NOT part of the identity, so the same broken line reported after an edit
 * moved it (or a snippet rendered twice) is one error.
 */
export function extractRenderedLiquidErrors(html: string): RenderedLiquidError[] {
  const found = new Map<string, RenderedLiquidError>();
  // ONE forward cursor over the page's "Liquid " occurrences. Searching from
  // each text run instead would rescan up to the next occurrence once per run
  // (quadratic on a page with many runs and a late or missing match), and the
  // fetch timeout cannot interrupt a synchronous scan. -1 = none left.
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
      ERROR_HEAD_RE.lastIndex = at;
      const head = ERROR_HEAD_RE.exec(html);
      if (!head || ERROR_HEAD_RE.lastIndex > end) continue;

      // A sentence quoting the error ("you may see 'Liquid error ...'").
      const before = html.slice(Math.max(start, at - 8), at).trimEnd();
      if (QUOTED_BEFORE_RE.test(before)) continue;
      // A sentence about the error ("Merchants often report Liquid error ...").
      if (isProseLead(html.slice(Math.max(start, at - PROSE_LEAD_CHARS), at))) continue;

      // The message runs to the end of this text run or line, bounded. Twice
      // the stored cap is read so entity decoding cannot shorten it below it.
      // The newline is looked for inside that bounded window only (a search
      // of the whole page per match would not be linear on a one-line page).
      const msgStart = ERROR_HEAD_RE.lastIndex;
      const window = html.slice(
        msgStart,
        Math.min(end, msgStart + MAX_LIQUID_ERROR_TEXT_CHARS * 2),
      );
      const newline = window.indexOf("\n");
      const rawMessage = cleanText(newline === -1 ? window : window.slice(0, newline));
      if (rawMessage.length === 0) continue;

      const kind = head[1] ? "syntax" : "error";
      const template = head[2] ?? null;
      const located = head[3] !== undefined;
      const missing = kind === "error" ? MISSING_SNIPPET_RE.exec(rawMessage) : null;
      // Pattern B: without a location, only the missing-snippet message counts.
      if (!located && !missing) continue;
      // A missing-snippet message ends at the snippet path: page text that
      // follows it on the same line is not part of the error and is not kept.
      const message = missing ? missing[0] : rawMessage;

      const key = `${kind}|${template ?? ""}|${message}`;
      if (found.has(key)) continue;
      const text = cleanText(html.slice(at, msgStart)) + " " + message;
      found.set(key, {
        text: text.slice(0, MAX_LIQUID_ERROR_TEXT_CHARS),
        message: message.slice(0, MAX_LIQUID_ERROR_TEXT_CHARS),
        kind,
        template,
        missingSnippet: missing ? missing[1] : null,
      });
      if (found.size >= MAX_LIQUID_ERRORS) {
        done = true;
        return;
      }
    }
  });

  return [...found.values()];
}

/** The theme file a template name points at, for copy ("layout/theme.liquid"). */
function templateFile(template: string): string {
  return /\.(?:liquid|json)$/.test(template) ? template : `${template}.liquid`;
}

/**
 * The finding's stable identity, stored as line 1 of `codeSnippet` (the differ
 * fingerprints only the first snippet line for `lineNumber: 1`, and the scan
 * page shows the start of the snippet). It reads as the error WITHOUT its line
 * number ("Liquid error in layout/theme: Could not find asset ..."), so
 * editing the file above the broken line does not turn one error into "fixed"
 * plus "new".
 */
function identityLine(error: RenderedLiquidError): string {
  const label = error.kind === "syntax" ? "Liquid syntax error" : "Liquid error";
  const where = error.template ? ` in ${error.template}` : "";
  return `${label}${where}: ${error.message}`.slice(0, MAX_LIQUID_ERROR_TEXT_CHARS);
}

/** Merchant copy for one error. Consequence first, no em dashes (house style). */
function describe(error: RenderedLiquidError, appName: string | null): string {
  const where = error.template ? ` The line is in ${templateFile(error.template)}.` : "";
  if (error.missingSnippet) {
    const name = error.missingSnippet;
    return appName
      ? `Shoppers see a Liquid error on your homepage. Your theme still tries to load ${appName}'s snippet "${name}", which no longer exists, so Shopify prints the error where the snippet used to be.${where}`
      : `Shoppers see a Liquid error on your homepage. Your theme tries to load the snippet "${name}", which no longer exists, so Shopify prints the error in its place. This often happens after an app that added the snippet is removed.${where}`;
  }
  return appName
    ? `Shoppers see a Liquid error on your homepage. It comes from ${appName}'s code in your theme.${where}`
    : `Shoppers see a Liquid error on your homepage. Shopify prints it where a piece of theme code failed.${where}`;
}

/**
 * Turn the errors read from the homepage into findings, one per error.
 *
 * App attribution uses the scanner's snippet-name matcher on the missing
 * snippet, or, for an error INSIDE a snippet, on that snippet's own name
 * ("snippets/klaviyo-form"). No match = no app named.
 */
export function detectLiquidErrors(errors: readonly RenderedLiquidError[]): CreateFindingInput[] {
  return errors.slice(0, MAX_LIQUID_ERRORS).map((error) => {
    const ownSnippet = error.template?.startsWith("snippets/")
      ? error.template.slice("snippets/".length)
      : null;
    const appName =
      (error.missingSnippet ? identifyAppFromSnippetName(error.missingSnippet) : null) ??
      (ownSnippet ? identifyAppFromSnippetName(ownSnippet) : null);
    return {
      filename: LIQUID_ERROR_FINDING_FILENAME,
      lineNumber: 1,
      // Line 1 = the stable identity (fingerprinted, no line number); line 2 =
      // the error exactly as shoppers see it. Cut to the same 300 characters
      // as every other finding's snippet (the privacy policy's stated limit);
      // line 1 is at most 200, so the identity always survives the cut.
      // Nothing else from the page is kept.
      codeSnippet: `${identityLine(error)}\n${error.text}`.slice(0, MAX_LIQUID_ERROR_SNIPPET_CHARS),
      findingType: FindingType.LIQUID_ERROR_RENDERED,
      severity: Severity.HIGH,
      appName: appName ?? undefined,
      description: describe(error, appName),
    };
  });
}
