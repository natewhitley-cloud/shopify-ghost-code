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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScanStatus } from "@prisma/client";

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
  getScanById,
  getScansForShop,
  updateScanStatus,
  getPreviousScanForTheme,
  countScansForShopSince,
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

  it("returns the scan with findings when found", async () => {
    const scanWithFindings = { ...baseScan, findings: [] };
    mockDb.scan.findUnique.mockResolvedValue(scanWithFindings);

    const result = await getScanById("scan-1");

    expect(mockDb.scan.findUnique).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      include: { findings: true },
    });
    expect(result).toEqual(scanWithFindings);
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

  it("applies the limit option when provided", async () => {
    const scans = [baseScan];
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID, { limit: 5 });

    expect(mockDb.scan.findMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    expect(result).toEqual(scans);
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
      },
    });
    expect(result).toBe(3);
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
