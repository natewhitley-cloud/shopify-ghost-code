/**
 * Runtime malicious check (gc-0htk): the curated KNOWN_MALICIOUS_DOMAINS list
 * matched against data the app ALREADY reads, with no new outbound request:
 *
 *   - the served public homepage, read once per scan by the storefront
 *     fetcher (findMaliciousInHomepage, called inside the fetcher so the HTML
 *     never leaves it); hits become MALICIOUS_SCRIPT findings filed under
 *     HOMEPAGE_MALICIOUS_FILENAME (homepageMaliciousFindings);
 *   - the URLs Lighthouse requested during a speed test (`network-requests`,
 *     maliciousDomainsInUrls), stored with that speed report.
 *
 * Why: a merchant thread (community.shopify.com) showed malicious scripts that
 * never appear in theme files. They are added by apps (script tags, app
 * embeds, app blocks) or loaded at runtime, so only the served page or a real
 * browser's request list can show them.
 *
 * Precision over recall, same as the theme detector:
 *   - Host matching is matchMaliciousDomain (exact or dot-boundary).
 *   - Homepage: only places that make the browser fetch, run or send
 *     something are read: a `<script src>`, a `<link href>`, an app's script
 *     tag (Shopify's asyncLoad list, already parsed by the fetcher), an
 *     `<iframe src>`, a `<form action>`, a URL in an import map and a URL
 *     inside inline JavaScript (a `<script>` with no src and a JavaScript
 *     type). A `<link>` that is only a connection hint (`preconnect`,
 *     `dns-prefetch`) is still reported, but labelled as named, not loaded
 *     (gc-3y89 item 3). A URL in
 *     page text, a link (`<a href>`), an image, or a JSON data block is not
 *     read: it does not load code, and merchant or shopper text (a blog post,
 *     a review) can mention any domain. Bodies of inert or text-only elements
 *     (`<textarea>`, `<title>`, `<template>`, `<noscript>`, ...) are skipped.
 *     Known limits: a URL in a JavaScript STRING counts (merchant text a theme
 *     serializes into a script can match), and a tag written inside another
 *     tag's attribute value is read as a tag.
 *   - HTML comments and JS comments are blanked first (blankInertComments,
 *     the theme detector's helper) for EVERY entry, not only `ignoreInComments`
 *     ones: a commented-out tag on the served page does not load, and the
 *     finding says the page uses the domain. Doubtful markup resolves toward
 *     reporting (see blankInertComments).
 *
 * Pure: no I/O, no logging.
 */
import { FindingType, Severity } from "@prisma/client";

import {
  blankInertComments,
  indexOfIgnoreCase,
  parseOpenTagAttributes,
  scriptUrlHost,
  urlHostsOnLine,
} from "./scan-engine.server";
import {
  homepageMaliciousDescription,
  KNOWN_MALICIOUS_DOMAINS,
  maliciousDescription,
  matchMaliciousDomain,
  type MaliciousDomain,
} from "../data/malicious-domains.server";
import { HOMEPAGE_MALICIOUS_FILENAME } from "../lib/finding-classification";
import type { CreateFindingInput } from "../models/finding.server";

/** Where on the homepage a listed domain was seen, most specific first. */
export type HomepageSource =
  | "script_tag"
  | "script"
  | "link"
  | "iframe"
  | "importmap"
  | "inline_script"
  | "form"
  | "hint";

const SOURCE_RANK: Record<HomepageSource, number> = {
  script_tag: 0,
  script: 1,
  link: 2,
  iframe: 3,
  importmap: 4,
  inline_script: 5,
  form: 6,
  hint: 7,
};

/** Merchant-facing: how the page used the domain (the stored snippet's second line). */
export const HOMEPAGE_SOURCE_LABELS: Record<HomepageSource, string> = {
  script_tag: "Loaded by a script tag an app added",
  script: "Loaded by a script tag in the page",
  link: "Loaded by a link tag in the page",
  iframe: "Loaded in a frame in the page",
  importmap: "Named in an import map in the page",
  inline_script: "Named in JavaScript in the page",
  form: "Named as where a form in the page sends its data",
  hint: "Named in a connection hint in the page",
};

/** `<link rel>` values that only warm up a connection: nothing is loaded. */
const HINT_RELS: ReadonlySet<string> = new Set(["preconnect", "dns-prefetch"]);

/** Whether a `<link>`'s rel is only connection hints (an empty rel is not). */
function isConnectionHint(rel: string | undefined): boolean {
  const tokens = (rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => HINT_RELS.has(t));
}

/** One listed domain seen on the homepage: the entry, the host as seen, and where. */
export type HomepageMaliciousHit = { domain: string; host: string; source: HomepageSource };

/**
 * At most this many homepage findings per scan (the list has a dozen entries;
 * the cap only bounds a page that somehow matches every one).
 */
export const MAX_HOMEPAGE_MALICIOUS_FINDINGS = 20;

/** `<script>` types a browser runs as JavaScript (absent or empty type included). */
const JS_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "application/x-ecmascript",
  "text/x-ecmascript",
  "text/x-javascript",
  "text/jscript",
  "text/livescript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "module",
]);

/**
 * The next `<script` or `<link` tag start, or the start of an element whose
 * body the browser never loads from (its body is skipped: a tag written
 * inside a `<textarea>`, `<title>`, `<template>`, `<noscript>` and the like is
 * text or inert). Followed by whitespace, `>` or `/`.
 */
const TAG_START_RE =
  /<(script|link|iframe|form|textarea|title|template|noscript|xmp|noembed|noframes|style)(?=[\s>/])/gi;

/** Whether a `type` attribute is run as JavaScript (MIME parameters such as `; charset=` ignored). */
function isJavaScriptType(type: string | undefined): boolean {
  return JS_SCRIPT_TYPES.has((type ?? "").split(";")[0].trim().toLowerCase());
}

/** The longest valid DNS name; a longer "host" is never stored (or matched). */
const MAX_HOST_LENGTH = 253;

/** A matched host as stored: lower case, no trailing FQDN dot. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Every listed domain the served homepage uses, ONE hit per domain (its most
 * specific source: script tag, then script src, then link, then inline JS),
 * sorted by domain. `scriptTagUrls` are the app script tags the fetcher
 * already parsed from the same page (parseScriptTagUrls).
 *
 * Linear: one forward pass over the comment-blanked page; a script's body is
 * skipped as markup (a `<link` written inside JavaScript is not a tag).
 */
export function findMaliciousInHomepage(
  html: string,
  scriptTagUrls: readonly string[],
): HomepageMaliciousHit[] {
  const best = new Map<string, HomepageMaliciousHit>();
  const add = (host: string | null, source: HomepageSource): void => {
    if (!host || host.length > MAX_HOST_LENGTH) return;
    const entry = matchMaliciousDomain(host);
    if (!entry) return;
    const prev = best.get(entry.domain);
    if (!prev || SOURCE_RANK[source] < SOURCE_RANK[prev.source]) {
      best.set(entry.domain, { domain: entry.domain, host: normalizeHost(host), source });
    }
  };

  for (const url of scriptTagUrls) add(scriptUrlHost(url), "script_tag");

  const live = blankInertComments(html, "homepage.html");
  TAG_START_RE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = TAG_START_RE.exec(live)) !== null) {
    const at = found.index;
    const element = found[1].toLowerCase();
    if (element === "iframe" || element === "form") {
      const attr = element === "iframe" ? "src" : "action";
      const tag = parseOpenTagAttributes(live, at, found[0].length, [attr]);
      if (!tag) break;
      add(tag.attributes[attr] ? scriptUrlHost(tag.attributes[attr].value) : null, element);
      if (element === "form") {
        // A form's body is ordinary markup: keep reading its tags.
        TAG_START_RE.lastIndex = tag.end;
        continue;
      }
      // An iframe's body is fallback text the browser never parses as tags.
      const close = indexOfIgnoreCase(live, "</iframe", tag.end);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }
    if (element !== "script" && element !== "link") {
      // An inert or text-only element: skip to its closing tag.
      const close = indexOfIgnoreCase(live, `</${element}`, at + found[0].length);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }
    const isScript = element === "script";
    const tag = parseOpenTagAttributes(
      live,
      at,
      found[0].length,
      isScript ? ["src", "type"] : ["href", "rel"],
    );
    // A tag that never closes: the browser reads the rest as that tag.
    if (!tag) break;
    if (!isScript) {
      add(
        tag.attributes.href ? scriptUrlHost(tag.attributes.href.value) : null,
        isConnectionHint(tag.attributes.rel?.value) ? "hint" : "link",
      );
      TAG_START_RE.lastIndex = tag.end;
      continue;
    }
    const close = indexOfIgnoreCase(live, "</script", tag.end);
    const bodyEnd = close === -1 ? live.length : close;
    if (tag.attributes.src) {
      add(scriptUrlHost(tag.attributes.src.value), "script");
    } else if (isJavaScriptType(tag.attributes.type?.value)) {
      for (const host of urlHostsOnLine(live.slice(tag.end, bodyEnd))) add(host, "inline_script");
    } else if (tag.attributes.type?.value.trim().toLowerCase() === "importmap") {
      // The module URLs an import map lets the page load (JSON, read as text).
      for (const host of urlHostsOnLine(live.slice(tag.end, bodyEnd))) add(host, "importmap");
    }
    if (close === -1) break;
    TAG_START_RE.lastIndex = close;
  }

  return [...best.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * The listed domains (entry domains, not the hosts) among request URLs,
 * de-duplicated and sorted. Only http(s) URLs count; anything unparseable is
 * skipped. Used for the speed test's `network-requests`.
 */
export function maliciousDomainsInUrls(urls: Iterable<unknown>): string[] {
  const domains = new Set<string>();
  for (const url of urls) {
    if (typeof url !== "string") continue;
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      host = parsed.hostname;
    } catch {
      continue;
    }
    const entry = matchMaliciousDomain(host);
    if (entry) domains.add(entry.domain);
  }
  return [...domains].sort();
}

/**
 * The listed domains a scan's THEME-FILE MALICIOUS_SCRIPT findings name, from
 * their stored descriptions (the detector's own builder, no parsing). A
 * homepage hit on one of these is already reported against the theme file
 * where the merchant can remove it, so it is not reported twice.
 */
export function themeMaliciousDomains(
  descriptions: Iterable<string>,
  domains: ReadonlyArray<MaliciousDomain> = KNOWN_MALICIOUS_DOMAINS,
): Set<string> {
  const byDescription = new Map(domains.map((d) => [maliciousDescription(d), d.domain]));
  const out = new Set<string>();
  for (const description of descriptions) {
    const domain = byDescription.get(description);
    if (domain) out.add(domain);
  }
  return out;
}

/**
 * The MALICIOUS_SCRIPT findings for homepage hits, minus the domains the
 * theme files already report. One per listed domain, HIGH, no app name.
 *
 * Stored shape (fixed, rebuilt from the list and the matched host only; no
 * page text, path or query string is kept):
 *   filename     HOMEPAGE_MALICIOUS_FILENAME
 *   lineNumber   0 (no line: it is not a file)
 *   codeSnippet  line 1 = the listed domain (the fingerprinted line, stable
 *                across scans whatever the source); line 2 = how the page
 *                used it and the host as seen, e.g.
 *                "Loaded by a script tag an app added: www.biliing.top"
 *   description  homepageMaliciousDescription(entry)
 */
export function homepageMaliciousFindings(
  hits: readonly HomepageMaliciousHit[],
  themeDomains: ReadonlySet<string>,
): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  for (const hit of hits) {
    if (themeDomains.has(hit.domain)) continue;
    const entry = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === hit.domain);
    if (!entry) continue;
    findings.push({
      filename: HOMEPAGE_MALICIOUS_FILENAME,
      lineNumber: 0,
      codeSnippet: `${entry.domain}\n${HOMEPAGE_SOURCE_LABELS[hit.source]}: ${hit.host}`,
      findingType: FindingType.MALICIOUS_SCRIPT,
      severity: Severity.HIGH,
      description: homepageMaliciousDescription(entry),
    });
    if (findings.length >= MAX_HOMEPAGE_MALICIOUS_FINDINGS) break;
  }
  return findings;
}
