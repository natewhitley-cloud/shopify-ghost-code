import { ScanStatus } from "@prisma/client";
import db from "../db.server";

/**
 * Create a new scan record in PENDING status.
 * The scan engine will transition it to IN_PROGRESS then COMPLETED/FAILED.
 */
export async function createScan(
  shopId: string,
  themeId: string,
  themeName: string,
) {
  return db.scan.create({
    data: { shopId, themeId, themeName },
  });
}

/**
 * Fetch a single scan by ID, including its findings count (denormalised on
 * the record itself) and the full findings relation for detailed views.
 * Returns null when the scan does not exist.
 */
export async function getScanById(scanId: string) {
  return db.scan.findUnique({
    where: { id: scanId },
    include: { findings: true },
  });
}

/**
 * Return scans for a shop, ordered newest-first.
 * Only the denormalised findingCount is included here — use getScanById
 * to fetch actual finding rows.
 */
export async function getScansForShop(
  shopId: string,
  options?: { limit?: number },
) {
  return db.scan.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    ...(options?.limit !== undefined ? { take: options.limit } : {}),
  });
}

/**
 * Transition a scan's status.  Automatically sets:
 *   - startedAt when moving to IN_PROGRESS
 *   - completedAt when moving to COMPLETED or FAILED
 *
 * Optionally updates findingCount so the two writes are a single round-trip.
 */
export async function updateScanStatus(
  scanId: string,
  status: ScanStatus,
  findingCount?: number,
) {
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
 * Return the most recent scan for a given shop + theme combination.
 * Used by the diff engine to compare the new scan against prior results.
 * Returns null if no prior scan exists for the theme.
 */
export async function getLatestScanForTheme(shopId: string, themeId: string) {
  return db.scan.findFirst({
    where: { shopId, themeId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Count scans created at or after `since` for a given shop.
 * Used by plan-gating to enforce per-month scan limits on the free tier.
 */
export async function countScansForShopSince(
  shopId: string,
  since: Date,
): Promise<number> {
  return db.scan.count({
    where: {
      shopId,
      createdAt: { gte: since },
    },
  });
}
