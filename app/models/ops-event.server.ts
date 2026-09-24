/**
 * Ops-event model (gc-06e.1).
 *
 * Data-access layer for the unified `OpsEvent` table that backs the app's
 * observability signals: cron heartbeats (dead-man's-switch), function-failure
 * logging, and the future daily ops digest. One table, one write path, several
 * read shapes.
 *
 * Write discipline mirrors the ops-alert channel: `recordOpsEvent` NEVER throws.
 * A failure to persist an observability event must never break the caller (a
 * failing cron must still complete its failure path; a successful cron must not
 * be turned into a failure by a heartbeat write). Errors are swallowed to a
 * logged line.
 */

import type { OpsEvent, Prisma } from "@prisma/client";

import db from "../db.server";
import { logger } from "../lib/logger.server";

// eventType discriminators. Kept as constants so callers and reads can never
// drift on a string literal.
export const OPS_EVENT_TYPES = {
  CRON_HEARTBEAT: "cron_heartbeat",
  FUNCTION_FAILURE: "function_failure",
  WORKER_FALLBACK: "worker_fallback",
  SHOP_UNINSTALLED: "shop_uninstalled",
  WEBHOOK_FAILURE: "webhook_failure",
  API_ERROR: "api_error",
  SCAN_SIGNAL: "scan_signal",
  PAGE_VISIT: "page_visit",
  // One row per reconcile-installs cron run (gc-dyt): a counts-only summary
  // (checked/marked/skipped). Keyed on a CONSTANT ("reconcile-installs"), never a
  // shop domain, and carries no per-shop PII — so it needs no per-shop redact
  // coverage in deleteShopData (which purges by domain) and no prune coverage in
  // pruneOpsEvents (one row/day is not high-volume, like digest_snapshot).
  RECONCILE_SUMMARY: "reconcile_summary",
  // One row on the RARE run where the reconciler's circuit breaker trips (gc-5ha):
  // more shops than the safety threshold classified "uninstalled" in a single run
  // (the mass-churn signature of a credential misconfig), so the run marked
  // NOTHING and aborted. Keyed on the same CONSTANT ("reconcile-installs"); the
  // affected domains are surfaced ONLY in the free-text `message` + the operator
  // email (like webhook_failure/function_failure error strings) — structured
  // `metadata` stays counts-only, so this needs no per-shop redact coverage in
  // deleteShopData and no prune coverage (a tripped breaker is near-never, not
  // high-volume) beyond the accepted free-text-message residual.
  RECONCILE_ABORTED: "reconcile_aborted",
  // Nudge-funnel telemetry (gc-97k.1): one row per funnel stage of an in-app
  // nudge (shown / clicked / dismissed / converted), written only via
  // app/services/nudge-telemetry.server. Keyed on the shop DOMAIN (OpsEvent has
  // no shopId column), with `metadata.nudgeKey` naming the nudge. Redact:
  // deleteShopData's existing `key: domain` clause reaches these rows (same as
  // page_visit), so no new clause is needed. Prune: pruneOpsEvents ages them out
  // at 90 days (NUDGE_RETENTION_DAYS): long enough to read a funnel at our
  // install volume, while `shown` can fire on page loads and would otherwise
  // grow without bound.
  NUDGE_SHOWN: "nudge_shown",
  NUDGE_CLICKED: "nudge_clicked",
  NUDGE_DISMISSED: "nudge_dismissed",
  NUDGE_CONVERTED: "nudge_converted",
} as const;

/** All nudge-funnel event types, for the prune and the digest's grouped read. */
export const NUDGE_FUNNEL_EVENT_TYPES = [
  OPS_EVENT_TYPES.NUDGE_SHOWN,
  OPS_EVENT_TYPES.NUDGE_CLICKED,
  OPS_EVENT_TYPES.NUDGE_DISMISSED,
  OPS_EVENT_TYPES.NUDGE_CONVERTED,
] as const;

/** Default retention for nudge-funnel rows (see pruneOpsEvents). */
export const NUDGE_RETENTION_DAYS = 90;

export interface RecordOpsEventInput {
  eventType: string;
  /** For heartbeat/failure events: the inngest function id. */
  key?: string;
  message?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append a single OpsEvent row. Best-effort — NEVER throws.
 *
 * On any persistence error the event is dropped and a warn line is logged; the
 * caller resolves normally. This is intentional: OpsEvents are observability,
 * not business data, and must not add a new failure mode to the code paths they
 * observe.
 */
export async function recordOpsEvent(input: RecordOpsEventInput): Promise<void> {
  try {
    await db.opsEvent.create({
      data: {
        eventType: input.eventType,
        key: input.key ?? null,
        message: input.message ?? null,
        // undefined leaves the nullable Json column at its null default.
        metadata: input.metadata,
      },
    });
  } catch (error) {
    logger.warn("ops-event-record-failed", {
      eventType: input.eventType,
      key: input.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Record a webhook that FAILED (its handler threw after HMAC auth). Thin
 * convenience over recordOpsEvent — same never-throws guarantee, so wrapping a
 * webhook body with this and re-throwing preserves Shopify's retry behavior
 * while making the failure durably countable for the daily digest.
 */
export async function recordWebhookFailure(input: {
  topic: string;
  shop: string;
  error: unknown;
}): Promise<void> {
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.WEBHOOK_FAILURE,
    key: input.topic,
    message: input.error instanceof Error ? input.error.message : String(input.error),
    metadata: { shop: input.shop },
  });
}

/**
 * Record a GraphQL / rate-limit API error or warning. Thin convenience over
 * recordOpsEvent — same never-throws guarantee. `level` distinguishes a genuine
 * error from a proximity warning; it is stored in metadata so the digest can
 * tally the two independently (see countApiErrorsByLevel).
 */
export async function recordApiError(input: {
  level: "error" | "warn";
  code: string;
  shopDomain?: string;
  message: string;
  metadata?: Record<string, string | number>;
}): Promise<void> {
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.API_ERROR,
    key: input.code,
    message: input.message,
    metadata: {
      level: input.level,
      ...(input.shopDomain ? { shopDomain: input.shopDomain } : {}),
      ...input.metadata,
    },
  });
}

/**
 * Record a successful cron run. Thin convenience over recordOpsEvent — same
 * never-throws guarantee, so wrapping a cron's success path with this can never
 * turn a healthy run into a failure.
 */
export async function recordCronHeartbeat(
  key: string,
  metadata?: Prisma.InputJsonValue,
): Promise<void> {
  await recordOpsEvent({ eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT, key, metadata });
}

/**
 * Latest heartbeat event for a cron, or null if it has never recorded one.
 */
export async function getLatestHeartbeat(key: string): Promise<OpsEvent | null> {
  return db.opsEvent.findFirst({
    where: { eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT, key },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Most-recent OpsEvent of a type (optionally narrowed by key), or null if none
 * exists. Used by the operator daily digest to read yesterday's `digest_snapshot`
 * row (plan-mix + MRR) before writing today's, so successive runs can diff
 * against a prior snapshot rather than against themselves.
 */
export async function getLatestOpsEvent(eventType: string, key?: string): Promise<OpsEvent | null> {
  return db.opsEvent.findFirst({
    where: { eventType, ...(key ? { key } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Count events of a type within a trailing window. Used by the daily digest to
 * count `function_failure` events over the last 24h.
 */
export async function countOpsEvents(eventType: string, sinceMs: number): Promise<number> {
  return db.opsEvent.count({
    where: { eventType, createdAt: { gte: new Date(Date.now() - sinceMs) } },
  });
}

/**
 * Tally API_ERROR events in the trailing window by their metadata.level. Used by
 * the daily digest to split GraphQL/rate-limit signals into errors vs warnings.
 *
 * Level fallback: a row whose `metadata.level` is anything other than the string
 * "warn" (missing, null, malformed, or literally "error") is counted as an
 * error. This is deliberate — an unclassifiable API_ERROR row is more useful
 * surfaced as an error than silently dropped. Volume is low (these rows only
 * exist when a genuine API error/warning fired), so an in-memory tally is fine.
 */
export async function countApiErrorsByLevel(
  sinceMs: number,
): Promise<{ error: number; warn: number }> {
  const rows = await db.opsEvent.findMany({
    where: {
      eventType: OPS_EVENT_TYPES.API_ERROR,
      createdAt: { gte: new Date(Date.now() - sinceMs) },
    },
    select: { metadata: true },
  });

  let error = 0;
  let warn = 0;
  for (const row of rows) {
    const level = (row.metadata as { level?: unknown } | null)?.level;
    if (level === "warn") {
      warn += 1;
    } else {
      error += 1;
    }
  }
  return { error, warn };
}

// ---------------------------------------------------------------------------
// Dead-man's-switch
// ---------------------------------------------------------------------------

export interface CronExpectation {
  /** Inngest function id — the heartbeat key. */
  key: string;
  /** Expected maximum gap between successful runs, in ms (the cron interval). */
  intervalMs: number;
}

export interface StaleCron {
  key: string;
  intervalMs: number;
  /** intervalMs * graceFactor — the age past which the cron is flagged. */
  thresholdMs: number;
  /** ms since the last heartbeat. */
  ageMs: number;
  lastHeartbeatAt: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// A cron is flagged only after it is this many multiples of its interval late.
// A factor of 2 tolerates Inngest scheduling jitter and post-failure retry
// backoff while still catching a scheduler that has genuinely stopped (the
// fastest cron, watch-stale-scans at 10m, is flagged within ~20m — the canary
// for a total Inngest outage such as signing-key drift).
const DEFAULT_GRACE_FACTOR = 2;

/**
 * The registry of scheduled (cron-triggered) Inngest functions and their
 * schedules. Event-triggered workers (poll-check-shop, scan-theme) are excluded
 * — they have no fixed cadence to be "late" against. Keys must match the
 * function ids passed to inngest.createFunction and the heartbeat keys written
 * by withCronHeartbeat.
 */
export const CRON_HEARTBEAT_EXPECTATIONS: CronExpectation[] = [
  { key: "watch-stale-scans", intervalMs: 10 * MINUTE_MS },
  { key: "monitor-deep-health", intervalMs: 15 * MINUTE_MS },
  { key: "monitor-scan-failures", intervalMs: 6 * HOUR_MS },
  { key: "snapshot-metrics", intervalMs: DAY_MS },
  { key: "poll-theme-changes", intervalMs: DAY_MS },
  { key: "operator-digest", intervalMs: DAY_MS },
  { key: "reconcile-installs", intervalMs: DAY_MS },
  { key: "weekly-scan", intervalMs: 7 * DAY_MS },
];

/**
 * Dead-man's-switch: return the crons whose latest heartbeat is older than
 * their interval * graceFactor.
 *
 * COLD-START SAFETY: a cron with NO recorded heartbeat is NOT flagged. Only a
 * cron that WAS heartbeating and has since gone silent counts as overdue. This
 * is deliberate — on the first deploy of this feature (and immediately after
 * any deploy that clears the table) no heartbeats exist yet, and the post-deploy
 * smoke gate hits /health/deep before any cron has run. Flagging never-seen
 * crons would false-degrade that first check and fail the deploy. The genuine
 * failure we care about (a scheduler that stops) always leaves prior heartbeats
 * behind. A cron that NEVER heartbeats (misregistered) is surfaced separately,
 * in the non-gating digest only, via getNeverSeenCrons.
 */
export async function getStaleCrons(
  expectations: CronExpectation[],
  options?: { graceFactor?: number; now?: number },
): Promise<StaleCron[]> {
  if (expectations.length === 0) return [];

  const graceFactor = options?.graceFactor ?? DEFAULT_GRACE_FACTOR;
  const now = options?.now ?? Date.now();
  const latestByKey = await getLatestHeartbeatByKey(expectations);

  const stale: StaleCron[] = [];
  for (const exp of expectations) {
    const last = latestByKey.get(exp.key);
    if (!last) continue; // cold-start safe: never-seen crons are not flagged
    const ageMs = now - last.getTime();
    const thresholdMs = exp.intervalMs * graceFactor;
    if (ageMs > thresholdMs) {
      stale.push({
        key: exp.key,
        intervalMs: exp.intervalMs,
        thresholdMs,
        ageMs,
        lastHeartbeatAt: last,
      });
    }
  }
  return stale;
}

/**
 * Crons with NO heartbeat on record at all (gc-288): the misregistered-cron case
 * (id typo, failed Inngest sync) that getStaleCrons' cold-start safety can never
 * flag. The prune always keeps each key's newest heartbeat (gc-q8g), so an
 * empty record means the cron has never succeeded: misregistered, or not run
 * YET (a cron added in the latest deploy). Because of that second case this is
 * for the NON-gating operator digest only; never wire it into /health/deep or
 * the external dead-man's-switch, or every deploy that adds a cron would fail
 * the smoke gate.
 */
export async function getNeverSeenCrons(expectations: CronExpectation[]): Promise<string[]> {
  if (expectations.length === 0) return [];
  const latestByKey = await getLatestHeartbeatByKey(expectations);
  return expectations.filter((e) => !latestByKey.has(e.key)).map((e) => e.key);
}

/** One grouped query (no N+1): max(createdAt) per key over the heartbeat rows. */
async function getLatestHeartbeatByKey(
  expectations: CronExpectation[],
): Promise<Map<string, Date>> {
  const rows = await db.opsEvent.groupBy({
    by: ["key"],
    where: {
      eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT,
      key: { in: expectations.map((e) => e.key) },
    },
    _max: { createdAt: true },
  });

  const latestByKey = new Map<string, Date>();
  for (const row of rows) {
    if (row.key && row._max.createdAt) {
      latestByKey.set(row.key, row._max.createdAt);
    }
  }
  return latestByKey;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Retention prune for the OpsEvent table (gc-06e.17).
 *
 * Deletes two independently-bounded high-volume event types and returns the
 * total number of rows deleted:
 *
 *   - `cron_heartbeat` older than `heartbeatOlderThanDays` (default 30d).
 *     Heartbeats are one per cron per run (~55k/yr, unbounded); the only consumer
 *     is the dead-man's-switch, which reads the LATEST heartbeat per key
 *     (getStaleCrons / getLatestHeartbeat). A heartbeat older than a day is
 *     already dead weight, so 30d keeps ample recent history for /health/deep
 *     while bounding table growth.
 *     EXCEPTION (gc-q8g): the NEWEST heartbeat per key is ALWAYS kept, whatever
 *     its age. Heartbeats are written only when a run SUCCEEDS, so a cron that
 *     fails every run for 30d+ would otherwise lose every heartbeat, fall out of
 *     getStaleCrons (cold-start safe: no heartbeat = not flagged), and turn
 *     /health/deep and the external dead-man's-switch GREEN for a dead cron.
 *     That surviving row is exactly the evidence the switch needs. Two bounded
 *     queries, no N+1: one groupBy for max(createdAt) per key, then the
 *     deleteMany excludes each (key, createdAt = max) pair whose max is past
 *     the cutoff. Ties (two rows sharing a key's max createdAt) are all kept,
 *     which is harmless. A null key is its own group and keeps its newest row
 *     too. (Not `findMany({ distinct })`: without the nativeDistinct preview,
 *     Prisma dedupes in memory after fetching every heartbeat row.)
 *   - `page_visit` older than `pageVisitOlderThanDays` (default 14d). Page visits
 *     are the HIGHEST-volume type — one row per authenticated navigation, wholly
 *     unbounded — and back only the operator digest's trailing per-shop activity
 *     counts (last day / last 7 days). 14d covers the digest's 7-day window plus
 *     a week of buffer for late/backfilled runs; anything older has no consumer
 *     and must be pruned or the table grows without limit.
 *   - the four nudge-funnel types (`nudge_shown`, `nudge_clicked`,
 *     `nudge_dismissed`, `nudge_converted`) older than `nudgeOlderThanDays`
 *     (default NUDGE_RETENTION_DAYS = 90d) (gc-97k.1). The digest only reads the
 *     trailing 7d, but at our install volume a funnel needs months of rows to be
 *     readable by hand, so they are kept far longer than page visits. `shown`
 *     can fire on page loads, so without a cutoff these grow unbounded.
 *
 * DELIBERATELY NARROW: this prunes ONLY `cron_heartbeat`, `page_visit` and the
 * nudge-funnel types.
 * `function_failure` rows back the operator digest's failure history and are left
 * untouched at any age. The remaining low-volume types (api_error,
 * webhook_failure, digest_snapshot, worker_fallback, scan_signal) are also left
 * alone — they don't accumulate the way heartbeats and page visits do. Widen this
 * predicate only alongside a matching per-type retention rationale.
 *
 * Each cutoff is computed from `new Date()` at call time, so each run trims
 * relative to "now". deleteMany only — no schema change.
 */
export async function pruneOpsEvents(options?: {
  heartbeatOlderThanDays?: number;
  pageVisitOlderThanDays?: number;
  nudgeOlderThanDays?: number;
}): Promise<number> {
  const heartbeatDays = options?.heartbeatOlderThanDays ?? 30;
  const pageVisitDays = options?.pageVisitOlderThanDays ?? 14;
  const nudgeDays = options?.nudgeOlderThanDays ?? NUDGE_RETENTION_DAYS;
  const now = Date.now();
  const heartbeatCutoff = new Date(now - heartbeatDays * DAY_MS);
  const pageVisitCutoff = new Date(now - pageVisitDays * DAY_MS);
  const nudgeCutoff = new Date(now - nudgeDays * DAY_MS);

  // Newest heartbeat per key. Only keys whose newest row is itself past the
  // cutoff need protecting; a recent newest row is never matched by `lt`.
  const newestByKey = await db.opsEvent.groupBy({
    by: ["key"],
    where: { eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT },
    _max: { createdAt: true },
  });
  const keepNewest = newestByKey.flatMap((row) =>
    row._max.createdAt && row._max.createdAt < heartbeatCutoff
      ? [{ key: row.key, createdAt: row._max.createdAt }]
      : [],
  );

  // One deleteMany, per-type age cutoffs. The nested OR pins each eventType to
  // its own cutoff so no other event type can ever match, regardless of age.
  const { count } = await db.opsEvent.deleteMany({
    where: {
      OR: [
        {
          eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT,
          createdAt: { lt: heartbeatCutoff },
          ...(keepNewest.length > 0 ? { NOT: { OR: keepNewest } } : {}),
        },
        { eventType: OPS_EVENT_TYPES.PAGE_VISIT, createdAt: { lt: pageVisitCutoff } },
        // One branch per nudge type, so every branch still pins a single eventType.
        ...NUDGE_FUNNEL_EVENT_TYPES.map((eventType) => ({
          eventType,
          createdAt: { lt: nudgeCutoff },
        })),
      ],
    },
  });

  return count;
}
