/**
 * Tests for app/models/scan.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function in isolation — no Shopify SDK or Inngest involved.
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations in the test file. Use vi.hoisted() to define mock
 * objects that are referenced inside a vi.mock factory.
 */

import { ScanStatus } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// tx-scoped mock for $transaction callback (used by createScan).
const mockTx = vi.hoisted(() => ({
  scan: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
}));

const mockDb = vi.hoisted(() => ({
  scan: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  // Callback-form $transaction: invoke the callback with the tx mock.
  $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createScan,
  expireStaleScans,
  getFailureRateStats,
  getScanById,
  getScansForShop,
  updateScanStatus,
  getPreviousScanForTheme,
  countScansForShopSince,
  hasCompletedScans,
} from "../../app/models/scan.server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc";
const THEME_ID = "theme-123";

const baseScan = {
  id: "scan-1",
  shopId: SHOP_ID,
  themeId: THEME_ID,
  themeName: "Dawn",
  status: ScanStatus.PENDING,
  findingCount: 0,
  createdAt: new Date("2026-01-15T10:00:00Z"),
  startedAt: null,
  completedAt: null,
};

// ---------------------------------------------------------------------------
// createScan (S-07: atomic TOCTOU guard via $transaction callback-form)
// ---------------------------------------------------------------------------

describe("createScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a scan record when no active scan exists for the shop", async () => {
    mockTx.scan.findFirst.mockResolvedValue(null); // no active scan
    mockTx.scan.create.mockResolvedValue(baseScan);

    const result = await createScan(SHOP_ID, THEME_ID, "Dawn");

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockTx.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shopId: SHOP_ID }),
      }),
    );
    expect(mockTx.scan.create).toHaveBeenCalledWith({
      data: { shopId: SHOP_ID, themeId: THEME_ID, themeName: "Dawn" },
    });
    expect(result).toEqual(baseScan);
  });

  it("throws when a PENDING scan already exists for the shop", async () => {
    mockTx.scan.findFirst.mockResolvedValue({ id: "existing-pending-scan" });

    await expect(createScan(SHOP_ID, THEME_ID, "Dawn")).rejects.toThrow(
      "A scan is already in progress for this shop.",
    );
    // Must not proceed to create
    expect(mockTx.scan.create).not.toHaveBeenCalled();
  });

  it("throws when an IN_PROGRESS scan already exists for the shop", async () => {
    mockTx.scan.findFirst.mockResolvedValue({ id: "existing-inprogress-scan" });

    await expect(createScan(SHOP_ID, THEME_ID, "Dawn")).rejects.toThrow(
      "A scan is already in progress for this shop.",
    );
    expect(mockTx.scan.create).not.toHaveBeenCalled();
  });

  it("checks for both PENDING and IN_PROGRESS statuses in the active-scan guard", async () => {
    mockTx.scan.findFirst.mockResolvedValue(null);
    mockTx.scan.create.mockResolvedValue(baseScan);

    await createScan(SHOP_ID, THEME_ID, "Dawn");

    const callArg = mockTx.scan.findFirst.mock.calls[0][0];
    expect(callArg.where.status.in).toContain("PENDING");
    expect(callArg.where.status.in).toContain("IN_PROGRESS");
  });

  it("propagates a database error when create fails", async () => {
    mockTx.scan.findFirst.mockResolvedValue(null);
    mockTx.scan.create.mockRejectedValue(new Error("DB constraint violation"));

    await expect(createScan(SHOP_ID, THEME_ID, "Dawn")).rejects.toThrow("DB constraint violation");
  });
});

// ---------------------------------------------------------------------------
// getScanById
// ---------------------------------------------------------------------------

describe("getScanById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the scan with findings when found (default includeFindings=true)", async () => {
    const scanWithFindings = { ...baseScan, findings: [] };
    mockDb.scan.findUnique.mockResolvedValue(scanWithFindings);

    const result = await getScanById("scan-1");

    expect(mockDb.scan.findUnique).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      include: { findings: true },
    });
    expect(result).toEqual(scanWithFindings);
  });

  it("includes findings when includeFindings option is explicitly true", async () => {
    const scanWithFindings = { ...baseScan, findings: [] };
    mockDb.scan.findUnique.mockResolvedValue(scanWithFindings);

    await getScanById("scan-1", { includeFindings: true });

    expect(mockDb.scan.findUnique).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      include: { findings: true },
    });
  });

  it("skips the findings JOIN when includeFindings is false", async () => {
    mockDb.scan.findUnique.mockResolvedValue(baseScan);

    const result = await getScanById("scan-1", { includeFindings: false });

    // Must NOT pass the include clause — this skips the findings JOIN entirely.
    expect(mockDb.scan.findUnique).toHaveBeenCalledWith({
      where: { id: "scan-1" },
    });
    expect(result).toEqual(baseScan);
  });

  it("returns null when the scan does not exist", async () => {
    mockDb.scan.findUnique.mockResolvedValue(null);

    const result = await getScanById("nonexistent-scan");

    expect(result).toBeNull();
  });

  it("propagates a database error", async () => {
    mockDb.scan.findUnique.mockRejectedValue(new Error("Connection timeout"));

    await expect(getScanById("scan-1")).rejects.toThrow("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// getScansForShop
// ---------------------------------------------------------------------------

describe("getScansForShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns scans for a shop ordered newest-first with no limit", async () => {
    const scans = [baseScan, { ...baseScan, id: "scan-0" }];
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID);

    expect(mockDb.scan.findMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toEqual(scans);
  });

  it("applies the limit option when provided (fetches limit+1 for next-page detection)", async () => {
    const scans = [baseScan];
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID, { limit: 5 });

    // The model fetches limit+1 rows so the caller can detect whether a next
    // page exists without a separate COUNT query.
    expect(mockDb.scan.findMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
      orderBy: { createdAt: "desc" },
      take: 6,
    });
    expect(result).toEqual(scans);
  });

  it("applies cursor pagination when cursor is provided", async () => {
    const scans = [baseScan];
    mockDb.scan.findMany.mockResolvedValue(scans);

    await getScansForShop(SHOP_ID, { limit: 5, cursor: "cursor-id-123" });

    expect(mockDb.scan.findMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
      orderBy: { createdAt: "desc" },
      take: 6,
      cursor: { id: "cursor-id-123" },
      skip: 1,
    });
  });

  it("does not include cursor fields when cursor is undefined", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getScansForShop(SHOP_ID, { limit: 5 });

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("cursor");
    expect(callArg).not.toHaveProperty("skip");
  });

  it("returns an empty array when the shop has no scans", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    const result = await getScansForShop(SHOP_ID);

    expect(result).toEqual([]);
  });

  it("does not include 'take' when limit is undefined", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getScansForShop(SHOP_ID, {});

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("take");
  });
});

// ---------------------------------------------------------------------------
// updateScanStatus
// ---------------------------------------------------------------------------

describe("updateScanStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets startedAt when transitioning to IN_PROGRESS", async () => {
    const updatedScan = { ...baseScan, status: ScanStatus.IN_PROGRESS };
    mockDb.scan.update.mockResolvedValue(updatedScan);

    await updateScanStatus("scan-1", ScanStatus.IN_PROGRESS);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data.status).toBe(ScanStatus.IN_PROGRESS);
    expect(callArg.data).toHaveProperty("startedAt");
    expect(callArg.data).not.toHaveProperty("completedAt");
    expect(callArg.where).toEqual({ id: "scan-1" });
  });

  it("sets completedAt when transitioning to COMPLETED", async () => {
    const updatedScan = { ...baseScan, status: ScanStatus.COMPLETED };
    mockDb.scan.update.mockResolvedValue(updatedScan);

    await updateScanStatus("scan-1", ScanStatus.COMPLETED);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data.status).toBe(ScanStatus.COMPLETED);
    expect(callArg.data).toHaveProperty("completedAt");
    expect(callArg.data).not.toHaveProperty("startedAt");
  });

  it("sets completedAt when transitioning to FAILED", async () => {
    const updatedScan = { ...baseScan, status: ScanStatus.FAILED };
    mockDb.scan.update.mockResolvedValue(updatedScan);

    await updateScanStatus("scan-1", ScanStatus.FAILED);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data.status).toBe(ScanStatus.FAILED);
    expect(callArg.data).toHaveProperty("completedAt");
  });

  it("sets findingCount when provided", async () => {
    mockDb.scan.update.mockResolvedValue(baseScan);

    await updateScanStatus("scan-1", ScanStatus.COMPLETED, 7);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data.findingCount).toBe(7);
  });

  it("does not set findingCount when omitted", async () => {
    mockDb.scan.update.mockResolvedValue(baseScan);

    await updateScanStatus("scan-1", ScanStatus.COMPLETED);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data).not.toHaveProperty("findingCount");
  });

  it("sets neither startedAt nor completedAt for PENDING status", async () => {
    mockDb.scan.update.mockResolvedValue(baseScan);

    await updateScanStatus("scan-1", ScanStatus.PENDING);

    const callArg = mockDb.scan.update.mock.calls[0][0];
    expect(callArg.data).not.toHaveProperty("startedAt");
    expect(callArg.data).not.toHaveProperty("completedAt");
  });

  it("propagates a database error", async () => {
    mockDb.scan.update.mockRejectedValue(new Error("Record not found"));

    await expect(updateScanStatus("bad-id", ScanStatus.COMPLETED)).rejects.toThrow(
      "Record not found",
    );
  });
});

// ---------------------------------------------------------------------------
// getPreviousScanForTheme
// ---------------------------------------------------------------------------

describe("getPreviousScanForTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the most recent COMPLETED scan before the given date", async () => {
    const previousScan = {
      ...baseScan,
      id: "scan-0",
      status: ScanStatus.COMPLETED,
      findings: [],
    };
    mockDb.scan.findFirst.mockResolvedValue(previousScan);

    const beforeDate = new Date("2026-01-15T10:00:00Z");
    const result = await getPreviousScanForTheme(SHOP_ID, THEME_ID, beforeDate);

    expect(mockDb.scan.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        themeId: THEME_ID,
        status: ScanStatus.COMPLETED,
        createdAt: { lt: beforeDate },
      },
      orderBy: { createdAt: "desc" },
      include: { findings: true },
    });
    expect(result).toEqual(previousScan);
  });

  it("returns null when no prior completed scan exists for the theme", async () => {
    mockDb.scan.findFirst.mockResolvedValue(null);

    const result = await getPreviousScanForTheme(
      SHOP_ID,
      THEME_ID,
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(result).toBeNull();
  });

  it("does not return PENDING or IN_PROGRESS scans (status filter)", async () => {
    // The function filters by status=COMPLETED — verify the where clause is correct.
    mockDb.scan.findFirst.mockResolvedValue(null);

    await getPreviousScanForTheme(SHOP_ID, THEME_ID, new Date());

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.where.status).toBe(ScanStatus.COMPLETED);
  });

  it("includes findings in the returned scan", async () => {
    // Verify include: { findings: true } is passed so callers can diff.
    mockDb.scan.findFirst.mockResolvedValue(null);

    await getPreviousScanForTheme(SHOP_ID, THEME_ID, new Date());

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.include).toEqual({ findings: true });
  });
});

// ---------------------------------------------------------------------------
// countScansForShopSince
// ---------------------------------------------------------------------------

describe("countScansForShopSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the scan count for the shop since the given date", async () => {
    mockDb.scan.count.mockResolvedValue(3);

    const since = new Date("2026-01-01T00:00:00Z");
    const result = await countScansForShopSince(SHOP_ID, since);

    expect(mockDb.scan.count).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        createdAt: { gte: since },
        status: { in: [ScanStatus.COMPLETED, ScanStatus.IN_PROGRESS] },
      },
    });
    expect(result).toBe(3);
  });

  it("filters to only COMPLETED and IN_PROGRESS statuses (excludes FAILED and PENDING)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await countScansForShopSince(SHOP_ID, new Date("2026-01-01T00:00:00Z"));

    const callArg = mockDb.scan.count.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).toContain(ScanStatus.IN_PROGRESS);
    expect(callArg.where.status.in).not.toContain(ScanStatus.FAILED);
    expect(callArg.where.status.in).not.toContain(ScanStatus.PENDING);
  });

  it("returns 0 when no scans have been run since the given date", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    const result = await countScansForShopSince(SHOP_ID, new Date());

    expect(result).toBe(0);
  });

  it("propagates a database error", async () => {
    mockDb.scan.count.mockRejectedValue(new Error("Query failed"));

    await expect(countScansForShopSince(SHOP_ID, new Date())).rejects.toThrow("Query failed");
  });
});

// ---------------------------------------------------------------------------
// hasCompletedScans
// ---------------------------------------------------------------------------

describe("hasCompletedScans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the shop has at least one completed scan", async () => {
    mockDb.scan.count.mockResolvedValue(3);

    const result = await hasCompletedScans(SHOP_ID);

    expect(result).toBe(true);
  });

  it("returns false when the shop has no completed scans", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    const result = await hasCompletedScans(SHOP_ID);

    expect(result).toBe(false);
  });

  it("queries only COMPLETED status scans (not PENDING, IN_PROGRESS, or FAILED)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await hasCompletedScans(SHOP_ID);

    expect(mockDb.scan.count).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        status: ScanStatus.COMPLETED,
      },
    });
  });

  it("propagates a database error", async () => {
    mockDb.scan.count.mockRejectedValue(new Error("DB unavailable"));

    await expect(hasCompletedScans(SHOP_ID)).rejects.toThrow("DB unavailable");
  });
});

// ---------------------------------------------------------------------------
// expireStaleScans
// ---------------------------------------------------------------------------

describe("expireStaleScans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks PENDING scans older than the cutoff as FAILED and returns the count", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 2 });

    const result = await expireStaleScans();

    expect(mockDb.scan.updateMany).toHaveBeenCalledOnce();
    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.PENDING);
    expect(callArg.data.status).toBe(ScanStatus.FAILED);
    expect(callArg.data).toHaveProperty("completedAt");
    expect(result).toBe(2);
  });

  it("marks IN_PROGRESS scans older than the cutoff as FAILED", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 1 });

    await expireStaleScans();

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.IN_PROGRESS);
  });

  it("uses a createdAt < cutoff filter so recent scans are not touched", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });

    const before = new Date();
    await expireStaleScans(30);
    const after = new Date();

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    const cutoff: Date = callArg.where.createdAt.lt;
    // cutoff should be ~30 minutes before now
    const expectedMin = new Date(before.getTime() - 30 * 60 * 1000);
    const expectedMax = new Date(after.getTime() - 30 * 60 * 1000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("respects a custom maxAgeMinutes parameter", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });

    const before = new Date();
    await expireStaleScans(60);
    const after = new Date();

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    const cutoff: Date = callArg.where.createdAt.lt;
    const expectedMin = new Date(before.getTime() - 60 * 60 * 1000);
    const expectedMax = new Date(after.getTime() - 60 * 60 * 1000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("does not include COMPLETED or FAILED scans in the status filter", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });

    await expireStaleScans();

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    expect(callArg.where.status.in).not.toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).not.toContain(ScanStatus.FAILED);
  });

  it("returns 0 when no stale scans exist", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireStaleScans();

    expect(result).toBe(0);
  });

  it("propagates a database error", async () => {
    mockDb.scan.updateMany.mockRejectedValue(new Error("DB connection lost"));

    await expect(expireStaleScans()).rejects.toThrow("DB connection lost");
  });
});

// ---------------------------------------------------------------------------
// getFailureRateStats
// ---------------------------------------------------------------------------

describe("getFailureRateStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { total: 0, failed: 0, rate: 0 } when no terminal scans exist in the window", async () => {
    // Both count calls return 0 (no COMPLETED or FAILED scans in the window)
    mockDb.scan.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const result = await getFailureRateStats();

    expect(result).toEqual({ total: 0, failed: 0, rate: 0 });
  });

  it("returns rate 0 when all scans completed successfully", async () => {
    // First count = total (COMPLETED + FAILED) = 5, second count = FAILED = 0
    mockDb.scan.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);

    const result = await getFailureRateStats();

    expect(result).toEqual({ total: 5, failed: 0, rate: 0 });
  });

  it("returns rate 1 when all terminal scans failed", async () => {
    mockDb.scan.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

    const result = await getFailureRateStats();

    expect(result).toEqual({ total: 4, failed: 4, rate: 1 });
  });

  it("returns the correct fractional rate for mixed COMPLETED and FAILED scans", async () => {
    // 2 failed out of 10 total = 0.2 rate
    mockDb.scan.count.mockResolvedValueOnce(10).mockResolvedValueOnce(2);

    const result = await getFailureRateStats();

    expect(result.total).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.rate).toBeCloseTo(0.2);
  });

  it("queries only COMPLETED and FAILED scans for the total count (excludes PENDING and IN_PROGRESS)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await getFailureRateStats(24);

    // First count call should filter by status COMPLETED and FAILED
    const firstCallArg = mockDb.scan.count.mock.calls[0][0];
    expect(firstCallArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(firstCallArg.where.status.in).toContain(ScanStatus.FAILED);
    expect(firstCallArg.where.status.in).not.toContain(ScanStatus.PENDING);
    expect(firstCallArg.where.status.in).not.toContain(ScanStatus.IN_PROGRESS);
  });

  it("queries only FAILED scans for the failed count", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await getFailureRateStats(24);

    // Second count call should filter by status FAILED only
    const secondCallArg = mockDb.scan.count.mock.calls[1][0];
    expect(secondCallArg.where.status).toBe(ScanStatus.FAILED);
  });

  it("uses a trailing time window based on the hours parameter", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    const before = new Date();
    await getFailureRateStats(6);
    const after = new Date();

    const firstCallArg = mockDb.scan.count.mock.calls[0][0];
    const since: Date = firstCallArg.where.createdAt.gte;

    // since should be ~6 hours before now
    const expectedMin = new Date(before.getTime() - 6 * 60 * 60 * 1000);
    const expectedMax = new Date(after.getTime() - 6 * 60 * 60 * 1000);
    expect(since.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(since.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("defaults to a 24-hour window when hours is not specified", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    const before = new Date();
    await getFailureRateStats();
    const after = new Date();

    const firstCallArg = mockDb.scan.count.mock.calls[0][0];
    const since: Date = firstCallArg.where.createdAt.gte;

    const expectedMin = new Date(before.getTime() - 24 * 60 * 60 * 1000);
    const expectedMax = new Date(after.getTime() - 24 * 60 * 60 * 1000);
    expect(since.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(since.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("propagates a database error", async () => {
    mockDb.scan.count.mockRejectedValue(new Error("DB unavailable"));

    await expect(getFailureRateStats()).rejects.toThrow("DB unavailable");
  });
});
