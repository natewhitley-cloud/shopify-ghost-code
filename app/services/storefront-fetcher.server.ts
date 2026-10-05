/**
 * Storefront ScriptTag fetcher (SCRIPT_TAG_SUNSET audit).
 *
 * The ONLY place the scanner reads a shop's public storefront, and it is DARK:
 * while SCRIPT_TAG_SUNSET_LIVE_ENABLED is not "true" it returns `disabled`
 * before making any Admin API call or HTTP request. (Everything else in the
 * scanner deliberately has no storefront fetcher; see the note in
 * dangling-reference-resolver.server.ts.)
 *
 * Why the storefront: the Admin `scriptTags` query returns only the CALLING
 * app's own tags, so other apps' ScriptTags are visible only in the public
 * homepage, where Shopify renders them in content_for_header as an asyncLoad
 * block (`var urls = ["https:\/\/...", ...];`).
 *
 * SSRF safety: the only URL ever requested is `https://<primaryDomain host>/`
 * from the Admin API (never a URL from theme content). Redirects are followed
 * manually, at most MAX_REDIRECTS, and only to the primary domain host or the
 * shop's myshopify host; anything else is unreachable. One request chain per
 * scan, homepage only, 10 s total budget, 5 MB body cap.
 *
 * Logging: host + outcome only. Never the query string, a ScriptTag URL, or HTML.
 */

import { isScriptTagSunsetLive } from "./soft-launch-flags.server";
import { logger } from "../lib/logger.server";
import type { AdminApiContext } from "../types/shopify";

export const STOREFRONT_FETCH_TIMEOUT_MS = 10_000;
export const STOREFRONT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const STOREFRONT_MAX_REDIRECTS = 3;
export const STOREFRONT_USER_AGENT = "GhostCode/1.0 (+https://alpenglowsoftware.com)";

/** Why the storefront could not be read (logged; never shown raw to merchants). */
export type StorefrontUnreachableReason =
  | "no_domain"
  | "password"
  | "http_status"
  | "redirect_refused"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "network"
  | "not_shopify"
  | "parse_failed";

export type StorefrontScriptTagResult =
  /** Flag off: nothing was requested (no Admin call, no HTTP). */
  | { status: "disabled" }
  /** The storefront was read; `urls` are the raw ScriptTag URLs (may be empty). */
  | { status: "ok"; host: string; urls: string[] }
  | { status: "unreachable"; reason: StorefrontUnreachableReason };

// ---------------------------------------------------------------------------
// Parser (pure)
// ---------------------------------------------------------------------------

const ASYNC_LOAD_RE = /function\s+asyncLoad\s*\(\s*\)\s*\{/;
const URLS_DECL_RE = /var\s+urls\s*=\s*\[/;

/**
 * Index just past the `]` that closes the array literal starting at `start`
 * (which must point at `[`), skipping brackets inside double-quoted strings.
 * -1 when the literal never closes.
 */
function closeOfArrayLiteral(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extract the ScriptTag URLs from storefront HTML.
 *
 * Returns:
 *   - `[]` when there is no asyncLoad block (a Shopify page with no ScriptTags)
 *     or its array is empty;
 *   - the URL strings (JSON-unescaped, so `\/` becomes `/`) when present;
 *   - `null` when the block is present but unreadable (array never closes,
 *     JSON.parse fails, or it is not an array of strings). Callers must treat
 *     null as "could not check", never as "zero".
 *
 * Which `var urls`: only the one inside Shopify's `function asyncLoad()` and
 * before that script's closing `</script>`. Themes and other apps can declare
 * their own `var urls = [...]` elsewhere on the page; those are ignored, so a
 * page whose only `var urls` is outside asyncLoad reads as zero ScriptTags.
 */
export function parseScriptTagUrls(html: string): string[] | null {
  const asyncLoad = ASYNC_LOAD_RE.exec(html);
  if (!asyncLoad) return [];
  const bodyStart = asyncLoad.index + asyncLoad[0].length;
  const scriptEnd = html.indexOf("</script>", bodyStart);
  const body = html.slice(bodyStart, scriptEnd === -1 ? html.length : scriptEnd);

  const decl = URLS_DECL_RE.exec(body);
  // Shopify's asyncLoad always declares its urls; an asyncLoad without one is
  // a format we do not understand, so it is unreadable rather than "zero".
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  const close = closeOfArrayLiteral(body, open);
  if (close === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(open, close));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === "string")) return null;
  return parsed as string[];
}

/** A real Shopify storefront always sets `Shopify.shop = "x.myshopify.com";`. */
export function isShopifyStorefrontHtml(html: string): boolean {
  return /Shopify\.shop\s*=/.test(html);
}

/** Shopify's password page carries a `template-password` body class. */
function isPasswordPageHtml(html: string): boolean {
  return /\btemplate-password\b/.test(html);
}

// ---------------------------------------------------------------------------
// Admin lookup
// ---------------------------------------------------------------------------

const SHOP_DOMAINS_QUERY = `{ shop { primaryDomain { host url } myshopifyDomain } }`;

type ShopDomains = { primaryHost: string; myshopifyHost: string | null };

/** The shop's primary storefront host + myshopify host, or null if unknown. */
async function fetchShopDomains(admin: AdminApiContext): Promise<ShopDomains | null> {
  const response = await admin.graphql(SHOP_DOMAINS_QUERY);
  const body = (await response.json()) as {
    data?: {
      shop?: {
        primaryDomain?: { host?: unknown; url?: unknown } | null;
        myshopifyDomain?: unknown;
      } | null;
    } | null;
    errors?: unknown;
  };
  const shop = body?.data?.shop;
  const primary = shop?.primaryDomain;
  // Prefer the URL's hostname (the canonical storefront address); fall back to
  // `host`. Either way it is validated as a bare hostname below.
  let primaryHost: string | null = null;
  if (typeof primary?.url === "string") {
    try {
      primaryHost = new URL(primary.url).hostname;
    } catch {
      primaryHost = null;
    }
  }
  if (!primaryHost && typeof primary?.host === "string") primaryHost = primary.host;
  if (!primaryHost || !isBareHostname(primaryHost)) return null;
  const myshopify =
    typeof shop?.myshopifyDomain === "string" && isBareHostname(shop.myshopifyDomain)
      ? shop.myshopifyDomain.toLowerCase()
      : null;
  return { primaryHost: primaryHost.toLowerCase(), myshopifyHost: myshopify };
}

/** A dotted DNS hostname with no scheme, port, path, or credentials. */
function isBareHostname(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {}

/** Read a response body as text, aborting once it exceeds `maxBytes`. */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function unreachable(
  reason: StorefrontUnreachableReason,
  shopId: string,
  host: string | null,
): StorefrontScriptTagResult {
  logger.info("storefront script tags unreachable", {
    function: "storefront-fetcher",
    event: "storefront_unreachable",
    shopId,
    host,
    reason,
  });
  return { status: "unreachable", reason };
}

/**
 * Read the shop's public homepage and extract its ScriptTag URLs.
 *
 * Never throws: every failure (Admin error, network, timeout, unexpected HTML)
 * is `unreachable`, so the caller can record the category as un-audited.
 *
 * @param opts.fetchImpl Test seam; defaults to the global fetch.
 */
export async function fetchStorefrontScriptTags(
  admin: AdminApiContext,
  opts: { shopId: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<StorefrontScriptTagResult> {
  // Dark gate FIRST: no Admin call and no HTTP while the flag is off.
  if (!isScriptTagSunsetLive()) return { status: "disabled" };

  const { shopId } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let domains: ShopDomains | null;
  try {
    domains = await fetchShopDomains(admin);
  } catch {
    domains = null;
  }
  if (!domains) return unreachable("no_domain", shopId, null);

  const allowedHosts = new Set([domains.primaryHost]);
  if (domains.myshopifyHost) allowedHosts.add(domains.myshopifyHost);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? STOREFRONT_FETCH_TIMEOUT_MS);
  let url = new URL(`https://${domains.primaryHost}/`);
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": STOREFRONT_USER_AGENT, Accept: "text/html" },
      });
      if (response.status < 300 || response.status >= 400) break;

      await response.body?.cancel().catch(() => {});
      if (redirects >= STOREFRONT_MAX_REDIRECTS) {
        return unreachable("too_many_redirects", shopId, domains.primaryHost);
      }
      const location = response.headers.get("location");
      let next: URL | null = null;
      try {
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      if (
        !next ||
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        next.port ||
        !allowedHosts.has(next.hostname.toLowerCase())
      ) {
        return unreachable("redirect_refused", shopId, domains.primaryHost);
      }
      url = next;
    }

    // Password-protected stores serve /password instead of the homepage.
    if (url.pathname === "/password" || url.pathname.startsWith("/password/")) {
      await response.body?.cancel().catch(() => {});
      return unreachable("password", shopId, domains.primaryHost);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      return unreachable("http_status", shopId, domains.primaryHost);
    }

    const html = await readCappedText(response, STOREFRONT_MAX_BODY_BYTES);
    if (isPasswordPageHtml(html)) return unreachable("password", shopId, domains.primaryHost);
    if (!isShopifyStorefrontHtml(html)) {
      return unreachable("not_shopify", shopId, domains.primaryHost);
    }
    const urls = parseScriptTagUrls(html);
    if (urls === null) return unreachable("parse_failed", shopId, domains.primaryHost);

    logger.info("storefront script tags read", {
      function: "storefront-fetcher",
      event: "storefront_read",
      shopId,
      host: domains.primaryHost,
      scriptTagCount: urls.length,
    });
    return { status: "ok", host: domains.primaryHost, urls };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return unreachable("too_large", shopId, domains.primaryHost);
    }
    return unreachable(
      controller.signal.aborted ? "timeout" : "network",
      shopId,
      domains.primaryHost,
    );
  } finally {
    clearTimeout(timer);
  }
}
