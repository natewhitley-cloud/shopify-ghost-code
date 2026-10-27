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
 * A check is stamped (lastCheckedAt) with the RUN's fire time, not the time
 * its chunk ran (audit fix): a shop checked late in a long run is still due
 * at the next hourly run, and a retried chunk step skips the shops it already
 * checked in that run (lastCheckedAt >= the fire time).
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
  EMAIL_INCIDENT_KINDS,
  MAX_HOSTS_PER_CHECK,
  newHostFingerprint,
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
  loadGuardIncidentsByFingerprint,
  pruneGuardIncidents,
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

/** A candidate as the cron orders it (plan and last check). */
export type GuardCandidateOrderInput = {
  plan: string;
  storefrontGuardState: { lastCheckedAt: Date | null } | null;
};

/**
 * The cron's run order (wave 3 B7): hourly (paid) shops first, then the
 * longest-waiting (never checked first). A run checks at most
 * MAX_GUARD_SHOPS_PER_RUN shops, so a backlog of Free shops (all due at once
 * on the first live run, or after an outage) must never push a paid shop's
 * hourly check out of the run.
 */
export function compareGuardCandidates(
  a: GuardCandidateOrderInput,
  b: GuardCandidateOrderInput,
): number {
  const tier = (s: GuardCandidateOrderInput) =>
    getPlanFeatures(s.plan).storefrontGuardCadence === "hourly" ? 0 : 1;
  const last = (s: GuardCandidateOrderInput) =>
    s.storefrontGuardState?.lastCheckedAt?.getTime() ?? -Infinity;
  const byTier = tier(a) - tier(b);
  if (byTier !== 0) return byTier;
  const la = last(a);
  const lb = last(b);
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/**
 * How long an unemailed incident episode keeps being offered to the email
 * step, from the LATER of the episode's opening and the shop's consent
 * (gc-1q1s.10, owner-pending assumption): an incident still open when the
 * merchant consents is offered for 24 h from the consent.
 */
export const EMAIL_RETRY_WINDOW_MS = 24 * HOUR_MS;

/**
 * When the shop consented to guard email, or null when no guard email may be
 * sent: the notice never shown (or reset after an owner-email change), the
 * merchant turned it off, or mail is unsubscribed (gc-1q1s.10, gc-njwa #6).
 * The cron pre-filters on it, so an unconsented shop never costs a notify
 * step. The email step re-checks every gate itself.
 */
export function guardEmailConsentAt(shop: {
  alertsEnabled: boolean;
  guardEmailNoticeShownAt: Date | null;
  guardEmailOffAt: Date | null;
}): Date | null {
  if (!shop.alertsEnabled || shop.guardEmailOffAt) return null;
  return shop.guardEmailNoticeShownAt;
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
  | {
      status: "checked";
      outcome: string;
      opened: OpenedIncident[];
      /**
       * Open KNOWN_MALICIOUS / SCRIPT_LOADER episodes not yet emailed, on a
       * plan with guard email, for a consented shop, within
       * EMAIL_RETRY_WINDOW_MS of the later of their opening and the consent.
       * Re-offered every run, so a failed or throttled send is retried (audit
       * fix); the email's own gates (consent, transport) still decide.
       */
      toEmail: OpenedIncident[];
    }
  | { status: "stale"; outcome: string }
  /** Already checked in this run (a retried chunk step): nothing done. */
  | { status: "already_checked" }
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

/** Every incident fingerprint an ok check could sight (signals and new hosts). */
export function sightedFingerprints(input: GuardCheckInput): string[] {
  if (input.outcome !== "ok") return [];
  return [
    ...new Set([
      ...input.sightings.map((s) => s.fingerprint),
      ...input.hosts.map((h) => newHostFingerprint(h.host)),
    ]),
  ];
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
 * episodes this check opened (every kind); `toEmail` the ones the email step
 * should (re)try. `runAt` is the cron run's fire time: the check is stamped
 * with it, and a shop already stamped at or after it is skipped.
 */
export async function checkGuardShop(
  shop: {
    id: string;
    domain: string;
    plan: string;
    /** guardEmailConsentAt, as the select step passed it (ISO in a step's output). */
    emailConsentAt?: Date | string | null;
  },
  now: Date,
  deps: GuardShopDeps,
  runAt: Date = now,
): Promise<GuardShopResult> {
  try {
    const loaded = await loadGuard(shop.id, now);
    const last = loaded.state.lastCheckedAt;
    if (last && last.getTime() >= runAt.getTime()) return { status: "already_checked" };
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

    // Rows this check sighted that loadGuard's NEW_SCRIPT_HOST cap left out
    // (wave 3 B1): without them a re-sighted open episode would be re-created
    // over its stored row, resetting openedAt (and a second email).
    const loadedFps = new Set(loaded.incidents.map((i) => i.fingerprint));
    const missing = sightedFingerprints(input).filter((fp) => !loadedFps.has(fp));
    const incidents = [
      ...loaded.incidents,
      ...(await loadGuardIncidentsByFingerprint(shop.id, missing)),
    ];
    const result = applyGuardCheck(loaded.state, incidents, input, now);
    if (result.droppedHosts > 0) {
      // gc-njwa #4: counts only, never the hosts themselves.
      logger.warn("checkout guard host cap hit; alphabetically last hosts not checked", {
        function: "storefront-guard",
        event: "storefront_guard_hosts_capped",
        shopId: shop.id,
        droppedHosts: result.droppedHosts,
        maxHosts: MAX_HOSTS_PER_CHECK,
      });
    }
    const saved = await saveGuardCheck({
      shopId: shop.id,
      expectedVersion: loaded.version,
      state: { ...result.state, lastCheckedAt: runAt },
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
    await pruneQuietly(shop.id, now, loaded.newHostsCapped);
    type Saved = GuardIncident & { id: string; openedAt: Date };
    const asOpened = (i: Saved): OpenedIncident => ({
      shopId: shop.id,
      incidentId: i.id,
      kind: i.kind,
      openedAt: i.openedAt.toISOString(),
    });
    const opened = result.opened
      .map((i) => saved.incidents.get(i.fingerprint))
      .filter((i): i is Saved => !!i?.id && !!i.openedAt)
      .map(asOpened);
    // Every incident as it now stands (the loaded rows, overlaid by this write).
    const current = new Map(incidents.map((i) => [i.fingerprint, i]));
    for (const [fp, i] of saved.incidents) current.set(fp, i);
    const consentMs = shop.emailConsentAt ? new Date(shop.emailConsentAt).getTime() : NaN;
    const toEmail =
      getPlanFeatures(shop.plan).storefrontGuardEmail && Number.isFinite(consentMs)
        ? [...current.values()]
            .filter(
              (i): i is Saved =>
                !!i.id &&
                i.state === "open" &&
                i.openedAt !== null &&
                EMAIL_INCIDENT_KINDS.has(i.kind) &&
                i.emailedOpenedAt?.getTime() !== i.openedAt.getTime() &&
                now.getTime() - Math.max(i.openedAt.getTime(), consentMs) < EMAIL_RETRY_WINDOW_MS,
            )
            .map(asOpened)
        : [];
    return { status: "checked", outcome, opened, toEmail };
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

/** pruneGuardIncidents, logged and swallowed: housekeeping never fails a check. */
async function pruneQuietly(shopId: string, now: Date, overCap: boolean): Promise<void> {
  try {
    await pruneGuardIncidents(shopId, now, overCap);
  } catch (err) {
    logger.warn("checkout guard incident prune failed", {
      function: "storefront-guard",
      event: "storefront_guard_prune_failed",
      shopId,
      ...safeErrorFields(err),
    });
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
