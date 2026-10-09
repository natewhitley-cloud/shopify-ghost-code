/**
 * Tests for app/models/app-removal.server.ts (gc-frda). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { AppRemovalState } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  appRemoval: { findMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  applyAppRemovalPlan,
  getAppRemovalsDetectedOnScan,
  getOpenAppRemovals,
} from "../../app/models/app-removal.server";

beforeEach(() => {
  vi.clearAllMocks();
  // Each builder returns a tagged op; $transaction resolves them in order.
  mockDb.appRemoval.createMany.mockImplementation((args) => ({ op: "createMany", args }));
  mockDb.appRemoval.updateMany.mockImplementation((args) => ({ op: "updateMany", args }));
  mockDb.$transaction.mockImplementation(async (ops: Array<{ op: string }>) =>
    ops.map((o) => ({ count: o.op === "createMany" ? 2 : 1 })),
  );
});

describe("reads", () => {
  it("getOpenAppRemovals reads REMOVED rows for the shop + theme", async () => {
    mockDb.appRemoval.findMany.mockResolvedValue([]);
    await getOpenAppRemovals("s1", "t1");
    expect(mockDb.appRemoval.findMany).toHaveBeenCalledWith({
      where: { shopId: "s1", themeId: "t1", state: AppRemovalState.REMOVED },
      select: { id: true, appName: true, leftoverCount: true, detectedScanId: true },
    });
  });

  it("getAppRemovalsDetectedOnScan reads one scan's detections, by app name", async () => {
    const rows = [{ id: "r1" }];
    mockDb.appRemoval.findMany.mockResolvedValue(rows);
    await expect(getAppRemovalsDetectedOnScan("s1", "t1", "scan1")).resolves.toBe(rows);
    expect(mockDb.appRemoval.findMany).toHaveBeenCalledWith({
      where: { shopId: "s1", themeId: "t1", detectedScanId: "scan1" },
      orderBy: { appName: "asc" },
    });
  });
});

describe("applyAppRemovalPlan", () => {
  const base = { shopId: "s1", themeId: "t1", scanId: "scan2", previousScanId: "scan1" };

  it("empty plan: no transaction", async () => {
    await expect(
      applyAppRemovalPlan({ ...base, plan: { creates: [], updates: [] } }),
    ).resolves.toEqual({ created: 0, updated: 0 });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("inserts detections idempotently (skipDuplicates on the unique key)", async () => {
    const result = await applyAppRemovalPlan({
      ...base,
      plan: {
        creates: [
          { appName: "Klaviyo", leftoverCount: 3 },
          { appName: "Privy", leftoverCount: 1 },
        ],
        updates: [],
      },
    });
    expect(mockDb.appRemoval.createMany).toHaveBeenCalledWith({
      data: [
        {
          shopId: "s1",
          themeId: "t1",
          appName: "Klaviyo",
          detectedScanId: "scan2",
          previousScanId: "scan1",
          leftoverCount: 3,
        },
        {
          shopId: "s1",
          themeId: "t1",
          appName: "Privy",
          detectedScanId: "scan2",
          previousScanId: "scan1",
          leftoverCount: 1,
        },
      ],
      skipDuplicates: true,
    });
    expect(result.created).toBe(2);
  });

  it("updates only rows still REMOVED; stamps stateChangedAt only on a state change", async () => {
    const result = await applyAppRemovalPlan({
      ...base,
      plan: {
        creates: [],
        updates: [
          { id: "r1", leftoverCount: 0, state: AppRemovalState.CLEANED },
          { id: "r2", leftoverCount: 4 },
        ],
      },
    });
    const calls = mockDb.appRemoval.updateMany.mock.calls.map((c) => c[0]);
    expect(calls[0].where).toEqual({ id: "r1", shopId: "s1", state: AppRemovalState.REMOVED });
    expect(calls[0].data).toMatchObject({ leftoverCount: 0, state: AppRemovalState.CLEANED });
    expect(calls[0].data.stateChangedAt).toBeInstanceOf(Date);
    expect(calls[1].data).toEqual({ leftoverCount: 4 });
    expect(result.updated).toBe(2);
    // One atomic transaction: createMany first, then the updates.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.$transaction.mock.calls[0][0].map((o: { op: string }) => o.op)).toEqual([
      "createMany",
      "updateMany",
      "updateMany",
    ]);
  });

  it("propagates a DB failure (the caller logs and swallows it)", async () => {
    mockDb.$transaction.mockRejectedValue(new Error("db down"));
    await expect(
      applyAppRemovalPlan({
        ...base,
        plan: { creates: [{ appName: "Klaviyo", leftoverCount: 1 }], updates: [] },
      }),
    ).rejects.toThrow("db down");
  });
});
