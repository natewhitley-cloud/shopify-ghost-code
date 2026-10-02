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
import type { BrowserFamily, ClientErrorReport } from "../lib/client-error";
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
  // A nudge the app asked the PLATFORM to show but the platform declined (so it
  // never rendered), e.g. Shopify's native review modal in its cooldown
  // (gc-97k.7). metadata = { nudgeKey, code } where code is a short allow-listed
  // reason (counts-only, no free text). Domain-keyed and listed in
  // NUDGE_FUNNEL_EVENT_TYPES, so it shares the funnel rows' redact (`key:
  // domain`) and 90-day prune coverage.
  NUDGE_NOT_SHOWN: "nudge_not_shown",
  // Browser-side error in the embedded app (gc-nn6): an uncaught error, an
  // unhandled rejection, a route ErrorBoundary render, or a failed / 4xx-5xx
  // same-origin fetch, beaconed by app/lib/client-error-reporter.ts and written
  // only via recordClientError. Keyed on the shop DOMAIN, so deleteShopData's
  // existing `key: domain` clause covers redact. message = sanitized error text;
  // metadata = { kind, path, browser, status?, stack? }, all sanitized
  // server-side (no query strings, tokens or emails). Pruned at 30 days
  // (CLIENT_ERROR_RETENTION_DAYS) and capped per shop per hour
  // (CLIENT_ERROR_HOURLY_LIMIT).
  CLIENT_ERROR: "client_error",
} as const;

/** All nudge-funnel event types, for the prune and the digest's grouped read. */
export const NUDGE_FUNNEL_EVENT_TYPES = [
  OPS_EVENT_TYPES.NUDGE_SHOWN,
  OPS_EVENT_TYPES.NUDGE_CLICKED,
  OPS_EVENT_TYPES.NUDGE_DISMISSED,
  OPS_EVENT_TYPES.NUDGE_CONVERTED,
  OPS_EVENT_TYPES.NUDGE_NOT_SHOWN,
] as const;

/** Default retention for nudge-funnel rows (see pruneOpsEvents). */
export const NUDGE_RETENTION_DAYS = 90;

/** Default retention for client_error rows (see pruneOpsEvents). */
export const CLIENT_ERROR_RETENTION_DAYS = 30;

/**
 * Max client_error rows stored per shop per trailing hour (gc-nn6). The client
 * already caps itself at 5 beacons per page load; this bounds a reload loop,
 * many open tabs, or a hand-rolled flood from an authenticated session.
 */
export const CLIENT_ERROR_HOURLY_LIMIT = 30;
const CLIENT_ERROR_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Max api_error rows stored per code (the row key) per trailing hour (gc-2sw).
 * api_error is exempt from pruning, so without this a bot storm hitting a route
 * that throws a bare Error would write unbounded, permanent rows.
 */
export const API_ERROR_HOURLY_LIMIT_PER_CODE = 30;
const API_ERROR_RATE_WINDOW_MS = 60 * 60 * 1000;

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
 * page_visit dedupe window (gc-0lo). Owner-approved semantics: a "visit" is the
 * FIRST load of a given shop + path within this window. Without it, every
 * revalidation of the parent app.tsx loader counted as a visit: the scan page
 * polls `revalidator.revalidate()` every ~3s while a scan runs (ortho-india
 * logged 25 "visits" in 75s), and every fetcher/form action (start scan,
 * dismiss a nudge, ignore/un-ignore) revalidates it too.
 */
export const PAGE_VISIT_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Record a page_visit for `domain` + `path` unless one already exists for that
 * exact pair within PAGE_VISIT_DEDUPE_WINDOW_MS. Best-effort: NEVER throws, and
 * callers fire-and-forget it (not awaited) so neither the check nor the insert
 * sits on the loader's critical path.
 *
 * `path` is the concrete pathname (e.g. /app/scans/<id>), so different scans
 * are different pages; the digest normalizes ids separately.
 *
 * Query cost: the lookup is keyed on `key` (the shop domain) + a createdAt
 * lower bound, served by the existing @@index([key, createdAt]); that narrows
 * to one shop's last-10-minute rows (a handful), and eventType + the JSON
 * metadata.path equality filter run on that tiny set. No new index needed.
 *
 * Race: check-then-insert is not atomic, so two truly simultaneous first loads
 * of the same path could both record. Acceptable for telemetry; the poll is
 * sequential (~3s apart) and never races itself.
 *
 * On a dedupe-query failure we log and RECORD anyway (fail-open): a real visit
 * is never silently dropped, and the worst case is the pre-gc-0lo over-count,
 * a known and visible state. If the DB is actually down, the insert fails too
 * and recordOpsEvent swallows it, so failing open adds no new failure mode.
 */
export async function recordPageVisit(domain: string, path: string): Promise<void> {
  try {
    const recent = await db.opsEvent.findFirst({
      where: {
        key: domain,
        eventType: OPS_EVENT_TYPES.PAGE_VISIT,
        createdAt: { gte: new Date(Date.now() - PAGE_VISIT_DEDUPE_WINDOW_MS) },
        metadata: { path: ["path"], equals: path },
      },
      select: { id: true },
    });
    if (recent) return;
  } catch (error) {
    logger.warn("page-visit-dedupe-failed", {
      key: domain,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.PAGE_VISIT,
    key: domain,
    metadata: { path },
  });
}

/**
 * Record a webhook that FAILED (its handler threw after HMAC auth). Thin
 * convenience over recordOpsEvent — same never-throws guarantee, so wrapping a
 * webhook body with this and re-throwing preserves Shopify's retry behavior
 * while making the failure durably countable for the daily digest.
 *
 * `degradedReason` marks a webhook that was still HANDLED (200) but in a
 * degraded way, e.g. its offline session could not be loaded/refreshed
 * (gc-4hk). Stored as metadata `{ degraded: true, reason }` beside `shop`, so
 * the same type, redact clause (metadata.shop) and digest count cover it.
 */
export async function recordWebhookFailure(input: {
  topic: string;
  shop: string;
  error: unknown;
  degradedReason?: string;
}): Promise<void> {
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.WEBHOOK_FAILURE,
    key: input.topic,
    message: input.error instanceof Error ? input.error.message : String(input.error),
    metadata: input.degradedReason
      ? { shop: input.shop, degraded: true, reason: input.degradedReason }
      : { shop: input.shop },
  });
}

/**
 * Record a browser-side error report for `domain` (gc-nn6), unless the shop
 * already has CLIENT_ERROR_HOURLY_LIMIT rows in the trailing hour. `report`
 * must already be sanitized (routes/app.client-error.tsx runs
 * sanitizeClientErrorReport on the untrusted body). Returns whether the row
 * was written (or attempted); NEVER throws.
 *
 * The limit check is one count on (key, createdAt), served by the existing
 * @@index([key, createdAt]); eventType filters that one shop's last-hour rows.
 * Check-then-insert is not atomic, so concurrent beacons can overshoot by a
 * few rows; fine for a volume bound. Unlike recordPageVisit this FAILS CLOSED:
 * the input is browser-supplied, so when the limit cannot be checked the
 * report is dropped rather than risk an unbounded write.
 */
export async function recordClientError(
  domain: string,
  report: ClientErrorReport & { browser: BrowserFamily },
): Promise<boolean> {
  try {
    const recent = await db.opsEvent.count({
      where: {
        key: domain,
        eventType: OPS_EVENT_TYPES.CLIENT_ERROR,
        createdAt: { gte: new Date(Date.now() - CLIENT_ERROR_RATE_WINDOW_MS) },
      },
    });
    if (recent >= CLIENT_ERROR_HOURLY_LIMIT) return false;
  } catch (error) {
    logger.warn("client-error-rate-check-failed", {
      key: domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.CLIENT_ERROR,
    key: domain,
    message: report.message,
    metadata: {
      kind: report.kind,
      path: report.path,
      browser: report.browser,
      ...(report.status !== undefined ? { status: report.status } : {}),
      ...(report.stack !== undefined ? { stack: report.stack } : {}),
    },
  });
  return true;
}

/**
 * Record a GraphQL / rate-limit API error or warning. Thin convenience over
 * recordOpsEvent — same never-throws guarantee. `level` distinguishes a genuine
 * error from a proximity warning; it is stored in metadata so the digest can
 * tally the two independently (see countApiErrorsByLevel).
 *
 * Capped at API_ERROR_HOURLY_LIMIT_PER_CODE rows per code per trailing hour
 * (gc-2sw); at the cap the write is skipped silently (logging each drop would
 * itself flood logs). The digest's per-code count therefore saturates at the
 * cap. Check-then-insert is not atomic, so concurrent errors can overshoot by
 * a few rows; fine for a volume bound. Unlike recordClientError this FAILS
 * OPEN: an error recorder must not drop real errors because the count failed.
 */
export async function recordApiError(input: {
  level: "error" | "warn";
  code: string;
  shopDomain?: string;
  message: string;
  metadata?: Record<string, string | number>;
}): Promise<void> {
  try {
    const recent = await db.opsEvent.count({
      where: {
        key: input.code,
        eventType: OPS_EVENT_TYPES.API_ERROR,
        createdAt: { gte: new Date(Date.now() - API_ERROR_RATE_WINDOW_MS) },
      },
    });
    if (recent >= API_ERROR_HOURLY_LIMIT_PER_CODE) return;
  } catch {
    // Fail open: fall through and attempt the write.
  }

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
 * The `metadata` of every event of a type in a trailing window. Shared by the
 * digest's in-memory metadata tallies (API errors by level, webhook failures by
 * degraded flag); volume is low for both, so fetching only `metadata` is fine.
 */
async function findOpsEventMetadataSince(eventType: string, sinceMs: number): Promise<unknown[]> {
  const rows = await db.opsEvent.findMany({
    where: { eventType, createdAt: { gte: new Date(Date.now() - sinceMs) } },
    select: { metadata: true },
  });
  return rows.map((row) => row.metadata);
}

/**
 * Tally API_ERROR events in the trailing window by their metadata.level. Used by
 * the daily digest to split GraphQL/rate-limit signals into errors vs warnings.
 *
 * Level fallback: a row whose `metadata.level` is anything other than the string
 * "warn" (missing, null, malformed, or literally "error") is counted as an
 * error. This is deliberate — an unclassifiable API_ERROR row is more useful
 * surfaced as an error than silently dropped. Volume is bounded (recordApiError caps
 * rows at API_ERROR_HOURLY_LIMIT_PER_CODE per code per hour), so an in-memory tally
 * is fine.
 */
export async function countApiErrorsByLevel(
  sinceMs: number,
): Promise<{ error: number; warn: number }> {
  const metadatas = await findOpsEventMetadataSince(OPS_EVENT_TYPES.API_ERROR, sinceMs);

  let error = 0;
  let warn = 0;
  for (const metadata of metadatas) {
    const level = (metadata as { level?: unknown } | null)?.level;
    if (level === "warn") {
      warn += 1;
    } else {
      error += 1;
    }
  }
  return { error, warn };
}

/**
 * Tally WEBHOOK_FAILURE events in the trailing window into real failures vs
 * degraded-but-handled rows (`metadata.degraded === true`, written by
 * recordWebhookFailure's `degradedReason`, gc-4hk). Used by the daily digest so
 * a handled-but-degraded webhook (200 returned) is not reported as a failure.
 *
 * Fallback: only a literal `degraded: true` counts as degraded; anything else
 * (missing, null, malformed metadata) is a real failure, since an
 * unclassifiable row is more useful surfaced than hidden.
 */
export async function countWebhookFailuresByKind(
  sinceMs: number,
): Promise<{ failed: number; degraded: number }> {
  const metadatas = await findOpsEventMetadataSince(OPS_EVENT_TYPES.WEBHOOK_FAILURE, sinceMs);

  let failed = 0;
  let degraded = 0;
  for (const metadata of metadatas) {
    if ((metadata as { degraded?: unknown } | null)?.degraded === true) {
      degraded += 1;
    } else {
      failed += 1;
    }
  }
  return { failed, degraded };
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
 *   - `client_error` older than `clientErrorOlderThanDays` (default
 *     CLIENT_ERROR_RETENTION_DAYS = 30d) (gc-nn6). Browser error reports back
 *     the digest's trailing-24h line and ad-hoc investigation of a recent
 *     uninstall; a month covers both, and the rows (stack frames included) are
 *     the most verbose per-shop telemetry we keep, so they go first.
 *
 * DELIBERATELY NARROW: this prunes ONLY `cron_heartbeat`, `page_visit`,
 * `client_error` and the nudge-funnel types.
 * `function_failure` rows back the operator digest's failure history and are left
 * untouched at any age. The remaining types (api_error, which recordApiError
 * caps per code per hour; webhook_failure, digest_snapshot, worker_fallback,
 * scan_signal) are also left alone — they don't accumulate the way heartbeats and page visits do. Widen this
 * predicate only alongside a matching per-type retention rationale.
 *
 * Each cutoff is computed from `new Date()` at call time, so each run trims
 * relative to "now". deleteMany only — no schema change.
 */
export async function pruneOpsEvents(options?: {
  heartbeatOlderThanDays?: number;
  pageVisitOlderThanDays?: number;
  nudgeOlderThanDays?: number;
  clientErrorOlderThanDays?: number;
}): Promise<number> {
  const heartbeatDays = options?.heartbeatOlderThanDays ?? 30;
  const pageVisitDays = options?.pageVisitOlderThanDays ?? 14;
  const nudgeDays = options?.nudgeOlderThanDays ?? NUDGE_RETENTION_DAYS;
  const clientErrorDays = options?.clientErrorOlderThanDays ?? CLIENT_ERROR_RETENTION_DAYS;
  const now = Date.now();
  const heartbeatCutoff = new Date(now - heartbeatDays * DAY_MS);
  const pageVisitCutoff = new Date(now - pageVisitDays * DAY_MS);
  const nudgeCutoff = new Date(now - nudgeDays * DAY_MS);
  const clientErrorCutoff = new Date(now - clientErrorDays * DAY_MS);

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
        { eventType: OPS_EVENT_TYPES.CLIENT_ERROR, createdAt: { lt: clientErrorCutoff } },
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
