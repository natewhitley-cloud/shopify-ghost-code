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

import { ScanOrigin, ScanStatus } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// tx-scoped mock for $transaction callback (used by createScan).
const mockTx = vi.hoisted(() => ({
  scan: {
    findFirst: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
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

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { logger } from "../../app/lib/logger.server";
import {
  buildStaleScanWhere,
  createScan,
  DEFAULT_STALE_SCAN_THRESHOLDS,
  expireStaleScans,
  finalizeScan,
  getFailureRateStats,
  getScanById,
  getScansForShop,
  updateScanStatus,
  getPreviousScanForTheme,
  getLatestSuccessfulScanForTheme,
  countScansForShopSince,
  hasCompletedScans,
  getCompletedScansForShop,
} from "../../app/models/scan.server";

const mockLoggerWarn = (logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

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
  origin: ScanOrigin.MANUAL,
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
      data: { shopId: SHOP_ID, themeId: THEME_ID, themeName: "Dawn", origin: ScanOrigin.MANUAL },
    });
    expect(result).toEqual(baseScan);
  });

  it("defaults origin to MANUAL when not provided (GC-iji)", async () => {
    mockTx.scan.findFirst.mockResolvedValue(null);
    mockTx.scan.create.mockResolvedValue(baseScan);

    await createScan(SHOP_ID, THEME_ID, "Dawn");

    expect(mockTx.scan.create).toHaveBeenCalledWith({
      data: { shopId: SHOP_ID, themeId: THEME_ID, themeName: "Dawn", origin: ScanOrigin.MANUAL },
    });
  });

  it("persists the given origin in the created scan (SCHEDULED)", async () => {
    mockTx.scan.findFirst.mockResolvedValue(null);
    mockTx.scan.create.mockResolvedValue(baseScan);

    await createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.SCHEDULED);

    expect(mockTx.scan.create).toHaveBeenCalledWith({
      data: {
        shopId: SHOP_ID,
        themeId: THEME_ID,
        themeName: "Dawn",
        origin: ScanOrigin.SCHEDULED,
      },
    });
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
// createScan — manual quota exemption (GC-iji)
//
// Standard-plan merchants get 1 MANUAL scan/week PLUS a weekly SCHEDULED cron
// scan and (Professional) AUTO_PUBLISH auto-rescans. Only MANUAL scans may
// consume the manual quota; SCHEDULED and AUTO_PUBLISH scans must be exempt so
// they can never block the merchant's own manual scan.
// ---------------------------------------------------------------------------

describe("createScan — manual quota exemption (GC-iji)", () => {
  // Standard plan: 1 manual scan per week.
  const STANDARD_QUOTA = {
    periodStart: new Date("2026-06-15T00:00:00Z"),
    maxScans: 1,
    periodLabel: "week" as const,
    isFirstScan: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.scan.findFirst.mockResolvedValue(null); // no active scan
    mockTx.scan.create.mockResolvedValue(baseScan);
  });

  // Simulate the DB honouring the where.origin filter: count only fixture rows
  // whose origin matches the query (or all rows when no origin filter is set).
  function countMatchingOrigin(scans: Array<{ origin: ScanOrigin }>) {
    return async ({ where }: { where: { origin?: ScanOrigin } }) =>
      scans.filter((s) => where.origin === undefined || s.origin === where.origin).length;
  }

  it("scopes the atomic quota count to origin=MANUAL", async () => {
    mockTx.scan.count.mockResolvedValue(0);

    await createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.MANUAL, STANDARD_QUOTA);

    const callArg = mockTx.scan.count.mock.calls[0][0];
    expect(callArg.where.origin).toBe(ScanOrigin.MANUAL);
  });

  it("allows a MANUAL scan when the only scan this week is SCHEDULED (the bead scenario)", async () => {
    // A Sunday-6AM cron SCHEDULED scan already ran this week. It must NOT consume
    // the merchant's single weekly manual scan — the exact GC-iji bug.
    mockTx.scan.count.mockImplementation(countMatchingOrigin([{ origin: ScanOrigin.SCHEDULED }]));

    await expect(
      createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.MANUAL, STANDARD_QUOTA),
    ).resolves.toEqual(baseScan);
    expect(mockTx.scan.create).toHaveBeenCalledOnce();
  });

  it("allows a MANUAL scan when the only scan this week is AUTO_PUBLISH", async () => {
    mockTx.scan.count.mockImplementation(
      countMatchingOrigin([{ origin: ScanOrigin.AUTO_PUBLISH }]),
    );

    await expect(
      createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.MANUAL, STANDARD_QUOTA),
    ).resolves.toEqual(baseScan);
    expect(mockTx.scan.create).toHaveBeenCalledOnce();
  });

  it("allows a MANUAL scan even when SCHEDULED and AUTO_PUBLISH scans both exist this week", async () => {
    mockTx.scan.count.mockImplementation(
      countMatchingOrigin([
        { origin: ScanOrigin.SCHEDULED },
        { origin: ScanOrigin.AUTO_PUBLISH },
        { origin: ScanOrigin.SCHEDULED },
      ]),
    );

    await expect(
      createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.MANUAL, STANDARD_QUOTA),
    ).resolves.toEqual(baseScan);
  });

  it("rejects a second MANUAL scan when a MANUAL scan already exists this week (quota consumed)", async () => {
    // Existing manual behaviour is preserved: a manual scan DOES consume quota.
    mockTx.scan.count.mockImplementation(countMatchingOrigin([{ origin: ScanOrigin.MANUAL }]));

    await expect(
      createScan(SHOP_ID, THEME_ID, "Dawn", ScanOrigin.MANUAL, STANDARD_QUOTA),
    ).rejects.toThrow("Scan limit reached: 1 of 1 scans used this week.");
    expect(mockTx.scan.create).not.toHaveBeenCalled();
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
    expect(result).toEqual({ items: scans, hasNextPage: false });
  });

  it("returns hasNextPage: false when no limit is provided (no over-fetch)", async () => {
    const scans = [baseScan];
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID);

    expect(result.hasNextPage).toBe(false);
    expect(result.items).toEqual(scans);
  });

  it("applies the limit option when provided (fetches limit+1 for next-page detection)", async () => {
    const scans = [baseScan];
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID, { limit: 5 });

    // The model fetches limit+1 rows internally for next-page detection.
    expect(mockDb.scan.findMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
      orderBy: { createdAt: "desc" },
      take: 6,
    });
    expect(result).toEqual({ items: scans, hasNextPage: false });
  });

  it("returns hasNextPage: true and slices items when DB returns limit+1 rows", async () => {
    // Simulate DB returning 6 rows when limit=5 — signals a next page exists.
    const scans = Array.from({ length: 6 }, (_, i) => ({ ...baseScan, id: `scan-${i}` }));
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID, { limit: 5 });

    expect(result.hasNextPage).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(result.items).toEqual(scans.slice(0, 5));
  });

  it("returns hasNextPage: false when DB returns exactly limit rows", async () => {
    const scans = Array.from({ length: 5 }, (_, i) => ({ ...baseScan, id: `scan-${i}` }));
    mockDb.scan.findMany.mockResolvedValue(scans);

    const result = await getScansForShop(SHOP_ID, { limit: 5 });

    expect(result.hasNextPage).toBe(false);
    expect(result.items).toHaveLength(5);
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

  it("returns empty items and hasNextPage: false when the shop has no scans", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    const result = await getScansForShop(SHOP_ID);

    expect(result).toEqual({ items: [], hasNextPage: false });
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

  it("returns the most recent successful (COMPLETED or PARTIAL) scan before the given date", async () => {
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
        status: { in: [ScanStatus.COMPLETED, ScanStatus.PARTIAL] },
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

  it("filters to successful (COMPLETED + PARTIAL) scans, excluding PENDING/IN_PROGRESS/FAILED", async () => {
    // The function filters by status in [COMPLETED, PARTIAL] — verify the where clause.
    mockDb.scan.findFirst.mockResolvedValue(null);

    await getPreviousScanForTheme(SHOP_ID, THEME_ID, new Date());

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).toContain(ScanStatus.PARTIAL);
    expect(callArg.where.status.in).not.toContain(ScanStatus.PENDING);
    expect(callArg.where.status.in).not.toContain(ScanStatus.IN_PROGRESS);
    expect(callArg.where.status.in).not.toContain(ScanStatus.FAILED);
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
// getLatestSuccessfulScanForTheme (LOG-7)
// ---------------------------------------------------------------------------

describe("getLatestSuccessfulScanForTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the createdAt of the most recent successful scan for the theme", async () => {
    const createdAt = new Date("2026-03-10T08:00:00Z");
    mockDb.scan.findFirst.mockResolvedValue({ createdAt });

    const result = await getLatestSuccessfulScanForTheme(SHOP_ID, THEME_ID);

    expect(mockDb.scan.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        themeId: THEME_ID,
        status: { in: [ScanStatus.COMPLETED, ScanStatus.PARTIAL] },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    expect(result).toEqual({ createdAt });
  });

  it("returns null when no successful scan exists (e.g. only a FAILED scan)", async () => {
    mockDb.scan.findFirst.mockResolvedValue(null);

    const result = await getLatestSuccessfulScanForTheme(SHOP_ID, THEME_ID);

    expect(result).toBeNull();
  });

  it("filters to COMPLETED + PARTIAL only, excluding PENDING/IN_PROGRESS/FAILED", async () => {
    mockDb.scan.findFirst.mockResolvedValue(null);

    await getLatestSuccessfulScanForTheme(SHOP_ID, THEME_ID);

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).toContain(ScanStatus.PARTIAL);
    expect(callArg.where.status.in).not.toContain(ScanStatus.PENDING);
    expect(callArg.where.status.in).not.toContain(ScanStatus.IN_PROGRESS);
    expect(callArg.where.status.in).not.toContain(ScanStatus.FAILED);
  });

  it("orders newest-first so the latest successful scan is returned", async () => {
    mockDb.scan.findFirst.mockResolvedValue(null);

    await getLatestSuccessfulScanForTheme(SHOP_ID, THEME_ID);

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.orderBy).toEqual({ createdAt: "desc" });
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
        origin: ScanOrigin.MANUAL,
        createdAt: { gte: since },
        status: { in: [ScanStatus.COMPLETED, ScanStatus.PARTIAL, ScanStatus.IN_PROGRESS] },
      },
    });
    expect(result).toBe(3);
  });

  it("filters to COMPLETED, PARTIAL, and IN_PROGRESS statuses (excludes FAILED and PENDING)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await countScansForShopSince(SHOP_ID, new Date("2026-01-01T00:00:00Z"));

    const callArg = mockDb.scan.count.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).toContain(ScanStatus.PARTIAL);
    expect(callArg.where.status.in).toContain(ScanStatus.IN_PROGRESS);
    expect(callArg.where.status.in).not.toContain(ScanStatus.FAILED);
    expect(callArg.where.status.in).not.toContain(ScanStatus.PENDING);
  });

  it("filters to origin=MANUAL so SCHEDULED and AUTO_PUBLISH scans are exempt (GC-iji)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await countScansForShopSince(SHOP_ID, new Date("2026-01-01T00:00:00Z"));

    const callArg = mockDb.scan.count.mock.calls[0][0];
    expect(callArg.where.origin).toBe(ScanOrigin.MANUAL);
  });

  it("counts only MANUAL scans in a mixed-origin period (excludes SCHEDULED + AUTO_PUBLISH)", async () => {
    // Behavioural check: a period containing 2 MANUAL, 1 SCHEDULED, 1 AUTO_PUBLISH
    // scan must report a manual usage of 2. Simulate the DB honouring the
    // where.origin filter.
    const periodScans = [
      { origin: ScanOrigin.MANUAL },
      { origin: ScanOrigin.SCHEDULED },
      { origin: ScanOrigin.AUTO_PUBLISH },
      { origin: ScanOrigin.MANUAL },
    ];
    mockDb.scan.count.mockImplementation(
      async ({ where }: { where: { origin?: ScanOrigin } }) =>
        periodScans.filter((s) => where.origin === undefined || s.origin === where.origin).length,
    );

    const result = await countScansForShopSince(SHOP_ID, new Date("2026-06-01T00:00:00Z"));

    expect(result).toBe(2);
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

  it("queries successful (COMPLETED + PARTIAL) scans (not PENDING, IN_PROGRESS, or FAILED)", async () => {
    mockDb.scan.count.mockResolvedValue(0);

    await hasCompletedScans(SHOP_ID);

    expect(mockDb.scan.count).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        status: { in: [ScanStatus.COMPLETED, ScanStatus.PARTIAL] },
      },
    });
  });

  it("propagates a database error", async () => {
    mockDb.scan.count.mockRejectedValue(new Error("DB unavailable"));

    await expect(hasCompletedScans(SHOP_ID)).rejects.toThrow("DB unavailable");
  });
});

// ---------------------------------------------------------------------------
// buildStaleScanWhere (LOG-6, #2-A) — per-status staleness predicate
//
// These replace the old single-`createdAt`-cutoff expireStaleScans tests. The
// previous behaviour aged BOTH PENDING and IN_PROGRESS scans from createdAt with
// one threshold, which falsely expired legitimately long-running IN_PROGRESS
// scans (the LOG-6 bug). The new predicate ages IN_PROGRESS from startedAt.
// ---------------------------------------------------------------------------

describe("buildStaleScanWhere", () => {
  const THRESHOLDS = { pendingMaxAgeMinutes: 15, inProgressMaxAgeMinutes: 30 };

  /** The PENDING branch of the OR predicate. */
  function pendingBranch(where: ReturnType<typeof buildStaleScanWhere>) {
    return (where.OR as Array<Record<string, unknown>>).find(
      (b) => b.status === ScanStatus.PENDING,
    ) as { status: ScanStatus; createdAt: { lt: Date } };
  }

  /** The IN_PROGRESS branch of the OR predicate. */
  function inProgressBranch(where: ReturnType<typeof buildStaleScanWhere>) {
    return (where.OR as Array<Record<string, unknown>>).find(
      (b) => b.status === ScanStatus.IN_PROGRESS,
    ) as {
      status: ScanStatus;
      OR: [{ startedAt: { lt: Date } }, { startedAt: null; createdAt: { lt: Date } }];
    };
  }

  it("ORs exactly two status-specific branches (PENDING and IN_PROGRESS)", () => {
    const where = buildStaleScanWhere(THRESHOLDS);
    expect(where.OR).toHaveLength(2);
    expect(pendingBranch(where)).toBeDefined();
    expect(inProgressBranch(where)).toBeDefined();
  });

  it("ages PENDING scans from createdAt using the pending threshold", () => {
    vi.setSystemTime(1_700_000_000_000);
    const where = buildStaleScanWhere(THRESHOLDS);
    const branch = pendingBranch(where);
    expect(branch.createdAt.lt).toEqual(new Date(1_700_000_000_000 - 15 * 60 * 1000));
    // PENDING must NOT be keyed off startedAt (a PENDING scan has none).
    expect(branch).not.toHaveProperty("startedAt");
    vi.useRealTimers();
  });

  it("ages IN_PROGRESS scans from startedAt, NOT createdAt (the core LOG-6 regression)", () => {
    vi.setSystemTime(1_700_000_000_000);
    const where = buildStaleScanWhere(THRESHOLDS);
    const branch = inProgressBranch(where);
    const expectedCutoff = new Date(1_700_000_000_000 - 30 * 60 * 1000);

    // Primary condition: startedAt older than the in-progress cutoff. This is
    // what lets an IN_PROGRESS scan with an old createdAt but a recent startedAt
    // survive — the regression the LOG-6 fix is about.
    expect(branch.OR[0]).toEqual({ startedAt: { lt: expectedCutoff } });
    vi.useRealTimers();
  });

  it("falls back to createdAt for IN_PROGRESS rows whose startedAt is null", () => {
    vi.setSystemTime(1_700_000_000_000);
    const where = buildStaleScanWhere(THRESHOLDS);
    const branch = inProgressBranch(where);
    const expectedCutoff = new Date(1_700_000_000_000 - 30 * 60 * 1000);

    expect(branch.OR[1]).toEqual({ startedAt: null, createdAt: { lt: expectedCutoff } });
    vi.useRealTimers();
  });

  it("uses a longer cutoff for IN_PROGRESS than for PENDING", () => {
    vi.setSystemTime(1_700_000_000_000);
    const where = buildStaleScanWhere(THRESHOLDS);
    const pendingCutoff = pendingBranch(where).createdAt.lt.getTime();
    const inProgressCutoff = inProgressBranch(where).OR[0].startedAt.lt.getTime();
    // A longer threshold means the cutoff is further in the past (smaller epoch).
    expect(inProgressCutoff).toBeLessThan(pendingCutoff);
    vi.useRealTimers();
  });

  it("never matches COMPLETED, PARTIAL, or FAILED scans (no such branch)", () => {
    const where = buildStaleScanWhere(THRESHOLDS);
    const statuses = (where.OR as Array<{ status: ScanStatus }>).map((b) => b.status);
    expect(statuses).not.toContain(ScanStatus.COMPLETED);
    expect(statuses).not.toContain(ScanStatus.PARTIAL);
    expect(statuses).not.toContain(ScanStatus.FAILED);
  });
});

// ---------------------------------------------------------------------------
// expireStaleScans (LOG-6, #2-A) — now takes per-status thresholds
// ---------------------------------------------------------------------------

describe("expireStaleScans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues an updateMany using exactly the buildStaleScanWhere predicate", async () => {
    vi.setSystemTime(1_700_000_000_000);
    mockDb.scan.updateMany.mockResolvedValue({ count: 2 });

    const result = await expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS);

    expect(mockDb.scan.updateMany).toHaveBeenCalledOnce();
    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    // The UPDATE predicate must equal the count predicate (DRY: shared builder).
    // Time is frozen so both produce identical Date cutoffs.
    expect(callArg.where).toEqual(buildStaleScanWhere(DEFAULT_STALE_SCAN_THRESHOLDS));
    expect(result).toBe(2);
    vi.useRealTimers();
  });

  it("marks matched scans FAILED and stamps completedAt", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 1 });

    await expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS);

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    expect(callArg.data.status).toBe(ScanStatus.FAILED);
    expect(callArg.data).toHaveProperty("completedAt");
  });

  it("returns 0 when no stale scans exist", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS);

    expect(result).toBe(0);
  });

  it("propagates a database error", async () => {
    mockDb.scan.updateMany.mockRejectedValue(new Error("DB connection lost"));

    await expect(expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS)).rejects.toThrow(
      "DB connection lost",
    );
  });
});

// ---------------------------------------------------------------------------
// finalizeScan resurrection guard (LOG-6, #2-A)
// ---------------------------------------------------------------------------

describe("finalizeScan", () => {
  const FINALIZE_ARGS = {
    status: ScanStatus.COMPLETED as typeof ScanStatus.COMPLETED,
    findingCount: 3,
    skippedCategories: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finalizes an IN_PROGRESS scan via a conditional updateMany (happy path)", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 1 });

    const result = await finalizeScan("scan-1", FINALIZE_ARGS);

    expect(mockDb.scan.updateMany).toHaveBeenCalledOnce();
    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    // Guard is in the WHERE: only an IN_PROGRESS row may be transitioned.
    expect(callArg.where).toEqual({ id: "scan-1", status: ScanStatus.IN_PROGRESS });
    expect(callArg.data.status).toBe(ScanStatus.COMPLETED);
    expect(callArg.data.findingCount).toBe(3);
    expect(callArg.data.skippedCategories).toEqual([]);
    expect(callArg.data).toHaveProperty("completedAt");
    expect(result).toEqual({ finalized: true });
  });

  it("persists PARTIAL status and skippedCategories on the happy path", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 1 });

    await finalizeScan("scan-1", {
      status: ScanStatus.PARTIAL,
      findingCount: 5,
      skippedCategories: ["GHOST_TAG", "GHOST_PRICE"],
    });

    const callArg = mockDb.scan.updateMany.mock.calls[0][0];
    expect(callArg.data.status).toBe(ScanStatus.PARTIAL);
    expect(callArg.data.skippedCategories).toEqual(["GHOST_TAG", "GHOST_PRICE"]);
  });

  it("does NOT revive a scan the watchdog already marked FAILED", async () => {
    // updateMany matches zero rows because the scan is no longer IN_PROGRESS.
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });
    mockDb.scan.findUnique.mockResolvedValue({ status: ScanStatus.FAILED });

    const result = await finalizeScan("scan-1", FINALIZE_ARGS);

    // Returns finalized:false (no throw → no Inngest retry storm) and never
    // issues a second, unconditional write that could resurrect the scan.
    expect(result).toEqual({ finalized: false });
    expect(mockDb.scan.update).not.toHaveBeenCalled();
  });

  it("logs a warning with the scan id and current status when the guard blocks the write", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });
    mockDb.scan.findUnique.mockResolvedValue({ status: ScanStatus.FAILED });

    await finalizeScan("scan-1", FINALIZE_ARGS);

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    const [message, context] = mockLoggerWarn.mock.calls[0];
    expect(message).toContain("finalizeScan skipped");
    expect(context).toMatchObject({
      scanId: "scan-1",
      attemptedStatus: ScanStatus.COMPLETED,
      currentStatus: ScanStatus.FAILED,
    });
  });

  it("logs currentStatus MISSING when the scan row has vanished", async () => {
    mockDb.scan.updateMany.mockResolvedValue({ count: 0 });
    mockDb.scan.findUnique.mockResolvedValue(null);

    const result = await finalizeScan("scan-1", FINALIZE_ARGS);

    expect(result).toEqual({ finalized: false });
    expect(mockLoggerWarn.mock.calls[0][1]).toMatchObject({ currentStatus: "MISSING" });
  });

  it("is race-safe: only one of two concurrent finalize attempts wins", async () => {
    // Simulate the DB awarding the IN_PROGRESS row to the first writer only.
    mockDb.scan.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mockDb.scan.findUnique.mockResolvedValue({ status: ScanStatus.COMPLETED });

    const [first, second] = await Promise.all([
      finalizeScan("scan-1", FINALIZE_ARGS),
      finalizeScan("scan-1", FINALIZE_ARGS),
    ]);

    const finalizedFlags = [first.finalized, second.finalized];
    expect(finalizedFlags.filter(Boolean)).toHaveLength(1);
    expect(finalizedFlags.filter((f) => f === false)).toHaveLength(1);
  });

  it("propagates a database error from the conditional write", async () => {
    mockDb.scan.updateMany.mockRejectedValue(new Error("DB write failed"));

    await expect(finalizeScan("scan-1", FINALIZE_ARGS)).rejects.toThrow("DB write failed");
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
    expect(firstCallArg.where.status.in).toContain(ScanStatus.PARTIAL);
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

// ---------------------------------------------------------------------------
// getCompletedScansForShop
// ---------------------------------------------------------------------------

describe("getCompletedScansForShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns successful (COMPLETED + PARTIAL) scans (status filter)", async () => {
    const rows = [
      { id: "scan-3", completedAt: new Date("2026-03-20T10:00:00Z"), themeName: "Dawn" },
    ];
    mockDb.scan.findMany.mockResolvedValue(rows);

    await getCompletedScansForShop(SHOP_ID);

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg.where.status.in).toContain(ScanStatus.COMPLETED);
    expect(callArg.where.status.in).toContain(ScanStatus.PARTIAL);
    expect(callArg.where.shopId).toBe(SHOP_ID);
  });

  it("orders by completedAt descending (newest first)", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getCompletedScansForShop(SHOP_ID);

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg.orderBy).toEqual({ completedAt: "desc" });
  });

  it("applies the limit parameter when provided", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getCompletedScansForShop(SHOP_ID, { limit: 5 });

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(5);
  });

  it("defaults to limit of 7 when no limit is specified", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getCompletedScansForShop(SHOP_ID);

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(7);
  });

  it("selects only id, completedAt, and themeName fields", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    await getCompletedScansForShop(SHOP_ID);

    const callArg = mockDb.scan.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({ id: true, completedAt: true, themeName: true });
  });

  it("returns an empty array when no completed scans exist", async () => {
    mockDb.scan.findMany.mockResolvedValue([]);

    const result = await getCompletedScansForShop(SHOP_ID);

    expect(result).toEqual([]);
  });

  it("returns the scans array when completed scans exist", async () => {
    const rows = [
      { id: "scan-3", completedAt: new Date("2026-03-20T10:00:00Z"), themeName: "Dawn" },
      { id: "scan-2", completedAt: new Date("2026-03-10T10:00:00Z"), themeName: "Craft" },
    ];
    mockDb.scan.findMany.mockResolvedValue(rows);

    const result = await getCompletedScansForShop(SHOP_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(rows[0]);
    expect(result[1]).toEqual(rows[1]);
  });

  it("filters out rows where completedAt is null (guards against unexpected null column values)", async () => {
    const rows = [
      { id: "scan-3", completedAt: new Date("2026-03-20T10:00:00Z"), themeName: "Dawn" },
      // Simulate a row where completedAt is unexpectedly null despite COMPLETED status.
      { id: "scan-bad", completedAt: null, themeName: "Broken" },
    ];
    mockDb.scan.findMany.mockResolvedValue(rows);

    const result = await getCompletedScansForShop(SHOP_ID);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("scan-3");
  });

  it("propagates a database error", async () => {
    mockDb.scan.findMany.mockRejectedValue(new Error("Connection refused"));

    await expect(getCompletedScansForShop(SHOP_ID)).rejects.toThrow("Connection refused");
  });
});
