/**
 * Tests for app/models/metric-snapshot.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each model function in isolation.
 *   - computeCurrentMetrics is the most complex function — test metric
 *     derivations (completion rate, plan breakdown, avgFindingsPerScan).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  metricSnapshot: {
    upsert: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  shop: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  scan: {
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  },
  finding: {
    count: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createMetricSnapshot,
  getLatestSnapshot,
  getSnapshotHistory,
  computeCurrentMetrics,
} from "../../app/models/metric-snapshot.server";
import type { MetricSnapshotData } from "../../app/models/metric-snapshot.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SNAPSHOT_DATE = new Date("2026-04-01T00:00:00.000Z");

const SAMPLE_DATA: MetricSnapshotData = {
  snapshotDate: SNAPSHOT_DATE,
  totalShops: 10,
  activeShops: 7,
  shopsByPlan: { free: 5, professional: 3, business: 2 },
  totalScans: 100,
  scansLast7d: 20,
  scansLast30d: 80,
  completionRate: 0.9,
  totalFindings: 500,
  avgFindingsPerScan: 5.0,
};

const SAMPLE_SNAPSHOT = {
  id: "snap-1",
  ...SAMPLE_DATA,
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// createMetricSnapshot
// ---------------------------------------------------------------------------

describe("createMetricSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls upsert with snapshotDate as the where key", async () => {
    mockDb.metricSnapshot.upsert.mockResolvedValue(SAMPLE_SNAPSHOT);

    await createMetricSnapshot(SAMPLE_DATA);

    expect(mockDb.metricSnapshot.upsert).toHaveBeenCalledOnce();
    const callArg = mockDb.metricSnapshot.upsert.mock.calls[0][0];
    expect(callArg.where).toEqual({ snapshotDate: SNAPSHOT_DATE });
  });

  it("includes all metric fields in the create payload", async () => {
    mockDb.metricSnapshot.upsert.mockResolvedValue(SAMPLE_SNAPSHOT);

    await createMetricSnapshot(SAMPLE_DATA);

    const callArg = mockDb.metricSnapshot.upsert.mock.calls[0][0];
    expect(callArg.create.totalShops).toBe(10);
    expect(callArg.create.activeShops).toBe(7);
    expect(callArg.create.completionRate).toBe(0.9);
  });

  it("returns the upserted snapshot", async () => {
    mockDb.metricSnapshot.upsert.mockResolvedValue(SAMPLE_SNAPSHOT);

    const result = await createMetricSnapshot(SAMPLE_DATA);

    expect(result).toEqual(SAMPLE_SNAPSHOT);
  });

  it("updates all metric fields (not just create) on conflict", async () => {
    mockDb.metricSnapshot.upsert.mockResolvedValue(SAMPLE_SNAPSHOT);

    await createMetricSnapshot(SAMPLE_DATA);

    const callArg = mockDb.metricSnapshot.upsert.mock.calls[0][0];
    expect(callArg.update.totalShops).toBe(10);
    expect(callArg.update.completionRate).toBe(0.9);
    expect(callArg.update.avgFindingsPerScan).toBe(5.0);
  });
});

// ---------------------------------------------------------------------------
// getLatestSnapshot
// ---------------------------------------------------------------------------

describe("getLatestSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries with orderBy snapshotDate desc", async () => {
    mockDb.metricSnapshot.findFirst.mockResolvedValue(SAMPLE_SNAPSHOT);

    await getLatestSnapshot();

    expect(mockDb.metricSnapshot.findFirst).toHaveBeenCalledWith({
      orderBy: { snapshotDate: "desc" },
    });
  });

  it("returns the snapshot from the DB", async () => {
    mockDb.metricSnapshot.findFirst.mockResolvedValue(SAMPLE_SNAPSHOT);

    const result = await getLatestSnapshot();

    expect(result).toEqual(SAMPLE_SNAPSHOT);
  });

  it("returns null when no snapshots exist", async () => {
    mockDb.metricSnapshot.findFirst.mockResolvedValue(null);

    const result = await getLatestSnapshot();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSnapshotHistory
// ---------------------------------------------------------------------------

describe("getSnapshotHistory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to 30 rows", async () => {
    mockDb.metricSnapshot.findMany.mockResolvedValue([SAMPLE_SNAPSHOT]);

    await getSnapshotHistory();

    const callArg = mockDb.metricSnapshot.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(30);
  });

  it("uses the provided days argument as take", async () => {
    mockDb.metricSnapshot.findMany.mockResolvedValue([SAMPLE_SNAPSHOT]);

    await getSnapshotHistory(7);

    const callArg = mockDb.metricSnapshot.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(7);
  });

  it("orders newest-first", async () => {
    mockDb.metricSnapshot.findMany.mockResolvedValue([SAMPLE_SNAPSHOT]);

    await getSnapshotHistory();

    const callArg = mockDb.metricSnapshot.findMany.mock.calls[0][0];
    expect(callArg.orderBy).toEqual({ snapshotDate: "desc" });
  });

  it("returns an empty array when no snapshots exist", async () => {
    mockDb.metricSnapshot.findMany.mockResolvedValue([]);

    const result = await getSnapshotHistory();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeCurrentMetrics
// ---------------------------------------------------------------------------

describe("computeCurrentMetrics", () => {
  // Promise.all call order in computeCurrentMetrics:
  //   0: shop.count()               → totalShops
  //   1: shop.findMany()            → allShops
  //   2: scan.count()               → totalScans (no args)
  //   3: scan.count({ where: createdAt>=7d })  → scansLast7d
  //   4: scan.count({ where: createdAt>=30d }) → scansLast30d
  //   5: scan.count({ where: completedLast30d }) → completedLast30d
  //   6: scan.count({ where: failedLast30d })    → failedLast30d
  //   7: finding.count()            → totalFindings
  //   8: scan.aggregate()           → scansWithFindings
  //   9: scan.groupBy()             → activeShopIds

  function setupDefaultMocks() {
    mockDb.shop.count.mockResolvedValue(10);
    mockDb.shop.findMany.mockResolvedValue([
      { plan: "free" },
      { plan: "free" },
      { plan: "professional" },
    ]);
    // scan.count called multiple times — use Once for stable ordering
    mockDb.scan.count
      .mockResolvedValueOnce(100) // totalScans (no args)
      .mockResolvedValueOnce(20) // scansLast7d
      .mockResolvedValueOnce(80) // scansLast30d
      .mockResolvedValueOnce(40) // completedLast30d
      .mockResolvedValueOnce(5); // failedLast30d
    mockDb.scan.aggregate.mockResolvedValue({
      _avg: { findingCount: 4.5 },
      _count: 50,
    });
    mockDb.scan.groupBy.mockResolvedValue([
      { shopId: "shop-1" },
      { shopId: "shop-2" },
      { shopId: "shop-3" },
    ]);
    mockDb.finding.count.mockResolvedValue(500);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("returns snapshotDate as midnight UTC of the current day", async () => {
    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    const now = new Date();
    const expectedMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    expect(result.snapshotDate.toISOString()).toBe(expectedMidnight.toISOString());
  });

  it("includes totalShops from shop.count", async () => {
    mockDb.shop.count.mockResolvedValue(42);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.totalShops).toBe(42);
  });

  it("counts only currently-installed shops (uninstalledAt: null) for totalShops (gc-grd)", async () => {
    await computeCurrentMetrics(mockDb as unknown as typeof import("../../app/db.server").default);

    expect(mockDb.shop.count).toHaveBeenCalledWith({ where: { uninstalledAt: null } });
  });

  it("computes shopsByPlan only over currently-installed shops (uninstalledAt: null) (gc-grd)", async () => {
    await computeCurrentMetrics(mockDb as unknown as typeof import("../../app/db.server").default);

    expect(mockDb.shop.findMany).toHaveBeenCalledWith({
      where: { uninstalledAt: null },
      select: { plan: true },
    });
  });

  it("computes shopsByPlan from findMany results", async () => {
    mockDb.shop.findMany.mockResolvedValue([
      { plan: "free" },
      { plan: "free" },
      { plan: "free" },
      { plan: "professional" },
      { plan: "business" },
    ]);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.shopsByPlan.free).toBe(3);
    expect(result.shopsByPlan.professional).toBe(1);
    expect(result.shopsByPlan.business).toBe(1);
  });

  it("handles plan names case-insensitively", async () => {
    mockDb.shop.findMany.mockResolvedValue([{ plan: "Free" }, { plan: "PROFESSIONAL" }]);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.shopsByPlan.free).toBe(1);
    expect(result.shopsByPlan.professional).toBe(1);
  });

  it("computes completion rate as completedLast30d / (completedLast30d + failedLast30d)", async () => {
    // Reset and re-queue scan.count with controlled values for this test.
    // setupDefaultMocks() already set Once values — reset to replace them.
    vi.clearAllMocks();
    setupDefaultMocks();
    mockDb.scan.count.mockReset();
    mockDb.scan.count
      .mockResolvedValueOnce(100) // totalScans
      .mockResolvedValueOnce(10) // scansLast7d
      .mockResolvedValueOnce(50) // scansLast30d
      .mockResolvedValueOnce(40) // completedLast30d
      .mockResolvedValueOnce(10); // failedLast30d

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    // 40 / (40 + 10) = 0.8
    expect(result.completionRate).toBeCloseTo(0.8);
  });

  it("returns completionRate of 1 when no terminal scans in last 30d", async () => {
    vi.clearAllMocks();
    setupDefaultMocks();
    mockDb.scan.count.mockReset();
    mockDb.scan.count
      .mockResolvedValueOnce(100) // totalScans
      .mockResolvedValueOnce(0) // scansLast7d
      .mockResolvedValueOnce(0) // scansLast30d
      .mockResolvedValueOnce(0) // completedLast30d = 0
      .mockResolvedValueOnce(0); // failedLast30d = 0

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.completionRate).toBe(1);
  });

  it("uses groupBy result length as activeShops count", async () => {
    mockDb.scan.groupBy.mockResolvedValue([{ shopId: "a" }, { shopId: "b" }]);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.activeShops).toBe(2);
  });

  it("returns 0 activeShops when no scans in last 30 days", async () => {
    mockDb.scan.groupBy.mockResolvedValue([]);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.activeShops).toBe(0);
  });

  it("uses aggregate _avg.findingCount as avgFindingsPerScan", async () => {
    mockDb.scan.aggregate.mockResolvedValue({
      _avg: { findingCount: 7.25 },
      _count: 20,
    });

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.avgFindingsPerScan).toBeCloseTo(7.25);
  });

  it("returns 0 avgFindingsPerScan when no completed scans", async () => {
    mockDb.scan.aggregate.mockResolvedValue({
      _avg: { findingCount: null },
      _count: 0,
    });

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.avgFindingsPerScan).toBe(0);
  });

  it("includes totalFindings from finding.count", async () => {
    mockDb.finding.count.mockResolvedValue(999);

    const result = await computeCurrentMetrics(
      mockDb as unknown as typeof import("../../app/db.server").default,
    );

    expect(result.totalFindings).toBe(999);
  });
});
