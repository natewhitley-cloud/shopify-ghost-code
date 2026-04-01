/**
 * Data access layer for MetricSnapshot — daily point-in-time metrics for
 * operator visibility into app health and growth.
 *
 * One snapshot per day (enforced by the @unique constraint on snapshotDate).
 * The daily cron upserts the snapshot for midnight UTC of the current day so
 * a forced "Refresh Now" within the same day overwrites rather than duplicates.
 */

import { ScanStatus } from "@prisma/client";

import db from "../db.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShopsByPlan = {
  free: number;
  professional: number;
  business: number;
  [key: string]: number;
};

export type MetricSnapshotData = {
  snapshotDate: Date;
  totalShops: number;
  activeShops: number;
  shopsByPlan: ShopsByPlan;
  totalScans: number;
  scansLast7d: number;
  scansLast30d: number;
  completionRate: number;
  totalFindings: number;
  avgFindingsPerScan: number;
};

// ---------------------------------------------------------------------------
// Model functions
// ---------------------------------------------------------------------------

/**
 * Insert (or overwrite for the same day) a metrics snapshot.
 *
 * Uses upsert keyed on snapshotDate so calling "Refresh Now" multiple times
 * per day updates the row in place rather than creating duplicates.
 */
export async function createMetricSnapshot(data: MetricSnapshotData) {
  return db.metricSnapshot.upsert({
    where: { snapshotDate: data.snapshotDate },
    create: data,
    update: {
      totalShops: data.totalShops,
      activeShops: data.activeShops,
      shopsByPlan: data.shopsByPlan,
      totalScans: data.totalScans,
      scansLast7d: data.scansLast7d,
      scansLast30d: data.scansLast30d,
      completionRate: data.completionRate,
      totalFindings: data.totalFindings,
      avgFindingsPerScan: data.avgFindingsPerScan,
    },
  });
}

/**
 * Return the most recent snapshot by snapshotDate.
 * Returns null if no snapshots have been stored yet.
 */
export async function getLatestSnapshot() {
  return db.metricSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
  });
}

/**
 * Return the last N days of snapshots, newest-first.
 * Useful for rendering a trend table on the admin dashboard.
 *
 * @param days - number of snapshots to return (default 30)
 */
export async function getSnapshotHistory(days = 30) {
  return db.metricSnapshot.findMany({
    orderBy: { snapshotDate: "desc" },
    take: days,
  });
}

/**
 * Compute all current metric values by querying the live DB tables.
 * This is what both the daily cron and the "Refresh Now" action call.
 *
 * @param prismaClient - Prisma client to use; defaults to the module-level db.
 *   Pass a transaction client when you need atomic reads across tables.
 */
export async function computeCurrentMetrics(
  prismaClient: typeof db = db,
): Promise<MetricSnapshotData> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Midnight UTC today — used as the snapshotDate key (one per day).
  const snapshotDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const [
    totalShops,
    allShops,
    totalScans,
    scansLast7d,
    scansLast30d,
    completedLast30d,
    failedLast30d,
    totalFindings,
    scansWithFindings,
    activeShopIds,
  ] = await Promise.all([
    // Total shops ever installed
    prismaClient.shop.count(),

    // All shops — needed to compute plan breakdown
    prismaClient.shop.findMany({ select: { plan: true } }),

    // All-time scan count (any status)
    prismaClient.scan.count(),

    // Scans created in last 7 days
    prismaClient.scan.count({
      where: { createdAt: { gte: sevenDaysAgo } },
    }),

    // Scans created in last 30 days
    prismaClient.scan.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),

    // Completed scans in last 30 days (for completion rate numerator)
    prismaClient.scan.count({
      where: {
        createdAt: { gte: thirtyDaysAgo },
        status: ScanStatus.COMPLETED,
      },
    }),

    // Failed scans in last 30 days (for completion rate denominator)
    prismaClient.scan.count({
      where: {
        createdAt: { gte: thirtyDaysAgo },
        status: ScanStatus.FAILED,
      },
    }),

    // All-time finding count
    prismaClient.finding.count(),

    // Completed scans that have at least one finding — for avg calculation
    // We use the denormalized findingCount on Scan to avoid a heavy JOIN.
    prismaClient.scan.aggregate({
      _avg: { findingCount: true },
      _count: true,
      where: { status: ScanStatus.COMPLETED },
    }),

    // Active shops: distinct shopIds with at least one scan in last 30 days
    prismaClient.scan.groupBy({
      by: ["shopId"],
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  // Plan breakdown
  const shopsByPlan: ShopsByPlan = { free: 0, professional: 0, business: 0 };
  for (const shop of allShops) {
    const key = shop.plan.toLowerCase();
    shopsByPlan[key] = (shopsByPlan[key] ?? 0) + 1;
  }

  // Completion rate: completed / (completed + failed). Exclude PENDING/IN_PROGRESS.
  const terminalLast30d = completedLast30d + failedLast30d;
  const completionRate = terminalLast30d === 0 ? 1 : completedLast30d / terminalLast30d;

  // Average findings per completed scan
  const avgFindingsPerScan = scansWithFindings._avg.findingCount ?? 0;

  return {
    snapshotDate,
    totalShops,
    activeShops: activeShopIds.length,
    shopsByPlan,
    totalScans,
    scansLast7d,
    scansLast30d,
    completionRate,
    totalFindings,
    avgFindingsPerScan,
  };
}
