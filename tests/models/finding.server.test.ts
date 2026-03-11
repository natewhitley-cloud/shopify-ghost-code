/**
 * Tests for app/models/finding.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function in isolation.
 *   - completeScanWithFindings wraps a $transaction — the mock factory calls
 *     the callback immediately with a tx-scoped mock client.
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations. Use vi.hoisted() for objects referenced inside a
 * vi.mock factory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FindingType, ScanStatus, Severity } from "@prisma/client";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Inner tx-scoped mock — shared between the $transaction callback and assertions.
const mockTx = vi.hoisted(() => ({
  finding: {
    createMany: vi.fn(),
  },
  scan: {
    update: vi.fn(),
  },
}));

const mockDb = vi.hoisted(() => ({
  finding: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  scan: {
    update: vi.fn(),
  },
  // $transaction receives an array of operations in completeScanWithFindings,
  // so we simulate the array-form: resolve with the resolved values of each operation.
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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
  completeScanWithFindings,
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
  appName: null,
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

    await expect(createFindings(SCAN_ID, [baseFinding])).rejects.toThrow(
      "DB write failed",
    );
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

    await expect(countFindingsBySeverity(SCAN_ID)).rejects.toThrow(
      "Aggregation failed",
    );
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

    await expect(getFindingSummary(SCAN_ID)).rejects.toThrow(
      "Type aggregation failed",
    );
  });
});

// ---------------------------------------------------------------------------
// completeScanWithFindings
// ---------------------------------------------------------------------------

describe("completeScanWithFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls $transaction with finding createMany + scan update when findings are non-empty", async () => {
    // The function passes an array of promise-returning calls to $transaction.
    // Our mock resolves each element individually.
    mockDb.finding.createMany.mockResolvedValue({ count: 1 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID, status: ScanStatus.COMPLETED });

    await completeScanWithFindings(SCAN_ID, [baseFinding]);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    // Verify that both the finding insert and the scan update were staged.
    expect(mockDb.finding.createMany).toHaveBeenCalledWith({
      data: [{ ...baseFinding, scanId: SCAN_ID }],
    });
    expect(mockDb.scan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SCAN_ID },
        data: expect.objectContaining({
          status: ScanStatus.COMPLETED,
          findingCount: 1,
        }),
      }),
    );
  });

  it("skips finding createMany but still updates scan when findings array is empty", async () => {
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID, status: ScanStatus.COMPLETED });

    await completeScanWithFindings(SCAN_ID, []);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    // No findings — createMany should not have been called.
    expect(mockDb.finding.createMany).not.toHaveBeenCalled();
    // But the scan must still be marked COMPLETED with count 0.
    expect(mockDb.scan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SCAN_ID },
        data: expect.objectContaining({
          status: ScanStatus.COMPLETED,
          findingCount: 0,
        }),
      }),
    );
  });

  it("sets completedAt timestamp on the scan update", async () => {
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await completeScanWithFindings(SCAN_ID, []);

    const updateCallArg = mockDb.scan.update.mock.calls[0][0];
    expect(updateCallArg.data).toHaveProperty("completedAt");
    expect(updateCallArg.data.completedAt).toBeInstanceOf(Date);
  });

  it("propagates a $transaction error", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("Transaction rolled back"));

    await expect(completeScanWithFindings(SCAN_ID, [baseFinding])).rejects.toThrow(
      "Transaction rolled back",
    );
  });

  it("correctly counts multiple findings in the findingCount field", async () => {
    mockDb.finding.createMany.mockResolvedValue({ count: 3 });
    mockDb.scan.update.mockResolvedValue({ id: SCAN_ID });

    await completeScanWithFindings(SCAN_ID, [baseFinding, anotherFinding, baseFinding]);

    const updateCallArg = mockDb.scan.update.mock.calls[0][0];
    expect(updateCallArg.data.findingCount).toBe(3);
  });
});
