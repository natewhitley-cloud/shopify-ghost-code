/**
 * Operator daily digest (gc-bny).
 *
 * ONE daily cron that emails Nathan (the operator) a plaintext business +
 * ops-health rollup through the existing Resend ops channel (sendOpsAlert).
 * This is the DAILY ROLLUP — real-time failure alerts stay a separate stream
 * (see ops-alert.server / the per-cron onFailure paths). Structure/style is
 * modeled on ClearSignal's operator-digest, adapted to Ghost Code's models.
 *
 * Read-only reporting. The ONLY write is one observability snapshot row
 * (OpsEvent, eventType "digest_snapshot"): today's plan-mix + MRR, so
 * tomorrow's run can diff against a prior snapshot for a net up/down line. No
 * shop/plan/billing state is ever written.
 *
 * Cron: 8:00 AM America/Denver (DST-correct via the Inngest `TZ=` prefix).
 * Wrapped in withCronHeartbeat so it participates in the dead-man's-switch.
 *
 * Sections (each "in 24h" = trailing 24h unless noted):
 *   A. Business  — installs, plan mix + net change, MRR + net change, scans by
 *      status + per store, findings, signature flywheel, activation.
 *   B. Ops health — scan runs (derived from A's status map), function/worker/
 *      webhook failures, API errors/warns, cron dead-man's-switch, an alerting
 *      self-check (loud banner at top if the paging channel is misconfigured).
 *
 * Dev/operator store(s) are excluded from every shop/scan count via
 * OPERATOR_EXCLUDE_SHOPS (defaults to Nathan's dev store).
 */

import { PLAN_AMOUNTS, PLANS } from "../../app/lib/billing.server";
import type { BillingEventType } from "../../app/models/billing-event.server";
import type { StaleCron } from "../../app/models/ops-event.server";
import type { OpsAlertConfigStatus } from "../../app/services/ops-alert.server";
import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

// One trailing day, in ms. `windowStart = now - DAY_MS`.
export const DAY_MS = 86_400_000;

// The stable OpsEvent discriminators for the daily plan-mix + MRR snapshot.
// Read (most-recent prior) then written each run so successive runs diff
// against a prior snapshot rather than against themselves.
export const DIGEST_SNAPSHOT_EVENT_TYPE = "digest_snapshot";
export const DIGEST_SNAPSHOT_KEY = "operator-digest";

// Dev/operator store(s) excluded from every count. Comma-separated shop domains
// in OPERATOR_EXCLUDE_SHOPS; defaults to Nathan's dev store so it is never
// counted before the env var is configured (referenced in billing.server.ts).
export const DEFAULT_EXCLUDE_SHOPS = "nw-dev-store-2.myshopify.com";

// Print caps so one noisy shop / long tail can't blow out the email. The true
// totals are always reported alongside the capped list.
const SCANS_PER_STORE_LIMIT = 10;
const FINDING_TYPES_LIMIT = 8;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing; no Prisma/Shopify/IO)
// ---------------------------------------------------------------------------

/**
 * Parse OPERATOR_EXCLUDE_SHOPS into a lowercased Set of shop domains. Unset or
 * all-blank falls back to DEFAULT_EXCLUDE_SHOPS so the operator's own store is
 * never accidentally counted before the env var is configured.
 */
export function parseExcludeShops(raw: string | undefined): Set<string> {
  const source = raw && raw.trim().length > 0 ? raw : DEFAULT_EXCLUDE_SHOPS;
  const domains = source
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return new Set(domains);
}

/**
 * Partition all fetched shops into the digest's install buckets, excluding the
 * dev/operator store(s). Consumes Date fields (installedAt/uninstalledAt) and
 * returns ONLY serialization-safe counts/strings/ids so nothing but plain data
 * crosses the Inngest step boundary.
 *
 * - totalActive / activeShops / activeShopIds: NET active installs (non-excluded
 *   AND not uninstalled-pending-redact).
 * - newIn24h: GROSS installs in the window (non-excluded, including a shop that
 *   also uninstalled in the same window) — contrast with the net Total active.
 * - domainById: id → domain over ALL non-excluded shops (a superset of active),
 *   so per-store domain lookups still resolve for any in-window scan.
 */
export function partitionShops(
  allShops: Array<{
    id: string;
    domain: string;
    plan: string;
    installedAt: Date;
    uninstalledAt: Date | null;
  }>,
  excludeSet: Set<string>,
  windowStart: Date,
): {
  totalActive: number;
  newIn24h: number;
  activeShops: Array<{ id: string; domain: string; plan: string }>;
  activeShopIds: string[];
  domainById: Record<string, string>;
} {
  const nonExcluded = allShops.filter((s) => !excludeSet.has(s.domain.toLowerCase()));
  const active = nonExcluded.filter((s) => s.uninstalledAt === null);
  const activeShops = active.map((s) => ({ id: s.id, domain: s.domain, plan: s.plan }));
  return {
    totalActive: active.length,
    // GROSS installs in the window (from non-excluded, incl. same-window
    // uninstalls); contrast with the net Total active above.
    newIn24h: nonExcluded.filter((s) => s.installedAt >= windowStart).length,
    activeShops,
    activeShopIds: activeShops.map((s) => s.id),
    domainById: Object.fromEntries(nonExcluded.map((s) => [s.id, s.domain])) as Record<
      string,
      string
    >,
  };
}

/**
 * Count SHOP_UNINSTALLED events whose `key` (the shop domain) is not in the
 * exclude set, so the uninstalls line is dev-store-consistent with every other
 * metric. Case-insensitive on the domain; null keys are ignored.
 */
export function countUninstallEventsExcluding(
  events: Array<{ key: string | null }>,
  excludeSet: Set<string>,
): number {
  return events.filter((e) => e.key != null && !excludeSet.has(e.key.toLowerCase())).length;
}

/** Active-install counts per live plan tier. Keys mirror PLANS values. */
export interface PlanMix {
  free: number;
  Standard: number;
  Professional: number;
}

const PLAN_MIX_KEYS: Array<keyof PlanMix> = ["free", "Standard", "Professional"];

/**
 * Count active shops per plan. Any unrecognized/legacy plan value falls into
 * `free` (never granted paid weight), matching how the app treats unknown plans.
 */
export function computePlanMix(shops: Array<{ plan: string }>): PlanMix {
  const mix: PlanMix = { free: 0, Standard: 0, Professional: 0 };
  for (const s of shops) {
    if (s.plan === PLANS.STANDARD) mix.Standard += 1;
    else if (s.plan === PLANS.PROFESSIONAL) mix.Professional += 1;
    else mix.free += 1;
  }
  return mix;
}

/**
 * MRR from the reconciled plan mix (the plan is the source of truth — no live
 * Shopify subscription lookups). free contributes nothing.
 */
export function computeMrr(mix: PlanMix): number {
  return (
    mix.Standard * (PLAN_AMOUNTS[PLANS.STANDARD] ?? 0) +
    mix.Professional * (PLAN_AMOUNTS[PLANS.PROFESSIONAL] ?? 0)
  );
}

/** The snapshot payload persisted as OpsEvent.metadata each run. */
export interface DigestSnapshot {
  planMix: PlanMix;
  mrr: number;
}

/**
 * Parse a prior snapshot's OpsEvent.metadata (arbitrary JSON) into a
 * DigestSnapshot, or null if missing/malformed. Defensive: a malformed prior
 * row must degrade to "no prior snapshot", never crash the digest.
 */
export function parseSnapshotMetadata(metadata: unknown): DigestSnapshot | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;

  const pm = m.planMix;
  if (typeof pm !== "object" || pm === null) return null;
  const p = pm as Record<string, unknown>;

  const planMix: PlanMix = { free: 0, Standard: 0, Professional: 0 };
  for (const key of PLAN_MIX_KEYS) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    planMix[key] = v;
  }

  const mrr = m.mrr;
  if (typeof mrr !== "number" || !Number.isFinite(mrr)) return null;

  return { planMix, mrr };
}

export interface SnapshotDiff {
  perPlan: Array<{ plan: keyof PlanMix; count: number; delta: number | null }>;
  mrrDelta: number | null;
}

/**
 * Diff the current snapshot against the most-recent prior one. Deltas are null
 * on day 1 (no prior snapshot), which the body renders as "deltas begin
 * tomorrow".
 */
export function diffSnapshot(current: DigestSnapshot, prior: DigestSnapshot | null): SnapshotDiff {
  const perPlan = PLAN_MIX_KEYS.map((plan) => ({
    plan,
    count: current.planMix[plan],
    delta: prior ? current.planMix[plan] - prior.planMix[plan] : null,
  }));
  return {
    perPlan,
    mrrDelta: prior ? current.mrr - prior.mrr : null,
  };
}

export interface ScanStatusCounts {
  COMPLETED: number;
  PARTIAL: number;
  FAILED: number;
  IN_PROGRESS: number;
  PENDING: number;
}

/** Tally in-window scans by status. Computed ONCE and reused across sections. */
export function computeScanStatusCounts(scans: Array<{ status: string }>): ScanStatusCounts {
  const counts: ScanStatusCounts = {
    COMPLETED: 0,
    PARTIAL: 0,
    FAILED: 0,
    IN_PROGRESS: 0,
    PENDING: 0,
  };
  for (const s of scans) {
    if (s.status in counts) counts[s.status as keyof ScanStatusCounts] += 1;
  }
  return counts;
}

/** Scans per store, most-active first. `domainById` maps shopId → domain. */
export function computeScansPerStore(
  scans: Array<{ shopId: string }>,
  domainById: Record<string, string>,
): Array<{ domain: string; count: number }> {
  const byShop = new Map<string, number>();
  for (const s of scans) byShop.set(s.shopId, (byShop.get(s.shopId) ?? 0) + 1);
  return [...byShop.entries()]
    .map(([shopId, count]) => ({ domain: domainById[shopId] ?? shopId, count }))
    .sort((a, b) => b.count - a.count);
}

/** Sort finding-type counts most-frequent first. */
export function sortFindingTypeCounts(
  rows: Array<{ type: string; count: number }>,
): Array<{ type: string; count: number }> {
  return [...rows].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Digest body (plaintext; sendOpsAlert is a text-only channel)
// ---------------------------------------------------------------------------

/** Serialization-safe stale-cron summary (Date rendered to an ISO string so no
 * Date crosses the step boundary). */
export interface StaleCronSummary {
  key: string;
  ageMs: number;
  lastHeartbeatAt: string;
}

export interface OperatorDigestData {
  dateLabel: string;
  alerting: OpsAlertConfigStatus;
  installs: { totalActive: number; newIn24h: number; uninstallsIn24h: number };
  planMix: SnapshotDiff;
  billingEvents: Record<BillingEventType, number>;
  mrr: { total: number; delta: number | null };
  scans: {
    total: number;
    statusCounts: ScanStatusCounts;
    perStore: Array<{ domain: string; count: number }>;
  };
  findings: { total: number; topTypes: Array<{ type: string; count: number }> };
  flywheel: {
    newUnknownScripts: number;
    newSubmissions: number;
    submissionsByStatus: { PENDING: number; ACCEPTED: number; REJECTED: number };
  };
  activation: { activated: number; dormant: number; totalActive: number };
  ops: {
    functionFailures: number;
    workerFallbacks: number;
    webhookFailures: number;
    apiErrors: { error: number; warn: number };
    staleCrons: StaleCronSummary[];
  };
}

function fmtCountDelta(delta: number | null): string {
  if (delta === null) return "";
  const sign = delta > 0 ? "+" : "";
  return ` (${sign}${delta})`;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtMoneyDelta(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `(${sign}${fmtMoney(Math.abs(delta))})`;
}

function alertingWhy(status: OpsAlertConfigStatus): string {
  return status.reason === "no_recipient" ? "OPS_ALERT_EMAIL unset" : "RESEND_API_KEY unset";
}

export function buildDigestBody(data: OperatorDigestData): string {
  const lines: string[] = [];

  lines.push(`GhostCode Operator Digest -- ${data.dateLabel}`);
  lines.push("(all figures are trailing 24h unless noted)");
  lines.push("");

  // Self-check the paging path FIRST and loudly. Every operator alert funnels
  // through sendOpsAlert, which silently no-ops if these env vars are unset;
  // surface that at the very top so a misconfigured channel can't hide.
  if (!data.alerting.configured) {
    lines.push(
      `*** ALERTING DISABLED (${alertingWhy(data.alerting)}) -- operator pages will not send ***`,
    );
    lines.push("");
  }

  // ----- Section A: Business -----
  lines.push("=== BUSINESS ===");
  lines.push("");

  const { installs } = data;
  lines.push("INSTALLS");
  lines.push(`  Total active: ${installs.totalActive}`);
  lines.push(`  New in 24h: ${installs.newIn24h}`);
  lines.push(`  Uninstalls in 24h: ${installs.uninstallsIn24h}`);
  lines.push("");

  const { planMix, billingEvents } = data;
  lines.push("PLAN MIX (active installs)");
  for (const p of planMix.perPlan) {
    lines.push(`  ${p.plan}: ${p.count}${fmtCountDelta(p.delta)}`);
  }
  if (planMix.perPlan[0]?.delta === null) {
    lines.push("  Net change: no prior snapshot (deltas begin tomorrow)");
  }
  lines.push(
    `  Billing events (24h): ${billingEvents.upgrade} upgrade, ${billingEvents.downgrade} downgrade, ${billingEvents.cancellation} cancellation, ${billingEvents.reactivation} reactivation`,
  );
  lines.push("");

  const { mrr } = data;
  lines.push("MRR (from reconciled plan; excludes free)");
  if (mrr.delta === null) {
    lines.push(`  ${fmtMoney(mrr.total)}/mo (no prior snapshot -- deltas begin tomorrow)`);
  } else {
    lines.push(`  ${fmtMoney(mrr.total)}/mo ${fmtMoneyDelta(mrr.delta)}`);
  }
  lines.push("");

  const { scans } = data;
  const sc = scans.statusCounts;
  lines.push("SCANS (last 24h)");
  lines.push(`  Total: ${scans.total}`);
  lines.push(
    `  By status: ${sc.COMPLETED} completed, ${sc.PARTIAL} partial, ${sc.FAILED} failed, ${sc.IN_PROGRESS} in-progress, ${sc.PENDING} pending`,
  );
  lines.push("  By store:");
  if (scans.perStore.length === 0) {
    lines.push("    None in the window");
  } else {
    for (const row of scans.perStore.slice(0, SCANS_PER_STORE_LIMIT)) {
      lines.push(`    ${row.domain} -- ${row.count}`);
    }
    if (scans.perStore.length > SCANS_PER_STORE_LIMIT) {
      lines.push(`    ...and ${scans.perStore.length - SCANS_PER_STORE_LIMIT} more store(s)`);
    }
  }
  lines.push("");

  const { findings } = data;
  lines.push("FINDINGS (last 24h)");
  lines.push(`  Total (sum of scan findingCount): ${findings.total}`);
  lines.push("  Top types:");
  if (findings.topTypes.length === 0) {
    lines.push("    None in the window");
  } else {
    for (const t of findings.topTypes.slice(0, FINDING_TYPES_LIMIT)) {
      lines.push(`    ${t.type} -- ${t.count}`);
    }
    if (findings.topTypes.length > FINDING_TYPES_LIMIT) {
      lines.push(`    ...and ${findings.topTypes.length - FINDING_TYPES_LIMIT} more type(s)`);
    }
  }
  lines.push("");

  const { flywheel } = data;
  const fs = flywheel.submissionsByStatus;
  lines.push("SIGNATURE FLYWHEEL (last 24h)");
  lines.push(`  New unknown scripts: ${flywheel.newUnknownScripts}`);
  lines.push(
    `  New signature submissions: ${flywheel.newSubmissions} (${fs.PENDING} pending, ${fs.ACCEPTED} accepted, ${fs.REJECTED} rejected)`,
  );
  lines.push("");

  const { activation } = data;
  lines.push("ACTIVATION");
  lines.push(
    `  Activated (>= 1 scan ever): ${activation.activated} of ${activation.totalActive} active installs`,
  );
  lines.push(`  Dormant (0 scans ever): ${activation.dormant}`);
  lines.push("");

  // ----- Section B: Operational health -----
  lines.push("=== OPERATIONAL HEALTH (last 24h) ===");
  lines.push("");

  lines.push("SCAN RUNS");
  lines.push(`  Completed: ${sc.COMPLETED}, Failed: ${sc.FAILED}, Partial: ${sc.PARTIAL}`);
  lines.push("");

  const { ops } = data;
  lines.push("FUNCTIONS & WORKERS");
  lines.push(`  Function failures: ${ops.functionFailures}`);
  lines.push(`  Worker-pool fallbacks: ${ops.workerFallbacks}`);
  lines.push(`  Webhook failures: ${ops.webhookFailures}`);
  lines.push("");

  lines.push("API");
  lines.push(`  Errors: ${ops.apiErrors.error}, Warnings: ${ops.apiErrors.warn}`);
  lines.push("");

  lines.push("CRON HEALTH (dead-man's-switch)");
  if (ops.staleCrons.length === 0) {
    lines.push("  All crons healthy");
  } else {
    for (const c of ops.staleCrons) {
      lines.push(`  OVERDUE: ${c.key} (last heartbeat ${c.lastHeartbeatAt}, ${c.ageMs} ms ago)`);
    }
  }
  lines.push("");

  lines.push("ALERTING (paging self-check)");
  if (data.alerting.configured) {
    lines.push("  Configured and live");
  } else {
    lines.push(`  DISABLED -- ${alertingWhy(data.alerting)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

export const operatorDigest = inngest.createFunction(
  { id: "operator-digest", name: "Operator Daily Digest" },
  { cron: "TZ=America/Denver 0 8 * * *" },
  withCronHeartbeat("operator-digest", async ({ step }) => {
    const windowStart = new Date(Date.now() - DAY_MS);
    const excludeSet = parseExcludeShops(process.env.OPERATOR_EXCLUDE_SHOPS);

    // Fetch all shops once, exclude the dev/operator store(s), and compute the
    // trailing-24h install counts INSIDE the step where the Prisma Date fields
    // are still real Dates. Only serialization-safe data crosses the boundary.
    const shopData = (await step.run("get-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      const all = await db.shop.findMany({
        select: {
          id: true,
          domain: true,
          plan: true,
          installedAt: true,
          uninstalledAt: true,
        },
      });
      // Dates are consumed inside the helper; only counts/strings/ids are returned.
      return partitionShops(all, excludeSet, windowStart);
    })) as {
      totalActive: number;
      newIn24h: number;
      activeShops: Array<{ id: string; domain: string; plan: string }>;
      activeShopIds: string[];
      domainById: Record<string, string>;
    };

    const { activeShops, activeShopIds, domainById } = shopData;

    // Uninstalls in 24h from the durable SHOP_UNINSTALLED OpsEvent stream, with
    // the dev/operator store excluded for consistency with every other metric.
    // Each event's `key` is the uninstalled shop's domain.
    const uninstallsIn24h = (await step.run("count-uninstalls", async () => {
      const db = (await import("../../app/db.server")).default;
      const { OPS_EVENT_TYPES } = await import("../../app/models/ops-event.server");
      const rows = await db.opsEvent.findMany({
        where: {
          eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED,
          createdAt: { gte: windowStart },
        },
        select: { key: true },
      });
      return countUninstallEventsExcluding(rows, excludeSet);
    })) as number;

    // In-window scans scoped to ACTIVE installs (excludes the dev store AND
    // uninstalled-pending-redact shops) so churned-shop activity doesn't inflate
    // current-base metrics; churn is separately visible in the uninstalls line.
    // shopId/status/findingCount is all downstream aggregation needs.
    const scanRows = (await step.run("get-scans", async () => {
      const db = (await import("../../app/db.server")).default;
      if (activeShopIds.length === 0) return [];
      return db.scan.findMany({
        where: {
          createdAt: { gte: windowStart },
          shopId: { in: activeShopIds },
        },
        select: { shopId: true, status: true, findingCount: true },
      });
    })) as Array<{ shopId: string; status: string; findingCount: number }>;

    // Top finding types across findings whose scan is in-window and belongs to
    // an ACTIVE install (excludes the dev store AND uninstalled-pending-redact
    // shops) so churned-shop findings don't inflate current-base metrics.
    const findingTypeRows = (await step.run("get-finding-types", async () => {
      const db = (await import("../../app/db.server")).default;
      if (activeShopIds.length === 0) return [];
      const rows = await db.finding.groupBy({
        by: ["findingType"],
        where: {
          scan: {
            createdAt: { gte: windowStart },
            shopId: { in: activeShopIds },
          },
        },
        _count: { _all: true },
      });
      return rows.map((r) => ({ type: r.findingType, count: r._count._all }));
    })) as Array<{ type: string; count: number }>;

    // Signature flywheel: new UnknownScript + new SignatureSubmission (by
    // status) in the window. Portfolio-wide (not dev-excluded): these are
    // internal signal-quality metrics, and the dev store's contribution is
    // negligible; keeping them unfiltered avoids a wrong-field join risk.
    const flywheel = (await step.run("get-flywheel", async () => {
      const db = (await import("../../app/db.server")).default;
      const newUnknownScripts = await db.unknownScript.count({
        where: { createdAt: { gte: windowStart } },
      });
      const submissionRows = await db.signatureSubmission.groupBy({
        by: ["status"],
        where: { createdAt: { gte: windowStart } },
        _count: { _all: true },
      });
      const submissionsByStatus = { PENDING: 0, ACCEPTED: 0, REJECTED: 0 };
      let newSubmissions = 0;
      for (const r of submissionRows) {
        newSubmissions += r._count._all;
        if (r.status in submissionsByStatus) {
          submissionsByStatus[r.status as keyof typeof submissionsByStatus] = r._count._all;
        }
      }
      return { newUnknownScripts, newSubmissions, submissionsByStatus };
    })) as OperatorDigestData["flywheel"];

    // Activation: active installs that have EVER run a scan (distinct shopIds).
    const activatedCount = (await step.run("count-activation", async () => {
      const db = (await import("../../app/db.server")).default;
      if (activeShopIds.length === 0) return 0;
      const rows = await db.scan.findMany({
        where: { shopId: { in: activeShopIds } },
        select: { shopId: true },
        distinct: ["shopId"],
      });
      return rows.length;
    })) as number;

    // BillingEvent breakdown for the window.
    const billingEvents = (await step.run("get-billing-events", async () => {
      const { getBillingEventStats } = await import("../../app/models/billing-event.server");
      return getBillingEventStats(windowStart);
    })) as Record<BillingEventType, number>;

    // Read the most-recent prior snapshot BEFORE writing today's (so we never
    // diff against ourselves), then write today's — the ONE allowed write.
    const priorSnapshot = (await step.run("read-prior-snapshot", async () => {
      const { getLatestOpsEvent } = await import("../../app/models/ops-event.server");
      const row = await getLatestOpsEvent(DIGEST_SNAPSHOT_EVENT_TYPE, DIGEST_SNAPSHOT_KEY);
      return parseSnapshotMetadata(row?.metadata);
    })) as DigestSnapshot | null;

    const planMixCurrent = computePlanMix(activeShops);
    const mrrTotal = computeMrr(planMixCurrent);
    const currentSnapshot: DigestSnapshot = {
      planMix: planMixCurrent,
      mrr: mrrTotal,
    };

    await step.run("write-snapshot", async () => {
      const { recordOpsEvent } = await import("../../app/models/ops-event.server");
      await recordOpsEvent({
        eventType: DIGEST_SNAPSHOT_EVENT_TYPE,
        key: DIGEST_SNAPSHOT_KEY,
        message: "operator digest plan-mix + MRR snapshot",
        // Inline fresh literals so Prisma's InputJsonValue accepts the object
        // (a named interface like PlanMix lacks the required index signature).
        metadata: {
          planMix: {
            free: planMixCurrent.free,
            Standard: planMixCurrent.Standard,
            Professional: planMixCurrent.Professional,
          },
          mrr: mrrTotal,
        },
      });
    });

    // Ops-health signals. getStaleCrons returns Date fields; map to an ISO
    // string here so no Date crosses the step boundary.
    const ops = (await step.run("get-ops-health", async () => {
      const {
        countOpsEvents,
        countApiErrorsByLevel,
        getStaleCrons,
        CRON_HEARTBEAT_EXPECTATIONS,
        OPS_EVENT_TYPES,
      } = await import("../../app/models/ops-event.server");
      const [functionFailures, workerFallbacks, webhookFailures, apiErrors, stale] =
        await Promise.all([
          countOpsEvents(OPS_EVENT_TYPES.FUNCTION_FAILURE, DAY_MS),
          countOpsEvents(OPS_EVENT_TYPES.WORKER_FALLBACK, DAY_MS),
          countOpsEvents(OPS_EVENT_TYPES.WEBHOOK_FAILURE, DAY_MS),
          countApiErrorsByLevel(DAY_MS),
          getStaleCrons(CRON_HEARTBEAT_EXPECTATIONS),
        ]);
      return {
        functionFailures,
        workerFallbacks,
        webhookFailures,
        apiErrors,
        staleCrons: stale.map((c: StaleCron) => ({
          key: c.key,
          ageMs: c.ageMs,
          lastHeartbeatAt: c.lastHeartbeatAt.toISOString(),
        })),
      };
    })) as OperatorDigestData["ops"];

    // Assemble via the pure aggregators (status map computed ONCE, reused in B).
    const statusCounts = computeScanStatusCounts(scanRows);
    const data: OperatorDigestData = {
      dateLabel: new Date().toISOString().slice(0, 10),
      alerting: { configured: false, reason: "no_recipient" }, // overwritten in send step
      installs: {
        totalActive: shopData.totalActive,
        newIn24h: shopData.newIn24h,
        uninstallsIn24h,
      },
      planMix: diffSnapshot(currentSnapshot, priorSnapshot),
      billingEvents,
      mrr: {
        total: mrrTotal,
        delta: diffSnapshot(currentSnapshot, priorSnapshot).mrrDelta,
      },
      scans: {
        total: scanRows.length,
        statusCounts,
        perStore: computeScansPerStore(scanRows, domainById),
      },
      findings: {
        total: scanRows.reduce((sum, s) => sum + s.findingCount, 0),
        topTypes: sortFindingTypeCounts(findingTypeRows),
      },
      flywheel,
      activation: {
        activated: activatedCount,
        dormant: shopData.totalActive - activatedCount,
        totalActive: shopData.totalActive,
      },
      ops,
    };

    // Build + send. Best-effort: sendOpsAlert never throws, but wrap defensively
    // so no failure escapes the cron as an unhandled throw.
    const alertSent = (await step.run("send-digest", async () => {
      const { sendOpsAlert, getOpsAlertConfigStatus } =
        await import("../../app/services/ops-alert.server");
      const body = buildDigestBody({
        ...data,
        alerting: getOpsAlertConfigStatus(),
      });
      try {
        const result = await sendOpsAlert(`Operator digest -- ${data.dateLabel}`, body);
        return result.sent;
      } catch {
        return false;
      }
    })) as boolean;

    return { status: "completed", dateReported: data.dateLabel, alertSent };
  }),
);
