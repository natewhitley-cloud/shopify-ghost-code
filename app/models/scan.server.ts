import { Prisma, ScanOrigin, ScanStatus } from "@prisma/client";

import db from "../db.server";
import { logger } from "../lib/logger.server";
import { SCAN_SOURCES } from "../lib/scan-source";
import type { ScanRequestSource } from "../lib/scan-source";

/**
 * Terminal statuses that represent a successful, usable scan.
 *
 * PARTIAL is included alongside COMPLETED everywhere a scan is treated as
 * "succeeded and usable": quota counting, onboarding eligibility, the dashboard
 * trend chart, and the diff baseline. A PARTIAL scan ran the core theme audit
 * successfully; it merely skipped one or more optional categories whose scope
 * was not granted (see ScanStatus enum / LOG-4).
 */
export const SUCCESSFUL_SCAN_STATUSES = [ScanStatus.COMPLETED, ScanStatus.PARTIAL] as const;

/**
 * Quota limits to enforce atomically inside the createScan transaction.
 * When provided, the transaction counts qualifying scans in the relevant
 * period and rejects if the quota is exceeded — closing the TOCTOU gap
 * between the advisory canStartScan check and actual scan creation.
 *
 * Pass `null` for plans with no quota (Professional / unlimited).
 */
export type ScanQuota = {
  /** Start of the billing period (month start for Free, week start for Standard). */
  periodStart: Date;
  /** Maximum scans allowed in the period. */
  maxScans: number;
  /** Human-readable period name for error messages. */
  periodLabel: "week" | "month";
  /** Whether this is the shop's first-ever scan (bypasses quota on Free plan). */
  isFirstScan: boolean;
} | null;

/**
 * Create a new scan record in PENDING status.
 * The scan engine will transition it to IN_PROGRESS then COMPLETED/FAILED.
 *
 * Atomic TOCTOU guard: the check for an existing active scan, the quota
 * check, and the create are all wrapped in a single transaction. This
 * prevents two concurrent requests from both passing a pre-flight
 * canStartScan check and both creating scans.
 *
 * Throws an Error with message "A scan is already in progress for this shop."
 * when a PENDING or IN_PROGRESS scan already exists. Callers should catch this
 * to surface a user-friendly message.
 *
 * `origin` records which surface initiated the scan and drives the manual-quota
 * exemption (GC-iji). Only MANUAL (merchant-initiated) scans count toward the
 * quota; SCHEDULED (cron) and AUTO_PUBLISH (theme-publish auto-rescan) scans are
 * exempt, so a scheduled or auto scan can never block a merchant's own manual
 * scan. Defaults to MANUAL for callers (and legacy behaviour) that do not
 * specify an origin.
 *
 * Telemetry (operator digest only, never gating):
 * - `requestedFrom` is the page a MANUAL scan was started from. Stored only for
 *   MANUAL scans ("unknown" when the caller passes none); always null for
 *   SCHEDULED / AUTO_PUBLISH.
 * - `shopScanNumber` is 1 + the shop's existing scans of EVERY origin and
 *   status, counted inside this transaction AFTER the active-scan guard, so a
 *   rejected request never counts and numbers follow creation order. It shares
 *   the guard's isolation: only the same concurrent-create race the guard
 *   itself does not close (READ COMMITTED) could produce a duplicate number.
 */
export async function createScan(
  shopId: string,
  themeId: string,
  themeName: string,
  origin: ScanOrigin = ScanOrigin.MANUAL,
  quota?: ScanQuota,
  requestedFrom?: ScanRequestSource,
) {
  return db.$transaction(async (tx) => {
    const activeScan = await tx.scan.findFirst({
      where: { shopId, status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] } },
      select: { id: true },
    });
    if (activeScan) {
      throw new Error("A scan is already in progress for this shop.");
    }

    // Enforce quota atomically when provided. Only MANUAL scans consume the
    // quota (GC-iji): the count is scoped to origin=MANUAL so a SCHEDULED or
    // AUTO_PUBLISH scan created earlier in the period does not count against the
    // merchant's manual allowance.
    if (quota && !quota.isFirstScan && quota.maxScans !== Infinity) {
      const usedInPeriod = await tx.scan.count({
        where: {
          shopId,
          origin: ScanOrigin.MANUAL,
          createdAt: { gte: quota.periodStart },
          status: { in: [...SUCCESSFUL_SCAN_STATUSES, ScanStatus.IN_PROGRESS] },
        },
      });
      if (usedInPeriod >= quota.maxScans) {
        throw new Error(
          `Scan limit reached: ${usedInPeriod} of ${quota.maxScans} scans used this ${quota.periodLabel}.`,
        );
      }
    }

    const existingScans = await tx.scan.count({ where: { shopId } });

    return tx.scan.create({
      data: {
        shopId,
        themeId,
        themeName,
        origin,
        requestedFrom:
          origin === ScanOrigin.MANUAL ? (requestedFrom ?? SCAN_SOURCES.UNKNOWN) : null,
        shopScanNumber: existingScans + 1,
      },
    });
  });
}

/** Page that rendered a scan's results (telemetry only). */
export type ScanResultsPage = "home" | "scan_page";

/** The per-scan "first results view" stamp column for each page. */
export const SCAN_VIEW_COLUMNS = {
  home: "viewedOnHomeAt",
  scan_page: "viewedOnScanPageAt",
} as const satisfies Record<ScanResultsPage, keyof Prisma.ScanWhereInput>;

/**
 * Atomically stamp the first time `page` rendered this scan's results.
 *
 * A conditional updateMany (`where id AND shopId AND <column> IS NULL`, the
 * shop scope as defense in depth) writes now() only
 * if the column is still unset, so of any number of concurrent loads exactly
 * one sees count === 1 and a later load never moves the timestamp. Returns true
 * IFF this call made the stamp. A missing scan row is a safe false.
 */
export async function claimScanViewStamp(
  scanId: string,
  shopId: string,
  page: ScanResultsPage,
): Promise<boolean> {
  const column = SCAN_VIEW_COLUMNS[page];
  const where: Prisma.ScanWhereInput = { id: scanId, shopId, [column]: null };
  const { count } = await db.scan.updateMany({ where, data: { [column]: new Date() } });
  return count === 1;
}

/**
 * Fetch a single scan by ID.
 *
 * Pass `includeFindings: true` (the default) to eager-load the findings
 * relation. Pass `false` when you know you do not need the findings rows
 * (e.g. free-tier shops that cannot view finding details) — this skips the
 * JOIN entirely and avoids an unnecessary DB round-trip.
 *
 * Returns null when the scan does not exist.
 */
export async function getScanById(scanId: string, options?: { includeFindings?: boolean }) {
  const includeFindings = options?.includeFindings ?? true;
  return db.scan.findUnique({
    where: { id: scanId },
    ...(includeFindings ? { include: { findings: true } } : {}),
  });
}

/**
 * Return scans for a shop, ordered newest-first.
 * Only the denormalised findingCount is included here — use getScanById
 * to fetch actual finding rows.
 *
 * Supports cursor-based pagination:
 * - Pass `limit` to cap the number of results returned.
 * - Pass `cursor` (a scan ID) to fetch the page after that record.
 *
 * Returns `{ items, hasNextPage }` so callers do not need to know about
 * the limit+1 over-fetch trick. When `limit` is not provided, `hasNextPage`
 * is always false and `items` contains all scans for the shop.
 */
export async function getScansForShop(
  shopId: string,
  options?: { limit?: number; cursor?: string; theme?: string; status?: string },
): Promise<{ items: Awaited<ReturnType<typeof db.scan.findMany>>; hasNextPage: boolean }> {
  const { limit, cursor, theme, status } = options ?? {};

  const rows = await db.scan.findMany({
    where: {
      shopId,
      ...(theme ? { themeName: theme } : {}),
      ...(status ? { status: status as ScanStatus } : {}),
    },
    orderBy: { createdAt: "desc" },
    ...(limit !== undefined ? { take: limit + 1 } : {}),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  if (limit === undefined) {
    return { items: rows, hasNextPage: false };
  }

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  return { items, hasNextPage };
}

/**
 * Return the distinct theme names this shop has ever scanned, sorted A→Z.
 *
 * Powers the Theme filter dropdown on the scan-history page. Derived from ALL
 * of the shop's scans (unfiltered), so the dropdown always offers every theme
 * the shop has scanned even while a filter is narrowing the visible list — and
 * a non-empty result also tells the UI the shop has at least one scan.
 */
export async function getDistinctThemesForShop(shopId: string): Promise<string[]> {
  const rows = await db.scan.findMany({
    where: { shopId },
    distinct: ["themeName"],
    select: { themeName: true },
    orderBy: { themeName: "asc" },
  });
  return rows.map((row) => row.themeName);
}

/**
 * True when the shop has at least one scan of ANY status (pending, running,
 * failed, or finished). Drives the "Run your first scan" empty-state CTA
 * (gc-vg4), which must disappear once any scan exists. A single indexed
 * findFirst on shopId, selecting only the id.
 */
export async function hasAnyScans(shopId: string): Promise<boolean> {
  const row = await db.scan.findFirst({ where: { shopId }, select: { id: true } });
  return row !== null;
}

/** True for terminal statuses where completedAt should be stamped. */
function isTerminalStatus(status: ScanStatus): boolean {
  return (
    status === ScanStatus.COMPLETED || status === ScanStatus.PARTIAL || status === ScanStatus.FAILED
  );
}

/**
 * Transition a scan's status.  Automatically sets:
 *   - startedAt when moving to IN_PROGRESS
 *   - completedAt when moving to a terminal status (COMPLETED, PARTIAL, FAILED)
 *
 * Optionally updates findingCount so the two writes are a single round-trip.
 */
export async function updateScanStatus(scanId: string, status: ScanStatus, findingCount?: number) {
  const now = new Date();
  const timestampFields =
    status === ScanStatus.IN_PROGRESS
      ? { startedAt: now }
      : isTerminalStatus(status)
        ? { completedAt: now }
        : {};

  return db.scan.update({
    where: { id: scanId },
    data: {
      status,
      ...timestampFields,
      ...(findingCount !== undefined ? { findingCount } : {}),
    },
  });
}

/**
 * Outcome of a markScanStarted call.
 *
 * `started` is true when this call moved the scan PENDING -> IN_PROGRESS. When
 * false, `status` is the scan's current status (null if the row is missing).
 */
export type MarkScanStartedResult =
  | { started: true }
  | { started: false; status: ScanStatus | null };

/**
 * Move a scan PENDING -> IN_PROGRESS (stamping startedAt), and ONLY from PENDING
 * (gc-i3vk). scan-theme may pick a scan up long after dispatch (concurrency
 * backlog); in the meantime check-scan-stale may already have failed it. An
 * unconditional updateScanStatus(IN_PROGRESS) would revive that FAILED scan and,
 * if it then hung, nothing would re-check it until the daily sweep.
 *
 * Atomic conditional `updateMany` (where status = PENDING), the same race-safe
 * pattern as finalizeScan's resurrection guard: no read-then-write window. When
 * zero rows match we do NOT throw (a throw would trigger Inngest retries that can
 * never succeed); the current status is read purely so the caller can log it.
 */
export async function markScanStarted(scanId: string): Promise<MarkScanStartedResult> {
  const result = await db.scan.updateMany({
    where: { id: scanId, status: ScanStatus.PENDING },
    data: { status: ScanStatus.IN_PROGRESS, startedAt: new Date() },
  });
  if (result.count === 1) return { started: true };

  const current = await db.scan.findUnique({ where: { id: scanId }, select: { status: true } });
  return { started: false, status: current?.status ?? null };
}

/**
 * Outcome of a finalizeScan call.
 *
 * `finalized` is true when this call actually transitioned the scan to its
 * terminal success status. It is false when the resurrection guard blocked the
 * write because the scan was no longer IN_PROGRESS (see finalizeScan docs).
 */
export type FinalizeScanResult = { finalized: boolean };

/**
 * Mark a scan with its final, terminal status after ALL audit steps have run
 * (LOG-4). This is the single point at which a scan becomes COMPLETED or
 * PARTIAL — the core theme step (saveThemeFindings) deliberately leaves it
 * IN_PROGRESS so a late audit failure can still mark it FAILED.
 *
 * Decides nothing itself: the caller (the scan-theme finalize step) passes the
 * already-decided status, the authoritative findingCount, the set of optional
 * categories that were skipped for missing scope, the set that ran but hit a
 * size cap (gc-11f), and the theme files skipped for exceeding the size cap.
 * skippedCategories, cappedCategories, and skippedFiles are persisted so the
 * diff engine never treats an un-audited (or partly audited) category's — or
 * an unscanned oversized file's — prior findings as "resolved".
 *
 * Resurrection guard (LOG-6, #2-A): the stale check (check-scan-stale) can mark a
 * still-running scan FAILED if it overruns the in-progress threshold. Without a
 * guard, this worker would later blindly UPDATE that row back to COMPLETED/
 * PARTIAL — silently resurrecting a terminal scan and producing out-of-order
 * history alongside whatever replacement scan was started in the meantime. To
 * prevent this we transition ONLY rows still in IN_PROGRESS, using a conditional
 * `updateMany` (where status = IN_PROGRESS) and checking the affected count.
 * This is race-safe: of two concurrent finalizers (or a finalizer racing the
 * watchdog), at most one updateMany matches the IN_PROGRESS row, so only one can
 * win — no read-then-write TOCTOU window.
 *
 * When the guard blocks the write (zero rows affected), we do NOT throw: a throw
 * inside the Inngest finalize step would trigger confusing retries that can
 * never succeed (the scan is already terminal). Instead we log a clear warning
 * and return `{ finalized: false }` so the caller can proceed without a retry
 * storm. The happy path (an IN_PROGRESS scan) is unaffected and returns
 * `{ finalized: true }`.
 *
 * Idempotent: a no-op on an Inngest retry that already finalized the scan (the
 * row is no longer IN_PROGRESS), reported via `finalized: false`.
 */
export async function finalizeScan(
  scanId: string,
  args: {
    status: typeof ScanStatus.COMPLETED | typeof ScanStatus.PARTIAL;
    findingCount: number;
    skippedCategories: string[];
    cappedCategories: string[];
    skippedFiles: string[];
    // Resolution-tracking counts (Feature 3 of the scan-observability spec),
    // computed by the caller via the scan differ. All three are OPTIONAL and
    // written only when supplied, so callers that do not compute a diff (and the
    // existing tests) leave the columns at their `@default(0)` and are unaffected.
    newFindingCount?: number;
    resolvedFindingCount?: number;
    persistedFindingCount?: number;
    // FindingTypes live for this scan (gc-rvo0); written only when supplied.
    liveFindingTypes?: string[];
    // Categories whose check could not run because the public storefront was
    // unreadable (SCRIPT_TAG_SUNSET); written only when supplied (default []).
    unreachableCategories?: string[];
    // { [appName]: signature fingerprint } for app-removal detection (gc-frda);
    // written only when supplied (NULL = never recorded).
    appSignatureFingerprints?: Record<string, string>;
    // Apps with a live hook per source (gc-frda); written only when supplied.
    liveAppHooks?: { embedApps: string[] | null; scriptTagApps: string[] | null };
  },
): Promise<FinalizeScanResult> {
  const result = await db.scan.updateMany({
    // Conditional write: only an IN_PROGRESS scan may be finalized. A scan the
    // watchdog already marked FAILED (or a concurrent finalizer already moved to
    // COMPLETED/PARTIAL) will not match, so it cannot be resurrected.
    where: { id: scanId, status: ScanStatus.IN_PROGRESS },
    data: {
      status: args.status,
      completedAt: new Date(),
      findingCount: args.findingCount,
      skippedCategories: args.skippedCategories,
      cappedCategories: args.cappedCategories,
      skippedFiles: args.skippedFiles,
      ...(args.newFindingCount !== undefined ? { newFindingCount: args.newFindingCount } : {}),
      ...(args.resolvedFindingCount !== undefined
        ? { resolvedFindingCount: args.resolvedFindingCount }
        : {}),
      ...(args.persistedFindingCount !== undefined
        ? { persistedFindingCount: args.persistedFindingCount }
        : {}),
      ...(args.liveFindingTypes !== undefined ? { liveFindingTypes: args.liveFindingTypes } : {}),
      ...(args.unreachableCategories !== undefined
        ? { unreachableCategories: args.unreachableCategories }
        : {}),
      ...(args.appSignatureFingerprints !== undefined
        ? { appSignatureFingerprints: args.appSignatureFingerprints }
        : {}),
      ...(args.liveAppHooks !== undefined ? { liveAppHooks: args.liveAppHooks } : {}),
    },
  });

  if (result.count === 0) {
    // Read the current status purely to make the log actionable (this path is
    // rare and off the hot path; it is not part of the race-safe write).
    const current = await db.scan.findUnique({
      where: { id: scanId },
      select: { status: true },
    });
    logger.warn("finalizeScan skipped: scan was no longer IN_PROGRESS", {
      function: "finalizeScan",
      scanId,
      attemptedStatus: args.status,
      currentStatus: current?.status ?? "MISSING",
    });
    return { finalized: false };
  }

  return { finalized: true };
}

/**
 * Return the most recent successful scan for a given shop + theme that was
 * created BEFORE `beforeDate`.  Used by the diff engine to find the scan
 * that immediately preceded the current one.
 *
 * PARTIAL scans qualify as baselines: a PARTIAL scan is a legitimate prior
 * state for every category it DID audit. The differ separately filters out the
 * categories the *current* scan skipped, so a category missing from a PARTIAL
 * baseline simply yields no prior findings (never a false "resolved").
 *
 * Returns null when no qualifying prior scan exists.
 */
export async function getPreviousScanForTheme(shopId: string, themeId: string, beforeDate: Date) {
  return db.scan.findFirst({
    where: {
      shopId,
      themeId,
      status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
      createdAt: { lt: beforeDate },
    },
    orderBy: { createdAt: "desc" },
    include: { findings: true },
  });
}

/**
 * Count scans created at or after `since` for a given shop.
 * Used by plan-gating to enforce per-month scan limits on the free tier.
 *
 * Only successful (COMPLETED / PARTIAL) and IN_PROGRESS scans count toward the
 * quota. FAILED and PENDING scans are excluded so merchants are not penalised
 * for infrastructure failures or scans that never ran.
 *
 * Only MANUAL (merchant-initiated) scans count (GC-iji): SCHEDULED (cron) and
 * AUTO_PUBLISH (theme-publish auto-rescan) scans are exempt from the manual
 * quota, mirroring the atomic count inside createScan.
 */
export async function countScansForShopSince(shopId: string, since: Date): Promise<number> {
  return db.scan.count({
    where: {
      shopId,
      origin: ScanOrigin.MANUAL,
      createdAt: { gte: since },
      status: { in: [...SUCCESSFUL_SCAN_STATUSES, ScanStatus.IN_PROGRESS] },
    },
  });
}

/**
 * Per-status staleness thresholds for the stale-scan checks (LOG-6, #2-A).
 *
 * PENDING and IN_PROGRESS are aged off DIFFERENT clocks:
 *   - A PENDING scan has never started, so it is aged from `createdAt`. If it
 *     has not been picked up within `pendingMaxAgeMinutes` it is genuinely stuck.
 *   - An IN_PROGRESS scan is aged from `startedAt`, NOT `createdAt`. A legitimate
 *     long scan (rate-limit sleeps in theme-fetcher + Inngest retry backoff) can
 *     sit far past `createdAt + pendingMaxAgeMinutes` while still healthy. Aging
 *     it from `startedAt` with a longer `inProgressMaxAgeMinutes` stops the
 *     watchdog from falsely FAILing a job that is still running (the LOG-6 bug).
 */
export type StaleScanThresholds = {
  pendingMaxAgeMinutes: number;
  inProgressMaxAgeMinutes: number;
};

/**
 * Default staleness thresholds shared by every caller that expires stale scans
 * (the per-scan check-scan-stale function and the daily poll-theme-changes sweep) so the
 * cutoffs stay defined in exactly one place.
 *
 * - pendingMaxAgeMinutes (15): a scan that never started within 15 minutes is
 *   genuinely stuck in the queue.
 * - inProgressMaxAgeMinutes (30): aged from startedAt; long enough to tolerate
 *   rate-limit sleeps plus Inngest retry backoff on a healthy long-running scan,
 *   short enough to unblock a shop within a reasonable window when a worker
 *   crashed mid-scan.
 */
export const DEFAULT_STALE_SCAN_THRESHOLDS: StaleScanThresholds = {
  pendingMaxAgeMinutes: 15,
  inProgressMaxAgeMinutes: 30,
};

/**
 * Build the Prisma `where` predicate identifying stale scans, shared by both the
 * UPDATE in `expireStaleScans` and `expireStaleScan` (single scan) so every
 * caller agrees on what stale means (DRY).
 *
 * The predicate is an OR of two status-specific branches:
 *   - PENDING:     createdAt older than the pending cutoff.
 *   - IN_PROGRESS: startedAt older than the in-progress cutoff. If `startedAt`
 *     is somehow null on an IN_PROGRESS row (it should always be set by
 *     updateScanStatus, but the column is nullable), fall back to `createdAt` so
 *     the row can still eventually be expired rather than getting stuck forever.
 */
export function buildStaleScanWhere(thresholds: StaleScanThresholds): Prisma.ScanWhereInput {
  const now = Date.now();
  const pendingCutoff = new Date(now - thresholds.pendingMaxAgeMinutes * 60 * 1000);
  const inProgressCutoff = new Date(now - thresholds.inProgressMaxAgeMinutes * 60 * 1000);

  return {
    OR: [
      {
        status: ScanStatus.PENDING,
        createdAt: { lt: pendingCutoff },
      },
      {
        status: ScanStatus.IN_PROGRESS,
        OR: [
          { startedAt: { lt: inProgressCutoff } },
          // Defensive fallback for an IN_PROGRESS row with no startedAt.
          { startedAt: null, createdAt: { lt: inProgressCutoff } },
        ],
      },
    ],
  };
}

/**
 * Mark stale scans as FAILED using per-status thresholds (LOG-6, #2-A).
 *
 * A scan is "stale" when it matches `buildStaleScanWhere`: a PENDING scan older
 * than `pendingMaxAgeMinutes` (aged from createdAt) or an IN_PROGRESS scan older
 * than `inProgressMaxAgeMinutes` (aged from startedAt, with a createdAt
 * fallback). This is called by the daily poll-theme-changes sweep so that shops whose scan jobs
 * crashed or timed out are unblocked, without falsely failing legitimately
 * long-running scans.
 *
 * Returns the number of scans cleaned up.
 */
export async function expireStaleScans(thresholds: StaleScanThresholds): Promise<number> {
  const result = await db.scan.updateMany({
    where: buildStaleScanWhere(thresholds),
    data: {
      status: ScanStatus.FAILED,
      completedAt: new Date(),
    },
  });
  return result.count;
}

/**
 * Single-scan variant of expireStaleScans (gc-ngx6): the same shared predicate
 * (buildStaleScanWhere), AND-ed with the scan id. Used by the per-scan delayed
 * check-scan-stale function. Never touches any other scan.
 *
 * Returns whether the scan was expired plus its current state, so the caller can
 * decide whether a still-running (IN_PROGRESS, not yet stale) scan needs another
 * check later. `status` is null if the scan no longer exists.
 */
export async function expireStaleScan(
  scanId: string,
  thresholds: StaleScanThresholds,
): Promise<{
  expired: boolean;
  status: ScanStatus | null;
  startedAt: Date | null;
  createdAt: Date | null;
}> {
  const result = await db.scan.updateMany({
    where: { AND: [{ id: scanId }, buildStaleScanWhere(thresholds)] },
    data: { status: ScanStatus.FAILED, completedAt: new Date() },
  });
  if (result.count > 0) {
    return { expired: true, status: ScanStatus.FAILED, startedAt: null, createdAt: null };
  }
  const scan = await db.scan.findUnique({
    where: { id: scanId },
    select: { status: true, startedAt: true, createdAt: true },
  });
  return {
    expired: false,
    status: scan?.status ?? null,
    startedAt: scan?.startedAt ?? null,
    createdAt: scan?.createdAt ?? null,
  };
}

/**
 * Return true if the shop has at least one successful (COMPLETED or PARTIAL)
 * scan ever. Used by plan-gating to detect first-time scanners who are eligible
 * for the free onboarding scan regardless of the monthly quota. A PARTIAL scan
 * still delivered a usable result, so it disqualifies the shop from a second
 * "first scan".
 */
export async function hasCompletedScans(shopId: string): Promise<boolean> {
  const count = await db.scan.count({
    where: { shopId, status: { in: [...SUCCESSFUL_SCAN_STATUSES] } },
  });
  return count > 0;
}

/**
 * completedAt of the shop's FIRST successful (COMPLETED or PARTIAL) scan, or
 * null when it has none. Failed, pending and in-progress scans never count.
 * Drives the feedback nudge's "came back on a later day" gate (gc-97k.3).
 */
export async function getFirstSuccessfulScanCompletedAt(shopId: string): Promise<Date | null> {
  const row = await db.scan.findFirst({
    where: {
      shopId,
      status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
      completedAt: { not: null },
    },
    orderBy: { completedAt: "asc" },
    select: { completedAt: true },
  });
  return row?.completedAt ?? null;
}

/**
 * Non-malicious finding count of the shop's LATEST successful (COMPLETED or
 * PARTIAL) scan, or null when it has none: ONE indexed query (the latest scan
 * plus a filtered relation _count over Finding's scanId index), no finding rows
 * loaded. Drives the return banner's "latest results have hidden findings"
 * rule (gc-97k.9, app/lib/upgrade-return.ts). MALICIOUS_SCRIPT is excluded
 * because it is never paywalled; ignores are not subtracted (see
 * UpgradeReturnState.latestScanNonMaliciousCount).
 */
export async function getLatestSuccessfulScanNonMaliciousCount(
  shopId: string,
): Promise<number | null> {
  const row = await db.scan.findFirst({
    where: {
      shopId,
      status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    select: {
      _count: { select: { findings: { where: { findingType: { not: "MALICIOUS_SCRIPT" } } } } },
    },
  });
  return row === null ? null : row._count.findings;
}

/**
 * Fetch the N most recent successful (COMPLETED or PARTIAL) scans for a shop,
 * newest first. Used by the dashboard trend chart — only returns successful
 * scans since in-progress/failed scans have no health score. PARTIAL scans have
 * a real health score for the categories they audited, so they belong on the
 * trend.
 *
 * `completedAt` is non-null for all terminal scans by construction
 * (finalizeScan / updateScanStatus stamp it), but the schema column is
 * nullable, so rows where it is somehow null are filtered out rather than
 * returned with a misleading cast.
 */
export async function getCompletedScansForShop(
  shopId: string,
  options?: { limit?: number },
): Promise<Array<{ id: string; completedAt: Date; themeName: string }>> {
  const limit = options?.limit ?? 7;

  const rows = await db.scan.findMany({
    where: { shopId, status: { in: [...SUCCESSFUL_SCAN_STATUSES] } },
    orderBy: { completedAt: "desc" },
    take: limit,
    select: { id: true, completedAt: true, themeName: true },
  });

  return rows.filter(
    (row): row is { id: string; completedAt: Date; themeName: string } => row.completedAt !== null,
  );
}

/**
 * Compute scan failure rate stats over a trailing time window.
 *
 * "Terminal" means COMPLETED, PARTIAL, or FAILED — scans still in PENDING or
 * IN_PROGRESS are excluded because they have not yet had a chance to succeed or
 * fail. PARTIAL counts as a success (it appears in the denominator, not the
 * failed numerator).
 *
 * @param hours - trailing window in hours (default 24)
 * @returns `{ total, failed, rate }` where `rate` is a 0–1 decimal.
 *   When `total` is 0 (no scans ran in the window), `rate` is 0.
 */
export async function getFailureRateStats(
  hours = 24,
): Promise<{ total: number; failed: number; rate: number }> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const [total, failed] = await Promise.all([
    db.scan.count({
      where: {
        createdAt: { gte: since },
        status: { in: [...SUCCESSFUL_SCAN_STATUSES, ScanStatus.FAILED] },
      },
    }),
    db.scan.count({
      where: {
        createdAt: { gte: since },
        status: ScanStatus.FAILED,
      },
    }),
  ]);

  const rate = total === 0 ? 0 : failed / total;
  return { total, failed, rate };
}
