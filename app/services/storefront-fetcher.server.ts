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
 * Network safety (DNS rebinding): requests go through an undici Agent whose
 * `connect.lookup` resolves the hostname and refuses to connect when ANY
 * resolved address is private, loopback, link-local, CGNAT, multicast,
 * reserved, or a v4-mapped form of those. The check runs at connect time, on
 * every hop, so a name that re-resolves to an internal address is refused
 * (`blocked_address`). IP-literal hosts are rejected before any request.
 *
 * Published theme only: the storefront renders only the MAIN theme, so a scan
 * of any other theme returns `not_published` without a request.
 *
 * Logging: host + outcome only. Never the query string, a ScriptTag URL, or HTML.
 */

import dns from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

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
  | "parse_failed"
  | "blocked_address";

export type StorefrontScriptTagResult =
  /** Flag off: nothing was requested (no Admin call, no HTTP). */
  | { status: "disabled" }
  /** The scanned theme is not the published (MAIN) one: no request was made. */
  | { status: "not_published" }
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

const STOREFRONT_CONTEXT_QUERY = `
  query StorefrontContext($themeId: ID!) {
    shop {
      primaryDomain {
        host
        url
      }
      myshopifyDomain
    }
    theme(id: $themeId) {
      role
    }
  }
`;

type ShopDomains = { primaryHost: string; myshopifyHost: string | null };

type StorefrontContext = { domains: ShopDomains | null; published: boolean };

/**
 * ONE Admin query: the shop's primary storefront host + myshopify host (null
 * when unusable) and whether the scanned theme is the published (MAIN) one.
 */
async function fetchStorefrontContext(
  admin: AdminApiContext,
  themeId: string,
): Promise<StorefrontContext> {
  const response = await admin.graphql(STOREFRONT_CONTEXT_QUERY, { variables: { themeId } });
  const body = (await response.json()) as {
    data?: {
      shop?: {
        primaryDomain?: { host?: unknown; url?: unknown } | null;
        myshopifyDomain?: unknown;
      } | null;
      theme?: { role?: unknown } | null;
    } | null;
    errors?: unknown;
  };
  const published = body?.data?.theme?.role === "MAIN";
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
  if (!primaryHost || !isBareHostname(primaryHost)) return { domains: null, published };
  const myshopify =
    typeof shop?.myshopifyDomain === "string" && isBareHostname(shop.myshopifyDomain)
      ? shop.myshopifyDomain.toLowerCase()
      : null;
  return {
    domains: { primaryHost: primaryHost.toLowerCase(), myshopifyHost: myshopify },
    published,
  };
}

/**
 * A dotted DNS hostname with no scheme, port, path, or credentials, and not an
 * IP literal: an all-numeric last label (127.0.0.1, 10.1) is never a real TLD,
 * and IPv6 literals (colons, brackets) fail the character class.
 */
export function isBareHostname(host: string): boolean {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
    return false;
  }
  const lastLabel = host.slice(host.lastIndexOf(".") + 1);
  return !/^\d+$/.test(lastLabel) && isIP(host) === 0;
}

// ---------------------------------------------------------------------------
// Connect-time address guard (DNS rebinding / SSRF)
// ---------------------------------------------------------------------------

const BLOCKED_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_RANGES.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address inside a v4-mapped IPv6 address (::ffff:a.b.c.d / ::ffff:hhhh:hhhh). */
function v4FromMapped(ip: string): string | null {
  const match = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/i.exec(ip);
  if (!match) return null;
  const tail = match[1];
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when the storefront fetch must never connect to `ip` (or it is not an IP). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_RANGES.check(ip, "ipv4");
  if (family === 6) {
    const mapped = v4FromMapped(ip);
    if (mapped) return BLOCKED_RANGES.check(mapped, "ipv4");
    return BLOCKED_RANGES.check(ip, "ipv6");
  }
  return true;
}

/** Raised by the guarded lookup; detected through fetch's `cause` chain. */
export class BlockedAddressError extends Error {
  readonly code = "ERR_BLOCKED_ADDRESS";
  constructor(hostname: string) {
    super(`refused to connect: ${hostname} resolves to a blocked address`);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;
type DnsLookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * A `connect.lookup` for undici: resolves every address for the name and
 * refuses the connection if ANY is blocked (so a mixed public/private answer
 * cannot be raced). Honors both the single-address and `all: true` shapes
 * Node's net/tls may request. `resolve` is the test seam (default dns.lookup).
 */
export function createGuardedLookup(resolve: DnsLookupAll = dns.lookup as DnsLookupAll) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      if (
        !Array.isArray(addresses) ||
        addresses.length === 0 ||
        addresses.some((a) => isBlockedAddress(a.address))
      ) {
        return callback(new BlockedAddressError(hostname), "");
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function isBlockedAddressFailure(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof BlockedAddressError) return true;
    if ((e as { code?: unknown }).code === "ERR_BLOCKED_ADDRESS") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Minimal fetch shape used here (the injected test seam or undici's fetch). */
export type StorefrontFetch = (url: URL, init: Record<string, unknown>) => Promise<Response>;

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
 * @param opts.themeId   The scanned theme; only the published (MAIN) one is checked.
 * @param opts.fetchImpl Test seam; defaults to undici's fetch.
 * @param opts.dnsLookup Test seam for the connect-time address guard.
 */
export async function fetchStorefrontScriptTags(
  admin: AdminApiContext,
  opts: {
    shopId: string;
    themeId: string;
    fetchImpl?: StorefrontFetch;
    dnsLookup?: DnsLookupAll;
    timeoutMs?: number;
  },
): Promise<StorefrontScriptTagResult> {
  // Dark gate FIRST: no Admin call and no HTTP while the flag is off.
  if (!isScriptTagSunsetLive()) return { status: "disabled" };

  const { shopId } = opts;

  let context: StorefrontContext;
  try {
    context = await fetchStorefrontContext(admin, opts.themeId);
  } catch {
    return unreachable("no_domain", shopId, null);
  }
  // The storefront renders only the published theme: other themes are not
  // checked at all (no request, no category, no finding).
  if (!context.published) return { status: "not_published" };
  const { domains } = context;
  if (!domains) return unreachable("no_domain", shopId, null);

  const fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as StorefrontFetch);
  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(opts.dnsLookup) },
  });

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
        dispatcher,
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
    if (isBlockedAddressFailure(err)) {
      return unreachable("blocked_address", shopId, domains.primaryHost);
    }
    return unreachable(
      controller.signal.aborted ? "timeout" : "network",
      shopId,
      domains.primaryHost,
    );
  } finally {
    clearTimeout(timer);
    void dispatcher.close().catch(() => {});
  }
}
