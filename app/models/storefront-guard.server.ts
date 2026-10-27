/**
 * Data access for the checkout guard (gc-1q1s.4): StorefrontGuardState (one
 * row per shop) and StorefrontIncident (one row per shop + signal).
 *
 * Writes go through ONE interactive transaction per check, guarded by the
 * state row's `version` (optimistic lock): the cron and Home's "This is
 * expected" can never overwrite each other's baseline or incident write. A
 * lost race returns `stale` and changes nothing; the next check redoes it.
 *
 * GDPR: hostnames, fixed labels, timestamps and counters only. Both tables
 * cascade from Shop and deleteShopData deletes them explicitly.
 */
import type { Prisma, StorefrontGuardState, StorefrontIncident } from "@prisma/client";

import db from "../db.server";
import {
  acknowledgeNewHost,
  EMPTY_GUARD_STATE,
  type GuardIncident,
  type GuardStateData,
  type IncidentKind,
  type IncidentPages,
  type IncidentResolution,
  type IncidentState,
} from "../lib/storefront-guard-state";

/** The cached hosts and refresh time kept beside the state machine's data. */
export type GuardDomainsCache = {
  primaryHost: string | null;
  myshopifyHost: string | null;
  domainsRefreshedAt: Date | null;
};

export type LoadedGuard = {
  /** null = no row yet (first check). */
  version: number | null;
  state: GuardStateData;
  domains: GuardDomainsCache;
  incidents: GuardIncident[];
};

const KINDS: ReadonlySet<string> = new Set(["KNOWN_MALICIOUS", "SCRIPT_LOADER", "NEW_SCRIPT_HOST"]);
const STATES: ReadonlySet<string> = new Set(["pending", "open", "resolved"]);
const PAGES: ReadonlySet<string> = new Set(["home", "cart", "both"]);
const RESOLUTIONS: ReadonlySet<string> = new Set([
  "clean",
  "lapsed",
  "acknowledged",
  "auto_merged",
]);

function parseBaseline(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [host, iso] of Object.entries(value)) {
    if (typeof iso === "string" && !Number.isNaN(Date.parse(iso))) out[host] = iso;
  }
  return out;
}

function parseHostSets(value: Prisma.JsonValue): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((set): set is Prisma.JsonArray => Array.isArray(set))
    .map((set) => set.filter((h): h is string => typeof h === "string"));
}

export function toGuardStateData(row: StorefrontGuardState | null): GuardStateData {
  if (!row) return { ...EMPTY_GUARD_STATE, baselineHosts: {}, recentHostSets: [] };
  return {
    lastCheckedAt: row.lastCheckedAt,
    lastOutcome: row.lastOutcome,
    lastReadableAt: row.lastReadableAt,
    lastRedirectHost: row.lastRedirectHost,
    consecutiveUnreachable: row.consecutiveUnreachable,
    backoffUntil: row.backoffUntil,
    readableChecks: row.readableChecks,
    baselineHosts: parseBaseline(row.baselineHosts),
    recentHostSets: parseHostSets(row.recentHostSets),
  };
}

/** A stored row as the state machine sees it; null for a row it cannot read. */
export function toGuardIncident(row: StorefrontIncident): GuardIncident | null {
  if (!KINDS.has(row.kind) || !STATES.has(row.state) || !PAGES.has(row.page)) return null;
  return {
    id: row.id,
    kind: row.kind as IncidentKind,
    fingerprint: row.fingerprint,
    host: row.host,
    page: row.page as IncidentPages,
    sourceLabel: row.sourceLabel,
    state: row.state as IncidentState,
    openedAt: row.openedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    seenCount: row.seenCount,
    cleanStreak: row.cleanStreak,
    resolvedAt: row.resolvedAt,
    resolution:
      row.resolution && RESOLUTIONS.has(row.resolution)
        ? (row.resolution as IncidentResolution)
        : null,
    acknowledgedAt: row.acknowledgedAt,
    emailedOpenedAt: row.emailedOpenedAt,
  };
}

/** Everything one check needs for a shop: state, cached hosts, every incident row. */
export async function loadGuard(shopId: string): Promise<LoadedGuard> {
  const [row, incidentRows] = await Promise.all([
    db.storefrontGuardState.findUnique({ where: { shopId } }),
    db.storefrontIncident.findMany({ where: { shopId } }),
  ]);
  return {
    version: row?.version ?? null,
    state: toGuardStateData(row),
    domains: {
      primaryHost: row?.primaryHost ?? null,
      myshopifyHost: row?.myshopifyHost ?? null,
      domainsRefreshedAt: row?.domainsRefreshedAt ?? null,
    },
    incidents: incidentRows.map(toGuardIncident).filter((i): i is GuardIncident => i !== null),
  };
}

function stateData(state: GuardStateData) {
  return {
    lastCheckedAt: state.lastCheckedAt,
    lastOutcome: state.lastOutcome,
    lastReadableAt: state.lastReadableAt,
    lastRedirectHost: state.lastRedirectHost,
    consecutiveUnreachable: state.consecutiveUnreachable,
    backoffUntil: state.backoffUntil,
    readableChecks: state.readableChecks,
    baselineHosts: state.baselineHosts,
    recentHostSets: state.recentHostSets,
  };
}

function incidentData(i: GuardIncident) {
  return {
    kind: i.kind,
    host: i.host,
    page: i.page,
    sourceLabel: i.sourceLabel,
    state: i.state,
    openedAt: i.openedAt,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    seenCount: i.seenCount,
    cleanStreak: i.cleanStreak,
    resolvedAt: i.resolvedAt,
    resolution: i.resolution,
    acknowledgedAt: i.acknowledgedAt,
    emailedOpenedAt: i.emailedOpenedAt,
  };
}

class StaleGuardWrite extends Error {}

/** Prisma unique-constraint violation (a concurrent first write created the row). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Persist one check: the state (and cached hosts), plus every changed
 * incident, in one transaction that only commits if the state row is still at
 * `expectedVersion` (null = must not exist yet). Returns the saved incidents
 * by fingerprint (with ids), or `stale` when another write won.
 */
export async function saveGuardCheck(input: {
  shopId: string;
  expectedVersion: number | null;
  state: GuardStateData;
  domains: GuardDomainsCache;
  changed: readonly GuardIncident[];
}): Promise<{ status: "saved"; incidents: Map<string, GuardIncident> } | { status: "stale" }> {
  const { shopId, expectedVersion } = input;
  const data = { ...stateData(input.state), ...input.domains };
  try {
    const saved = await db.$transaction(async (tx) => {
      if (expectedVersion === null) {
        await tx.storefrontGuardState.create({ data: { shopId, ...data } });
      } else {
        const { count } = await tx.storefrontGuardState.updateMany({
          where: { shopId, version: expectedVersion },
          data: { ...data, version: { increment: 1 } },
        });
        if (count !== 1) throw new StaleGuardWrite();
      }
      const out = new Map<string, GuardIncident>();
      for (const incident of input.changed) {
        const row = await tx.storefrontIncident.upsert({
          where: { shopId_fingerprint: { shopId, fingerprint: incident.fingerprint } },
          create: { shopId, fingerprint: incident.fingerprint, ...incidentData(incident) },
          update: incidentData(incident),
        });
        out.set(incident.fingerprint, { ...incident, id: row.id });
      }
      return out;
    });
    return { status: "saved", incidents: saved };
  } catch (error) {
    if (error instanceof StaleGuardWrite || isUniqueViolation(error)) return { status: "stale" };
    throw error;
  }
}

/** Cache freshly read storefront hosts (or create the row with them). */
export function guardDomainsFrom(
  domains: { primaryHost: string; myshopifyHost: string | null },
  now: Date,
): GuardDomainsCache {
  return {
    primaryHost: domains.primaryHost,
    myshopifyHost: domains.myshopifyHost,
    domainsRefreshedAt: now,
  };
}

/** What Home shows: the guard state row (or null) and the shop's open incidents. */
export async function loadGuardForHome(shopId: string): Promise<{
  state: StorefrontGuardState | null;
  incidents: GuardIncident[];
}> {
  const [state, rows] = await Promise.all([
    db.storefrontGuardState.findUnique({ where: { shopId } }),
    db.storefrontIncident.findMany({
      where: { shopId, state: "open" },
      orderBy: [{ openedAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    state,
    incidents: rows.map(toGuardIncident).filter((i): i is GuardIncident => i !== null),
  };
}

/** Stamp the episodes that were emailed (emailedOpenedAt = their openedAt). */
export async function markIncidentsEmailed(
  incidents: ReadonlyArray<{ id: string; openedAt: Date }>,
): Promise<void> {
  for (const i of incidents) {
    await db.storefrontIncident.updateMany({
      where: { id: i.id, openedAt: i.openedAt },
      data: { emailedOpenedAt: i.openedAt },
    });
  }
}

/**
 * Hosts the shop's latest successful theme scan recorded (ScanDomain rows; no
 * Shopify hosts are stored there). They are "known to the theme", so the guard
 * never calls them new. Empty when the shop has no successful scan.
 */
export async function latestScanThemeHosts(shopId: string): Promise<Set<string>> {
  const scan = await db.scan.findFirst({
    where: { shopId, status: { in: ["COMPLETED", "PARTIAL"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!scan) return new Set();
  const rows = await db.scanDomain.findMany({
    where: { scanId: scan.id },
    select: { domain: true },
  });
  return new Set(rows.map((r) => r.domain.toLowerCase()));
}

/** Installed shops with the guard fields the due check needs. */
export function listGuardCandidateShops() {
  return db.shop.findMany({
    where: { uninstalledAt: null },
    select: {
      id: true,
      domain: true,
      plan: true,
      storefrontGuardState: { select: { lastCheckedAt: true, backoffUntil: true } },
    },
    orderBy: { id: "asc" },
  });
}

/**
 * Home's "This is expected" on a NEW_SCRIPT_HOST incident: its host joins the
 * baseline and the incident resolves (acknowledgeNewHost), in one transaction
 * at the state row's version, so it never races the cron's write. Retries
 * once on a lost race. False when the incident is not this shop's open
 * new-host incident, or the shop has no guard state.
 */
export async function acknowledgeGuardIncident(
  shopId: string,
  incidentId: string,
  now: Date,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await loadGuard(shopId);
    const incident = loaded.incidents.find((i) => i.id === incidentId);
    if (!incident || loaded.version === null) return false;
    const next = acknowledgeNewHost(loaded.state, incident, now);
    if (!next) return false;
    const saved = await saveGuardCheck({
      shopId,
      expectedVersion: loaded.version,
      state: next.state,
      domains: loaded.domains,
      changed: [next.incident],
    });
    if (saved.status === "saved") return true;
  }
  return false;
}
