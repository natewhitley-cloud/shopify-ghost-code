// ---------------------------------------------------------------------------
// Detector: SCRIPT_TAG_SUNSET — apps still loading through a storefront ScriptTag
// ---------------------------------------------------------------------------
//
// PURE, side-effect-free. Operates ONLY on ScriptTag URLs already read from the
// shop's public storefront (storefront-fetcher.server.ts) plus the set of apps
// with an ENABLED theme app embed. No Admin API, DB, or network access.
//
// Background: Shopify stops running storefront ScriptTags on March 1, 2027
// (changelog 2026-08-24; create/update blocked since 2026-10-01). An app that
// still loads its storefront JS through a ScriptTag stops working on that store
// unless its vendor moves it to a theme app embed. Merchants cannot see
// ScriptTags in the admin, and they cannot remove them either, so the copy only
// ever points at the vendor (never "delete this").
//
// Grouping: one finding per app (signature match via identifyAppFromUrl), else
// per hostname. Severity: LOW when that app also has an enabled app embed (it
// has probably migrated already), otherwise HIGH. An unmatched host can never
// be tied to an embed, so it is always HIGH.
//
// Privacy: ScriptTag URLs carry shop ids, guids, and tokens in their query
// strings, so the query and fragment are stripped BEFORE anything is grouped,
// attributed, stored, or fingerprinted.

import { FindingType, Severity } from "@prisma/client";

import { identifyAppFromUrl } from "./app-lookup.server";
import type { CreateFindingInput } from "../models/finding.server";

/** The instant Shopify stops running storefront ScriptTags. */
export const SCRIPT_TAG_SUNSET_AT_MS = Date.parse("2027-03-01T00:00:00Z");

/** Synthetic locator for every SCRIPT_TAG_SUNSET finding (not a theme file). */
export const SCRIPT_TAG_FINDING_FILENAME = "storefront/script-tags";

/** Shopify's own CDN: app files can be hosted there, but it names no app. */
const SHOPIFY_CDN_HOST = "cdn.shopify.com";

/**
 * Reduce a ScriptTag URL to `protocol//host/path`: query string and fragment
 * dropped. Returns null for anything that is not a parseable http(s) URL
 * (protocol-relative URLs are read as https, matching how the browser loads
 * them from an https storefront).
 */
export function stripQueryAndFragment(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

interface ScriptTagGroup {
  /** Signature app name, or null when only the host is known. */
  appName: string | null;
  host: string;
  urls: Set<string>;
}

/**
 * Detect apps still loading through a storefront ScriptTag.
 *
 * @param scriptTagUrls   Raw URLs from the storefront's asyncLoad block.
 * @param enabledEmbedApps Signature app names with an ENABLED theme app embed
 *                        (scan-engine `enabledAppEmbedApps`). Disabled embeds
 *                        must not be in this set.
 * @param now             Clock seam for the date-aware copy.
 * @returns One finding per app (or host), in a stable order.
 */
export function detectScriptTagSunset(
  scriptTagUrls: readonly string[],
  enabledEmbedApps: ReadonlySet<string>,
  now: Date = new Date(),
): CreateFindingInput[] {
  const groups = new Map<string, ScriptTagGroup>();
  for (const raw of scriptTagUrls) {
    if (typeof raw !== "string") continue;
    const url = stripQueryAndFragment(raw);
    if (!url) continue;
    const host = new URL(url).hostname.toLowerCase();
    // Attribute on the stripped URL: the query carries shop-specific values
    // that must not decide (or leak into) the attribution.
    const appName = identifyAppFromUrl(url);
    const key = appName ? `app:${appName}` : `host:${host}`;
    const group = groups.get(key) ?? { appName, host, urls: new Set<string>() };
    group.urls.add(url);
    groups.set(key, group);
  }

  const afterSunset = now.getTime() >= SCRIPT_TAG_SUNSET_AT_MS;
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => {
      const embedOn = group.appName !== null && enabledEmbedApps.has(group.appName);
      return {
        filename: SCRIPT_TAG_FINDING_FILENAME,
        lineNumber: 1,
        // Sorted so the same set of URLs always yields the same snippet (and
        // fingerprint), whatever order the storefront rendered them in.
        codeSnippet: [...group.urls].sort().join("\n"),
        findingType: FindingType.SCRIPT_TAG_SUNSET,
        severity: embedOn ? Severity.LOW : Severity.HIGH,
        appName: group.appName ?? undefined,
        description: describe(group, embedOn, afterSunset),
      };
    });
}

/** Merchant copy for one group. No em dashes anywhere (house style). */
function describe(group: ScriptTagGroup, embedOn: boolean, afterSunset: boolean): string {
  // `subject` opens the sentence; `ref` is every later mention.
  let subject: string;
  let ref: string;
  if (group.appName) {
    subject = group.appName;
    ref = group.appName;
  } else if (group.host === SHOPIFY_CDN_HOST) {
    subject = "An app script hosted on Shopify's CDN";
    ref = "that app";
  } else {
    subject = `An app loading from ${group.host}`;
    ref = "that app";
  }

  if (embedOn) {
    // Only reachable for a signature match, so `ref` is the app's name.
    return afterSunset
      ? `${subject} loads on your storefront through a script tag, which Shopify stopped running on March 1, 2027. ${ref} also has an app embed turned on in your theme, so it has probably moved already. Worth confirming with ${ref}'s support.`
      : `${subject} loads on your storefront through a script tag, which Shopify will stop running on March 1, 2027. ${ref} also has an app embed turned on in your theme, so it has probably moved already. Worth confirming with ${ref}'s support.`;
  }
  return afterSunset
    ? `${subject} loads on your storefront through a script tag. Shopify stopped running script tags on March 1, 2027, so the parts of ${ref} that rely on it have stopped working on your store unless ${ref} has moved to an app embed. Ask ${ref}'s support whether they have migrated.`
    : `${subject} loads on your storefront through a script tag. Shopify will stop running script tags on March 1, 2027, so the parts of ${ref} that rely on it will stop working on your store unless ${ref} moves to an app embed before then. Ask ${ref}'s support whether they have migrated.`;
}
