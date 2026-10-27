/**
 * Menu-label injection detector (gc-7gjj.1, spike §2.4-2.5).
 *
 * In October 2026 a compromised app wrote an `<img src=x onerror=...>` script
 * loader into navigation menu labels. Themes that print `link.title` without
 * `| escape` (Horizon does, Dawn does not) then ran it on every page. Menus are
 * stored in the admin, not in theme files, so only the Admin `menus` query
 * (menu-fetcher.server.ts, scope read_online_store_navigation) can see them.
 *
 * One MENU_INJECTION finding per menu item whose TITLE or URL matches a rule,
 * first rule wins (in this order):
 *
 *   script     `<script` anywhere in the title.
 *   handler    an `on<letters>=` attribute inside a tag in the title
 *              (`<img onerror=`, `<svg/onload=`, `<body onpageshow=`).
 *   frame      `<iframe`, `<object`, `<embed`, a `srcdoc=` attribute, or a
 *              `<meta http-equiv` tag in the title.
 *   script_url a `javascript:` / `vbscript:` / `data:text/html` URL: the item's
 *              URL (after removing whitespace and control characters, which
 *              browsers ignore inside a scheme), or an attribute value inside a
 *              tag in the title (character references decoded, as a browser
 *              decodes them).
 *   domain     a host on the curated KNOWN_MALICIOUS_DOMAINS list in a URL in
 *              the title or the item's URL.
 *
 * Precision first:
 *   - The title is read RAW, never entity-decoded as a whole: `&lt;script&gt;`
 *     prints as text and is harmless. Only attribute values INSIDE a real tag
 *     are decoded (that is what the browser does with them).
 *   - Plain markup a merchant uses on purpose (`<b>`, `<span class=badge>`,
 *     `<img src=icon.png>`, `<br>`) is not flagged.
 *   - Prose is never a URL: "JavaScript: the basics" as a label is text. A
 *     scheme only counts in the item's URL or inside a tag's attribute value.
 *
 * Linear time: one pass over each title's tags (each tag segment is read once,
 * segments do not overlap) plus bounded regexes with disjoint quantifiers.
 *
 * Pure: no I/O, no logging.
 */
import { FindingType, Severity } from "@prisma/client";

import { decodeAttributeValue } from "./runtime-malicious.server";
import { indexOfIgnoreCase, urlHostsOnLine } from "./scan-engine.server";
import { matchMaliciousDomain } from "../data/malicious-domains.server";
import type { CreateFindingInput } from "../models/finding.server";

/** One menu item as the detector reads it (built by menu-fetcher.server.ts). */
export interface MenuItemData {
  /** The menu's numeric id (from its GID). */
  menuId: string;
  menuTitle: string;
  /** The item's numeric id (from its GID). */
  itemId: string;
  /** Titles of the item's parents inside the menu, top first. */
  parents: string[];
  title: string;
  url: string | null;
}

/** Which rule matched, most dangerous first. */
export type MenuInjectionRule = "script" | "handler" | "frame" | "script_url" | "domain";

export interface MenuInjectionMatch {
  rule: MenuInjectionRule;
  field: "title" | "url";
  /** Offset of the match in the field (for the stored excerpt). */
  at: number;
  /** The listed domain, for the `domain` rule. */
  domain?: string;
}

/** At most this many findings per scan: one per item, bounded for a flood. */
export const MAX_MENU_INJECTION_FINDINGS = 50;

/** Characters of a label kept on each side of the match in the stored excerpt. */
const EXCERPT_LEAD = 60;
/** The stored excerpt's maximum length. */
export const MENU_EXCERPT_MAX = 200;
/** Each title in the stored menu path is cut to this length. */
const PATH_TITLE_MAX = 80;

/** A tag start in a title: `<` and a letter (an element name). */
const TAG_START_RE = /<[a-z]/gi;
/** An event-handler attribute inside a tag segment: separator, `on`, letters, `=`. */
const HANDLER_ATTR_RE = /[\s/"']on[a-z]{1,40}[ \t\n\f\r]{0,20}=/i;
/** Frame-like elements that load or run a document. */
const FRAME_TAG_RE = /^<(?:iframe|object|embed)(?=[\s/>]|$)/i;
/** A `srcdoc=` attribute inside a tag segment. */
const SRCDOC_ATTR_RE = /[\s/"']srcdoc[ \t\n\f\r]{0,20}=/i;
/** `<meta` with an `http-equiv` attribute (a refresh redirect). */
const META_REFRESH_RE = /^<meta(?=[\s/])[^]*?[\s/"']http-equiv[ \t\n\f\r]{0,20}=/i;
/** Attribute values inside a tag segment: quoted, or unquoted up to a separator. */
const ATTR_VALUE_RE = /=[ \t\n\f\r]{0,20}(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
/** Schemes that run code or render HTML when a link is followed. */
const SCRIPT_SCHEME_RE = /^(?:javascript:|vbscript:|data:text\/html)/;
/** What a browser drops from a URL before reading its scheme: U+0000 to space, and DEL. */
// eslint-disable-next-line no-control-regex
const URL_IGNORED_CHARS_RE = /[\u0000- \u007f]/g;

/** Whether a URL value (an item's URL or an attribute value) runs code when followed. */
export function isScriptUrl(value: string): boolean {
  return SCRIPT_SCHEME_RE.test(value.replace(URL_IGNORED_CHARS_RE, "").toLowerCase());
}

/**
 * The tag segments of a title: each `<letter ...` up to and including the
 * next `>` (or the end). Segments never overlap, so reading them is linear.
 */
function tagSegments(title: string): Array<{ at: number; text: string }> {
  const segments: Array<{ at: number; text: string }> = [];
  TAG_START_RE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = TAG_START_RE.exec(title)) !== null) {
    const close = title.indexOf(">", found.index + 1);
    const end = close === -1 ? title.length : close + 1;
    segments.push({ at: found.index, text: title.slice(found.index, end) });
    if (close === -1) break;
    TAG_START_RE.lastIndex = end;
  }
  return segments;
}

/** The first listed malicious domain named by URL in `text`, with its offset. */
function listedDomainIn(text: string): { domain: string; at: number } | null {
  for (const host of urlHostsOnLine(text)) {
    const entry = matchMaliciousDomain(host);
    if (entry) return { domain: entry.domain, at: Math.max(0, indexOfIgnoreCase(text, host)) };
  }
  return null;
}

/** The rule a menu item matches, or null. See the module doc for the rules. */
export function matchMenuItem(
  item: Pick<MenuItemData, "title" | "url">,
): MenuInjectionMatch | null {
  const title = item.title ?? "";
  const url = item.url ?? "";

  const script = indexOfIgnoreCase(title, "<script");
  if (script !== -1) return { rule: "script", field: "title", at: script };

  const segments = tagSegments(title);
  for (const seg of segments) {
    if (HANDLER_ATTR_RE.test(seg.text)) return { rule: "handler", field: "title", at: seg.at };
  }
  for (const seg of segments) {
    if (FRAME_TAG_RE.test(seg.text) || SRCDOC_ATTR_RE.test(seg.text)) {
      return { rule: "frame", field: "title", at: seg.at };
    }
    if (META_REFRESH_RE.test(seg.text)) return { rule: "frame", field: "title", at: seg.at };
  }

  if (isScriptUrl(url)) return { rule: "script_url", field: "url", at: 0 };
  for (const seg of segments) {
    ATTR_VALUE_RE.lastIndex = 0;
    let value: RegExpExecArray | null;
    while ((value = ATTR_VALUE_RE.exec(seg.text)) !== null) {
      const raw = value[1] ?? value[2] ?? value[3] ?? "";
      if (isScriptUrl(decodeAttributeValue(raw))) {
        return { rule: "script_url", field: "title", at: seg.at };
      }
    }
  }

  const inTitle = listedDomainIn(title);
  if (inTitle) return { rule: "domain", field: "title", at: inTitle.at, domain: inTitle.domain };
  const inUrl = listedDomainIn(url);
  if (inUrl) return { rule: "domain", field: "url", at: inUrl.at, domain: inUrl.domain };
  return null;
}

/** One line, whitespace collapsed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** "Main menu > Shop > Sale": the menu's title, then the item's path in it. */
export function menuItemPath(item: Pick<MenuItemData, "menuTitle" | "parents" | "title">): string {
  return [item.menuTitle, ...item.parents, item.title]
    .map((t) => oneLine(t ?? "", PATH_TITLE_MAX) || "(untitled)")
    .join(" > ");
}

/** The bounded excerpt of the matched field around the match. */
function excerpt(text: string, at: number): string {
  const from = Math.max(0, at - EXCERPT_LEAD);
  return text.slice(from, from + MENU_EXCERPT_MAX).replace(/\s+/g, " ");
}

/** What the matched code is, in merchant words (the description's middle). */
const RULE_WORDS: Record<MenuInjectionRule, string> = {
  script: "a script tag",
  handler: "code that runs when the label is shown",
  frame: "an embedded frame or page redirect",
  script_url: "a link that runs code when it is clicked",
  domain: "a link to a known malicious domain",
};

/** The stored description for a match (fixed wording, the domain only from the curated list). */
export function menuInjectionDescription(
  match: Pick<MenuInjectionMatch, "rule" | "domain" | "field">,
): string {
  const where = match.field === "url" ? "A menu item's link" : "A menu item's label";
  const what =
    match.rule === "domain" && match.domain
      ? `a link to ${match.domain}, a known malicious domain`
      : RULE_WORDS[match.rule];
  return `${where} contains ${what}. Apps and staff can edit menus; in October 2026 a compromised app used menu labels to hijack checkouts.`;
}

/** The synthetic locator of a menu item: `menus/{menuId}/items/{itemId}`. */
export function menuItemFilename(item: Pick<MenuItemData, "menuId" | "itemId">): string {
  return `menus/${item.menuId}/items/${item.itemId}`;
}

/**
 * The MENU_INJECTION findings for a store's menu items, at most
 * MAX_MENU_INJECTION_FINDINGS, in the order given (the fetcher's menu order).
 *
 * Stored shape:
 *   filename     menuItemFilename(item)
 *   lineNumber   0 (not a file)
 *   codeSnippet  line 1 = the menu path ("Main menu > Shop"), the fingerprinted
 *                line; line 2 = "Label: <excerpt>" or "Link: <excerpt>", at
 *                most MENU_EXCERPT_MAX characters of the matched field.
 *   severity     HIGH, always
 *   description  menuInjectionDescription(match)
 */
export function detectMenuInjection(items: readonly MenuItemData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  for (const item of items) {
    const match = matchMenuItem(item);
    if (!match) continue;
    const field = match.field === "url" ? (item.url ?? "") : item.title;
    findings.push({
      filename: menuItemFilename(item),
      lineNumber: 0,
      codeSnippet: `${menuItemPath(item)}\n${match.field === "url" ? "Link" : "Label"}: ${excerpt(field, match.at)}`,
      findingType: FindingType.MENU_INJECTION,
      severity: Severity.HIGH,
      description: menuInjectionDescription(match),
    });
    if (findings.length >= MAX_MENU_INJECTION_FINDINGS) break;
  }
  return findings;
}
