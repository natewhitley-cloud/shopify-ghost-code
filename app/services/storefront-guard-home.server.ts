/**
 * Home's checkout guard view (gc-1q1s.6): the shop's open incidents (every
 * plan, whatever the flag: a stored security hit is never hidden) and, while
 * the guard is live, its one status line. Never throws: a failed read is
 * logged and Home renders without the guard.
 */
import { isStorefrontGuardLive } from "./soft-launch-flags.server";
import { KNOWN_MALICIOUS_DOMAINS } from "../data/malicious-domains.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import type {
  GuardHomeView,
  GuardIncidentView,
  GuardStatusView,
} from "../lib/storefront-guard-copy";
import type { GuardIncident } from "../lib/storefront-guard-state";
import { loadGuardForHome } from "../models/storefront-guard.server";

/** A readable check older than this turns the status line into "couldn't read since". */
export const GUARD_UNREADABLE_AFTER_MS = 24 * 60 * 60 * 1000;

const EMPTY: GuardHomeView = { incidents: [], status: null };

/** An incident row as Home shows it (the listed domain is the fingerprint's tail). */
export function toIncidentView(i: GuardIncident & { id: string }): GuardIncidentView {
  const domain =
    i.kind === "KNOWN_MALICIOUS" ? i.fingerprint.slice("KNOWN_MALICIOUS:".length) || null : null;
  const entry = domain ? KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === domain) : undefined;
  return {
    id: i.id,
    kind: i.kind,
    host: i.host,
    domain,
    note: entry?.note ?? null,
    pages: i.page,
    sourceLabel: i.sourceLabel,
    openedAt: (i.openedAt ?? i.firstSeenAt).toISOString(),
    lastSeenAt: i.lastSeenAt.toISOString(),
    seenCount: i.seenCount,
  };
}

/** Security kinds first (known malicious, then loaders), then new hosts; oldest first. */
const KIND_ORDER: Record<GuardIncidentView["kind"], number> = {
  KNOWN_MALICIOUS: 0,
  SCRIPT_LOADER: 1,
  NEW_SCRIPT_HOST: 2,
};

export function buildGuardStatus(
  state: {
    lastCheckedAt: Date | null;
    lastOutcome: string | null;
    lastReadableAt: Date | null;
    primaryHost: string | null;
    lastRedirectHost: string | null;
  } | null,
  plan: string,
  now: Date,
): GuardStatusView {
  const cadence = getPlanFeatures(plan).storefrontGuardCadence;
  const base = {
    cadence,
    date: null,
    primaryHost: state?.primaryHost ?? null,
    redirectHost: state?.lastRedirectHost ?? null,
  };
  if (!state?.lastCheckedAt || !state.lastOutcome) return { ...base, state: "waiting" };
  const outcome = state.lastOutcome;
  if (outcome === "paused_password") return { ...base, state: "paused_password" };
  if (outcome === "paused_redirect") return { ...base, state: "paused_redirect" };
  const readable = state.lastReadableAt;
  const date = readable?.toISOString() ?? null;
  if (outcome === "ok" || outcome === "partial") return { ...base, state: "ok", date };
  // Unreachable or error: say so only once nothing was readable for a day.
  if (readable && now.getTime() - readable.getTime() < GUARD_UNREADABLE_AFTER_MS) {
    return { ...base, state: "ok", date };
  }
  return { ...base, state: "unreachable", date };
}

export async function loadGuardHome(
  shop: { id: string; plan: string },
  now: Date,
): Promise<GuardHomeView> {
  try {
    const { state, incidents } = await loadGuardForHome(shop.id);
    const views = incidents
      .filter((i): i is GuardIncident & { id: string } => !!i.id)
      .map(toIncidentView)
      .sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.openedAt.localeCompare(b.openedAt),
      );
    return {
      incidents: views,
      status: isStorefrontGuardLive() ? buildGuardStatus(state, shop.plan, now) : null,
    };
  } catch (err) {
    logger.warn("checkout guard: home view unavailable", {
      function: "loadGuardHome",
      shopId: shop.id,
      ...safeErrorFields(err),
    });
    return EMPTY;
  }
}
