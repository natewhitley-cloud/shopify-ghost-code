/**
 * Tests for app/models/app-removal.server.ts (gc-frda). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { AppRemovalState } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  appRemoval: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  applyAppRemovalPlan,
  getAppRemovalForScanApp,
  getAppRemovalsDetectedOnScan,
  getOpenAppRemovals,
  getRemovalNoticeRows,
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

describe("Home + scan page reads (gc-frda UI)", () => {
  it("getRemovalNoticeRows: REMOVED rows detected on the scan OR rows CLEANED on it, one query", async () => {
    const rows = [{ appName: "Klaviyo", leftoverCount: 3, state: "REMOVED" }];
    mockDb.appRemoval.findMany.mockResolvedValue(rows);
    await expect(getRemovalNoticeRows("s1", "t1", "scan2")).resolves.toBe(rows);
    expect(mockDb.appRemoval.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.appRemoval.findMany).toHaveBeenCalledWith({
      where: {
        shopId: "s1",
        themeId: "t1",
        OR: [
          { detectedScanId: "scan2", state: AppRemovalState.REMOVED },
          { stateChangedScanId: "scan2", state: AppRemovalState.CLEANED },
        ],
      },
      select: { appName: true, leftoverCount: true, state: true },
      orderBy: { appName: "asc" },
    });
  });

  it("getRemovalNoticeRows never asks for REINSTALLED rows", async () => {
    mockDb.appRemoval.findMany.mockResolvedValue([]);
    await getRemovalNoticeRows("s1", "t1", "scan2");
    expect(JSON.stringify(mockDb.appRemoval.findMany.mock.calls[0][0])).not.toContain(
      "REINSTALLED",
    );
  });

  it("getAppRemovalForScanApp is a unique-key lookup scoped to the shop + theme", async () => {
    mockDb.appRemoval.findUnique.mockResolvedValue(null);
    await expect(getAppRemovalForScanApp("s1", "t1", "Klaviyo", "scan2")).resolves.toBeNull();
    expect(mockDb.appRemoval.findUnique).toHaveBeenCalledWith({
      where: {
        shopId_themeId_appName_detectedScanId: {
          shopId: "s1",
          themeId: "t1",
          appName: "Klaviyo",
          detectedScanId: "scan2",
        },
      },
      select: { appName: true, previousScanId: true },
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
    // gc-frda UI: the scan that changed the state, so Home can say "cleaned
    // up on this scan" exactly.
    expect(calls[0].data.stateChangedScanId).toBe("scan2");
    // A count refresh is not a state change: neither stamp is written.
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
