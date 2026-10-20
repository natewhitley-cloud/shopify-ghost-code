import { Prisma, ScanStatus } from "@prisma/client";

import db from "../db.server";
import {
  type AppBlockRef,
  MANIFEST_VERSION,
  type ManifestEntry,
  parseManifestEntries,
} from "../lib/theme-manifest";

/**
 * Per-scan theme file manifests (gc-rrh.4, spec 1). Hashes and metadata only,
 * never file content. Cascades Shop -> Scan -> ScanManifest, so shop/redact
 * needs no clause of its own.
 */

/**
 * Manifests kept per (shop, theme). A manifest is needed only as the next
 * scan's baseline; keeping 2 rather than 1 lets a failed or replayed
 * change computation recompute against the same baseline (spec 1.4).
 */
export const MANIFEST_KEEP_PER_THEME = 2;

/** Scan states whose manifest may serve as a baseline (as getPreviousScanForTheme). */
const BASELINE_STATUSES: ScanStatus[] = [ScanStatus.COMPLETED, ScanStatus.PARTIAL];

/**
 * Write the scan's manifest. Runs inside fetch-and-scan, which Inngest re-runs
 * wholesale on retry, so this upserts on the scan id: a retry rewrites the
 * same row instead of failing on the primary key.
 */
export async function upsertScanManifest(
  scanId: string,
  input: {
    shopId: string;
    themeId: string;
    entries: ManifestEntry[];
    appBlocks: AppBlockRef[] | null;
  },
) {
  const data = {
    shopId: input.shopId,
    themeId: input.themeId,
    version: MANIFEST_VERSION,
    fileCount: input.entries.length,
    entries: input.entries as unknown as Prisma.InputJsonValue,
    // SQL NULL = not captured; [] = captured, none referenced.
    appBlocks:
      input.appBlocks === null
        ? Prisma.DbNull
        : (input.appBlocks as unknown as Prisma.InputJsonValue),
  };
  return db.scanManifest.upsert({
    where: { scanId },
    create: { scanId, ...data },
    update: data,
    select: { scanId: true },
  });
}

export type StoredManifest = {
  scanId: string;
  themeId: string;
  createdAt: Date;
  entries: ManifestEntry[];
};

/**
 * The newest usable baseline manifest for a shop's theme: same encoding
 * version, from a scan that finished (COMPLETED or PARTIAL; a FAILED scan's
 * manifest is never a baseline), excluding `excludeScanId` (the current scan).
 * A row whose entries do not parse is skipped as unusable, so the caller falls
 * back to an older one or to a baseline check, never to invented changes.
 */
export async function getLatestManifestForTheme(
  shopId: string,
  themeId: string,
  { excludeScanId }: { excludeScanId?: string } = {},
): Promise<StoredManifest | null> {
  const rows = await db.scanManifest.findMany({
    where: {
      shopId,
      themeId,
      version: MANIFEST_VERSION,
      ...(excludeScanId ? { scanId: { not: excludeScanId } } : {}),
      scan: { status: { in: BASELINE_STATUSES } },
    },
    orderBy: [{ createdAt: "desc" }, { scanId: "desc" }],
    // Only the kept window can exist (plus the current scan's, excluded).
    take: MANIFEST_KEEP_PER_THEME + 1,
    select: { scanId: true, themeId: true, createdAt: true, entries: true },
  });
  for (const row of rows) {
    const entries = parseManifestEntries(row.entries);
    if (entries) {
      return { scanId: row.scanId, themeId: row.themeId, createdAt: row.createdAt, entries };
    }
  }
  return null;
}

/**
 * Delete the (shop, theme)'s manifests older than the newest `keep` (spec
 * 1.4). Two queries: read the newest ids, then one deleteMany for the rest.
 * Scoped to one shop and theme, so another shop or theme is never touched.
 */
export async function pruneScanManifests(
  shopId: string,
  themeId: string,
  keep: number = MANIFEST_KEEP_PER_THEME,
): Promise<{ count: number }> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`[scan-manifest] keep must be a positive integer, got ${keep}`);
  }
  const newest = await db.scanManifest.findMany({
    where: { shopId, themeId },
    orderBy: [{ createdAt: "desc" }, { scanId: "desc" }],
    take: keep,
    select: { scanId: true },
  });
  if (newest.length < keep) return { count: 0 };
  return db.scanManifest.deleteMany({
    where: { shopId, themeId, scanId: { notIn: newest.map((row) => row.scanId) } },
  });
}
