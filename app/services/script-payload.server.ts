/**
 * Loader-payload matcher (gc-1q1s.2): does a piece of text build or load
 * code? ONE pure function meant to be shared: the checkout guard runs it over
 * served `on*=` handler values and scripts inside menu or checkout-button
 * markup; the menu-label scan (gc-7gjj) can run it over menu titles from the
 * Admin navigation API.
 *
 * Precision first (a hit can email a merchant):
 *   - Code construction: `createElement('script')`, `import(`, `eval(`,
 *     `Function(`, `atob(`, `fromCharCode`, `document.write(`.
 *   - A URL on a non-Shopify host counts only when `urlCounts` is set: the
 *     guard sets it for handlers that fire on their own (`onerror`,
 *     `onload`). A click handler that opens a link (`onclick="window.open(
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
  if (opts.urlCounts && host) return { reason: "external_url", host };
  return null;
}
