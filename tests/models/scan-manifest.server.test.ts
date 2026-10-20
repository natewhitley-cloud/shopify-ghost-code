/**
 * Tests for app/models/scan-manifest.server.ts (gc-rrh.4).
 *
 * db.server is replaced by a small in-memory fake of `scanManifest` that
 * honours the where / orderBy / take / select shapes these functions use, so
 * keep-N pruning and baseline selection are checked on the resulting state,
 * not only on call shapes. No database is touched.
 */
import { Prisma, ScanStatus } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  scanId: string;
  shopId: string;
  themeId: string;
  version: number;
  fileCount: number;
  entries: unknown;
  appBlocks: unknown;
  createdAt: Date;
  scanStatus: ScanStatus;
};

const store = vi.hoisted(() => ({ rows: [] as Row[] }));

type Where = {
  shopId?: string;
  themeId?: string;
  version?: number;
  scanId?: { not?: string; notIn?: string[] };
  scan?: { status: { in: ScanStatus[] } };
};

function matches(row: Row, where: Where): boolean {
  if (where.shopId !== undefined && row.shopId !== where.shopId) return false;
  if (where.themeId !== undefined && row.themeId !== where.themeId) return false;
  if (where.version !== undefined && row.version !== where.version) return false;
  if (where.scanId?.not !== undefined && row.scanId === where.scanId.not) return false;
  if (where.scanId?.notIn !== undefined && where.scanId.notIn.includes(row.scanId)) return false;
  if (where.scan && !where.scan.status.in.includes(row.scanStatus)) return false;
  return true;
}

const mockDb = vi.hoisted(() => ({
  scanManifest: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { MANIFEST_VERSION, type ManifestEntry } from "../../app/lib/theme-manifest";
import {
  getLatestManifestForTheme,
  MANIFEST_KEEP_PER_THEME,
  pruneScanManifests,
  upsertScanManifest,
} from "../../app/models/scan-manifest.server";

const SHOP = "shop-1";
const THEME = "gid://shopify/Theme/1";
const ENTRIES: ManifestEntry[] = [
  ["layout/theme.liquid", "0cc175b9c0f1b6a831c399e269772661", 10, 1_760_000_000, null],
  ["snippets/klaviyo-onsite.liquid", null, 20, null, "Klaviyo"],
];

function seed(
  scanId: string,
  minute: number,
  over: Partial<Omit<Row, "scanId" | "createdAt">> = {},
): void {
  store.rows.push({
    scanId,
    shopId: SHOP,
    themeId: THEME,
    version: MANIFEST_VERSION,
    fileCount: ENTRIES.length,
    entries: ENTRIES,
    appBlocks: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)),
    scanStatus: ScanStatus.COMPLETED,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  mockDb.scanManifest.upsert.mockImplementation(
    async ({ where, create, update }: { where: { scanId: string }; create: Row; update: Row }) => {
      const at = store.rows.findIndex((r) => r.scanId === where.scanId);
      if (at >= 0) store.rows[at] = { ...store.rows[at], ...update };
      else
        store.rows.push({
          ...create,
          createdAt: new Date(),
          scanStatus: ScanStatus.IN_PROGRESS,
        });
      return { scanId: where.scanId };
    },
  );
  mockDb.scanManifest.findMany.mockImplementation(
    async ({ where, take }: { where: Where; take?: number }) => {
      const sorted = store.rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.scanId < b.scanId ? 1 : -1),
        );
      return sorted.slice(0, take ?? sorted.length);
    },
  );
  mockDb.scanManifest.deleteMany.mockImplementation(async ({ where }: { where: Where }) => {
    const before = store.rows.length;
    store.rows = store.rows.filter((r) => !matches(r, where));
    return { count: before - store.rows.length };
  });
});

describe("upsertScanManifest", () => {
  it("creates the row with version, file count, entries and app blocks", async () => {
    const appBlocks = [{ handle: "judgeme", block: "review", file: "templates/product.json" }];
    await upsertScanManifest("scan-1", {
      shopId: SHOP,
      themeId: THEME,
      entries: ENTRIES,
      appBlocks,
    });

    const args = mockDb.scanManifest.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ scanId: "scan-1" });
    expect(args.create).toEqual({
      scanId: "scan-1",
      shopId: SHOP,
      themeId: THEME,
      version: MANIFEST_VERSION,
      fileCount: 2,
      entries: ENTRIES,
      appBlocks,
    });
    expect(args.select).toEqual({ scanId: true });
  });

  it("a retry of the same scan rewrites the one row (idempotent), never a second insert", async () => {
    await upsertScanManifest("scan-1", {
      shopId: SHOP,
      themeId: THEME,
      entries: [],
      appBlocks: [],
    });
    await upsertScanManifest("scan-1", {
      shopId: SHOP,
      themeId: THEME,
      entries: ENTRIES,
      appBlocks: [],
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].fileCount).toBe(2);
    expect(store.rows[0].entries).toEqual(ENTRIES);
  });

  it("an empty theme writes an empty manifest (fileCount 0)", async () => {
    await upsertScanManifest("scan-e", {
      shopId: SHOP,
      themeId: THEME,
      entries: [],
      appBlocks: [],
    });
    expect(mockDb.scanManifest.upsert.mock.calls[0][0].create.fileCount).toBe(0);
  });

  it("appBlocks null is stored as SQL NULL (not captured), [] as captured-none", async () => {
    await upsertScanManifest("scan-n", {
      shopId: SHOP,
      themeId: THEME,
      entries: [],
      appBlocks: null,
    });
    expect(mockDb.scanManifest.upsert.mock.calls[0][0].create.appBlocks).toBe(Prisma.DbNull);
  });

  it("stores no file content: only the five-scalar entries and block refs", async () => {
    await upsertScanManifest("scan-1", {
      shopId: SHOP,
      themeId: THEME,
      entries: ENTRIES,
      appBlocks: [],
    });
    const json = JSON.stringify(mockDb.scanManifest.upsert.mock.calls[0][0].create);
    expect(json).not.toMatch(/content|<html|\{%/);
  });

  it("propagates a write error (the caller decides it never fails the scan)", async () => {
    mockDb.scanManifest.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(
      upsertScanManifest("scan-1", { shopId: SHOP, themeId: THEME, entries: [], appBlocks: [] }),
    ).rejects.toThrow("db down");
  });
});

describe("getLatestManifestForTheme", () => {
  it("none stored: null", async () => {
    await expect(getLatestManifestForTheme(SHOP, THEME)).resolves.toBeNull();
  });

  it("returns the newest finished scan's manifest, parsed", async () => {
    seed("old", 1);
    seed("new", 2);
    const latest = await getLatestManifestForTheme(SHOP, THEME);
    expect(latest).toEqual({
      scanId: "new",
      themeId: THEME,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 2)),
      entries: ENTRIES,
    });
  });

  it("excludes the current scan, so the baseline is the one before it", async () => {
    seed("prev", 1);
    seed("current", 2, { scanStatus: ScanStatus.COMPLETED });
    const latest = await getLatestManifestForTheme(SHOP, THEME, { excludeScanId: "current" });
    expect(latest?.scanId).toBe("prev");
  });

  it("a FAILED or still-running scan's manifest is never a baseline; PARTIAL is", async () => {
    seed("partial", 1, { scanStatus: ScanStatus.PARTIAL });
    seed("failed", 2, { scanStatus: ScanStatus.FAILED });
    seed("running", 3, { scanStatus: ScanStatus.IN_PROGRESS });
    expect((await getLatestManifestForTheme(SHOP, THEME))?.scanId).toBe("partial");
  });

  it("another theme (unpublished or switched) or another shop is never returned", async () => {
    seed("other-theme", 5, { themeId: "gid://shopify/Theme/2" });
    seed("other-shop", 6, { shopId: "shop-2" });
    await expect(getLatestManifestForTheme(SHOP, THEME)).resolves.toBeNull();
    expect((await getLatestManifestForTheme(SHOP, "gid://shopify/Theme/2"))?.scanId).toBe(
      "other-theme",
    );
  });

  it("another encoding version is not comparable", async () => {
    seed("v2", 1, { version: MANIFEST_VERSION + 1 });
    await expect(getLatestManifestForTheme(SHOP, THEME)).resolves.toBeNull();
    expect(mockDb.scanManifest.findMany.mock.calls[0][0].where.version).toBe(MANIFEST_VERSION);
  });

  it("a malformed newest row is skipped for the next usable one", async () => {
    seed("good", 1);
    seed("bad", 2, { entries: { not: "an array" } });
    expect((await getLatestManifestForTheme(SHOP, THEME))?.scanId).toBe("good");
  });
});

describe("pruneScanManifests (keep-N)", () => {
  it("keeps the newest MANIFEST_KEEP_PER_THEME (2) of the shop+theme and deletes the rest", async () => {
    expect(MANIFEST_KEEP_PER_THEME).toBe(2);
    seed("s1", 1);
    seed("s2", 2);
    seed("s3", 3);
    seed("s4", 4);

    const result = await pruneScanManifests(SHOP, THEME);

    expect(result).toEqual({ count: 2 });
    expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s3", "s4"]);
  });

  it("never touches another theme or another shop", async () => {
    seed("s1", 1);
    seed("s2", 2);
    seed("s3", 3);
    seed("t1", 0, { themeId: "gid://shopify/Theme/2" });
    seed("x1", 0, { shopId: "shop-2" });

    await pruneScanManifests(SHOP, THEME);

    expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s2", "s3", "t1", "x1"]);
    const where = mockDb.scanManifest.deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ shopId: SHOP, themeId: THEME });
  });

  it("under the limit: no delete issued", async () => {
    seed("s1", 1);
    await expect(pruneScanManifests(SHOP, THEME)).resolves.toEqual({ count: 0 });
    expect(mockDb.scanManifest.deleteMany).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it("exactly at the limit: both kept (the delete matches nothing)", async () => {
    seed("s1", 1);
    seed("s2", 2);
    await expect(pruneScanManifests(SHOP, THEME)).resolves.toEqual({ count: 0 });
    expect(store.rows).toHaveLength(2);
  });

  it("nothing stored: no delete issued", async () => {
    await expect(pruneScanManifests(SHOP, THEME)).resolves.toEqual({ count: 0 });
    expect(mockDb.scanManifest.deleteMany).not.toHaveBeenCalled();
  });

  it("keep = 1 keeps only the newest; equal timestamps break ties by scan id", async () => {
    seed("a", 1);
    seed("b", 1);
    await pruneScanManifests(SHOP, THEME, 1);
    expect(store.rows.map((r) => r.scanId)).toEqual(["b"]);
  });

  it.each([0, -1, 1.5])("rejects keep = %s rather than deleting everything", async (keep) => {
    seed("s1", 1);
    await expect(pruneScanManifests(SHOP, THEME, keep)).rejects.toThrow("keep must be");
    expect(store.rows).toHaveLength(1);
  });
});
