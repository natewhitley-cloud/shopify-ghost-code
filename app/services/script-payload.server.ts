/**
 * Loader-payload matcher (gc-1q1s.2): does a piece of text build or load
 * code? The checkout guard runs it over served `on*=` handler values and
 * scripts inside menu or checkout-button markup.
 *
 * NOT shared with the menu-label scan (gc-7gjj.7, decided 2026-10-27): the
 * two answer different questions, so they keep two rule sets.
 *   - Here (served pages): handlers are everywhere in real themes
 *     (`onload="this.media='all'"`, `onerror="this.style.display='none'"`),
 *     so a handler counts only when its VALUE builds or loads code.
 *   - menu-injection-detector.server.ts (menu titles from the Admin API): a
 *     menu label is plain text, so ANY tag that can run or load something
 *     (`<script`, any `on*=` attribute, frames, `<base>`, `<link>`, script
 *     URLs, listed domains) is flagged, whatever its value. Feeding labels
 *     through this matcher would miss `<img onerror=alert(1)>`; feeding pages
 *     through the menu rules would flag every theme's async-CSS idiom.
 * Shared pieces stay shared: both use urlHostsOnLine (scan-engine) and the
 * curated malicious-domain list.
 *
 * Precision first (a hit can email a merchant):
 *   - Code construction: `createElement('script')`, `import(`, `eval(`,
 *     `Function(`, `atob(`, `fromCharCode`, `document.write(`.
 *   - A URL on a non-Shopify host counts only when `urlCounts` is set: the
 *     guard sets it for handlers that fire on their own (`onerror`,
 *     `onload`), and then only when the text names a `.js`/`.mjs` file or
 *     makes a network call or navigation (`fetch(`, `sendBeacon(`, `open(`,
 *     `location`). An image fallback (`this.src='https://x/y.png'`) never
 *     counts. A click handler that opens a link (`onclick="window.open(
 *     'https://wa.me/...')"`) is navigation, not a loader.
 *   - Handlers that only touch the element (`onload="this.media='all'"`, the
 *     async CSS idiom; `onerror="this.style.display='none'"`) never match.
 *
 * Pure: no I/O, no logging.
 */
import { isShopifyDomain, urlHostsOnLine } from "./scan-engine.server";

export type ScriptPayloadReason =
  | "creates_script"
  | "dynamic_import"
  | "evaluates_code"
  | "decodes_code"
  | "writes_markup"
  | "external_url";

export interface ScriptPayloadHit {
  reason: ScriptPayloadReason;
  /** The first non-Shopify URL host in the text (lower case), or null. */
  host: string | null;
}

/** Longest text examined; a longer value is read up to this length. */
export const MAX_PAYLOAD_TEXT = 8192;

const CODE_PATTERNS: ReadonlyArray<[ScriptPayloadReason, RegExp]> = [
  ["creates_script", /createElement\s*\(\s*(?:["'`]|\\["'])\s*script\b/i],
  ["dynamic_import", /\bimport\s*\(/],
  ["evaluates_code", /\b(?:eval|Function)\s*\(/],
  ["decodes_code", /\batob\s*\(|\bfromCharCode\b/],
  ["writes_markup", /\bdocument\s*\.\s*write(?:ln)?\s*\(/],
];

/** A URL path ending in .js / .mjs (query, hash or quote may follow). */
const SCRIPT_URL_RE = /\/\/[^\s'"`]+\.m?js(?=$|[?#'"`\s)])/i;
/** A network send or a navigation. */
const NETWORK_CALL_RE =
  /\b(?:fetch|sendBeacon|XMLHttpRequest|open)\s*\(|\blocation\s*(?:\.\s*(?:href|assign|replace)\b|=)/;

/** The first URL host in `text` that is not a Shopify domain, lower case. */
export function firstExternalHost(text: string): string | null {
  for (const host of urlHostsOnLine(text)) {
    const clean = host.toLowerCase().replace(/\.$/, "");
    if (!isShopifyDomain(clean)) return clean;
  }
  return null;
}

/** Whether `text` builds or loads code (see the module comment), or null. */
export function findScriptPayload(
  text: string,
  opts: { urlCounts?: boolean } = {},
): ScriptPayloadHit | null {
  const value = text.length > MAX_PAYLOAD_TEXT ? text.slice(0, MAX_PAYLOAD_TEXT) : text;
  const host = firstExternalHost(value);
  for (const [reason, pattern] of CODE_PATTERNS) {
    if (pattern.test(value)) return { reason, host };
  }
  // A URL alone (no code construction) counts only when it LOADS or SENDS:
  // a script file, a network call or a navigation. An image fallback
  // (`this.src='https://cdn.example/x.png'`) never does (audit fix).
  if (opts.urlCounts && host && (SCRIPT_URL_RE.test(value) || NETWORK_CALL_RE.test(value))) {
    return { reason: "external_url", host };
  }
  return null;
}
