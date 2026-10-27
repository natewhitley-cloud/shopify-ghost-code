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
 * Known limits: menu regions are found by tag name, not by role or class
 * (`<div role="navigation">` is not a region); a region ends at the first
 * matching close tag, and an element that never closes is no region (audit
 * fix: it used to run to the end of the page).
 */
import {
  findMaliciousInHomepage,
  MAX_HOST_LENGTH,
  normalizeHost,
  walkHomepage,
  type HomepageMaliciousHit,
  type HomepageSource,
} from "./runtime-malicious.server";
import { identifyAppForExternalUrl, isShopifyDomain } from "./scan-engine.server";
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

/** Index of the first `<name` start tag at or after `from` (any case). */
function findTag(lower: string, name: string, from: number): number {
  for (let i = lower.indexOf(`<${name}`, from); i !== -1; i = lower.indexOf(`<${name}`, i + 1)) {
    if (/[\s>/]/.test(lower.charAt(i + name.length + 1))) return i;
  }
  return -1;
}

const CHECKOUT_TAG_RE =
  /\sname\s*=\s*["']?checkout["'\s>]|\sid\s*=\s*["']?[^"'\s>]*checkout|\shref\s*=\s*["']?\/checkout\b/;

/** Menu and checkout-button regions of the page (offsets into `html`). */
export function findGuardRegions(html: string): Region[] {
  const lower = html.toLowerCase();
  const regions: Region[] = [];
  for (const name of MENU_ELEMENTS) {
    let from = 0;
    for (let n = 0; n < MAX_REGIONS; n++) {
      const start = findTag(lower, name, from);
      if (start === -1) break;
      const close = lower.indexOf(`</${name}`, start);
      // Never closed: not a region (it would cover the rest of the page).
      if (close === -1) break;
      regions.push({ start, end: close, kind: "menu" });
      from = close;
    }
  }
  for (const name of ["button", "a"] as const) {
    let from = 0;
    for (let seen = 0; seen < MAX_REGIONS * 5; seen++) {
      const start = findTag(lower, name, from);
      if (start === -1) break;
      from = start + name.length + 1;
      const tagEnd = lower.indexOf(">", start);
      if (tagEnd === -1) break;
      if (tagEnd - start > 2048 || !CHECKOUT_TAG_RE.test(lower.slice(start, tagEnd + 1))) continue;
      const close = lower.indexOf(`</${name}`, tagEnd);
      // Never closed: not a region (it would cover the rest of the page).
      if (close === -1) continue;
      regions.push({ start, end: close, kind: "checkout" });
      if (regions.length >= MAX_REGIONS * 2) break;
    }
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
  const maliciousHits = findMaliciousInHomepage(html, scriptTagUrls);
  const regions = findGuardRegions(html);
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

  walkHomepage(html, scriptTagUrls, {
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
  });

  return {
    maliciousHits,
    loaders: [...loaders.values()],
    hosts: [...hosts.values()],
  };
}
