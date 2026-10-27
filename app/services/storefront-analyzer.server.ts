/**
 * Checkout guard storefront HTML analyzer (gc-1q1s.2). Pure: one served page
 * in, plain values out (hostnames and fixed labels; never page text).
 *
 * Three signals, all from the ONE homepage walk the scan's known-malicious
 * check uses (walkHomepage, runtime-malicious.server), so both read a page
 * the same way:
 *
 *   1. maliciousHits: findMaliciousInHomepage (unchanged, on*= handlers
 *      included since gc-7gjj.4).
 *   2. loaders (SCRIPT_LOADER):
 *        - an `on*=` handler on a non-script element whose value builds or
 *          loads code (findScriptPayload; a non-Shopify URL counts only in
 *          onerror/onload, which fire without a click);
 *        - a running `<script>` inside menu markup (`<nav>`, `<header-menu>`,
 *          `<menu-drawer>`, `<mega-menu>`) or inside the checkout button
 *          (`<button name="checkout">`, an id naming checkout, a link to
 *          /checkout) that loads from a non-Shopify host or whose body
 *          builds or loads code.
 *      A loader whose host is on the known-malicious list is left to
 *      maliciousHits (one incident per domain, the stronger one).
 *   3. hosts (NEW_SCRIPT_HOST candidates): hosts the page loads scripts,
 *      frames, form posts or import-mapped modules from, minus suppressed
 *      ones: Shopify domains, the shop's own hosts, known apps
 *      (identifyAppForExternalUrl), benign libraries, the curated allowlist,
 *      hosts the latest theme scan already saw (ScanDomain), and listed
 *      malicious hosts (already their own incident). Links, connection
 *      hints, inline-JS strings and handler URLs never count as new hosts.
 *
 * Menu and checkout regions come from one walk over the page's real tags
 * (findGuardRegions): menu elements, any element with a real
 * `role="navigation"` attribute, and checkout buttons or links, each up to
 * its own close tag (same-name nesting counted). Known limits: not by class;
 * an element that never closes is no region (audit fix: it used to run to
 * the end of the page).
 */
import { segmentAttributes, tagEnd } from "./menu-injection-detector.server";
import {
  findMaliciousInHomepage,
  MAX_HOST_LENGTH,
  normalizeHost,
  walkHomepage,
  type HomepageMaliciousHit,
  type HomepageSource,
  type WalkOptions,
} from "./runtime-malicious.server";
import {
  asciiLowerCase,
  blankInertComments,
  closeTagAt,
  identifyAppForExternalUrl,
  isHtmlSpace,
  isShopifyDomain,
} from "./scan-engine.server";
import {
  findScriptPayload,
  firstExternalHost,
  type ScriptPayloadReason,
} from "./script-payload.server";
import { isBareHostname, parseScriptTagUrls } from "./storefront-fetcher.server";
import { matchMaliciousDomain } from "../data/malicious-domains.server";
import { isGuardAllowedHost } from "../data/storefront-guard-allowlist.server";
import { isBenignLibrary } from "../lib/library-matcher.server";

export interface LoaderHit {
  /** Stable key: `SCRIPT_LOADER:<host>` or `SCRIPT_LOADER:<reason>` when host-less. */
  fingerprint: string;
  host: string | null;
  reason: ScriptPayloadReason | "script_in_menu" | "script_in_checkout";
  /** Merchant-facing, fixed text. */
  label: string;
}

export interface NewHostCandidate {
  host: string;
  source: HomepageSource;
  label: string;
}

export interface StorefrontAnalysis {
  maliciousHits: HomepageMaliciousHit[];
  loaders: LoaderHit[];
  hosts: NewHostCandidate[];
}

export interface AnalyzeContext {
  /** The shop's own storefront hosts (primary, myshopify). */
  shopHosts?: readonly string[];
  /** Hosts the latest completed theme scan recorded (ScanDomain). */
  knownThemeHosts?: ReadonlySet<string>;
}

/** Sources a NEW_SCRIPT_HOST may come from (things that run or receive data). */
const NEW_HOST_SOURCES: ReadonlySet<HomepageSource> = new Set([
  "script_tag",
  "script",
  "iframe",
  "form",
  "importmap",
]);

/** Merchant-facing: how the page used a new host. */
const NEW_HOST_LABELS: Partial<Record<HomepageSource, string>> = {
  script_tag: "Loaded by a script tag an app added",
  script: "Loaded by a script tag in the page",
  iframe: "Loaded in a frame in the page",
  form: "Where a form in the page sends its data",
  importmap: "Named in an import map in the page",
};

/** Handlers that fire without a click, so a URL in them is a load, not a link. */
const SELF_FIRING_HANDLERS: ReadonlySet<string> = new Set(["onerror", "onload"]);

/** Elements whose markup holds the store menu. */
const MENU_ELEMENTS = ["nav", "header-menu", "menu-drawer", "mega-menu"] as const;

/** At most this many regions of each kind are tracked (a page has a handful). */
const MAX_REGIONS = 200;

type Region = { start: number; end: number; kind: "menu" | "checkout" };

/**
 * Elements whose content is never markup the page shows: text (script,
 * style, ...), an iframe's fallback text, or an inert `<template>`. A tag
 * written inside one opens nothing.
 */
const OPAQUE_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "noscript",
  "noembed",
  "noframes",
  "template",
  "iframe",
]);

const CC_SLASH = 0x2f;
const CC_GT = 0x3e;

/** Whether a `role` value names the navigation role (a space-separated, any-case list). */
function isNavigationRole(value: string | null | undefined): boolean {
  return (
    !!value &&
    asciiLowerCase(value)
      .split(/[\t\n\f\r ]+/)
      .includes("navigation")
  );
}

/** A link or button that IS the checkout: `name="checkout"`, an id naming checkout, a link to /checkout. */
function isCheckoutControl(attributes: ReadonlyMap<string, string | null>): boolean {
  const attr = (name: string) => asciiLowerCase((attributes.get(name) ?? "").trim());
  return (
    attr("name") === "checkout" ||
    attr("id").includes("checkout") ||
    /^\/checkout(?![a-z0-9_])/.test(attr("href"))
  );
}

/** The guard region a start tag opens, or null (see findGuardRegions). */
function regionKindOf(name: string, lowerTag: string, tag: string): Region["kind"] | null {
  if ((MENU_ELEMENTS as readonly string[]).includes(name)) return "menu";
  const checkoutCandidate = name === "a" || name === "button";
  if (!checkoutCandidate && !lowerTag.includes("role")) return null;
  const { attributes } = segmentAttributes(tag);
  if (isNavigationRole(attributes.get("role"))) return "menu";
  return checkoutCandidate && isCheckoutControl(attributes) ? "checkout" : null;
}

/**
 * Menu and checkout-button regions of the page (offsets into `html`), each
 * from its start tag to ITS close tag. A region is opened by:
 *   - a menu element (`<nav>`, `<header-menu>`, `<menu-drawer>`, `<mega-menu>`);
 *   - any element with a real `role="navigation"` attribute (gc-njwa #3);
 *   - a checkout `<button>` or `<a>` (`name="checkout"`, an id naming
 *     checkout, an href to /checkout).
 *
 * ONE forward walk over the page's real tags (wave 3 D4; it used to search
 * the text for `<nav` etc., so a tag name written inside a script string, a
 * comment, an attribute value or a template opened a region). The walk reads
 * the comment-blanked page walkHomepage reads (blankInertComments, length
 * preserved), skips the body of every OPAQUE_ELEMENTS element, reads
 * attributes with segmentAttributes (so `data-x="role=navigation"` is no
 * role, and a quoted `>` does not end a tag), and pairs each region with its
 * close tag by a per-name open count, so nested elements of the same name do
 * not end it early. Names are compared on an ASCII-only lower-case copy that
 * keeps every offset (wave 3 D2: `İ` lower-cases to two code units, which
 * shifted every later region).
 *
 * Linear: every step moves forward, and each close tag looks only at the
 * innermost open region of its name. At most MAX_REGIONS regions of each
 * kind are tracked; one never closed is no region (it would cover the rest of the
 * page).
 */
export function findGuardRegions(html: string, opts: WalkOptions = {}): Region[] {
  const live = opts.blanked ? html : blankInertComments(html, "homepage.html");
  const lower = asciiLowerCase(live);
  const regions: Region[] = [];
  const openByName = new Map<
    string,
    Array<{ start: number; depth: number; kind: Region["kind"] }>
  >();
  const depth = new Map<string, number>();
  const tracked: Record<Region["kind"], number> = { menu: 0, checkout: 0 };
  const n = lower.length;
  let i = lower.indexOf("<");
  while (i !== -1) {
    if (lower.startsWith("<!--", i)) {
      // A comment the blanking did not model: it runs to `-->`.
      const close = lower.indexOf("-->", i + 4);
      if (close === -1) break;
      i = lower.indexOf("<", close + 3);
      continue;
    }
    const closing = lower.charCodeAt(i + 1) === CC_SLASH;
    const nameStart = closing ? i + 2 : i + 1;
    const first = lower.charCodeAt(nameStart);
    if (!(first >= 0x61 && first <= 0x7a)) {
      i = lower.indexOf("<", i + 1);
      continue;
    }
    let j = nameStart + 1;
    while (j < n && lower.charCodeAt(j) !== CC_SLASH && lower.charCodeAt(j) !== CC_GT) {
      if (isHtmlSpace(lower.charCodeAt(j))) break;
      j++;
    }
    const name = lower.slice(nameStart, j);
    if (closing) {
      const gt = lower.indexOf(">", j);
      if (gt === -1) break;
      const level = Math.max(0, (depth.get(name) ?? 0) - 1);
      depth.set(name, level);
      const open = openByName.get(name);
      const top = open?.[open.length - 1];
      if (top && top.depth === level) {
        open!.pop();
        regions.push({ start: top.start, end: i, kind: top.kind });
      }
      i = lower.indexOf("<", gt + 1);
      continue;
    }
    const { end, closed } = tagEnd(live, i);
    if (!closed) break;
    if (OPAQUE_ELEMENTS.has(name)) {
      const close = closeTagAt(lower, name, end);
      if (close === -1) break;
      i = close;
      continue;
    }
    const level = depth.get(name) ?? 0;
    const kind = regionKindOf(name, lower.slice(i, end), live.slice(i, end));
    if (kind && tracked[kind] < MAX_REGIONS) {
      tracked[kind]++;
      const open = openByName.get(name) ?? [];
      open.push({ start: i, depth: level, kind });
      openByName.set(name, open);
    }
    depth.set(name, level + 1);
    i = lower.indexOf("<", end);
  }
  return regions;
}

/** The innermost-agnostic region kind at `at` ("checkout" wins over "menu"), or null. */
function regionAt(regions: readonly Region[], at: number): Region["kind"] | null {
  let kind: Region["kind"] | null = null;
  for (const r of regions) {
    if (at > r.start && at < r.end) {
      if (r.kind === "checkout") return "checkout";
      kind = "menu";
    }
  }
  return kind;
}

const REGION_WORDS: Record<Region["kind"], string> = {
  menu: "in your store menu",
  checkout: "in the checkout button",
};

/**
 * The shop's own hosts as trusted: each given host, plus its `www.` twin (the
 * apex of a `www.` host, or the `www.` of any other). Never another parent:
 * `x.myshopify.com` never makes `myshopify.com` (or any public suffix's
 * other subdomains) trusted. Audit fix: an exact match missed the apex or
 * `www.` the store also serves from.
 */
export function ownStoreHosts(shopHosts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of shopHosts) {
    const h = normalizeHost(raw);
    if (!h) continue;
    out.add(h);
    out.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
  }
  out.delete("");
  return out;
}

function cleanHost(host: string): string | null {
  const h = normalizeHost(host);
  return h.length <= MAX_HOST_LENGTH && isBareHostname(h) ? h : null;
}

function loaderFingerprint(host: string | null, reason: LoaderHit["reason"]): string {
  return `SCRIPT_LOADER:${host ?? reason}`;
}

/**
 * Analyze one served storefront page. Never throws for odd markup (the walk is
 * total); an unreadable app script-tag block reads as no script tags.
 */
export function analyzeStorefrontHtml(html: string, ctx: AnalyzeContext = {}): StorefrontAnalysis {
  const scriptTagUrls = parseScriptTagUrls(html) ?? [];
  // Comments blanked ONCE for every reader below (length kept, so offsets
  // agree): the known-malicious walk, the regions and the analyzer's walk.
  const live = blankInertComments(html, "homepage.html");
  const maliciousHits = findMaliciousInHomepage(live, scriptTagUrls, { blanked: true });
  const regions = findGuardRegions(live, { blanked: true });
  const shopHosts = ownStoreHosts(ctx.shopHosts ?? []);

  const loaders = new Map<string, LoaderHit>();
  const addLoader = (host: string | null, reason: LoaderHit["reason"], label: string) => {
    const clean = host ? cleanHost(host) : null;
    if (clean && matchMaliciousDomain(clean)) return; // reported as KNOWN_MALICIOUS
    const fingerprint = loaderFingerprint(clean, reason);
    if (!loaders.has(fingerprint))
      loaders.set(fingerprint, { fingerprint, host: clean, reason, label });
  };

  const hosts = new Map<string, NewHostCandidate>();

  /**
   * A host the store, its theme or a known app owns: the shop's own domains
   * (Shopify serves theme assets from the primary domain, `/cdn/shop/...`),
   * hosts the latest theme scan recorded, the allowlist, known apps and
   * benign libraries. A loader on such a host is not evidence by itself
   * (audit fix: a theme's own menu script must never email the merchant).
   */
  const isTrustedHost = (host: string, rawUrl: string | null): boolean => {
    if (isShopifyDomain(host) || shopHosts.has(host) || isGuardAllowedHost(host)) return true;
    if (ctx.knownThemeHosts?.has(host)) return true;
    const url = rawUrl?.trim() || `https://${host}/`;
    return identifyAppForExternalUrl(url) !== null || isBenignLibrary(url);
  };

  walkHomepage(
    live,
    scriptTagUrls,
    {
      host(rawHost, source, rawUrl) {
        if (!NEW_HOST_SOURCES.has(source)) return;
        const host = cleanHost(rawHost);
        if (!host || hosts.has(host)) return;
        if (matchMaliciousDomain(host) || isTrustedHost(host, rawUrl)) return;
        hosts.set(host, { host, source, label: NEW_HOST_LABELS[source] ?? "Loaded by the page" });
      },
      handler(element, name, value, at) {
        if (element === "script") return;
        const hit = findScriptPayload(value, { urlCounts: SELF_FIRING_HANDLERS.has(name) });
        if (!hit) return;
        const host = hit.host ? cleanHost(hit.host) : null;
        const trusted = host !== null && isTrustedHost(host, null);
        // A URL alone is evidence only on a host nobody vouches for.
        if (hit.reason === "external_url" && (host === null || trusted)) return;
        const region = regionAt(regions, at);
        const where = region ? ` ${REGION_WORDS[region]}` : " in the page";
        // Code construction stays a loader; a trusted host is not its identity.
        addLoader(trusted ? null : host, hit.reason, `Code in an ${name} attribute${where}`);
      },
      script(at, info) {
        if (!info.runs) return;
        const region = regionAt(regions, at);
        if (!region) return;
        const external = info.src ? firstExternalHost(info.src) : null;
        const srcHost =
          external && !isTrustedHost(cleanHost(external) ?? external, info.src) ? external : null;
        const payload = info.src ? null : findScriptPayload(info.body());
        if (!srcHost && !payload) return;
        addLoader(
          srcHost ?? payload!.host,
          region === "checkout" ? "script_in_checkout" : "script_in_menu",
          `A script ${REGION_WORDS[region]}`,
        );
      },
    },
    { blanked: true },
  );

  return {
    maliciousHits,
    loaders: [...loaders.values()],
    hosts: [...hosts.values()],
  };
}
