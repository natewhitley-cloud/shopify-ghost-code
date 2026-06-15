import { ScanStatus } from "@prisma/client";

import db from "../db.server";

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
 */
export async function createScan(
  shopId: string,
  themeId: string,
  themeName: string,
  quota?: ScanQuota,
) {
  return db.$transaction(async (tx) => {
    const activeScan = await tx.scan.findFirst({
      where: { shopId, status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] } },
      select: { id: true },
    });
    if (activeScan) {
      throw new Error("A scan is already in progress for this shop.");
    }

    // Enforce quota atomically when provided.
    if (quota && !quota.isFirstScan && quota.maxScans !== Infinity) {
      const usedInPeriod = await tx.scan.count({
        where: {
          shopId,
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

    return tx.scan.create({
      data: { shopId, themeId, themeName },
    });
  });
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
  options?: { limit?: number; cursor?: string },
): Promise<{ items: Awaited<ReturnType<typeof db.scan.findMany>>; hasNextPage: boolean }> {
  const { limit, cursor } = options ?? {};

  const rows = await db.scan.findMany({
    where: { shopId },
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
 * Mark a scan with its final, terminal status after ALL audit steps have run
 * (LOG-4). This is the single point at which a scan becomes COMPLETED or
 * PARTIAL — the core theme step (saveThemeFindings) deliberately leaves it
 * IN_PROGRESS so a late audit failure can still mark it FAILED.
 *
 * Decides nothing itself: the caller (the scan-theme finalize step) passes the
 * already-decided status, the authoritative findingCount, and the set of
 * optional categories that were skipped for missing scope. skippedCategories is
 * persisted so the diff engine never treats an un-audited category's prior
 * findings as "resolved".
 *
 * Idempotent: a single scan.update, safe to re-run on an Inngest retry.
 */
export async function finalizeScan(
  scanId: string,
  args: {
    status: typeof ScanStatus.COMPLETED | typeof ScanStatus.PARTIAL;
    findingCount: number;
    skippedCategories: string[];
  },
) {
  return db.scan.update({
    where: { id: scanId },
    data: {
      status: args.status,
      completedAt: new Date(),
      findingCount: args.findingCount,
      skippedCategories: args.skippedCategories,
    },
  });
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
 */
export async function countScansForShopSince(shopId: string, since: Date): Promise<number> {
  return db.scan.count({
    where: {
      shopId,
      createdAt: { gte: since },
      status: { in: [...SUCCESSFUL_SCAN_STATUSES, ScanStatus.IN_PROGRESS] },
    },
  });
}

/**
 * Mark stale scans as FAILED.  A scan is "stale" if it has been PENDING or
 * IN_PROGRESS for longer than `maxAgeMinutes` (default 30).
 *
 * This is called by the daily cron coordinator before fanning out per-shop
 * checks so that shops whose scan jobs crashed or timed out are unblocked
 * before new scans are attempted.
 *
 * Returns the number of scans cleaned up.
 */
export async function expireStaleScans(maxAgeMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const result = await db.scan.updateMany({
    where: {
      status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: ScanStatus.FAILED,
      completedAt: new Date(),
    },
  });
  return result.count;
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
