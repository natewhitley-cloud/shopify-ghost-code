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

/** Parse one stored row; null when its entries are unusable. */
function toStoredManifest(row: {
  scanId: string;
  themeId: string;
  createdAt: Date;
  entries: unknown;
}): StoredManifest | null {
  const entries = parseManifestEntries(row.entries);
  return entries
    ? { scanId: row.scanId, themeId: row.themeId, createdAt: row.createdAt, entries }
    : null;
}

/**
 * The newest usable baseline manifest for a shop's theme: same encoding
 * version, from a scan that finished (COMPLETED or PARTIAL; a FAILED scan's
 * manifest is never a baseline), excluding `excludeScanId` (the current scan)
 * and, with `before`, any scan created at or after it (so a recompute of an
 * older check never compares against a newer one). "Newest" is by the scan's
 * createdAt, the same clock as `before` (a manifest is written mid-scan, so
 * its own createdAt can invert two overlapping scans). A row whose entries do
 * not parse is skipped as unusable, so the caller falls back to an older one
 * or to a baseline check, never to invented changes.
 *
 * Two reads: the candidate ids (no entry blobs), then one row's entries
 * (another only when that row does not parse).
 */
export async function getLatestManifestForTheme(
  shopId: string,
  themeId: string,
  { excludeScanId, before }: { excludeScanId?: string; before?: Date } = {},
): Promise<StoredManifest | null> {
  const candidates = await db.scanManifest.findMany({
    where: {
      shopId,
      themeId,
      version: MANIFEST_VERSION,
      ...(excludeScanId ? { scanId: { not: excludeScanId } } : {}),
      scan: {
        status: { in: BASELINE_STATUSES },
        ...(before ? { createdAt: { lt: before } } : {}),
      },
    },
    orderBy: [{ scan: { createdAt: "desc" } }, { scanId: "desc" }],
    // The kept window (plus the current scan's, excluded); older rows are a
    // fallback only for unparsable entries.
    take: MANIFEST_KEEP_PER_THEME + 1,
    select: { scanId: true },
  });
  for (const { scanId } of candidates) {
    const row = await db.scanManifest.findUnique({
      where: { scanId },
      select: { scanId: true, themeId: true, createdAt: true, entries: true },
    });
    const manifest = row ? toStoredManifest(row) : null;
    if (manifest) return manifest;
  }
  return null;
}

/**
 * One scan's own manifest (the current side of a change computation), or
 * null when none was written, it is another encoding version, or its entries
 * do not parse.
 */
export async function getScanManifest(scanId: string): Promise<StoredManifest | null> {
  const row = await db.scanManifest.findUnique({
    where: { scanId },
    select: { scanId: true, themeId: true, createdAt: true, entries: true, version: true },
  });
  if (!row || row.version !== MANIFEST_VERSION) return null;
  return toStoredManifest(row);
}

/** Scan states whose manifest no change computation can still need. */
const RUNNING_STATUSES: ReadonlySet<ScanStatus> = new Set([
  ScanStatus.PENDING,
  ScanStatus.IN_PROGRESS,
]);

/**
 * How long a successful scan without a change set counts as still waiting on
 * its own change computation (the compute-changes step runs minutes after
 * finalize, Inngest retries included). Past this, the computation is taken as
 * failed for good, so its manifests stop being pinned and retention stays
 * bounded.
 */
export const PENDING_COMPUTE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Keep the (shop, theme)'s newest `keep` baseline-eligible manifests (spec
 * 1.4) and delete the rest. Ranked by the scan's createdAt over COMPLETED /
 * PARTIAL scans only, so a newer FAILED scan's manifest never pushes out the
 * baseline a retried change computation still needs; FAILED scans' manifests
 * are deleted (they are never baselines). A still-running scan's manifest is
 * never deleted (its own change computation has not run yet).
 *
 * Nor is a finalized scan's computation that has not run yet stranded: two
 * scans of one theme can overlap (a cron scan and a manual one), and the
 * later one's prune may run before the earlier one computes. So a successful
 * scan with no ScanChangeSet yet (created within PENDING_COMPUTE_GRACE_MS)
 * keeps its own manifest and its baseline (the newest successful manifest
 * from a scan created before it), exactly what getLatestManifestForTheme will
 * pick for it. Scoped to one shop and theme, so another shop or theme is
 * never touched. Two queries at most: the theme's few rows, then one
 * deleteMany by id.
 */
export async function pruneScanManifests(
  shopId: string,
  themeId: string,
  keep: number = MANIFEST_KEEP_PER_THEME,
  now: Date = new Date(),
): Promise<{ count: number }> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`[scan-manifest] keep must be a positive integer, got ${keep}`);
  }
  const rows = await db.scanManifest.findMany({
    where: { shopId, themeId },
    orderBy: [{ scan: { createdAt: "desc" } }, { scanId: "desc" }],
    select: {
      scanId: true,
      scan: { select: { status: true, createdAt: true, changeSet: { select: { scanId: true } } } },
    },
  });
  const successful = rows.filter((row) => BASELINE_STATUSES.includes(row.scan.status));
  const kept = new Set(successful.slice(0, keep).map((row) => row.scanId));
  successful.forEach((row, index) => {
    const awaitingCompute =
      row.scan.changeSet === null &&
      now.getTime() - row.scan.createdAt.getTime() < PENDING_COMPUTE_GRACE_MS;
    if (!awaitingCompute) return;
    kept.add(row.scanId);
    const baseline = successful
      .slice(index + 1)
      .find((older) => older.scan.createdAt.getTime() < row.scan.createdAt.getTime());
    if (baseline) kept.add(baseline.scanId);
  });
  const doomed = rows
    .filter((row) => !kept.has(row.scanId) && !RUNNING_STATUSES.has(row.scan.status))
    .map((row) => row.scanId);
  if (doomed.length === 0) return { count: 0 };
  return db.scanManifest.deleteMany({
    where: { shopId, themeId, scanId: { in: doomed } },
  });
}
