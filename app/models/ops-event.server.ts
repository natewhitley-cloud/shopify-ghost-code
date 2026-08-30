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
} as const;

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
  { key: "monitor-scan-failures", intervalMs: 6 * HOUR_MS },
  { key: "snapshot-metrics", intervalMs: DAY_MS },
  { key: "poll-theme-changes", intervalMs: DAY_MS },
  { key: "operator-digest", intervalMs: DAY_MS },
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
 * behind, so this loses no real signal.
 *
 * One grouped query (no N+1): max(createdAt) per key over the heartbeat rows.
 */
export async function getStaleCrons(
  expectations: CronExpectation[],
  options?: { graceFactor?: number; now?: number },
): Promise<StaleCron[]> {
  if (expectations.length === 0) return [];

  const graceFactor = options?.graceFactor ?? DEFAULT_GRACE_FACTOR;
  const now = options?.now ?? Date.now();
  const keys = expectations.map((e) => e.key);

  const rows = await db.opsEvent.groupBy({
    by: ["key"],
    where: { eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT, key: { in: keys } },
    _max: { createdAt: true },
  });

  const latestByKey = new Map<string, Date>();
  for (const row of rows) {
    if (row.key && row._max.createdAt) {
      latestByKey.set(row.key, row._max.createdAt);
    }
  }

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
