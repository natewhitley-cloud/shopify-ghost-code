/**
 * Tests for app/models/speed-report.server.ts (gc-wt3y). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  speedReport: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  opsEvent: { count: vi.fn() },
  shop: { findUnique: vi.fn(), updateMany: vi.fn() },
  pageSpeedDailyUsage: { updateMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { RUN_NOW_COOLDOWN_MS } from "../../app/lib/speed-report";
import {
  claimFreeSpeedTest,
  claimSpeedReportRunNow,
  countFreeSpeedTestAttempts,
  createSpeedReport,
  failAbandonedSpeedReport,
  finishSpeedReport,
  getAbandonedSpeedReportCalls,
  getFreeSpeedTestUsedAt,
  hasRecentSpeedReportEvent,
  recordSpeedReportCall,
  startManualSpeedReport,
  startSpeedReportForRun,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
  releaseSpeedReportRunNow,
  reservePageSpeedCall,
  SPEED_REPORT_HISTORY_TAKE,
  utcDayKey,
} from "../../app/models/speed-report.server";

const NOW = new Date("2026-10-11T23:59:59.999Z");

beforeEach(() => {
  vi.resetAllMocks();
  // finishSpeedReport always writes through one transaction (gc-au2l).
  mockDb.$transaction.mockResolvedValue([]);
});

describe("reports", () => {
  it("createSpeedReport starts a RUNNING row for the shop", async () => {
    mockDb.speedReport.create.mockResolvedValue({ id: "r1", createdAt: NOW });
    await createSpeedReport("s1", "MANUAL");
    expect(mockDb.speedReport.create).toHaveBeenCalledWith({
      data: { shopId: "s1", origin: "MANUAL", status: "RUNNING" },
      select: { id: true, createdAt: true },
    });
  });

  it("finishSpeedReport writes status, reason, pages, calls and completedAt", async () => {
    await finishSpeedReport("r1", {
      status: "COMPLETED",
      failureReason: null,
      pages: [
        { page: "home", status: "OK", url: "https://a.example/", runsAttempted: 3, runsOk: 3 },
      ],
      psiCalls: 3,
    });
    const arg = mockDb.speedReport.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "r1" });
    expect(arg.data).toMatchObject({ status: "COMPLETED", failureReason: null });
    expect(arg.data.pages).toHaveLength(1);
    expect(arg.data.completedAt).toBeInstanceOf(Date);
    // The calls are a raise-only write of their own (gc-au2l), never part of
    // the plain update, which could lower the count recorded call by call.
    expect(arg.data).not.toHaveProperty("psiCalls");
    expect(mockDb.speedReport.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", psiCalls: { lt: 3 } },
      data: { psiCalls: 3 },
    });
  });

  it("finishSpeedReport stores DbNull (not JSON null) when there are no pages", async () => {
    await finishSpeedReport("r1", {
      status: "FAILED",
      failureReason: "not_configured",
      pages: null,
      psiCalls: 0,
    });
    expect(mockDb.speedReport.update.mock.calls[0][0].data.pages).toBe(Prisma.DbNull);
  });

  it("getRecentSpeedReports reads newest first, bounded", async () => {
    mockDb.speedReport.findMany.mockResolvedValue([]);
    await getRecentSpeedReports("s1");
    expect(mockDb.speedReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "s1" },
        orderBy: { createdAt: "desc" },
        take: SPEED_REPORT_HISTORY_TAKE,
      }),
    );
    expect(mockDb.speedReport.findMany.mock.calls[0][0].select).toMatchObject({ startedAt: true });
  });
});

describe("run tracking (gc-wt3y #2/#3/#8)", () => {
  it("startSpeedReportForRun is keyed on the run: a retried prepare reuses the row", async () => {
    mockDb.speedReport.upsert.mockResolvedValue({ id: "r1" });
    expect(await startSpeedReportForRun("s1", "SCHEDULED", "run-1", NOW)).toEqual({ id: "r1" });
    expect(mockDb.speedReport.upsert).toHaveBeenCalledWith({
      where: { runId: "run-1" },
      create: {
        shopId: "s1",
        origin: "SCHEDULED",
        status: "RUNNING",
        runId: "run-1",
        startedAt: NOW,
      },
      update: {},
      select: { id: true },
    });
  });

  it("startManualSpeedReport stamps run + start time on the still-RUNNING row only", async () => {
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 1 });
    expect(await startManualSpeedReport("r9", "run-2", NOW)).toBe(true);
    expect(mockDb.speedReport.updateMany).toHaveBeenCalledWith({
      where: { id: "r9", status: "RUNNING" },
      data: { runId: "run-2", startedAt: NOW },
    });
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 0 });
    expect(await startManualSpeedReport("gone", "run-2", NOW)).toBe(false);
  });

  it("failAbandonedSpeedReport closes only a RUNNING row of this shop, by run or report id", async () => {
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 1 });
    expect(
      await failAbandonedSpeedReport(
        { shopId: "s1", runId: "run-1", reportId: "r9" },
        "stuck",
        NOW,
      ),
    ).toBe(1);
    expect(mockDb.speedReport.updateMany).toHaveBeenCalledWith({
      where: { shopId: "s1", status: "RUNNING", OR: [{ runId: "run-1" }, { id: "r9" }] },
      data: { status: "FAILED", failureReason: "stuck", completedAt: NOW },
    });
  });

  it("failAbandonedSpeedReport tolerates a missing row (count 0, no throw) and needs no report id", async () => {
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await failAbandonedSpeedReport({ shopId: "s1", runId: "run-1" }, "worker_failed", NOW),
    ).toBe(0);
    expect(mockDb.speedReport.updateMany.mock.calls[0][0].where.OR).toEqual([{ runId: "run-1" }]);
  });
});

describe("hasRecentSpeedReportEvent (gc-wt3y #9)", () => {
  it("counts this shop's speed_report events with that reason since the cutoff", async () => {
    mockDb.opsEvent.count.mockResolvedValue(1);
    const since = new Date(NOW.getTime() - 3_600_000);
    expect(await hasRecentSpeedReportEvent("a.myshopify.com", "not_configured", since)).toBe(true);
    expect(mockDb.opsEvent.count).toHaveBeenCalledWith({
      where: {
        eventType: "speed_report",
        key: "a.myshopify.com",
        createdAt: { gte: since },
        metadata: { path: ["reason"], equals: "not_configured" },
      },
    });
    mockDb.opsEvent.count.mockResolvedValue(0);
    expect(await hasRecentSpeedReportEvent("a.myshopify.com", "not_configured", since)).toBe(false);
  });
});

describe("run-now claim", () => {
  it("claims atomically: null, or a previous claim at least 24h old (boundary inclusive)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimSpeedReportRunNow("s1", NOW)).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        id: "s1",
        OR: [
          { speedReportRequestedAt: null },
          { speedReportRequestedAt: { lte: new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS) } },
        ],
      },
      data: { speedReportRequestedAt: NOW },
    });
  });

  it("loses the claim when the conditional update matches nothing", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimSpeedReportRunNow("s1", NOW)).resolves.toBe(false);
  });

  it("release restores the previous value only if our claim is still in place", async () => {
    const prev = new Date("2026-10-09T00:00:00Z");
    await releaseSpeedReportRunNow("s1", NOW, prev);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", speedReportRequestedAt: NOW },
      data: { speedReportRequestedAt: prev },
    });
  });

  it("getSpeedReportRequestedAt returns null for a missing shop", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    await expect(getSpeedReportRequestedAt("nope")).resolves.toBeNull();
  });
});

describe("reservePageSpeedCall (global daily budget)", () => {
  it("keys the budget on the UTC day", () => {
    expect(utcDayKey(NOW)).toBe("2026-10-11");
    expect(utcDayKey(new Date("2026-10-12T00:00:00.000Z"))).toBe("2026-10-12");
  });

  it("reserves by a conditional increment (calls < budget)", async () => {
    mockDb.pageSpeedDailyUsage.updateMany.mockResolvedValue({ count: 1 });
    await expect(reservePageSpeedCall(5000, NOW)).resolves.toBe(true);
    expect(mockDb.pageSpeedDailyUsage.updateMany).toHaveBeenCalledWith({
      where: { day: "2026-10-11", calls: { lt: 5000 } },
      data: { calls: { increment: 1 } },
    });
    expect(mockDb.pageSpeedDailyUsage.create).not.toHaveBeenCalled();
  });

  it("creates the day's row with calls = 1 on the first call of the day", async () => {
    mockDb.pageSpeedDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    mockDb.pageSpeedDailyUsage.create.mockResolvedValue({});
    await expect(reservePageSpeedCall(5000, NOW)).resolves.toBe(true);
    expect(mockDb.pageSpeedDailyUsage.create).toHaveBeenCalledWith({
      data: { day: "2026-10-11", calls: 1 },
    });
  });

  it("refuses when the day's row exists and is exhausted (create hits the unique key)", async () => {
    mockDb.pageSpeedDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    mockDb.pageSpeedDailyUsage.create.mockRejectedValue({ code: "P2002" });
    await expect(reservePageSpeedCall(5000, NOW)).resolves.toBe(false);
    expect(mockDb.pageSpeedDailyUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it("wins the retry when a concurrent first call created the row", async () => {
    mockDb.pageSpeedDailyUsage.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockDb.pageSpeedDailyUsage.create.mockRejectedValue({ code: "P2002" });
    await expect(reservePageSpeedCall(5000, NOW)).resolves.toBe(true);
  });

  it("rethrows any other DB error (the caller's step retries; nothing was called yet)", async () => {
    mockDb.pageSpeedDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    mockDb.pageSpeedDailyUsage.create.mockRejectedValue(new Error("db down"));
    await expect(reservePageSpeedCall(5000, NOW)).rejects.toThrow("db down");
  });

  it("a budget of 0 reserves nothing and touches no row", async () => {
    await expect(reservePageSpeedCall(0, NOW)).resolves.toBe(false);
    expect(mockDb.pageSpeedDailyUsage.updateMany).not.toHaveBeenCalled();
    expect(mockDb.pageSpeedDailyUsage.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Free speed test
// ---------------------------------------------------------------------------

describe("free speed test", () => {
  const RESULT = {
    status: "COMPLETED" as const,
    failureReason: null,
    pages: [],
    psiCalls: 3,
  };

  it("getRecentSpeedReports can be narrowed to one origin", async () => {
    mockDb.speedReport.findMany.mockResolvedValue([]);
    await getRecentSpeedReports("s1", { origin: "FREE_TEST" });
    expect(mockDb.speedReport.findMany.mock.calls[0][0].where).toEqual({
      shopId: "s1",
      origin: "FREE_TEST",
    });
  });

  it("claimFreeSpeedTest: one conditional write, the 24h slot AND the test unused", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimFreeSpeedTest("s1", NOW)).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        freeSpeedTestUsedAt: null,
        id: "s1",
        OR: [
          { speedReportRequestedAt: null },
          { speedReportRequestedAt: { lte: new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS) } },
        ],
      },
      data: { speedReportRequestedAt: NOW },
    });
  });

  it("claimFreeSpeedTest loses when the conditional write matches nothing (used, or within 24h)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimFreeSpeedTest("s1", NOW)).resolves.toBe(false);
  });

  it("two concurrent claims against one shop row: exactly one wins", async () => {
    // A tiny in-memory row honouring the conditional where (as Postgres does
    // per row): the second write sees the first one's stamp.
    const row = { speedReportRequestedAt: null as Date | null, freeSpeedTestUsedAt: null };
    mockDb.shop.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { speedReportRequestedAt: Date };
      }) => {
        await Promise.resolve();
        const cutoff = (
          (where.OR as Array<{ speedReportRequestedAt: { lte: Date } | null }>)[1]
            .speedReportRequestedAt as { lte: Date }
        ).lte;
        const slotFree =
          row.speedReportRequestedAt === null || row.speedReportRequestedAt <= cutoff;
        const unused = !("freeSpeedTestUsedAt" in where) || row.freeSpeedTestUsedAt === null;
        if (!slotFree || !unused) return { count: 0 };
        row.speedReportRequestedAt = data.speedReportRequestedAt;
        return { count: 1 };
      },
    );
    const results = await Promise.all([
      claimFreeSpeedTest("s1", NOW),
      claimFreeSpeedTest("s1", NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("finishSpeedReport without a consume: the update and the raise-only calls write, no shop write", async () => {
    mockDb.speedReport.update.mockReturnValue("UPDATE");
    mockDb.speedReport.updateMany.mockReturnValue("RAISE");
    mockDb.$transaction.mockResolvedValue([{ id: "r1" }, { count: 1 }]);
    await expect(finishSpeedReport("r1", RESULT)).resolves.toEqual({ id: "r1" });
    expect(mockDb.$transaction).toHaveBeenCalledWith(["UPDATE", "RAISE"]);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(mockDb.speedReport.update).toHaveBeenCalledTimes(1);
  });

  it("finishSpeedReport consuming the free test: report + conditional stamp in ONE transaction", async () => {
    mockDb.speedReport.update.mockReturnValue("UPDATE");
    mockDb.speedReport.updateMany.mockReturnValue("RAISE");
    mockDb.shop.updateMany.mockReturnValue("STAMP");
    mockDb.$transaction.mockResolvedValue([{ id: "r1" }, { count: 1 }, { count: 1 }]);
    await expect(finishSpeedReport("r1", RESULT, { consumeFreeTestOf: "s1" })).resolves.toEqual({
      id: "r1",
    });
    expect(mockDb.$transaction).toHaveBeenCalledWith(["UPDATE", "RAISE", "STAMP"]);
    const stamp = mockDb.shop.updateMany.mock.calls[0][0];
    expect(stamp.where).toEqual({ id: "s1", freeSpeedTestUsedAt: null });
    // The stamp is the report's own completedAt.
    expect(stamp.data.freeSpeedTestUsedAt).toEqual(
      mockDb.speedReport.update.mock.calls[0][0].data.completedAt,
    );
  });

  it("getFreeSpeedTestUsedAt: the stamp, or null for a missing shop", async () => {
    const at = new Date("2026-10-10T00:00:00Z");
    mockDb.shop.findUnique.mockResolvedValueOnce({ freeSpeedTestUsedAt: at });
    await expect(getFreeSpeedTestUsedAt("s1")).resolves.toEqual(at);
    mockDb.shop.findUnique.mockResolvedValueOnce(null);
    await expect(getFreeSpeedTestUsedAt("nope")).resolves.toBeNull();
  });

  it("countFreeSpeedTestAttempts: only FREE_TEST reports that reached Google and were not stopped by the daily ceiling", async () => {
    mockDb.speedReport.count.mockResolvedValueOnce(3);
    await expect(countFreeSpeedTestAttempts("s1")).resolves.toBe(3);
    // psiCalls > 0 excludes every run that never reached Google
    // (dispatch_failed, a worker that died or got stuck before its first
    // call, not_configured, not_eligible) and a password page, which all end
    // with 0 calls; SKIPPED_BUDGET excludes the daily ceiling.
    expect(mockDb.speedReport.count).toHaveBeenCalledWith({
      where: {
        shopId: "s1",
        origin: "FREE_TEST",
        psiCalls: { gt: 0 },
        status: { not: "SKIPPED_BUDGET" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Calls recorded as they happen (gc-au2l)
// ---------------------------------------------------------------------------

describe("calls recorded as they happen (gc-au2l)", () => {
  type Row = { id: string; shopId: string; origin: string; status: string; psiCalls: number };

  /**
   * One in-memory SpeedReport row behind the mocked Prisma calls, honouring
   * the conditions the model sends (as Postgres does per row). A write is
   * applied when it is awaited or run by $transaction, never when it is built.
   */
  function useRow(row: Row) {
    const write = (apply: () => unknown) => ({
      run: apply,
      then: (resolve: (v: unknown) => unknown) => resolve(apply()),
    });
    mockDb.speedReport.update.mockImplementation(
      ({ data }: { data: Partial<Row> & Record<string, unknown> }) =>
        write(() => Object.assign(row, data)),
    );
    mockDb.speedReport.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id?: string; status?: string; psiCalls?: { lt: number } };
        data: { psiCalls?: number | { increment: number }; status?: string };
      }) =>
        write(() => {
          if (where.id !== undefined && where.id !== row.id) return { count: 0 };
          if (where.status !== undefined && where.status !== row.status) return { count: 0 };
          if (where.psiCalls && !(row.psiCalls < where.psiCalls.lt)) return { count: 0 };
          if (typeof data.psiCalls === "number") row.psiCalls = data.psiCalls;
          else if (data.psiCalls) row.psiCalls += data.psiCalls.increment;
          if (data.status) row.status = data.status;
          return { count: 1 };
        }),
    );
    mockDb.$transaction.mockImplementation(async (ops: Array<{ run: () => unknown }>) =>
      ops.map((op) => op.run()),
    );
    mockDb.speedReport.count.mockImplementation(
      async ({
        where,
      }: {
        where: {
          shopId: string;
          origin: string;
          psiCalls: { gt: number };
          status: { not: string };
        };
      }) =>
        row.shopId === where.shopId &&
        row.origin === where.origin &&
        row.psiCalls > where.psiCalls.gt &&
        row.status !== where.status.not
          ? 1
          : 0,
    );
  }

  const freeRow = (): Row => ({
    id: "r1",
    shopId: "s1",
    origin: "FREE_TEST",
    status: "RUNNING",
    psiCalls: 0,
  });

  it("recordSpeedReportCall adds exactly one call to the report, in one atomic increment", async () => {
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 1 });
    await expect(recordSpeedReportCall("r1")).resolves.toBeUndefined();
    expect(mockDb.speedReport.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.speedReport.updateMany).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { psiCalls: { increment: 1 } },
    });
  });

  it("recordSpeedReportCall tolerates a missing row (shop redacted): no throw", async () => {
    mockDb.speedReport.updateMany.mockResolvedValue({ count: 0 });
    await expect(recordSpeedReportCall("gone")).resolves.toBeUndefined();
  });

  it.each([
    // [recorded call by call, counted by finalize, stored afterwards]
    [3, 2, 3], // a replayed step: the higher number is what was spent
    [1, 1, 1],
    [6, 6, 6],
    [2, 0, 2], // never lowered to 0 either
    [0, 2, 2], // a row with nothing recorded still gets the finalize count
    [0, 0, 0],
  ])(
    "finishSpeedReport never lowers psiCalls: recorded %i, finalize counts %i -> %i",
    async (recorded, counted, stored) => {
      const row = { ...freeRow(), psiCalls: recorded };
      useRow(row);
      await finishSpeedReport("r1", {
        status: "FAILED",
        failureReason: "timeout",
        pages: [],
        psiCalls: counted,
      });
      expect(row.psiCalls).toBe(stored);
      expect(row.status).toBe("FAILED");
    },
  );

  it("finishSpeedReport consuming the free test never lowers psiCalls either", async () => {
    const row = { ...freeRow(), psiCalls: 4 };
    useRow(row);
    mockDb.shop.updateMany.mockReturnValue({ run: () => ({ count: 1 }) });
    await finishSpeedReport(
      "r1",
      { status: "COMPLETED", failureReason: null, pages: [], psiCalls: 3 },
      { consumeFreeTestOf: "s1" },
    );
    expect(row.psiCalls).toBe(4);
    expect(row.status).toBe("COMPLETED");
  });

  it("an abandoned FREE_TEST run that made a call counts toward the attempt cap", async () => {
    const row = freeRow();
    useRow(row);
    await recordSpeedReportCall("r1");
    // The worker died after the call: the run never finished its own report.
    await failAbandonedSpeedReport({ shopId: "s1", runId: "run-1", reportId: "r1" }, "stuck", NOW);
    expect(row).toMatchObject({ status: "FAILED", psiCalls: 1 });
    await expect(countFreeSpeedTestAttempts("s1")).resolves.toBe(1);
  });

  it("an abandoned FREE_TEST run that made no call does not count", async () => {
    const row = freeRow();
    useRow(row);
    await failAbandonedSpeedReport(
      { shopId: "s1", runId: "run-1", reportId: "r1" },
      "worker_failed",
      NOW,
    );
    expect(row).toMatchObject({ status: "FAILED", psiCalls: 0 });
    await expect(countFreeSpeedTestAttempts("s1")).resolves.toBe(0);
  });

  it("getAbandonedSpeedReportCalls sums the calls of the run's report, by run or report id", async () => {
    mockDb.speedReport.aggregate.mockResolvedValue({ _sum: { psiCalls: 2 } });
    await expect(
      getAbandonedSpeedReportCalls({ shopId: "s1", runId: "run-1", reportId: "r9" }),
    ).resolves.toBe(2);
    expect(mockDb.speedReport.aggregate).toHaveBeenCalledWith({
      where: { shopId: "s1", OR: [{ runId: "run-1" }, { id: "r9" }] },
      _sum: { psiCalls: true },
    });
  });

  it("getAbandonedSpeedReportCalls tolerates a missing row (0) and needs no report id", async () => {
    mockDb.speedReport.aggregate.mockResolvedValue({ _sum: { psiCalls: null } });
    await expect(getAbandonedSpeedReportCalls({ shopId: "s1", runId: "run-1" })).resolves.toBe(0);
    expect(mockDb.speedReport.aggregate.mock.calls[0][0].where.OR).toEqual([{ runId: "run-1" }]);
  });
});
