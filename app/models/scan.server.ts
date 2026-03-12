import { ScanStatus } from "@prisma/client";

import db from "../db.server";

/**
 * Create a new scan record in PENDING status.
 * The scan engine will transition it to IN_PROGRESS then COMPLETED/FAILED.
 *
 * Atomic TOCTOU guard: the check for an existing active scan and the create
 * are wrapped in a single transaction. This prevents two concurrent requests
 * from both passing a pre-flight canStartScan check and both creating scans.
 *
 * Throws an Error with message "A scan is already in progress for this shop."
 * when a PENDING or IN_PROGRESS scan already exists. Callers should catch this
 * to surface a user-friendly message.
 */
export async function createScan(shopId: string, themeId: string, themeName: string) {
  return db.$transaction(async (tx) => {
    const activeScan = await tx.scan.findFirst({
      where: { shopId, status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] } },
      select: { id: true },
    });
    if (activeScan) {
      throw new Error("A scan is already in progress for this shop.");
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
 *   Internally fetches `limit + 1` rows so the caller can detect whether
 *   a next page exists without a separate COUNT query.
 */
export async function getScansForShop(
  shopId: string,
  options?: { limit?: number; cursor?: string },
) {
  return db.scan.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    ...(options?.limit !== undefined ? { take: options.limit + 1 } : {}),
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}

/**
 * Transition a scan's status.  Automatically sets:
 *   - startedAt when moving to IN_PROGRESS
 *   - completedAt when moving to COMPLETED or FAILED
 *
 * Optionally updates findingCount so the two writes are a single round-trip.
 */
export async function updateScanStatus(scanId: string, status: ScanStatus, findingCount?: number) {
  const now = new Date();
  const timestampFields =
    status === ScanStatus.IN_PROGRESS
      ? { startedAt: now }
      : status === ScanStatus.COMPLETED || status === ScanStatus.FAILED
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
 * Return the most recent COMPLETED scan for a given shop + theme that was
 * created BEFORE `beforeDate`.  Used by the diff engine to find the scan
 * that immediately preceded the current one.
 *
 * Returns null when no qualifying prior scan exists.
 */
export async function getPreviousScanForTheme(shopId: string, themeId: string, beforeDate: Date) {
  return db.scan.findFirst({
    where: {
      shopId,
      themeId,
      status: ScanStatus.COMPLETED,
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
 * Only COMPLETED and IN_PROGRESS scans count toward the quota.
 * FAILED and PENDING scans are excluded so merchants are not penalised for
 * infrastructure failures or scans that never ran.
 */
export async function countScansForShopSince(shopId: string, since: Date): Promise<number> {
  return db.scan.count({
    where: {
      shopId,
      createdAt: { gte: since },
      status: { in: [ScanStatus.COMPLETED, ScanStatus.IN_PROGRESS] },
    },
  });
}

/**
 * Return true if the shop has at least one COMPLETED scan ever.
 * Used by plan-gating to detect first-time scanners who are eligible
 * for the free onboarding scan regardless of the monthly quota.
 */
export async function hasCompletedScans(shopId: string): Promise<boolean> {
  const count = await db.scan.count({
    where: { shopId, status: ScanStatus.COMPLETED },
  });
  return count > 0;
}
