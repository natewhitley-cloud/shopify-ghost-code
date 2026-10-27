/**
 * Checkout guard orchestration (gc-1q1s.5): which shops are due this hour,
 * and one shop's check end to end (cached hosts, page reads, analysis, state
 * machine, one optimistic-locked write). Called by the storefront-guard cron.
 *
 * Cadence (PlanFeatures.storefrontGuardCadence, owner decision 2026-10-26):
 *   - hourly (Standard, Professional): due when the last check is at least
 *     HOURLY_MIN_GAP_MS old (50 min, so cron jitter never skips an hour);
 *   - daily (Free): due in the shop's hash hour slot (guardHourSlot, spreads
 *     free shops across the day) once the last check is DAILY_MIN_GAP_MS old,
 *     or in any hour once it is DAILY_CATCH_UP_MS old (a missed slot never
 *     costs a whole extra day);
 *   - never while backoffUntil is in the future.
 *
 * Isolation: checkGuardShop never throws. A shop's failure is logged and
 * returned as `failed`; it never fails the chunk or another shop.
 */
import { HOMEPAGE_SOURCE_LABELS } from "./runtime-malicious.server";
import { analyzeStorefrontHtml, type StorefrontAnalysis } from "./storefront-analyzer.server";
import { fetchShopDomains, type ShopDomains } from "./storefront-fetcher.server";
import {
  checkStorefront,
  guardDomainsNeedRefresh,
  type CheckStorefrontOptions,
} from "./storefront-guard-check.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  applyGuardCheck,
  type GuardCheckInput,
  type GuardHostSighting,
  type GuardIncident,
  type GuardSighting,
  type IncidentKind,
} from "../lib/storefront-guard-state";
import {
  guardDomainsFrom,
  latestScanThemeHosts,
  loadGuard,
  saveGuardCheck,
  type GuardDomainsCache,
} from "../models/storefront-guard.server";
import type { AdminApiContext } from "../types/shopify";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const HOURLY_MIN_GAP_MS = 50 * MINUTE_MS;
export const DAILY_MIN_GAP_MS = 20 * HOUR_MS;
export const DAILY_CATCH_UP_MS = 26 * HOUR_MS;

/** A stable hour (0-23) for a shop's daily check: FNV-1a of the shop id, mod 24. */
export function guardHourSlot(shopId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < shopId.length; i++) {
    hash ^= shopId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 24;
}

export type GuardDueInput = {
  id: string;
  plan: string;
  storefrontGuardState: { lastCheckedAt: Date | null; backoffUntil: Date | null } | null;
};

/** Whether a shop is due for a check at `now` (see the module comment). */
export function isGuardDue(shop: GuardDueInput, now: Date): boolean {
  const state = shop.storefrontGuardState;
  if (state?.backoffUntil && state.backoffUntil.getTime() > now.getTime()) return false;
  const last = state?.lastCheckedAt ?? null;
  const age = last ? now.getTime() - last.getTime() : Infinity;
  if (getPlanFeatures(shop.plan).storefrontGuardCadence === "hourly") {
    return age >= HOURLY_MIN_GAP_MS;
  }
  if (age >= DAILY_CATCH_UP_MS) return true;
  return guardHourSlot(shop.id) === now.getUTCHours() && age >= DAILY_MIN_GAP_MS;
}

/** One newly opened incident episode, as the cron passes it on (JSON-safe). */
export type OpenedIncident = {
  shopId: string;
  incidentId: string;
  kind: IncidentKind;
  /** ISO time of the episode start (the email ledger key). */
  openedAt: string;
};

export type GuardShopResult =
  | { status: "checked"; outcome: string; opened: OpenedIncident[] }
  | { status: "stale"; outcome: string }
  | { status: "failed" };

/** The analysis of each read page as the state machine's sightings and hosts. */
export function toGuardCheckInput(
  outcome: Awaited<ReturnType<typeof checkStorefront<StorefrontAnalysis>>>,
): GuardCheckInput {
  if (outcome.outcome !== "ok") return outcome;
  const sightings: GuardSighting[] = [];
  const hosts: GuardHostSighting[] = [];
  for (const { page, result } of outcome.pages) {
    for (const hit of result.maliciousHits) {
      sightings.push({
        kind: "KNOWN_MALICIOUS",
        fingerprint: `KNOWN_MALICIOUS:${hit.domain}`,
        host: hit.host,
        page,
        sourceLabel: HOMEPAGE_SOURCE_LABELS[hit.source],
      });
    }
    for (const loader of result.loaders) {
      sightings.push({
        kind: "SCRIPT_LOADER",
        fingerprint: loader.fingerprint,
        host: loader.host,
        page,
        sourceLabel: loader.label,
      });
    }
    for (const h of result.hosts) hosts.push({ host: h.host, page, sourceLabel: h.label });
  }
  return { outcome: "ok", complete: outcome.complete, sightings, hosts };
}

export type GuardShopDeps = {
  /** Admin context for the daily host refresh (unauthenticated.admin in prod). */
  getAdmin: (shopDomain: string) => Promise<AdminApiContext>;
  /** Storefront fetch seams (tests). */
  fetchOptions?: Omit<CheckStorefrontOptions, "shopId">;
};

/** Cached hosts, refreshed through the Admin API when stale. Null = none usable. */
async function resolveDomains(
  shop: { id: string; domain: string },
  cached: GuardDomainsCache,
  now: Date,
  deps: GuardShopDeps,
): Promise<{ domains: ShopDomains | null; cache: GuardDomainsCache }> {
  const fromCache: ShopDomains | null = cached.primaryHost
    ? { primaryHost: cached.primaryHost, myshopifyHost: cached.myshopifyHost }
    : null;
  if (!guardDomainsNeedRefresh(cached, now)) return { domains: fromCache, cache: cached };
  try {
    const fresh = await fetchShopDomains(await deps.getAdmin(shop.domain));
    if (fresh) return { domains: fresh, cache: guardDomainsFrom(fresh, now) };
  } catch (err) {
    logger.warn("checkout guard domain refresh failed", {
      function: "storefront-guard",
      event: "storefront_guard_domains_failed",
      shopId: shop.id,
      ...safeErrorFields(err),
    });
  }
  // Keep the cached hosts (stale beats none); retry the refresh next check.
  return { domains: fromCache, cache: cached };
}

/**
 * One shop's check, end to end. Never throws. `opened` lists the incident
 * episodes this check opened (every kind; the caller decides what may email).
 */
export async function checkGuardShop(
  shop: { id: string; domain: string },
  now: Date,
  deps: GuardShopDeps,
): Promise<GuardShopResult> {
  try {
    const loaded = await loadGuard(shop.id);
    const { domains, cache } = await resolveDomains(shop, loaded.domains, now, deps);

    let input: GuardCheckInput;
    if (!domains) {
      input = { outcome: "unreachable", reason: "no_domain", challenged: false };
    } else {
      const knownThemeHosts = await latestScanThemeHosts(shop.id);
      const shopHosts = [domains.primaryHost, domains.myshopifyHost].filter(
        (h): h is string => h !== null,
      );
      const outcome = await checkStorefront(
        domains,
        (html) => analyzeStorefrontHtml(html, { shopHosts, knownThemeHosts }),
        { ...deps.fetchOptions, shopId: shop.id },
      );
      input = toGuardCheckInput(outcome);
    }

    const result = applyGuardCheck(loaded.state, loaded.incidents, input, now);
    const saved = await saveGuardCheck({
      shopId: shop.id,
      expectedVersion: loaded.version,
      state: result.state,
      domains: cache,
      changed: result.changed,
    });
    const outcome = result.state.lastOutcome ?? input.outcome;
    if (saved.status === "stale") {
      logger.info("checkout guard write lost a race", {
        function: "storefront-guard",
        event: "storefront_guard_stale",
        shopId: shop.id,
      });
      return { status: "stale", outcome };
    }
    const opened = result.opened
      .map((i) => saved.incidents.get(i.fingerprint))
      .filter((i): i is GuardIncident & { id: string; openedAt: Date } => !!i?.id && !!i.openedAt)
      .map((i) => ({
        shopId: shop.id,
        incidentId: i.id,
        kind: i.kind,
        openedAt: i.openedAt.toISOString(),
      }));
    return { status: "checked", outcome, opened };
  } catch (err) {
    logger.error("checkout guard check failed", {
      function: "storefront-guard",
      event: "storefront_guard_failed",
      shopId: shop.id,
      ...safeErrorFields(err),
    });
    return { status: "failed" };
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
