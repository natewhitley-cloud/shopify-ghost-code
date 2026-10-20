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
  /** The owning Scan's createdAt (defaults to the manifest's). */
  scanCreatedAt?: Date;
  /** Whether the owning Scan already has its ScanChangeSet. */
  hasChangeSet?: boolean;
};

type OrderBy = Array<
  { createdAt?: "desc" } | { scanId?: "desc" } | { scan?: { createdAt: "desc" } }
>;

/** Sort newest first by each orderBy key in turn (desc only, as the model uses). */
function sortRows(rows: Row[], orderBy: OrderBy): Row[] {
  const value = (r: Row, o: OrderBy[number]): number | string =>
    "scan" in o
      ? (r.scanCreatedAt ?? r.createdAt).getTime()
      : "createdAt" in o
        ? r.createdAt.getTime()
        : r.scanId;
  return [...rows].sort((a, b) => {
    for (const o of orderBy) {
      const x = value(a, o);
      const y = value(b, o);
      if (x !== y) return x < y ? 1 : -1;
    }
    return 0;
  });
}

const store = vi.hoisted(() => ({ rows: [] as Row[] }));

type Where = {
  shopId?: string;
  themeId?: string;
  version?: number;
  scanId?: { not?: string; notIn?: string[]; in?: string[] };
  scan?: { status: { in: ScanStatus[] }; createdAt?: { lt: Date } };
};

function matches(row: Row, where: Where): boolean {
  if (where.shopId !== undefined && row.shopId !== where.shopId) return false;
  if (where.themeId !== undefined && row.themeId !== where.themeId) return false;
  if (where.version !== undefined && row.version !== where.version) return false;
  if (where.scanId?.not !== undefined && row.scanId === where.scanId.not) return false;
  if (where.scanId?.notIn !== undefined && where.scanId.notIn.includes(row.scanId)) return false;
  if (where.scanId?.in !== undefined && !where.scanId.in.includes(row.scanId)) return false;
  if (where.scan && !where.scan.status.in.includes(row.scanStatus)) return false;
  const scanCreatedAt = row.scanCreatedAt ?? row.createdAt;
  if (where.scan?.createdAt && !(scanCreatedAt < where.scan.createdAt.lt)) return false;
  return true;
}

const mockDb = vi.hoisted(() => ({
  scanManifest: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { MANIFEST_VERSION, type ManifestEntry } from "../../app/lib/theme-manifest";
import {
  getLatestManifestForTheme,
  getScanManifest,
  MANIFEST_KEEP_PER_THEME,
  PENDING_COMPUTE_GRACE_MS,
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
    async ({ where, take, orderBy }: { where: Where; take?: number; orderBy: OrderBy }) => {
      const sorted = sortRows(
        store.rows.filter((r) => matches(r, where)),
        orderBy,
      );
      // The relation select (prune) reads the scan's status, createdAt and
      // whether its change set exists.
      return sorted.slice(0, take ?? sorted.length).map((r) => ({
        ...r,
        scan: {
          status: r.scanStatus,
          createdAt: r.scanCreatedAt ?? r.createdAt,
          changeSet: r.hasChangeSet ? { scanId: r.scanId } : null,
        },
      }));
    },
  );
  mockDb.scanManifest.findUnique.mockImplementation(
    async ({ where }: { where: { scanId: string } }) =>
      store.rows.find((r) => r.scanId === where.scanId) ?? null,
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

  it("with `before`, a scan created at or after it is never the baseline (a recompute of an older check)", async () => {
    seed("older", 1);
    seed("current", 2);
    seed("newer", 3);
    const before = new Date(Date.UTC(2026, 9, 1, 0, 2));
    const latest = await getLatestManifestForTheme(SHOP, THEME, {
      excludeScanId: "current",
      before,
    });
    expect(latest?.scanId).toBe("older");
    expect(mockDb.scanManifest.findMany.mock.calls[0][0].where.scan).toEqual({
      status: { in: [ScanStatus.COMPLETED, ScanStatus.PARTIAL] },
      createdAt: { lt: before },
    });
  });

  it("newest by the scan's createdAt: a manifest written later by an earlier-started scan is not the baseline", async () => {
    // Overlapping scans: "early" started at minute 1 but wrote its manifest at
    // minute 5; "late" started at minute 2 and wrote at minute 3.
    seed("early", 5, { scanCreatedAt: new Date(Date.UTC(2026, 9, 1, 0, 1)) });
    seed("late", 3, { scanCreatedAt: new Date(Date.UTC(2026, 9, 1, 0, 2)) });
    const latest = await getLatestManifestForTheme(SHOP, THEME);
    expect(latest?.scanId).toBe("late");
  });

  it("selects candidate ids first, then loads one row's entries (no blobs for the others)", async () => {
    seed("s1", 1);
    seed("s2", 2);
    seed("s3", 3);
    await expect(getLatestManifestForTheme(SHOP, THEME)).resolves.toMatchObject({ scanId: "s3" });
    const listArgs = mockDb.scanManifest.findMany.mock.calls[0][0];
    expect(listArgs.select).toEqual({ scanId: true });
    expect(mockDb.scanManifest.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.scanManifest.findUnique.mock.calls[0][0].where).toEqual({ scanId: "s3" });
  });

  it("a malformed newest row is skipped for the next usable one", async () => {
    seed("good", 1);
    seed("bad", 2, { entries: { not: "an array" } });
    expect((await getLatestManifestForTheme(SHOP, THEME))?.scanId).toBe("good");
  });
});

describe("getScanManifest", () => {
  it("returns the scan's own manifest, parsed", async () => {
    seed("current", 2);
    await expect(getScanManifest("current")).resolves.toEqual({
      scanId: "current",
      themeId: THEME,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 2)),
      entries: ENTRIES,
    });
  });

  it("none written: null", async () => {
    await expect(getScanManifest("missing")).resolves.toBeNull();
  });

  it("another encoding version or malformed entries: null (unusable, never invented changes)", async () => {
    seed("v2", 1, { version: MANIFEST_VERSION + 1 });
    seed("bad", 2, { entries: [["only-a-path"]] });
    await expect(getScanManifest("v2")).resolves.toBeNull();
    await expect(getScanManifest("bad")).resolves.toBeNull();
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

  it("ranks successful scans only: a newer FAILED scan never pushes out the baseline a retry needs", async () => {
    seed("baseline", 1);
    seed("failed", 2, { scanStatus: ScanStatus.FAILED });
    seed("current", 3);

    await pruneScanManifests(SHOP, THEME);

    expect(store.rows.map((r) => r.scanId).sort()).toEqual(["baseline", "current"]);
    // The retried computation still finds its baseline.
    const latest = await getLatestManifestForTheme(SHOP, THEME, { excludeScanId: "current" });
    expect(latest?.scanId).toBe("baseline");
  });

  it("never deletes a still-running scan's manifest (its own computation has not run)", async () => {
    seed("s1", 1);
    seed("s2", 2);
    seed("s3", 3);
    seed("pending", 0, { scanStatus: ScanStatus.PENDING });
    seed("running", 4, { scanStatus: ScanStatus.IN_PROGRESS });

    await pruneScanManifests(SHOP, THEME);

    expect(store.rows.map((r) => r.scanId).sort()).toEqual(["pending", "running", "s2", "s3"]);
  });

  describe("overlapping scans: a finalized scan whose change set is not computed yet", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));
    const NOW = at(30);

    it("keeps that scan's manifest and its baseline, so its later computation still compares (M2)", async () => {
      // S1, S2 computed. Cron S3 finalized but compute-changes not run yet;
      // manual S4 finalized, computed, and now prunes.
      seed("s1", 1, { hasChangeSet: true });
      seed("s2", 2, { hasChangeSet: true });
      seed("s3", 3);
      seed("s4", 4, { hasChangeSet: true });

      await pruneScanManifests(SHOP, THEME, MANIFEST_KEEP_PER_THEME, NOW);

      expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s2", "s3", "s4"]);
      // S3's computation now runs and finds S2, not a baseline check.
      const baseline = await getLatestManifestForTheme(SHOP, THEME, {
        excludeScanId: "s3",
        before: at(3),
      });
      expect(baseline?.scanId).toBe("s2");
    });

    it("its own manifest survives too when two newer scans finish first", async () => {
      seed("s1", 1, { hasChangeSet: true });
      seed("s2", 2);
      seed("s3", 3, { hasChangeSet: true });
      seed("s4", 4, { hasChangeSet: true });

      await pruneScanManifests(SHOP, THEME, MANIFEST_KEEP_PER_THEME, NOW);

      expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    });

    it("once computed, the pin is released and the next prune keeps only the newest two", async () => {
      seed("s1", 1, { hasChangeSet: true });
      seed("s2", 2, { hasChangeSet: true });
      seed("s3", 3, { hasChangeSet: true });
      seed("s4", 4, { hasChangeSet: true });

      await pruneScanManifests(SHOP, THEME, MANIFEST_KEEP_PER_THEME, NOW);

      expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s3", "s4"]);
    });

    it("a computation missing for longer than the grace period no longer pins (bounded retention)", async () => {
      seed("s1", 1, { hasChangeSet: true });
      seed("s2", 2, { hasChangeSet: true });
      seed("s3", 3);
      seed("s4", 4, { hasChangeSet: true });
      const later = new Date(at(3).getTime() + PENDING_COMPUTE_GRACE_MS);

      await pruneScanManifests(SHOP, THEME, MANIFEST_KEEP_PER_THEME, later);

      expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s3", "s4"]);
    });

    it("a FAILED scan never pins anything (it is never computed)", async () => {
      seed("s1", 1, { hasChangeSet: true });
      seed("s2", 2, { hasChangeSet: true });
      seed("failed", 3, { scanStatus: ScanStatus.FAILED });
      seed("s4", 4, { hasChangeSet: true });

      await pruneScanManifests(SHOP, THEME, MANIFEST_KEEP_PER_THEME, NOW);

      expect(store.rows.map((r) => r.scanId).sort()).toEqual(["s2", "s4"]);
    });
  });

  it("deletes by id within the shop and theme only", async () => {
    seed("s1", 1);
    seed("s2", 2);
    seed("s3", 3);
    await pruneScanManifests(SHOP, THEME);
    expect(mockDb.scanManifest.deleteMany.mock.calls[0][0].where).toEqual({
      shopId: SHOP,
      themeId: THEME,
      scanId: { in: ["s1"] },
    });
  });

  it.each([0, -1, 1.5])("rejects keep = %s rather than deleting everything", async (keep) => {
    seed("s1", 1);
    await expect(pruneScanManifests(SHOP, THEME, keep)).rejects.toThrow("keep must be");
    expect(store.rows).toHaveLength(1);
  });
});
