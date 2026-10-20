/**
 * Tests for app/models/scan-change.server.ts (gc-rrh.4). db.server is mocked
 * (no database): the call shapes are pinned, plus an in-memory upsert that
 * proves a retried write leaves one row.
 */
import { ScanStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  scan: { findUnique: vi.fn() },
  scanChangeSet: { upsert: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { CHANGE_SET_VERSION, emptyCounts, emptyFootnotes } from "../../app/lib/change-log";
import {
  type ChangeSetWrite,
  getLatestPublishedChangeSetBefore,
  getScanForChangeLog,
  upsertScanChangeSet,
} from "../../app/models/scan-change.server";

const WRITE: ChangeSetWrite = {
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/1",
  baselineScanId: "scan-0",
  kind: "compared",
  checkKind: "weekly",
  onPublishedTheme: true,
  themeName: "Dawn",
  themeVersion: "15.2.0",
  changeCount: 1,
  worthALookCount: 0,
  checksRan: 30,
  counts: { ...emptyCounts(), filesChanged: 1 },
  rows: [
    {
      key: "file_edit:sections/header.liquid",
      type: "file_edit",
      app: null,
      lane: "housekeeping",
      worthALook: false,
      files: [{ path: "sections/header.liquid", status: "changed", changedAt: 1 }],
      moreFiles: 0,
      noIssuesInNewVersion: true,
      scanId: "scan-1",
    },
  ],
  footnotes: emptyFootnotes(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertScanChangeSet", () => {
  it("creates the row keyed by scan id, with the encoding version", async () => {
    mockDb.scanChangeSet.upsert.mockResolvedValue({ scanId: "scan-1" });
    await upsertScanChangeSet("scan-1", WRITE);
    const args = mockDb.scanChangeSet.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ scanId: "scan-1" });
    expect(args.create).toEqual({ scanId: "scan-1", ...WRITE, version: CHANGE_SET_VERSION });
    expect(args.update).toEqual({ ...WRITE, version: CHANGE_SET_VERSION });
    expect(args.select).toEqual({ scanId: true });
  });

  it("a retried write rewrites the one row (idempotent), never a duplicate", async () => {
    const rows = new Map<string, unknown>();
    mockDb.scanChangeSet.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { scanId: string };
        create: object;
        update: object;
      }) => {
        rows.set(
          where.scanId,
          rows.has(where.scanId) ? { ...(rows.get(where.scanId) as object), ...update } : create,
        );
        return { scanId: where.scanId };
      },
    );
    await upsertScanChangeSet("scan-1", { ...WRITE, changeCount: 0, rows: [] });
    await upsertScanChangeSet("scan-1", WRITE);
    expect(rows.size).toBe(1);
    expect(rows.get("scan-1")).toMatchObject({ changeCount: 1, rows: WRITE.rows });
  });

  it("propagates a write error (the worker step decides it never fails the scan)", async () => {
    mockDb.scanChangeSet.upsert.mockRejectedValue(new Error("db down"));
    await expect(upsertScanChangeSet("scan-1", WRITE)).rejects.toThrow("db down");
  });
});

describe("getScanForChangeLog", () => {
  it("reads one scan with its findings, unknown scripts and domains in one query", async () => {
    mockDb.scan.findUnique.mockResolvedValue({ id: "scan-1", status: ScanStatus.COMPLETED });
    await expect(getScanForChangeLog("scan-1")).resolves.toMatchObject({ id: "scan-1" });
    const args = mockDb.scan.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ id: "scan-1" });
    expect(Object.keys(args.select)).toEqual(
      expect.arrayContaining([
        "findings",
        "unknownScripts",
        "scanDomains",
        "liveAppHooks",
        "themeInfo",
        "shop",
      ]),
    );
    expect(mockDb.scan.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([ScanStatus.COMPLETED, ScanStatus.PARTIAL])("a %s scan is returned", async (status) => {
    mockDb.scan.findUnique.mockResolvedValue({ id: "s", status });
    await expect(getScanForChangeLog("s")).resolves.not.toBeNull();
  });

  it.each([ScanStatus.FAILED, ScanStatus.IN_PROGRESS, ScanStatus.PENDING])(
    "a %s scan is never compared (null)",
    async (status) => {
      mockDb.scan.findUnique.mockResolvedValue({ id: "s", status });
      await expect(getScanForChangeLog("s")).resolves.toBeNull();
    },
  );

  it("a missing scan: null", async () => {
    mockDb.scan.findUnique.mockResolvedValue(null);
    await expect(getScanForChangeLog("nope")).resolves.toBeNull();
  });
});

describe("getLatestPublishedChangeSetBefore", () => {
  it("the newest published-theme set from an earlier scan, excluding the current one", async () => {
    mockDb.scanChangeSet.findFirst.mockResolvedValue({ scanId: "s0", themeId: "t0" });
    const before = new Date("2026-10-19T06:40:00Z");
    await expect(getLatestPublishedChangeSetBefore("shop-1", before, "s1")).resolves.toEqual({
      scanId: "s0",
      themeId: "t0",
    });
    expect(mockDb.scanChangeSet.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        onPublishedTheme: true,
        scanId: { not: "s1" },
        scan: { createdAt: { lt: before } },
      },
      orderBy: [{ scan: { createdAt: "desc" } }, { scanId: "desc" }],
      select: { scanId: true, themeId: true },
    });
  });

  it("orders by the scan's createdAt, not the change set's compute time (no false second switch)", async () => {
    // A cron scan of theme A started (06:00) before the merchant published B,
    // but computed its change set (06:30) after B's scan (06:10, computed 06:15).
    const sets = [
      {
        scanId: "scan-a",
        themeId: "theme-A",
        createdAt: new Date("2026-10-19T06:30:00Z"),
        scan: { createdAt: new Date("2026-10-19T06:00:00Z") },
      },
      {
        scanId: "scan-b",
        themeId: "theme-B",
        createdAt: new Date("2026-10-19T06:15:00Z"),
        scan: { createdAt: new Date("2026-10-19T06:10:00Z") },
      },
    ];
    type Key = "createdAt" | "scanId";
    type Order = { [K in Key]?: "desc" | "asc" } & { scan?: { createdAt: "desc" | "asc" } };
    // In-memory findFirst honouring the where/orderBy shapes used here.
    mockDb.scanChangeSet.findFirst.mockImplementation(
      async ({
        where,
        orderBy,
      }: {
        where: { scan: { createdAt: { lt: Date } } };
        orderBy: Order[];
      }) => {
        const value = (row: (typeof sets)[number], o: Order) =>
          o.scan
            ? row.scan.createdAt.getTime()
            : o.createdAt
              ? row.createdAt.getTime()
              : row.scanId;
        const sorted = sets
          .filter((r) => r.scan.createdAt < where.scan.createdAt.lt)
          .sort((x, y) => {
            for (const o of orderBy) {
              const a = value(x, o);
              const b = value(y, o);
              if (a !== b) return a < b ? 1 : -1;
            }
            return 0;
          });
        return sorted[0] ? { scanId: sorted[0].scanId, themeId: sorted[0].themeId } : null;
      },
    );
    await expect(
      getLatestPublishedChangeSetBefore("shop-1", new Date("2026-10-26T06:40:00Z"), "scan-c"),
    ).resolves.toEqual({ scanId: "scan-b", themeId: "theme-B" });
  });

  it("none: null", async () => {
    mockDb.scanChangeSet.findFirst.mockResolvedValue(null);
    await expect(getLatestPublishedChangeSetBefore("shop-1", new Date(), "s1")).resolves.toBeNull();
  });
});
