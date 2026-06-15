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
  getFindingsForScan,
  countFindingsBySeverity,
  getFindingSummary,
  saveThemeFindings,
  getHighestSeverityFinding,
  getDistinctFileCount,
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
