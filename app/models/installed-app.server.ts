/**
 * Data access layer for the InstalledApp model.
 *
 * Tracks third-party apps installed on a merchant's store. Records are
 * populated by the permission-fetcher sync function (not webhooks — Shopify
 * does not provide webhooks for other apps being installed/uninstalled on a
 * store; the APP_UNINSTALLED topic only fires for your own app).
 *
 * Each function follows the pattern established in shop.server.ts:
 *   - Accept plain IDs/data, return Prisma model objects or null.
 *   - Let database errors propagate — callers decide how to handle them.
 */

import type { InstalledApp } from "@prisma/client";

import db from "../db.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertInstalledAppData {
  shopifyAppId: string;
  appHandle: string;
  appName: string;
  appDescription?: string;
  publicCategory?: string;
  grantedScopes?: string;
  grantedScopeCount?: number;
  hasActiveSubscription?: boolean;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create or update an installed app record.
 *
 * On create: sets presence=INSTALLED, firstSeenAt and lastSeenAt to now.
 * On update: refreshes metadata fields and lastSeenAt, resets presence to
 * INSTALLED (handles the case where a previously-removed app is re-installed),
 * and clears removedAt.
 */
export async function upsertInstalledApp(
  shopId: string,
  data: UpsertInstalledAppData,
): Promise<InstalledApp> {
  const now = new Date();

  return db.installedApp.upsert({
    where: {
      shopId_shopifyAppId: {
        shopId,
        shopifyAppId: data.shopifyAppId,
      },
    },
    create: {
      shopId,
      shopifyAppId: data.shopifyAppId,
      appHandle: data.appHandle,
      appName: data.appName,
      appDescription: data.appDescription ?? null,
      publicCategory: data.publicCategory ?? null,
      grantedScopes: data.grantedScopes ?? "[]",
      grantedScopeCount: data.grantedScopeCount ?? 0,
      hasActiveSubscription: data.hasActiveSubscription ?? false,
      presence: "INSTALLED",
      lastSeenAt: now,
    },
    update: {
      appHandle: data.appHandle,
      appName: data.appName,
      appDescription: data.appDescription ?? null,
      publicCategory: data.publicCategory ?? null,
      grantedScopes: data.grantedScopes ?? "[]",
      grantedScopeCount: data.grantedScopeCount ?? 0,
      hasActiveSubscription: data.hasActiveSubscription ?? false,
      presence: "INSTALLED",
      lastSeenAt: now,
      removedAt: null,
    },
  });
}

/**
 * Mark multiple apps as removed in a single batch operation.
 * Used by syncInstalledApps to mark apps no longer returned by the API.
 */
export async function markAppsRemovedByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  await db.installedApp.updateMany({
    where: { id: { in: ids } },
    data: {
      presence: "REMOVED",
      removedAt: new Date(),
    },
  });
}

/**
 * Mark an app as removed from the store.
 *
 * Sets presence=REMOVED and records the removal timestamp.
 * Returns null if the app record does not exist (idempotent — caller should
 * log and continue rather than throw).
 */
export async function markAppRemoved(
  shopId: string,
  shopifyAppId: string,
): Promise<InstalledApp | null> {
  const existing = await db.installedApp.findUnique({
    where: {
      shopId_shopifyAppId: {
        shopId,
        shopifyAppId,
      },
    },
  });

  if (!existing) return null;

  return db.installedApp.update({
    where: {
      shopId_shopifyAppId: {
        shopId,
        shopifyAppId,
      },
    },
    data: {
      presence: "REMOVED",
      removedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Return all currently-installed apps for a shop (presence=INSTALLED).
 * Excludes apps that have been marked as removed.
 */
export async function getInstalledApps(shopId: string): Promise<InstalledApp[]> {
  return db.installedApp.findMany({
    where: {
      shopId,
      presence: "INSTALLED",
    },
    orderBy: { appName: "asc" },
  });
}

/**
 * Look up a single installed app by its handle within a shop.
 * Returns null if not found — does not filter by presence, so callers can
 * check whether a previously-removed app exists.
 */
export async function getInstalledAppByHandle(
  shopId: string,
  appHandle: string,
): Promise<InstalledApp | null> {
  return db.installedApp.findFirst({
    where: {
      shopId,
      appHandle,
    },
  });
}

/**
 * Look up a single installed app by its primary key ID.
 * Returns null if not found. Does not filter by presence — callers can
 * display details for removed apps too.
 */
export async function getInstalledAppById(id: string): Promise<InstalledApp | null> {
  return db.installedApp.findUnique({
    where: { id },
  });
}
