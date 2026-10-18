/**
 * NOD digest loader (contract v1, ~/ventures/nod/docs/spec/digest-contract.md).
 *
 * Builds the payload for GET /ops/digest.json. READ-ONLY and DB-ONLY (NOD
 * ADR-006): it only calls findMany / groupBy on Shop / Scan / Finding /
 * AppRemoval / OpsEvent, writes nothing (no digest_snapshot, no OpsEvent) and
 * calls no Shopify API. It deliberately does NOT call the
 * operator-digest Inngest handler (which writes a snapshot row); it reuses that
 * module's exported pure helpers so the NOD numbers and the digest email agree.
 *
 * Exclusion matches the email exactly: Shop.isInternal OR OPERATOR_EXCLUDE_SHOPS
 * OR the app-review- prefixes for shop rows (isExcludedShop via partitionShops),
 * and for domain-keyed OpsEvent streams the isInternal domains are merged into
 * the exclude set (gc-zeh).
 *
 * value[] leads with outcomes (NOD ADR-010): apps cleaned up and their
 * leftover items (AppRemoval CLEANED), shops warned about a malicious script,
 * findings resolved; then scans run (activity). Rows that can overstate carry a
 * caveat. `journey` gives each non-excluded shop still in the DB (uninstalled
 * ones included) its all-time first scan, first results view and first
 * confirmed cleanup; NOD keeps that history after the shop is deleted.
 *
 * Merchant and journey rows carry Shop.id only (ADR-004): a domain never appears in output.
 * Free-text columns (OpsEvent.message) are never selected.
 */

import { AppRemovalState, FindingType } from "@prisma/client";

import db from "../../app/db.server";
import { PLAN_AMOUNTS, PLANS } from "../../app/lib/billing.server";
import {
  isExcluded,
  isExcludedShop,
  parseExcludePrefixes,
  parseExcludeShops,
} from "../../app/lib/store-exclusion";
import { OPS_EVENT_TYPES } from "../../app/models/ops-event.server";
import { SUCCESSFUL_SCAN_STATUSES } from "../../app/models/scan.server";
import { NUDGE_KEYS } from "../../app/services/nudge-telemetry.server";
import {
  DAY_MS,
  NUDGE_OTHER_KEY,
  computeMrr,
  computePlanMix,
  countUninstallEventsExcluding,
  partitionShops,
} from "../functions/operator-digest";

export type NodErrorCategory = "api" | "webhook" | "job" | "other";

export interface NodValueRow {
  key: string;
  label: string;
  d1: number;
  d7: number;
  d30: number;
  /** One line, <= 200 chars: why this row can overstate (NOD ADR-010). */
  caveat?: string;
}

export type NodJourneyStage = "first_scan" | "first_results" | "first_cleanup";

export interface NodJourney {
  stages: Array<{ key: NodJourneyStage; label: string }>;
  valueStage: NodJourneyStage;
  merchants: Array<{
    id: string;
    installedAt: string;
    uninstalledAt?: string;
    plan: string;
    reached: Partial<Record<NodJourneyStage, string>>;
  }>;
}

export interface NodDigest {
  contractVersion: 1;
  app: { key: string; name: string; platform: "shopify" };
  generatedAt: string;
  lifecycle: { stage: "live" };
  installs: {
    active: number;
    installed7d: number;
    uninstalled7d: number;
    installed30d: number;
    uninstalled30d: number;
    excludedInternal: number;
  };
  revenue: {
    currency: "USD";
    mrrCents: number;
    plans: Array<{ plan: string; installs: number; mrrCents: number }>;
  };
  value: NodValueRow[];
  engagement: { activeMerchants7d: number; returningMerchants7d: number; visits7d: number };
  nudges: Array<{
    key: string;
    label: string;
    shown: number;
    clicked: number;
    dismissed: number;
    converted: number;
  }>;
  errors: {
    count24h: number;
    count7d: number;
    byCode: Array<{
      code: string;
      category: NodErrorCategory;
      count24h: number;
      count7d: number;
      lastAt: string;
    }>;
  };
  series: { days: string[]; installed: number[]; uninstalled: number[]; value: number[] };
  journey: NodJourney;
  merchants: Array<{
    id: string;
    plan: string;
    installedAt: string;
    lastActiveAt?: string;
    actions7d: { scans: number; apps_cleaned: number };
    actions30d: { scans: number; apps_cleaned: number };
  }>;
}

const SERIES_DAYS = 30;
const MAX_ERROR_CODES = 50;
// Error codes become output strings: keep them to a short, lowercase
// [a-z0-9_-] alphabet. This is NOT identity protection by itself (a domain would
// become foo_myshopify_com), so any code containing "myshopify" is replaced.
const CODE_MAX_LEN = 60;

const NUDGE_STAGE_BY_EVENT_TYPE: Record<string, "shown" | "clicked" | "dismissed" | "converted"> = {
  [OPS_EVENT_TYPES.NUDGE_SHOWN]: "shown",
  [OPS_EVENT_TYPES.NUDGE_CLICKED]: "clicked",
  [OPS_EVENT_TYPES.NUDGE_DISMISSED]: "dismissed",
  [OPS_EVENT_TYPES.NUDGE_CONVERTED]: "converted",
};

const NUDGE_LABELS: Record<string, string> = {
  [NUDGE_KEYS.UPGRADE_PREVIEW]: "Upgrade preview",
  [NUDGE_KEYS.FEEDBACK]: "Feedback ask",
  [NUDGE_KEYS.REVIEW_REQUEST]: "Review ask",
  [NUDGE_KEYS.UPGRADE_RETURN]: "Upgrade return",
  [NUDGE_KEYS.STALE_RESULTS]: "Stale results",
  [NUDGE_KEYS.SPEED_TEASER]: "Speed teaser",
  [NUDGE_OTHER_KEY]: "Other",
};

/** Plan label for output; unknown/legacy plans are "Free", as computePlanMix treats them. */
function planLabel(plan: string): string {
  if (plan === PLANS.STANDARD) return "Standard";
  if (plan === PLANS.PROFESSIONAL) return "Professional";
  return "Free";
}

function sanitizeCode(prefix: string, raw: unknown): string {
  const body =
    typeof raw === "string" && raw.length > 0 && !/myshopify/i.test(raw)
      ? raw
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "_")
          .slice(0, CODE_MAX_LEN)
      : "unknown";
  return `${prefix}${body}`;
}

function metaString(metadata: unknown, field: string): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const v = (metadata as Record<string, unknown>)[field];
  return typeof v === "string" ? v : undefined;
}

// apps_cleaned / leftovers_removed. A row goes CLEANED when a later scan of the
// SAME theme finds none of the app's leftovers (app/services/app-removal.server.ts),
// so a theme switch cannot clean it, but a scanner update that stops attributing
// the findings, or the merchant ignoring each one, can.
const CLEANED_CAVEAT =
  "Also counts apps whose leftovers a scanner update stopped flagging or the merchant ignored item by item";

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export async function buildNodDigest(now: Date = new Date()): Promise<NodDigest> {
  const t = now.getTime();
  const d1 = new Date(t - DAY_MS);
  const d7 = new Date(t - 7 * DAY_MS);
  const d14 = new Date(t - 14 * DAY_MS);
  const d30 = new Date(t - 30 * DAY_MS);

  const excludeSet = parseExcludeShops(process.env.OPERATOR_EXCLUDE_SHOPS);
  const excludePrefixes = parseExcludePrefixes(process.env.OPERATOR_EXCLUDE_PREFIXES);

  const shops = await db.shop.findMany({
    select: {
      id: true,
      domain: true,
      plan: true,
      installedAt: true,
      uninstalledAt: true,
      isInternal: true,
      lastSeenAt: true,
      firstResultsViewedAt: true,
    },
  });

  // Domain-keyed event streams carry no shop object, so merge the isInternal
  // domains into the exclude set exactly as the operator digest does.
  const eventExclude = new Set([
    ...excludeSet,
    ...shops.filter((s) => s.isInternal).map((s) => s.domain.toLowerCase()),
  ]);

  const { activeShops } = partitionShops(shops, excludeSet, excludePrefixes, d1);
  const nonExcluded = shops.filter((s) => !isExcludedShop(s, excludeSet, excludePrefixes));
  const excludedInternal = shops.filter(
    (s) => s.uninstalledAt === null && isExcludedShop(s, excludeSet, excludePrefixes),
  ).length;
  const activeIds = new Set(activeShops.map((s) => s.id));
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const activeIdByDomain = new Map(activeShops.map((s) => [s.domain.toLowerCase(), s.id]));
  const nonExcludedDomains = new Set(nonExcluded.map((s) => s.domain.toLowerCase()));

  // ---- Installs (Shop rows for installs, shop_uninstalled events for uninstalls) ----
  const uninstallEvents = await db.opsEvent.findMany({
    where: { eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED, createdAt: { gte: d30 } },
    select: { key: true, createdAt: true },
  });
  const uninstallsKept = uninstallEvents.filter(
    (e) => e.key != null && !isExcluded(e.key, eventExclude, excludePrefixes),
  );
  const installs = {
    active: activeShops.length,
    installed7d: nonExcluded.filter((s) => s.installedAt >= d7).length,
    uninstalled7d: countUninstallEventsExcluding(
      uninstallEvents.filter((e) => e.createdAt >= d7),
      eventExclude,
      excludePrefixes,
    ),
    installed30d: nonExcluded.filter((s) => s.installedAt >= d30).length,
    uninstalled30d: countUninstallEventsExcluding(uninstallEvents, eventExclude, excludePrefixes),
    excludedInternal,
  };

  // ---- Revenue: list-price MRR from the active plan mix ----
  const mix = computePlanMix(activeShops);
  const price = (plan: string) => Math.round((PLAN_AMOUNTS[plan] ?? 0) * 100);
  const plans = [
    { plan: "Free", installs: mix.free, mrrCents: 0 },
    {
      plan: "Standard",
      installs: mix.Standard,
      mrrCents: mix.Standard * price(PLANS.STANDARD),
    },
    {
      plan: "Professional",
      installs: mix.Professional,
      mrrCents: mix.Professional * price(PLANS.PROFESSIONAL),
    },
  ].filter((p) => p.installs > 0);
  const revenue = {
    currency: "USD" as const,
    mrrCents: plans.reduce((sum, p) => sum + p.mrrCents, 0),
    plans,
  };
  // Guard against drift from the digest email's own MRR definition.
  if (revenue.mrrCents !== Math.round(computeMrr(mix) * 100)) {
    throw new Error("nod-digest: MRR plan sum disagrees with computeMrr");
  }

  // ---- Value: outcomes first (NOD ADR-010), then scans run ----
  // Outcome rows cover every non-excluded shop still in the DB, uninstalled
  // ones included, so value delivered before an uninstall still counts. Each
  // row comes from ONE query filtered in memory, so d1 <= d7 <= d30 holds by
  // construction.
  const nonExcludedIds = nonExcluded.map((s) => s.id);
  const cleaned =
    nonExcludedIds.length === 0
      ? []
      : await db.appRemoval.findMany({
          where: {
            state: AppRemovalState.CLEANED,
            stateChangedAt: { gte: d30 },
            shopId: { in: nonExcludedIds },
          },
          select: { shopId: true, stateChangedAt: true, leftoverCount: true },
        });
  const cleanedAt = (r: (typeof cleaned)[number]) => r.stateChangedAt as Date;
  // Successful scans completed in the window (resolved findings, malicious warnings).
  const doneScans =
    nonExcludedIds.length === 0
      ? []
      : await db.scan.findMany({
          where: {
            status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
            completedAt: { gte: d30 },
            shopId: { in: nonExcludedIds },
          },
          select: { completedAt: true, resolvedFindingCount: true },
        });
  const malicious =
    nonExcludedIds.length === 0
      ? []
      : await db.finding.findMany({
          where: {
            findingType: FindingType.MALICIOUS_SCRIPT,
            scan: {
              status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
              completedAt: { gte: d30 },
              shopId: { in: nonExcludedIds },
            },
          },
          select: { scan: { select: { shopId: true, completedAt: true } } },
        });
  const scans =
    activeIds.size === 0
      ? []
      : await db.scan.findMany({
          where: { createdAt: { gte: d30 }, shopId: { in: [...activeIds] } },
          select: { shopId: true, createdAt: true },
        });

  const windows = <T>(rows: T[], at: (r: T) => Date, sum: (rs: T[]) => number) => {
    const since = (from: Date) => sum(rows.filter((r) => at(r) >= from));
    return { d1: since(d1), d7: since(d7), d30: sum(rows) };
  };
  const count = <T>(rs: T[]) => rs.length;
  const value: NodValueRow[] = [
    {
      key: "apps_cleaned",
      label: "Apps cleaned up",
      ...windows(cleaned, cleanedAt, count),
      caveat: CLEANED_CAVEAT,
    },
    {
      key: "leftovers_removed",
      label: "Leftover items removed",
      ...windows(cleaned, cleanedAt, (rs) => rs.reduce((n, r) => n + r.leftoverCount, 0)),
      caveat: CLEANED_CAVEAT,
    },
    {
      key: "malicious_shops",
      label: "Shops warned about a malicious script",
      ...windows(
        malicious,
        (f) => f.scan.completedAt as Date,
        (fs) => new Set(fs.map((f) => f.scan.shopId)).size,
      ),
      caveat: "Detection only: does not confirm the merchant saw it",
    },
    {
      key: "findings_resolved",
      label: "Findings resolved",
      ...windows(
        doneScans,
        (s) => s.completedAt as Date,
        (ss) => ss.reduce((n, s) => n + s.resolvedFindingCount, 0),
      ),
      // Same note as the operator digest's resolution rollup.
      caveat: "Also counts findings a scanner update stopped flagging",
    },
    {
      // Activity, not an outcome: every scan of an active install, any status.
      key: "scans",
      label: "Scans run",
      ...windows(scans, (s) => s.createdAt, count),
      caveat: "Includes scheduled and theme-publish automatic scans, and failed scans",
    },
  ];

  // ---- Engagement: page_visit (domain-keyed, 14d retention) + scans ----
  const visits = await db.opsEvent.findMany({
    where: { eventType: OPS_EVENT_TYPES.PAGE_VISIT, createdAt: { gte: d14 } },
    select: { key: true, createdAt: true },
  });
  const activeVisits = visits.flatMap((v) => {
    const id = v.key == null ? undefined : activeIdByDomain.get(v.key.toLowerCase());
    return id ? [{ id, createdAt: v.createdAt }] : [];
  });
  const thisWeek = new Set<string>();
  const priorWeek = new Set<string>();
  const addActivity = (id: string, at: Date) => (at >= d7 ? thisWeek : priorWeek).add(id);
  for (const v of activeVisits) addActivity(v.id, v.createdAt);
  for (const s of scans) if (s.createdAt >= d14) addActivity(s.shopId, s.createdAt);
  for (const s of activeShops) {
    const seen = shopById.get(s.id)?.lastSeenAt;
    if (seen && seen >= d7) thisWeek.add(s.id);
  }
  const engagement = {
    activeMerchants7d: thisWeek.size,
    returningMerchants7d: [...thisWeek].filter((id) => priorWeek.has(id)).length,
    visits7d: activeVisits.filter((v) => v.createdAt >= d7).length,
  };

  // ---- Nudges: trailing 30d, pinned to non-excluded domains (as the digest does) ----
  const nudgeEvents = await db.opsEvent.findMany({
    where: {
      eventType: { in: Object.keys(NUDGE_STAGE_BY_EVENT_TYPE) },
      createdAt: { gte: d30 },
    },
    select: { eventType: true, key: true, metadata: true },
  });
  const nudgeRows = new Map<
    string,
    { shown: number; clicked: number; dismissed: number; converted: number }
  >();
  for (const e of nudgeEvents) {
    const stage = NUDGE_STAGE_BY_EVENT_TYPE[e.eventType];
    if (!stage || e.key == null || !nonExcludedDomains.has(e.key.toLowerCase())) continue;
    const raw = metaString(e.metadata, "nudgeKey");
    const key = raw !== undefined && raw in NUDGE_LABELS ? raw : NUDGE_OTHER_KEY;
    const row = nudgeRows.get(key) ?? { shown: 0, clicked: 0, dismissed: 0, converted: 0 };
    row[stage] += 1;
    nudgeRows.set(key, row);
  }
  const nudges = Object.keys(NUDGE_LABELS).flatMap((key) => {
    const row = nudgeRows.get(key);
    return row ? [{ key, label: NUDGE_LABELS[key], ...row }] : [];
  });

  // ---- Errors: trailing 7d from OpsEvent; expired offline sessions are not OpsEvents ----
  const errorEvents = await db.opsEvent.findMany({
    where: {
      eventType: {
        in: [
          OPS_EVENT_TYPES.WEBHOOK_FAILURE,
          OPS_EVENT_TYPES.API_ERROR,
          OPS_EVENT_TYPES.FUNCTION_FAILURE,
          OPS_EVENT_TYPES.CLIENT_ERROR,
        ],
      },
      createdAt: { gte: d7 },
    },
    select: { eventType: true, key: true, metadata: true, createdAt: true },
  });
  const errorRows = new Map<
    string,
    { category: NodErrorCategory; count24h: number; count7d: number; last: Date }
  >();
  let errors24h = 0;
  let errors7d = 0;
  for (const e of errorEvents) {
    let code: string;
    let category: NodErrorCategory;
    // Shop attribution lives in different places per type; an excluded shop's
    // errors are dropped, an unattributed one (null) is kept.
    let shopDomain: string | null | undefined;
    if (e.eventType === OPS_EVENT_TYPES.WEBHOOK_FAILURE) {
      // Degraded-but-handled webhooks (200 returned) are not failures (digest parity).
      if ((e.metadata as { degraded?: unknown } | null)?.degraded === true) continue;
      code = sanitizeCode("webhook_", e.key);
      category = "webhook";
      shopDomain = metaString(e.metadata, "shop");
    } else if (e.eventType === OPS_EVENT_TYPES.API_ERROR) {
      // Warnings are not errors (digest splits them out).
      if (metaString(e.metadata, "level") === "warn") continue;
      code = sanitizeCode("api_", e.key);
      category = "api";
      shopDomain = metaString(e.metadata, "shopDomain");
    } else if (e.eventType === OPS_EVENT_TYPES.FUNCTION_FAILURE) {
      code = sanitizeCode("job_", e.key);
      category = "job";
      // notifications.server stamps metadata.shop (a domain) when the failing run had one.
      shopDomain = metaString(e.metadata, "shop");
    } else {
      code = sanitizeCode("client_", metaString(e.metadata, "kind"));
      category = "other";
      shopDomain = e.key;
    }
    if (shopDomain && isExcluded(shopDomain, eventExclude, excludePrefixes)) continue;
    const in24h = e.createdAt >= d1;
    errors7d += 1;
    if (in24h) errors24h += 1;
    const row = errorRows.get(code) ?? { category, count24h: 0, count7d: 0, last: e.createdAt };
    row.count7d += 1;
    if (in24h) row.count24h += 1;
    if (e.createdAt > row.last) row.last = e.createdAt;
    errorRows.set(code, row);
  }
  const errors = {
    count24h: errors24h,
    count7d: errors7d,
    byCode: [...errorRows.entries()]
      .sort(([ca, a], [cb, b]) => b.count7d - a.count7d || ca.localeCompare(cb))
      .slice(0, MAX_ERROR_CODES)
      .map(([code, r]) => ({
        code,
        category: r.category,
        count24h: r.count24h,
        count7d: r.count7d,
        lastAt: r.last.toISOString(),
      })),
  };

  // ---- Series: last 30 UTC days (today included), oldest first ----
  const days = Array.from({ length: SERIES_DAYS }, (_, i) =>
    utcDay(new Date(t - (SERIES_DAYS - 1 - i) * DAY_MS)),
  );
  const bucket = (dates: Date[]) => {
    const counts = new Map<string, number>();
    for (const d of dates) counts.set(utcDay(d), (counts.get(utcDay(d)) ?? 0) + 1);
    return days.map((day) => counts.get(day) ?? 0);
  };
  const series = {
    days,
    installed: bucket(nonExcluded.filter((s) => s.installedAt >= d30).map((s) => s.installedAt)),
    uninstalled: bucket(uninstallsKept.map((e) => e.createdAt)),
    value: bucket(cleaned.map(cleanedAt)), // value[0]: apps cleaned up per day
  };

  // ---- Merchants: active installs, Shop.id only ----
  const lastScanAt = new Map<string, Date>();
  const scans7d = new Map<string, number>();
  const scans30d = new Map<string, number>();
  for (const s of scans) {
    scans30d.set(s.shopId, (scans30d.get(s.shopId) ?? 0) + 1);
    if (s.createdAt >= d7) scans7d.set(s.shopId, (scans7d.get(s.shopId) ?? 0) + 1);
    const prev = lastScanAt.get(s.shopId);
    if (!prev || s.createdAt > prev) lastScanAt.set(s.shopId, s.createdAt);
  }
  const cleaned7d = new Map<string, number>();
  const cleaned30d = new Map<string, number>();
  for (const r of cleaned) {
    cleaned30d.set(r.shopId, (cleaned30d.get(r.shopId) ?? 0) + 1);
    if (cleanedAt(r) >= d7) cleaned7d.set(r.shopId, (cleaned7d.get(r.shopId) ?? 0) + 1);
  }
  const lastVisitAt = new Map<string, Date>();
  for (const v of activeVisits) {
    const prev = lastVisitAt.get(v.id);
    if (!prev || v.createdAt > prev) lastVisitAt.set(v.id, v.createdAt);
  }
  const merchants = activeShops.map((a) => {
    const shop = shopById.get(a.id)!;
    const candidates = [shop.lastSeenAt, lastScanAt.get(a.id), lastVisitAt.get(a.id)].filter(
      (d): d is Date => d != null,
    );
    const last =
      candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
    return {
      id: a.id,
      plan: planLabel(a.plan),
      installedAt: shop.installedAt.toISOString(),
      ...(last ? { lastActiveAt: last.toISOString() } : {}),
      actions7d: { scans: scans7d.get(a.id) ?? 0, apps_cleaned: cleaned7d.get(a.id) ?? 0 },
      actions30d: { scans: scans30d.get(a.id) ?? 0, apps_cleaned: cleaned30d.get(a.id) ?? 0 },
    };
  });

  // ---- Journey (NOD ADR-010): all-time first times, one row per non-excluded shop ----
  // Uninstalled-but-not-yet-deleted shops are included (with uninstalledAt) so
  // NOD sees them before shop/redact deletes the row. Caveats:
  //   - first_results: Shop.firstResultsViewedAt is only tracked for shops whose
  //     first successful scan completed on/after RESULTS_VIEW_TRACKED_SINCE
  //     (app/lib/journey-stage.ts); earlier shops may lack it though they viewed.
  //   - first_cleanup: only CLEANED rows count. A REMOVED row that turns
  //     REINSTALLED never gets a cleanup time; CLEANED itself is terminal (only
  //     REMOVED rows are re-evaluated), so a recorded cleanup time is never lost.
  //   - Shop.installedAt keeps the first install across a reinstall.
  const [firstScans, firstCleanups] =
    nonExcludedIds.length === 0
      ? [[], []]
      : await Promise.all([
          db.scan.groupBy({
            by: ["shopId"],
            where: {
              status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
              shopId: { in: nonExcludedIds },
            },
            _min: { completedAt: true },
          }),
          db.appRemoval.groupBy({
            by: ["shopId"],
            where: { state: AppRemovalState.CLEANED, shopId: { in: nonExcludedIds } },
            _min: { stateChangedAt: true },
          }),
        ]);
  const firstScanAt = new Map(firstScans.map((g) => [g.shopId, g._min.completedAt]));
  const firstCleanupAt = new Map(firstCleanups.map((g) => [g.shopId, g._min.stateChangedAt]));
  const journey: NodJourney = {
    stages: [
      { key: "first_scan", label: "First scan done" },
      { key: "first_results", label: "Saw first results" },
      { key: "first_cleanup", label: "Cleanup confirmed" },
    ],
    valueStage: "first_cleanup",
    merchants: nonExcluded.map((s) => {
      const reached: Record<string, string> = {};
      const stamps: Array<[string, Date | null | undefined]> = [
        ["first_scan", firstScanAt.get(s.id)],
        ["first_results", s.firstResultsViewedAt],
        ["first_cleanup", firstCleanupAt.get(s.id)],
      ];
      for (const [key, at] of stamps) if (at) reached[key] = at.toISOString();
      return {
        id: s.id,
        installedAt: s.installedAt.toISOString(),
        ...(s.uninstalledAt ? { uninstalledAt: s.uninstalledAt.toISOString() } : {}),
        plan: planLabel(s.plan),
        reached,
      };
    }),
  };

  return {
    contractVersion: 1,
    app: { key: "ghostcode", name: "GhostCode", platform: "shopify" },
    generatedAt: now.toISOString(),
    lifecycle: { stage: "live" },
    installs,
    revenue,
    value,
    engagement,
    nudges,
    errors,
    series,
    journey,
    merchants,
  };
}
