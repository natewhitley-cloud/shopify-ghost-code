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
 *     (gc-3y89 item 3). A URL inside an `on*=` event-handler attribute of ANY
 *     element (`<img onerror>`, `<svg onload>`, `<a onclick>`) is read too,
 *     after decoding HTML character references (gc-7gjj.4: the 17TRACK
 *     menu-label loader was an `<img src=x onerror=...>`). A URL in
 *     page text, a link (`<a href>`), an image, or a JSON data block is not
 *     read: it does not load code, and merchant or shopper text (a blog post,
 *     a review) can mention any domain. Bodies of inert or text-only elements
 *     (`<textarea>`, `<title>`, `<template>`, `<noscript>`, ...) are skipped.
 *     Known limits: a URL in a JavaScript STRING counts (merchant text a theme
 *     serializes into a script can match); a loader that builds its URL at
 *     run time (`atob`, string concatenation) names no host; and once one tag
 *     on the page never closes, later elements' handlers are no longer read
 *     (and a tag written inside another tag's attribute value is read as a
 *     tag again, as before gc-7gjj.4), which keeps the pass linear.
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
  asciiLowerCase,
  blankInertComments,
  closeTagAt,
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
  | "event_handler"
  | "form"
  | "hint";

const SOURCE_RANK: Record<HomepageSource, number> = {
  script_tag: 0,
  script: 1,
  link: 2,
  iframe: 3,
  importmap: 4,
  inline_script: 5,
  event_handler: 6,
  form: 7,
  hint: 8,
};

/** Merchant-facing: how the page used the domain (the stored snippet's second line). */
export const HOMEPAGE_SOURCE_LABELS: Record<HomepageSource, string> = {
  script_tag: "Loaded by a script tag an app added",
  script: "Loaded by a script tag in the page",
  link: "Loaded by a link tag in the page",
  iframe: "Loaded in a frame in the page",
  importmap: "Named in an import map in the page",
  inline_script: "Named in JavaScript in the page",
  event_handler: "Named in JavaScript attached to an element in the page",
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
 * The next element start tag of any name, followed by whitespace, `>` or `/`.
 * `<script>`, `<link>`, `<iframe>` and `<form>` are read for what they load;
 * every element is read for its `on*=` handlers (gc-7gjj.4).
 */
const TAG_START_RE = /<([a-z][a-z0-9-]{0,63})(?=[\s>/])/gi;

/** Elements read for the URL they load, and the attributes that hold it. */
const LOADING_ELEMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  script: ["src", "type"],
  link: ["href", "rel"],
  iframe: ["src"],
  form: ["action"],
};

/**
 * Elements whose BODY the browser never loads from (it is skipped: a tag
 * written inside a `<textarea>`, `<title>`, `<template>`, `<noscript>` and the
 * like is text or inert). Their own start tag's handlers are still read.
 */
const OPAQUE_BODY_ELEMENTS: ReadonlySet<string> = new Set([
  "textarea",
  "title",
  "template",
  "noscript",
  "xmp",
  "noembed",
  "noframes",
  "style",
]);

/** An event-handler attribute name: `on` then at least one letter (`onerror`, `onload`). */
const EVENT_HANDLER_NAME_RE = /^on[a-z]+$/;

/** Named character references worth decoding in a handler (others stay as written). */
const NAMED_CHAR_REFS: Readonly<Record<string, string>> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  sol: "/",
  colon: ":",
  period: ".",
  lpar: "(",
  rpar: ")",
  comma: ",",
  semi: ";",
  equals: "=",
  Tab: "\t",
  NewLine: "\n",
  nbsp: "\u00a0",
};

// A numeric reference (`;` optional, as browsers decode it) or a named one
// with its `;`. Browsers accept any number of leading zeros (`&#0000106;`,
// `&#x0006a;`), so the zero run is unbounded (audit fix); the significant
// digits stay bounded and the value is range-checked after. `0*` and the
// digit run can only trade zeros at one start, and `;?` never fails, so the
// scan stays linear.
const CHAR_REF_RE = /&(?:#0*(\d{1,8})|#[xX]0*([0-9a-fA-F]{1,7})|([A-Za-z]{2,8}));?/g;

/**
 * An attribute value as the browser hands it to the handler: numeric and the
 * common named character references decoded (`&#47;`, `&#x2F;`, `&quot;`,
 * `&colon;`). An out-of-range or unknown reference stays as written. Exported
 * for tests.
 */
export function decodeAttributeValue(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(CHAR_REF_RE, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) {
      return whole.endsWith(";") && Object.hasOwn(NAMED_CHAR_REFS, name)
        ? NAMED_CHAR_REFS[name]
        : whole;
    }
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

/** Whether a `type` attribute is run as JavaScript (MIME parameters such as `; charset=` ignored). */
function isJavaScriptType(type: string | undefined): boolean {
  return JS_SCRIPT_TYPES.has((type ?? "").split(";")[0].trim().toLowerCase());
}

/** The longest valid DNS name; a longer "host" is never stored (or matched). */
export const MAX_HOST_LENGTH = 253;

/** A matched host as stored: lower case, no trailing FQDN dot. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * What the homepage walk reports (walkHomepage). Offsets are into the
 * comment-blanked page, which keeps the original length, so they are offsets
 * into the served HTML too.
 */
export interface HomepageVisitor {
  /**
   * A URL host the page loads, runs or sends something to, with its source.
   * `rawUrl` is the attribute or script tag value it came from (absent for
   * inline JavaScript, import maps and handlers, which yield hosts only).
   */
  host(host: string, source: HomepageSource, rawUrl: string | null, at: number): void;
  /** An `on*=` attribute (lower-case name, decoded value) on `element`'s start tag. */
  handler?(element: string, name: string, value: string, at: number): void;
  /**
   * A `<script>` element at `at`: its src (raw, or null), whether the browser
   * runs it (a src, or a JavaScript type), and its inline body (read lazily).
   */
  script?(at: number, info: { src: string | null; runs: boolean; body: () => string }): void;
}

/** Options for walkHomepage and findMaliciousInHomepage. */
export interface WalkOptions {
  /**
   * `html` is already blankInertComments(page, "homepage.html") (the
   * checkout guard's analyzer blanks the page once for all its readers).
   */
  blanked?: boolean;
}

/**
 * The ONE forward walk over the served homepage, shared by the known-malicious
 * check (findMaliciousInHomepage) and the checkout guard's analyzer
 * (gc-1q1s.2), so both read the page the same way. `scriptTagUrls` are the
 * app script tags the fetcher already parsed from the same page
 * (parseScriptTagUrls); they are reported first, as `script_tag`.
 *
 * Linear: one forward pass over the comment-blanked page; a script's body is
 * skipped as markup (a `<link` written inside JavaScript is not a tag), and a
 * parsed start tag is skipped whole. A start tag that never closes is parsed
 * to the end of the page at most once: after that, elements are read only
 * for what they load, as before gc-7gjj.4.
 */
export function walkHomepage(
  html: string,
  scriptTagUrls: readonly string[],
  visitor: HomepageVisitor,
  opts: WalkOptions = {},
): void {
  const add = (host: string | null, source: HomepageSource, rawUrl: string | null, at: number) => {
    if (host) visitor.host(host, source, rawUrl, at);
  };
  for (const url of scriptTagUrls) add(scriptUrlHost(url), "script_tag", url, -1);

  const live = opts.blanked ? html : blankInertComments(html, "homepage.html");
  // Close tags are found on an ASCII-lower-cased copy (same offsets) and
  // only when the name really ends there (closeTagAt, wave 4): a script
  // string holding `</scriptx` must not end the script early.
  const lower = asciiLowerCase(live);
  // Handlers seen in the start tag being parsed, kept until it closes.
  let handlers: Array<{ name: string; value: string }> = [];
  const onAttribute = (name: string, value: string): void => {
    if (EVENT_HANDLER_NAME_RE.test(name)) handlers.push({ name, value });
  };
  // Set once a start tag never closes: later handlers are not read (linear).
  let handlersOff = false;
  TAG_START_RE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = TAG_START_RE.exec(live)) !== null) {
    const at = found.index;
    const element = found[1].toLowerCase();
    // Own keys only: an element named `constructor` or `__proto__` must not
    // resolve to an Object.prototype member (audit fix, gc-7gjj.4).
    const loadAttributes = Object.hasOwn(LOADING_ELEMENT_ATTRIBUTES, element)
      ? LOADING_ELEMENT_ATTRIBUTES[element]
      : undefined;
    const opaque = OPAQUE_BODY_ELEMENTS.has(element);
    if (!loadAttributes && handlersOff) {
      if (!opaque) continue;
      // An inert or text-only element: skip to its closing tag.
      const close = closeTagAt(lower, element, at + found[0].length);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }

    handlers = [];
    const tag = parseOpenTagAttributes(
      live,
      at,
      found[0].length,
      loadAttributes ?? [],
      handlersOff ? undefined : onAttribute,
    );
    if (!tag) {
      // A tag that never closes: the browser reads the rest as that tag.
      if (loadAttributes) break;
      handlersOff = true;
      if (!opaque) continue;
      const close = closeTagAt(lower, element, at + found[0].length);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }
    for (const { name, value } of handlers) {
      const decoded = decodeAttributeValue(value);
      for (const host of urlHostsOnLine(decoded)) add(host, "event_handler", null, at);
      visitor.handler?.(element, name, decoded, at);
    }

    if (opaque) {
      // An inert or text-only element: skip to its closing tag.
      const close = closeTagAt(lower, element, tag.end);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }
    if (element === "iframe" || element === "form") {
      const attr = element === "iframe" ? "src" : "action";
      const value = tag.attributes[attr]?.value ?? null;
      add(value ? scriptUrlHost(value) : null, element, value, at);
      if (element === "form") {
        // A form's body is ordinary markup: keep reading its tags.
        TAG_START_RE.lastIndex = tag.end;
        continue;
      }
      // An iframe's body is fallback text the browser never parses as tags.
      const close = closeTagAt(lower, "iframe", tag.end);
      if (close === -1) break;
      TAG_START_RE.lastIndex = close;
      continue;
    }
    if (element === "link") {
      const href = tag.attributes.href?.value ?? null;
      add(
        href ? scriptUrlHost(href) : null,
        isConnectionHint(tag.attributes.rel?.value) ? "hint" : "link",
        href,
        at,
      );
      TAG_START_RE.lastIndex = tag.end;
      continue;
    }
    if (element !== "script") {
      // Any other element: its body is markup, read on.
      TAG_START_RE.lastIndex = tag.end;
      continue;
    }
    const close = closeTagAt(lower, "script", tag.end);
    const bodyEnd = close === -1 ? live.length : close;
    const isJs = isJavaScriptType(tag.attributes.type?.value);
    visitor.script?.(at, {
      src: tag.attributes.src?.value ?? null,
      runs: isJs,
      body: () => live.slice(tag.end, bodyEnd),
    });
    if (tag.attributes.src) {
      const src = tag.attributes.src.value;
      add(scriptUrlHost(src), "script", src, at);
    } else if (isJs) {
      for (const host of urlHostsOnLine(live.slice(tag.end, bodyEnd))) {
        add(host, "inline_script", null, at);
      }
    } else if (tag.attributes.type?.value.trim().toLowerCase() === "importmap") {
      // The module URLs an import map lets the page load (JSON, read as text).
      for (const host of urlHostsOnLine(live.slice(tag.end, bodyEnd))) {
        add(host, "importmap", null, at);
      }
    }
    if (close === -1) break;
    TAG_START_RE.lastIndex = close;
  }
}

/**
 * Every listed domain the served homepage uses, ONE hit per domain (its most
 * specific source: script tag, then script src, then link, then inline JS,
 * then an event handler), sorted by domain. A filter over walkHomepage.
 */
export function findMaliciousInHomepage(
  html: string,
  scriptTagUrls: readonly string[],
  opts: WalkOptions = {},
): HomepageMaliciousHit[] {
  const best = new Map<string, HomepageMaliciousHit>();
  walkHomepage(
    html,
    scriptTagUrls,
    {
      host(host, source) {
        if (host.length > MAX_HOST_LENGTH) return;
        const entry = matchMaliciousDomain(host);
        if (!entry) return;
        const prev = best.get(entry.domain);
        if (!prev || SOURCE_RANK[source] < SOURCE_RANK[prev.source]) {
          best.set(entry.domain, { domain: entry.domain, host: normalizeHost(host), source });
        }
      },
    },
    opts,
  );
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
