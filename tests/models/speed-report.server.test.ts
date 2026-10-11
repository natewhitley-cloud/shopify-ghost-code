/**
 * Tests for app/models/speed-report.server.ts (gc-wt3y). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  speedReport: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  shop: { findUnique: vi.fn(), updateMany: vi.fn() },
  pageSpeedDailyUsage: { updateMany: vi.fn(), create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { RUN_NOW_COOLDOWN_MS } from "../../app/lib/speed-report";
import {
  claimSpeedReportRunNow,
  createSpeedReport,
  finishSpeedReport,
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
    expect(arg.data).toMatchObject({ status: "COMPLETED", failureReason: null, psiCalls: 3 });
    expect(arg.data.pages).toHaveLength(1);
    expect(arg.data.completedAt).toBeInstanceOf(Date);
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
