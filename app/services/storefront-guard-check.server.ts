/**
 * Checkout guard page reader (gc-1q1s.3): reads the shop's public homepage and
 * empty cart page with CACHED storefront hosts (no Admin call per check) over
 * the one guarded storefront GET (storefront-fetcher.server), and returns a
 * typed outcome.
 *
 * The page HTML never leaves this module's call: the caller passes `analyze`,
 * which runs on each page's HTML here and returns plain values (hostnames and
 * labels, never page text).
 *
 * Outcome rules (the state machine relies on them):
 *   - `ok`: the homepage was read; `complete` says whether /cart was too. Only
 *     a complete check can count as clean for an incident or teach the
 *     new-host baseline; a partial one can only add sightings.
 *   - `paused_password`: the store serves its password page. Never clean,
 *     never a hit, no backoff.
 *   - `paused_redirect`: the primary host redirects us to another host the
 *     read may not follow (often a market domain). Never clean, never a hit.
 *   - `unreachable`: anything else (timeout, network, blocked address, HTTP
 *     status, not a Shopify page, too large). Never clean, never a hit.
 *     `challenged` = HTTP 403 or 429 (bot protection or rate limit): the cron
 *     backs off at once instead of after three in a row.
 *   - `error`: `analyze` threw on the homepage. Never clean, never a hit.
 *
 * Requests: at most two sequential GETs (homepage, then /cart), each with the
 * fetcher's own 10 s budget, 5 MB cap, redirect allowlist and DNS-rebinding
 * guard. Logging: host + outcome only.
 */

import {
  isPasswordPageHtml,
  isPasswordPath,
  isShopifyStorefrontHtml,
  readStorefrontPage,
  type DnsLookupAll,
  type ShopDomains,
  type StorefrontFetch,
  type StorefrontPagePath,
  type StorefrontUnreachableReason,
} from "./storefront-fetcher.server";
import { logger } from "../lib/logger.server";
import type { GuardPage } from "../lib/storefront-guard-state";

const PAGE_PATHS: ReadonlyArray<{ page: GuardPage; path: StorefrontPagePath }> = [
  { page: "home", path: "/" },
  { page: "cart", path: "/cart" },
];

/** Why a check could not read the store (logged and stored; never shown raw). */
export type GuardUnreachableReason = Exclude<
  StorefrontUnreachableReason,
  "no_domain" | "password" | "redirect_other_domain" | "parse_failed"
>;

export type GuardPageResult<T> = { page: GuardPage; result: T };

export type StorefrontCheckOutcome<T> =
  | { outcome: "ok"; pages: GuardPageResult<T>[]; complete: boolean }
  | { outcome: "paused_password" }
  | { outcome: "paused_redirect"; redirectHost: string | null }
  | { outcome: "unreachable"; reason: GuardUnreachableReason; challenged: boolean }
  | { outcome: "error" };

type PageRead<T> =
  | { status: "ok"; result: T }
  | { status: "password" }
  | { status: "redirect"; host: string | null }
  | { status: "unreachable"; reason: GuardUnreachableReason; challenged: boolean }
  | { status: "error" };

/** HTTP statuses that mean bot protection or a rate limit, not a broken store. */
function isChallengeStatus(httpStatus: number): boolean {
  return httpStatus === 403 || httpStatus === 429;
}

async function readOnePage<T>(
  domains: ShopDomains,
  path: StorefrontPagePath,
  analyze: (html: string) => T,
  opts: CheckStorefrontOptions,
): Promise<PageRead<T>> {
  const read = await readStorefrontPage(domains, path, {
    readBody: (url, httpStatus) =>
      !isPasswordPath(url.pathname) && httpStatus >= 200 && httpStatus < 300,
    fetchImpl: opts.fetchImpl,
    dnsLookup: opts.dnsLookup,
    timeoutMs: opts.timeoutMs,
  });
  if (read.status === "unreachable") {
    if (read.reason === "redirect_other_domain") {
      return { status: "redirect", host: read.redirectHost ?? null };
    }
    return { status: "unreachable", reason: read.reason, challenged: false };
  }
  if (isPasswordPath(read.url.pathname)) return { status: "password" };
  if (read.httpStatus < 200 || read.httpStatus >= 300 || read.body === null) {
    return {
      status: "unreachable",
      reason: "http_status",
      challenged: isChallengeStatus(read.httpStatus),
    };
  }
  const html = read.body;
  if (isPasswordPageHtml(html)) return { status: "password" };
  if (!isShopifyStorefrontHtml(html)) {
    return { status: "unreachable", reason: "not_shopify", challenged: false };
  }
  try {
    return { status: "ok", result: analyze(html) };
  } catch {
    return { status: "error" };
  }
}

export type CheckStorefrontOptions = {
  /** Shop id for log lines only. */
  shopId: string;
  fetchImpl?: StorefrontFetch;
  dnsLookup?: DnsLookupAll;
  timeoutMs?: number;
};

/**
 * Read the homepage, then /cart, and run `analyze` on each readable page.
 * The homepage decides the outcome; /cart only decides `complete`. Never
 * throws.
 */
export async function checkStorefront<T>(
  domains: ShopDomains,
  analyze: (html: string) => T,
  opts: CheckStorefrontOptions,
): Promise<StorefrontCheckOutcome<T>> {
  const outcome = await checkPages(domains, analyze, opts);
  logger.info("checkout guard check", {
    function: "storefront-guard",
    event: "storefront_guard_check",
    shopId: opts.shopId,
    host: domains.primaryHost,
    outcome: outcome.outcome,
    ...(outcome.outcome === "unreachable"
      ? { reason: outcome.reason, challenged: outcome.challenged }
      : {}),
    ...(outcome.outcome === "ok" ? { complete: outcome.complete } : {}),
  });
  return outcome;
}

async function checkPages<T>(
  domains: ShopDomains,
  analyze: (html: string) => T,
  opts: CheckStorefrontOptions,
): Promise<StorefrontCheckOutcome<T>> {
  const pages: GuardPageResult<T>[] = [];
  for (const { page, path } of PAGE_PATHS) {
    let read: PageRead<T>;
    try {
      read = await readOnePage(domains, path, analyze, opts);
    } catch {
      // readStorefrontPage never throws; this is a belt for a bug in the seams.
      read = { status: "unreachable", reason: "network", challenged: false };
    }
    if (read.status === "ok") {
      pages.push({ page, result: read.result });
      continue;
    }
    if (page !== "home") {
      // The homepage was read: a failed /cart only makes the check partial.
      return { outcome: "ok", pages, complete: false };
    }
    switch (read.status) {
      case "password":
        return { outcome: "paused_password" };
      case "redirect":
        return { outcome: "paused_redirect", redirectHost: read.host };
      case "unreachable":
        return { outcome: "unreachable", reason: read.reason, challenged: read.challenged };
      case "error":
        return { outcome: "error" };
    }
  }
  return { outcome: "ok", pages, complete: true };
}

/** Cached storefront hosts are refreshed from the Admin API at most this often. */
export const GUARD_DOMAINS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Whether the cached hosts must be re-read before a check (none yet, or stale). */
export function guardDomainsNeedRefresh(
  cached: { primaryHost: string | null; domainsRefreshedAt: Date | null },
  now: Date,
): boolean {
  if (!cached.primaryHost || !cached.domainsRefreshedAt) return true;
  return now.getTime() - cached.domainsRefreshedAt.getTime() >= GUARD_DOMAINS_MAX_AGE_MS;
}
