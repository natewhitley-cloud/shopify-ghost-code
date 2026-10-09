import { AppRemovalState, type AppRemoval } from "@prisma/client";

import db from "../db.server";

/**
 * Data access for AppRemoval (gc-frda): apps no longer active on a theme that
 * left code behind (Rule 1D). Merchant copy: "X is no longer active in your
 * store. It left N items behind." Never claim the merchant uninstalled it.
 * The detection rules live in app/services/app-removal.server.ts (pure); this
 * module only reads and writes rows. Rows cascade-delete with their Shop
 * (shop/redact) and are never deleted on reinstall.
 */

/** REMOVED records for a shop + theme: the only ones a later scan updates. */
export function getOpenAppRemovals(shopId: string, themeId: string) {
  return db.appRemoval.findMany({
    where: { shopId, themeId, state: AppRemovalState.REMOVED },
    select: { id: true, appName: true, leftoverCount: true, detectedScanId: true },
  });
}

/**
 * Removals detected on `scanId` for this shop + theme, by app name. The UI
 * shows the removals detected on the theme's latest successful scan.
 */
export function getAppRemovalsDetectedOnScan(
  shopId: string,
  themeId: string,
  scanId: string,
): Promise<AppRemoval[]> {
  return db.appRemoval.findMany({
    where: { shopId, themeId, detectedScanId: scanId },
    orderBy: { appName: "asc" },
  });
}

/** The fields Home's removal banner reads (app/lib/app-removal-notice.ts). */
export type RemovalNoticeRow = Pick<AppRemoval, "appName" | "leftoverCount" | "state">;

/**
 * Home's banner rows for one scan of a shop + theme: apps detected as no
 * longer active ON `scanId` (still REMOVED) and apps whose leftovers became
 * CLEANED on `scanId` (stateChangedScanId). REINSTALLED rows are never read.
 * One query on the (shopId, themeId, ...) prefix of the unique key, so it only
 * ever scans this theme's few rows.
 */
export function getRemovalNoticeRows(
  shopId: string,
  themeId: string,
  scanId: string,
): Promise<RemovalNoticeRow[]> {
  return db.appRemoval.findMany({
    where: {
      shopId,
      themeId,
      OR: [
        { detectedScanId: scanId, state: AppRemovalState.REMOVED },
        { stateChangedScanId: scanId, state: AppRemovalState.CLEANED },
      ],
    },
    select: { appName: true, leftoverCount: true, state: true },
    orderBy: { appName: "asc" },
  });
}

/**
 * The record for `appName` detected on `scanId` (any state), or null: the
 * scan page's `?app=` removal context. A unique-key lookup.
 */
export function getAppRemovalForScanApp(
  shopId: string,
  themeId: string,
  appName: string,
  scanId: string,
) {
  return db.appRemoval.findUnique({
    where: {
      shopId_themeId_appName_detectedScanId: { shopId, themeId, appName, detectedScanId: scanId },
    },
    select: { appName: true, previousScanId: true },
  });
}

/**
 * Apply a plan in one transaction. Inserts skip duplicates on the
 * (shopId, themeId, appName, detectedScanId) unique key, and each update only
 * matches a row still REMOVED, so an Inngest retry is a no-op.
 */
export async function applyAppRemovalPlan(args: {
  shopId: string;
  themeId: string;
  scanId: string;
  previousScanId: string;
  plan: {
    creates: ReadonlyArray<{ appName: string; leftoverCount: number }>;
    updates: ReadonlyArray<{
      id: string;
      leftoverCount: number;
      state?: typeof AppRemovalState.CLEANED | typeof AppRemovalState.REINSTALLED;
    }>;
  };
}): Promise<{ created: number; updated: number }> {
  const { shopId, themeId, scanId, previousScanId, plan } = args;
  if (plan.creates.length === 0 && plan.updates.length === 0) return { created: 0, updated: 0 };
  const now = new Date();

  const results = await db.$transaction([
    db.appRemoval.createMany({
      data: plan.creates.map((c) => ({
        shopId,
        themeId,
        appName: c.appName,
        detectedScanId: scanId,
        previousScanId,
        leftoverCount: c.leftoverCount,
      })),
      skipDuplicates: true,
    }),
    ...plan.updates.map((u) =>
      db.appRemoval.updateMany({
        where: { id: u.id, shopId, state: AppRemovalState.REMOVED },
        data: {
          leftoverCount: u.leftoverCount,
          ...(u.state ? { state: u.state, stateChangedAt: now, stateChangedScanId: scanId } : {}),
        },
      }),
    ),
  ]);
  const [created, ...updated] = results;
  return { created: created.count, updated: updated.reduce((n, r) => n + r.count, 0) };
}
