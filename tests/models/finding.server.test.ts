/**
 * Tests for app/models/finding.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function in isolation.
 *   - saveThemeFindings wraps a $transaction — the mock factory calls
 *     the callback immediately with a tx-scoped mock client.
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations. Use vi.hoisted() for objects referenced inside a
 * vi.mock factory.
 */

import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  finding: {
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    groupBy: vi.fn(),
  },
  scan: {
    update: vi.fn(),
  },
  // $transaction supports both the interactive (callback) and array forms.
  // saveThemeFindings uses the interactive form: pass a tx-scoped client
  // to the callback so the inner awaits execute against the same mockDb.
  $transaction: vi.fn(
    async (arg: ((tx: typeof mockDb) => Promise<unknown>) | Promise<unknown>[]) => {
      if (typeof arg === "function") {
        return arg(mockDb);
      }
      return Promise.all(arg);
    },
  ),
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createFindings,
  getAppAttributionForScan,
  countFindingsBySeverity,
  getDistinctFileCount,
  getFindingFilterOptionsForScan,
  getFindingsForScan,
  getFindingsPageForScan,
  getFindingSummary,
  getSeverityCountsForScans,
  getTypeCountsForScan,
  getHighestSeverityFinding,
  saveThemeFindings,
  type CreateFindingInput,
} from "../../app/models/finding.server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SCAN_ID = "scan-abc";

const baseFinding: CreateFindingInput = {
  filename: "layout/theme.liquid",
  lineNumber: 42,
  codeSnippet: '<script src="https://cdn.oldapp.com/widget.js"></script>',
  findingType: FindingType.GHOST_SCRIPT,
  severity: Severity.HIGH,
  appName: "OldApp",
  description: "Ghost script from uninstalled app OldApp",
};

const anotherFinding: CreateFindingInput = {
  filename: "snippets/app-badge.liquid",
  lineNumber: 5,
  codeSnippet: "{% render 'removed-snippet' %}",
  findingType: FindingType.GHOST_SNIPPET,
  severity: Severity.MEDIUM,
  appName: undefined,
  description: "Snippet reference to removed file",
};

// ---------------------------------------------------------------------------
// createFindings
// ---------------------------------------------------------------------------

describe("createFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { count: 0 } immediately when findings array is empty", async () => {
    const result = await createFindings(SCAN_ID, []);

    expect(mockDb.finding.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it("calls db.finding.createMany with scanId merged into each finding", async () => {
    mockDb.finding.createMany.mockResolvedValue({ count: 2 });

    const result = await createFindings(SCAN_ID, [baseFinding, anotherFinding]);

    expect(mockDb.finding.createMany).toHaveBeenCalledOnce();
    expect(mockDb.finding.createMany).toHaveBeenCalledWith({
      data: [
        { ...baseFinding, scanId: SCAN_ID },
        { ...anotherFinding, scanId: SCAN_ID },
      ],
    });
    expect(result).toEqual({ count: 2 });
  });

  it("handles a single finding correctly", async () => {
    mockDb.finding.createMany.mockResolvedValue({ count: 1 });

    await createFindings(SCAN_ID, [baseFinding]);

    expect(mockDb.finding.createMany).toHaveBeenCalledWith({
      data: [{ ...baseFinding, scanId: SCAN_ID }],
    });
  });

  it("propagates a database error", async () => {
    mockDb.finding.createMany.mockRejectedValue(new Error("DB write failed"));

    await expect(createFindings(SCAN_ID, [baseFinding])).rejects.toThrow("DB write failed");
  });
});

// ---------------------------------------------------------------------------
// getFindingsForScan
// ---------------------------------------------------------------------------

describe("getFindingsForScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all findings when no filters are applied", async () => {
    const findings = [{ id: "f1", ...baseFinding, scanId: SCAN_ID }];
    mockDb.finding.findMany.mockResolvedValue(findings);

    const result = await getFindingsForScan(SCAN_ID);

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID },
      orderBy: [{ severity: "asc" }, { filename: "asc" }],
    });
    expect(result).toEqual(findings);
  });

  it("filters by severity when provided", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsForScan(SCAN_ID, { severity: Severity.HIGH });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID, severity: Severity.HIGH },
      orderBy: [{ severity: "asc" }, { filename: "asc" }],
    });
  });

  it("filters by findingType when provided", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsForScan(SCAN_ID, { findingType: FindingType.GHOST_SCRIPT });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID, findingType: FindingType.GHOST_SCRIPT },
      orderBy: [{ severity: "asc" }, { filename: "asc" }],
    });
  });

  it("applies both severity and findingType filters simultaneously", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsForScan(SCAN_ID, {
      severity: Severity.MEDIUM,
      findingType: FindingType.GHOST_SNIPPET,
    });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: {
        scanId: SCAN_ID,
        severity: Severity.MEDIUM,
        findingType: FindingType.GHOST_SNIPPET,
      },
      orderBy: [{ severity: "asc" }, { filename: "asc" }],
    });
  });

  it("returns an empty array (not null) when no findings match", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    const result = await getFindingsForScan(SCAN_ID);

    expect(result).toEqual([]);
  });

  it("propagates a database error", async () => {
    mockDb.finding.findMany.mockRejectedValue(new Error("Query error"));

    await expect(getFindingsForScan(SCAN_ID)).rejects.toThrow("Query error");
  });
});

// ---------------------------------------------------------------------------
// countFindingsBySeverity
// ---------------------------------------------------------------------------

describe("countFindingsBySeverity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns normalised counts for all severity levels", async () => {
    mockDb.finding.groupBy.mockResolvedValue([
      { severity: Severity.HIGH, _count: { severity: 3 } },
      { severity: Severity.MEDIUM, _count: { severity: 2 } },
      { severity: Severity.LOW, _count: { severity: 1 } },
    ]);

    const result = await countFindingsBySeverity(SCAN_ID);

    expect(result).toEqual({
      [Severity.HIGH]: 3,
      [Severity.MEDIUM]: 2,
      [Severity.LOW]: 1,
    });
  });

  it("returns zeros for severity levels with no findings", async () => {
    mockDb.finding.groupBy.mockResolvedValue([
      { severity: Severity.HIGH, _count: { severity: 5 } },
    ]);

    const result = await countFindingsBySeverity(SCAN_ID);

    expect(result[Severity.HIGH]).toBe(5);
    expect(result[Severity.MEDIUM]).toBe(0);
    expect(result[Severity.LOW]).toBe(0);
  });

  it("returns all-zero counts when the scan has no findings", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    const result = await countFindingsBySeverity(SCAN_ID);

    expect(result).toEqual({
      [Severity.HIGH]: 0,
      [Severity.MEDIUM]: 0,
      [Severity.LOW]: 0,
    });
  });

  it("calls groupBy with the correct arguments", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    await countFindingsBySeverity(SCAN_ID);

    expect(mockDb.finding.groupBy).toHaveBeenCalledWith({
      by: ["severity"],
      where: { scanId: SCAN_ID },
      _count: { severity: true },
    });
  });

  it("propagates a database error", async () => {
    mockDb.finding.groupBy.mockRejectedValue(new Error("Aggregation failed"));

    await expect(countFindingsBySeverity(SCAN_ID)).rejects.toThrow("Aggregation failed");
  });
});

// ---------------------------------------------------------------------------
// getFindingSummary
// ---------------------------------------------------------------------------

describe("getFindingSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns total, bySeverity, and byType with correct values", async () => {
    // First groupBy call = bySeverity, second = byType (Promise.all order)
    mockDb.finding.groupBy
      .mockResolvedValueOnce([
        { severity: Severity.HIGH, _count: { severity: 2 } },
        { severity: Severity.LOW, _count: { severity: 1 } },
      ])
      .mockResolvedValueOnce([
        { findingType: FindingType.GHOST_SCRIPT, _count: { findingType: 2 } },
        { findingType: FindingType.GHOST_SNIPPET, _count: { findingType: 1 } },
      ]);

    const result = await getFindingSummary(SCAN_ID);

    expect(result.total).toBe(3);
    expect(result.bySeverity[Severity.HIGH]).toBe(2);
    expect(result.bySeverity[Severity.MEDIUM]).toBe(0);
    expect(result.bySeverity[Severity.LOW]).toBe(1);
    expect(result.byType[FindingType.GHOST_SCRIPT]).toBe(2);
    expect(result.byType[FindingType.GHOST_SNIPPET]).toBe(1);
    expect(result.byType[FindingType.ORPHAN_ASSET]).toBe(0);
  });

  it("returns zero total and all-zero counts when scan has no findings", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    const result = await getFindingSummary(SCAN_ID);

    expect(result.total).toBe(0);
    expect(result.bySeverity[Severity.HIGH]).toBe(0);
    expect(result.byType[FindingType.GHOST_SCRIPT]).toBe(0);
  });

  it("runs both groupBy queries in parallel (calls groupBy twice)", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    await getFindingSummary(SCAN_ID);

    expect(mockDb.finding.groupBy).toHaveBeenCalledTimes(2);
  });

  it("propagates a database error from either parallel query", async () => {
    mockDb.finding.groupBy
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Type aggregation failed"));

    await expect(getFindingSummary(SCAN_ID)).rejects.toThrow("Type aggregation failed");
  });
});

// ---------------------------------------------------------------------------
// getSeverityCountsForScans
// ---------------------------------------------------------------------------

describe("getSeverityCountsForScans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty Map without querying when scanIds is empty", async () => {
    const result = await getSeverityCountsForScans([]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(mockDb.finding.groupBy).not.toHaveBeenCalled();
  });

  it("issues a single groupBy over [scanId, severity] scoped to the requested ids", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    await getSeverityCountsForScans(["scan-a", "scan-b"]);

    expect(mockDb.finding.groupBy).toHaveBeenCalledOnce();
    expect(mockDb.finding.groupBy).toHaveBeenCalledWith({
      by: ["scanId", "severity"],
      where: { scanId: { in: ["scan-a", "scan-b"] } },
      _count: { severity: true },
    });
  });

  it("buckets counts per scan and severity across multiple scans", async () => {
    mockDb.finding.groupBy.mockResolvedValue([
      { scanId: "scan-a", severity: Severity.HIGH, _count: { severity: 2 } },
      { scanId: "scan-a", severity: Severity.LOW, _count: { severity: 1 } },
      { scanId: "scan-b", severity: Severity.MEDIUM, _count: { severity: 4 } },
    ]);

    const result = await getSeverityCountsForScans(["scan-a", "scan-b"]);

    expect(result.get("scan-a")).toEqual({
      [Severity.HIGH]: 2,
      [Severity.MEDIUM]: 0,
      [Severity.LOW]: 1,
    });
    expect(result.get("scan-b")).toEqual({
      [Severity.HIGH]: 0,
      [Severity.MEDIUM]: 4,
      [Severity.LOW]: 0,
    });
  });

  it("returns a zeroed record for a requested scan that has no findings", async () => {
    // groupBy returns rows only for scan-a; scan-b has zero findings.
    mockDb.finding.groupBy.mockResolvedValue([
      { scanId: "scan-a", severity: Severity.HIGH, _count: { severity: 3 } },
    ]);

    const result = await getSeverityCountsForScans(["scan-a", "scan-b"]);

    // Every requested id is present, even the one with no findings.
    expect(result.size).toBe(2);
    expect(result.get("scan-b")).toEqual({
      [Severity.HIGH]: 0,
      [Severity.MEDIUM]: 0,
      [Severity.LOW]: 0,
    });
  });

  it("propagates a database error", async () => {
    mockDb.finding.groupBy.mockRejectedValue(new Error("Batch aggregation failed"));

    await expect(getSeverityCountsForScans(["scan-a"])).rejects.toThrow("Batch aggregation failed");
  });
});

// ---------------------------------------------------------------------------
// saveThemeFindings
//
// LOG-4: persistence is decoupled from completion. saveThemeFindings writes the
// theme findings and updates findingCount but deliberately leaves the scan
// IN_PROGRESS — it must NOT set a terminal status or completedAt. The terminal
// status is set later by finalizeScan() after all audit steps run.
// ---------------------------------------------------------------------------

describe("saveThemeFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls $transaction with deleteMany + finding createMany + findingCount update when findings are non-empty", async () => {
    mockDb.finding.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.finding.createMany.mockResolvedValue({ count: 1 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await saveThemeFindings(SCAN_ID, [baseFinding]);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    // Idempotency guard: deleteMany must be called first (clearing prior findings).
    expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({ where: { scanId: SCAN_ID } });
    expect(mockDb.finding.createMany).toHaveBeenCalledWith({
      data: [{ ...baseFinding, scanId: SCAN_ID }],
    });
    expect(mockDb.scan.update).toHaveBeenCalledWith({
      where: { id: SCAN_ID },
      data: { findingCount: 1 },
    });
  });

  it("does NOT set a terminal status or completedAt (scan stays IN_PROGRESS)", async () => {
    mockDb.finding.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.finding.createMany.mockResolvedValue({ count: 1 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await saveThemeFindings(SCAN_ID, [baseFinding]);

    const updateCallArg = mockDb.scan.update.mock.calls[0][0];
    // The whole point of LOG-4: no status, no completedAt at the persistence step.
    expect(updateCallArg.data).not.toHaveProperty("status");
    expect(updateCallArg.data).not.toHaveProperty("completedAt");
  });

  it("calls deleteMany even when findings array is empty (idempotency guard always runs)", async () => {
    mockDb.finding.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await saveThemeFindings(SCAN_ID, []);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    // deleteMany must still be called even with no findings.
    expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({ where: { scanId: SCAN_ID } });
    // No findings — createMany should not have been called.
    expect(mockDb.finding.createMany).not.toHaveBeenCalled();
    // findingCount is still updated to 0 (no status change).
    expect(mockDb.scan.update).toHaveBeenCalledWith({
      where: { id: SCAN_ID },
      data: { findingCount: 0 },
    });
  });

  it("is idempotent: calling twice produces the same result (deleteMany clears prior findings)", async () => {
    mockDb.finding.deleteMany.mockResolvedValue({ count: 1 }); // second call clears 1 prior finding
    mockDb.finding.createMany.mockResolvedValue({ count: 1 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    // First call, then a second call (Inngest retry scenario).
    await saveThemeFindings(SCAN_ID, [baseFinding]);
    await saveThemeFindings(SCAN_ID, [baseFinding]);

    expect(mockDb.finding.deleteMany).toHaveBeenCalledTimes(2);
    expect(mockDb.finding.createMany).toHaveBeenCalledTimes(2);
    const firstCallData = mockDb.finding.createMany.mock.calls[0][0];
    const secondCallData = mockDb.finding.createMany.mock.calls[1][0];
    expect(firstCallData).toEqual(secondCallData);
  });

  it("propagates a $transaction error", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("Transaction rolled back"));

    await expect(saveThemeFindings(SCAN_ID, [baseFinding])).rejects.toThrow(
      "Transaction rolled back",
    );
  });

  it("correctly counts multiple findings in the findingCount field", async () => {
    mockDb.finding.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.finding.createMany.mockResolvedValue({ count: 3 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await saveThemeFindings(SCAN_ID, [baseFinding, anotherFinding, baseFinding]);

    const updateCallArg = mockDb.scan.update.mock.calls[0][0];
    expect(updateCallArg.data.findingCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getTypeCountsForScan
// ---------------------------------------------------------------------------

describe("getTypeCountsForScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls groupBy with by:[findingType] scoped to the scan", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    await getTypeCountsForScan(SCAN_ID);

    expect(mockDb.finding.groupBy).toHaveBeenCalledOnce();
    expect(mockDb.finding.groupBy).toHaveBeenCalledWith({
      by: ["findingType"],
      where: { scanId: SCAN_ID },
      _count: { findingType: true },
    });
  });

  it("returns a fully zero-seeded record covering all 26 FindingType members", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    const result = await getTypeCountsForScan(SCAN_ID);

    const keys = Object.keys(result);
    expect(keys).toHaveLength(26);
    // Every enum member present and defaulted to 0.
    for (const type of Object.values(FindingType)) {
      expect(result[type]).toBe(0);
    }
  });

  it("fills counts from grouped rows and leaves the rest at zero", async () => {
    mockDb.finding.groupBy.mockResolvedValue([
      { findingType: FindingType.GHOST_SCRIPT, _count: { findingType: 4 } },
      { findingType: FindingType.GHOST_PIXEL, _count: { findingType: 2 } },
    ]);

    const result = await getTypeCountsForScan(SCAN_ID);

    expect(result[FindingType.GHOST_SCRIPT]).toBe(4);
    expect(result[FindingType.GHOST_PIXEL]).toBe(2);
    // An untouched type stays at its seeded zero.
    expect(result[FindingType.ORPHAN_ASSET]).toBe(0);
  });

  it("returns all zeros for an empty scan", async () => {
    mockDb.finding.groupBy.mockResolvedValue([]);

    const result = await getTypeCountsForScan(SCAN_ID);

    const total = Object.values(result).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(0);
  });

  it("propagates a database error", async () => {
    mockDb.finding.groupBy.mockRejectedValue(new Error("Type aggregation failed"));

    await expect(getTypeCountsForScan(SCAN_ID)).rejects.toThrow("Type aggregation failed");
  });
});

// ---------------------------------------------------------------------------
// getHighestSeverityFinding
// ---------------------------------------------------------------------------

describe("getHighestSeverityFinding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the finding when one exists for the scan", async () => {
    const finding = {
      id: "finding-1",
      scanId: SCAN_ID,
      ...baseFinding,
      createdAt: new Date("2026-01-15T10:00:00Z"),
    };
    mockDb.finding.findFirst.mockResolvedValue(finding);

    const result = await getHighestSeverityFinding(SCAN_ID);

    expect(result).toEqual(finding);
  });

  it("returns null when the scan has no findings", async () => {
    mockDb.finding.findFirst.mockResolvedValue(null);

    const result = await getHighestSeverityFinding(SCAN_ID);

    expect(result).toBeNull();
  });

  it("passes orderBy [{ severity: 'asc' }, { createdAt: 'asc' }] to ensure HIGH comes first", async () => {
    // Prisma sorts enums by declaration order; the schema declares HIGH, MEDIUM, LOW,
    // so ascending sort places HIGH first. The secondary createdAt sort is a tiebreaker.
    mockDb.finding.findFirst.mockResolvedValue(null);

    await getHighestSeverityFinding(SCAN_ID);

    expect(mockDb.finding.findFirst).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID },
      orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
    });
  });

  it("propagates a database error", async () => {
    mockDb.finding.findFirst.mockRejectedValueOnce(new Error("Connection lost"));

    await expect(getHighestSeverityFinding(SCAN_ID)).rejects.toThrow("Connection lost");
  });
});

// ---------------------------------------------------------------------------
// getDistinctFileCount
// ---------------------------------------------------------------------------

describe("getDistinctFileCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the count of distinct filenames for a scan", async () => {
    mockDb.finding.findMany.mockResolvedValue([
      { filename: "layout/theme.liquid" },
      { filename: "snippets/app-badge.liquid" },
      { filename: "assets/app.css" },
    ]);

    const result = await getDistinctFileCount(SCAN_ID);

    expect(result).toBe(3);
  });

  it("returns 0 when no findings exist for the scan", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    const result = await getDistinctFileCount(SCAN_ID);

    expect(result).toBe(0);
  });

  it("passes scanId, distinct on filename, and filename select to findMany", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getDistinctFileCount(SCAN_ID);

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID },
      select: { filename: true },
      distinct: ["filename"],
    });
  });

  it("counts each unique filename once even when findings share the same file", async () => {
    // The DB deduplication is handled by Prisma's distinct — the mock returns
    // already-deduped rows (simulating what Prisma would return).
    mockDb.finding.findMany.mockResolvedValue([
      { filename: "layout/theme.liquid" },
      { filename: "snippets/app-badge.liquid" },
    ]);

    const result = await getDistinctFileCount(SCAN_ID);

    expect(result).toBe(2);
  });

  it("propagates a database error", async () => {
    mockDb.finding.findMany.mockRejectedValueOnce(new Error("Distinct query failed"));

    await expect(getDistinctFileCount(SCAN_ID)).rejects.toThrow("Distinct query failed");
  });
});

// ---------------------------------------------------------------------------
// getFindingsPageForScan
// ---------------------------------------------------------------------------

describe("getFindingsPageForScan", () => {
  const PAGE_SIZE = 50;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the first page of findings when no cursor is provided", async () => {
    const rows = [{ id: "f-1", ...baseFinding, scanId: SCAN_ID }];
    mockDb.finding.findMany.mockResolvedValue(rows);

    await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scanId: SCAN_ID },
        orderBy: [{ severity: "asc" }, { filename: "asc" }, { id: "asc" }],
        take: PAGE_SIZE + 1,
      }),
    );
    // No cursor means no cursor/skip fields in the query.
    const call = mockDb.finding.findMany.mock.calls[0][0];
    expect(call).not.toHaveProperty("cursor");
    expect(call).not.toHaveProperty("skip");
  });

  it("passes cursor and skip:1 when a cursor is provided", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE, cursor: "f-50" });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "f-50" },
        skip: 1,
      }),
    );
  });

  it("returns hasNextPage:false and nextCursor:null when results fit within limit", async () => {
    // Return exactly limit rows — no over-fetch item, so no next page.
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `f-${i}`,
      ...baseFinding,
      scanId: SCAN_ID,
    }));
    mockDb.finding.findMany.mockResolvedValue(rows);

    const result = await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE });

    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(PAGE_SIZE);
  });

  it("returns hasNextPage:true and nextCursor equal to last item id when over-fetch item exists", async () => {
    // Return limit+1 rows — the extra item signals another page.
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
      id: `f-${i}`,
      ...baseFinding,
      scanId: SCAN_ID,
    }));
    mockDb.finding.findMany.mockResolvedValue(rows);

    const result = await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE });

    expect(result.hasNextPage).toBe(true);
    // nextCursor is the id of the last item in the returned page (index limit-1),
    // not the over-fetch item (index limit).
    expect(result.nextCursor).toBe(`f-${PAGE_SIZE - 1}`);
    expect(result.items).toHaveLength(PAGE_SIZE);
  });

  it("returns empty items, hasNextPage:false, and null nextCursor when scan has no findings", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    const result = await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE });

    expect(result.items).toHaveLength(0);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("returns a single-item page when the scan has exactly one finding", async () => {
    const rows = [{ id: "f-only", ...baseFinding, scanId: SCAN_ID }];
    mockDb.finding.findMany.mockResolvedValue(rows);

    const result = await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("f-only");
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("propagates a database error", async () => {
    mockDb.finding.findMany.mockRejectedValueOnce(new Error("Page query failed"));

    await expect(getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE })).rejects.toThrow(
      "Page query failed",
    );
  });

  // ------- Server-side filters (severity / findingType / appName) -------

  it("filters by severity only (threads severity into the where clause)", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE, severity: Severity.HIGH });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scanId: SCAN_ID, severity: Severity.HIGH } }),
    );
  });

  it("filters by findingType only", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, {
      limit: PAGE_SIZE,
      findingType: FindingType.GHOST_SCRIPT,
    });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scanId: SCAN_ID, findingType: FindingType.GHOST_SCRIPT },
      }),
    );
  });

  it("filters by appName only", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, { limit: PAGE_SIZE, appName: "OldApp" });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scanId: SCAN_ID, appName: "OldApp" } }),
    );
  });

  it("combines severity + findingType + appName into a single where clause", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, {
      limit: PAGE_SIZE,
      severity: Severity.MEDIUM,
      findingType: FindingType.GHOST_SNIPPET,
      appName: "OtherApp",
    });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scanId: SCAN_ID,
          severity: Severity.MEDIUM,
          findingType: FindingType.GHOST_SNIPPET,
          appName: "OtherApp",
        },
      }),
    );
  });

  it("omits filter keys entirely when filter values are empty/undefined", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, {
      limit: PAGE_SIZE,
      severity: "",
      findingType: undefined,
      appName: "",
    });

    const call = mockDb.finding.findMany.mock.calls[0][0];
    // No filter keys leak into the where clause — only scanId is present.
    expect(call.where).toEqual({ scanId: SCAN_ID });
  });

  it("preserves cursor/skip pagination alongside active filters", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingsPageForScan(SCAN_ID, {
      limit: PAGE_SIZE,
      cursor: "f-50",
      severity: Severity.LOW,
    });

    expect(mockDb.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scanId: SCAN_ID, severity: Severity.LOW },
        cursor: { id: "f-50" },
        skip: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getFindingFilterOptionsForScan
// ---------------------------------------------------------------------------

describe("getFindingFilterOptionsForScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns distinct findingType values and non-null appName values", async () => {
    // Promise.all order: types query first, apps query second.
    mockDb.finding.findMany
      .mockResolvedValueOnce([
        { findingType: FindingType.GHOST_SCRIPT },
        { findingType: FindingType.GHOST_STYLE },
      ])
      .mockResolvedValueOnce([{ appName: "AppA" }, { appName: "AppB" }]);

    const result = await getFindingFilterOptionsForScan(SCAN_ID);

    expect(result.types).toEqual([FindingType.GHOST_SCRIPT, FindingType.GHOST_STYLE]);
    expect(result.apps).toEqual(["AppA", "AppB"]);
  });

  it("issues a distinct+sorted query per axis (types over all findings, apps non-null)", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getFindingFilterOptionsForScan(SCAN_ID);

    expect(mockDb.finding.findMany).toHaveBeenNthCalledWith(1, {
      where: { scanId: SCAN_ID },
      distinct: ["findingType"],
      select: { findingType: true },
      orderBy: { findingType: "asc" },
    });
    expect(mockDb.finding.findMany).toHaveBeenNthCalledWith(2, {
      where: { scanId: SCAN_ID, appName: { not: null } },
      distinct: ["appName"],
      select: { appName: true },
      orderBy: { appName: "asc" },
    });
  });

  it("filters out any null appName rows defensively", async () => {
    mockDb.finding.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ appName: "AppA" }, { appName: null }]);

    const result = await getFindingFilterOptionsForScan(SCAN_ID);

    expect(result.apps).toEqual(["AppA"]);
  });

  it("returns empty lists when the scan has no findings", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    const result = await getFindingFilterOptionsForScan(SCAN_ID);

    expect(result).toEqual({ types: [], apps: [] });
  });

  it("propagates a database error", async () => {
    mockDb.finding.findMany.mockRejectedValue(new Error("Options query failed"));

    await expect(getFindingFilterOptionsForScan(SCAN_ID)).rejects.toThrow("Options query failed");
  });
});

// ---------------------------------------------------------------------------
// getAppAttributionForScan
// ---------------------------------------------------------------------------

describe("getAppAttributionForScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns lean attribution rows where appName is not null", async () => {
    mockDb.finding.findMany.mockResolvedValue([
      { appName: "SomeApp", filename: "layout/theme.liquid", findingType: "GHOST_SCRIPT" },
      { appName: "OtherApp", filename: "assets/style.css", findingType: "GHOST_STYLE" },
    ]);

    const result = await getAppAttributionForScan(SCAN_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      appName: "SomeApp",
      filename: "layout/theme.liquid",
      findingType: "GHOST_SCRIPT",
    });
  });

  it("queries only appName, filename, and findingType (lean select)", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    await getAppAttributionForScan(SCAN_ID);

    expect(mockDb.finding.findMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID, appName: { not: null } },
      select: { appName: true, filename: true, findingType: true },
    });
  });

  it("returns an empty array when no findings have an attributed app", async () => {
    mockDb.finding.findMany.mockResolvedValue([]);

    const result = await getAppAttributionForScan(SCAN_ID);

    expect(result).toEqual([]);
  });

  it("filters out any null appName rows at the type level (defensive guard)", async () => {
    // Simulate a row that bypassed the where clause (should not happen in practice).
    mockDb.finding.findMany.mockResolvedValue([
      { appName: "RealApp", filename: "layout/theme.liquid", findingType: "GHOST_SCRIPT" },
      { appName: null, filename: "snippets/foo.liquid", findingType: "GHOST_SNIPPET" },
    ]);

    const result = await getAppAttributionForScan(SCAN_ID);

    expect(result).toHaveLength(1);
    expect(result[0].appName).toBe("RealApp");
  });

  it("propagates a database error", async () => {
    mockDb.finding.findMany.mockRejectedValueOnce(new Error("Attribution query failed"));

    await expect(getAppAttributionForScan(SCAN_ID)).rejects.toThrow("Attribution query failed");
  });
});
