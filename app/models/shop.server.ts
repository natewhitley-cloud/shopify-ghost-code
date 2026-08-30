import db from "../db.server";

/**
 * The subset of shop fields returned by getShopMetadata.
 */
export type ShopMetadata = {
  id: string;
  domain: string;
  plan: string;
  planReconciledAt: Date | null;
  installedAt: Date;
  uninstalledAt: Date | null;
  lastThemePublishAt: Date | null;
  hasSeenReviewPrompt: boolean;
};

/**
 * Lightweight shop lookup that returns all shop metadata fields.
 * Use this for plan checks, feature gating, review prompts, and any
 * caller that only needs shop identity or settings.
 *
 * Returns null if no shop exists — callers must handle the null case.
 */
export async function getShopMetadata(domain: string): Promise<ShopMetadata | null> {
  return db.shop.findUnique({
    where: { domain },
    select: {
      id: true,
      domain: true,
      plan: true,
      planReconciledAt: true,
      installedAt: true,
      uninstalledAt: true,
      lastThemePublishAt: true,
      hasSeenReviewPrompt: true,
    },
  });
}

/**
 * Clear the uninstalled-pending-redact flag on reinstall so the shop rejoins the
 * active set (weekly-scan/poll-theme-changes/metrics/digest all skip rows with a
 * non-null uninstalledAt).
 *
 * Called from the app loader ONLY when an existing shop row still carries a set
 * uninstalledAt (i.e. an actual reinstall), never on every load. Uses updateMany
 * keyed on domain so a missing row is a safe no-op (count 0) rather than a throw.
 */
export async function reactivateShop(domain: string): Promise<void> {
  await db.shop.updateMany({ where: { domain }, data: { uninstalledAt: null } });
}

/**
 * Create a shop record on install, or no-op update if it already exists.
 *
 * The Shopify access token is NOT stored here: the operative offline token
 * lives in the Session table (managed by PrismaSessionStorage) and is read by
 * every background job and webhook via `unauthenticated.admin()`. This function
 * only persists shop identity/settings (domain, plan, installedAt, etc.).
 *
 * Idempotent: safe to call on every authenticated visit. On re-install for an
 * existing shop, the create is skipped and existing metadata is preserved.
 */
export async function upsertShop(domain: string) {
  return db.shop.upsert({
    where: { domain },
    create: { domain },
    // Defensive fallback only: upsertShop is NOT called on a normal reinstall
    // (the app loader takes the existing-row branch and skips this), so this
    // clause only clears uninstalledAt in the rare create-race where the row
    // reappears here. The real reinstall-reset happens via reactivateShop in the
    // app loader (gc-grd).
    update: { uninstalledAt: null },
  });
}

/**
 * Revoke access and mark a shop as uninstalled WITHOUT hard-deleting its data.
 *
 * Called by the app/uninstalled webhook. Instead of wiping the Shop + scan data
 * immediately (which would make the shop/redact 48h GDPR grace window meaningless
 * and leave no uninstall record), this:
 *   1. Deletes the shop's Session rows — Sessions use a plain string `shop` field
 *      (no FK), so they must be deleted explicitly. This revokes access tokens.
 *   2. Stamps `uninstalledAt` = now() on the Shop row, marking it uninstalled-but-
 *      pending-redact so iterators/metrics skip it (gc-grd).
 *
 * The full wipe (Shop + all scan data via cascade) stays deferred to shop/redact,
 * which Shopify delivers ~48h after uninstall and which calls deleteShopData.
 *
 * Both writes run in a single transaction. Uses updateMany keyed on domain so a
 * missing shop row is a safe no-op (count 0) rather than a throw — idempotent,
 * matching the null-safe style of deleteShopData. Returns whether a shop row was
 * found and updated, so the caller can log a warn on a miss and still return 200.
 */
export async function markShopUninstalled(domain: string): Promise<{ found: boolean }> {
  const [, updateResult] = await db.$transaction([
    // Sessions use a plain string `shop` field (no FK) — delete explicitly to revoke access.
    db.session.deleteMany({ where: { shop: domain } }),
    // updateMany is a no-op (count 0) if the shop row is already gone — idempotent.
    db.shop.updateMany({ where: { domain }, data: { uninstalledAt: new Date() } }),
  ]);

  return { found: updateResult.count > 0 };
}

/**
 * Update the billing plan tier for a shop by Shopify domain.
 * Used by the app/subscriptions/update webhook, which provides the domain
 * (not the internal shop ID) in the webhook payload.
 *
 * Returns null if the shop is not found — caller is responsible for logging
 * and still returning 200 to Shopify.
 *
 * Also stamps `planReconciledAt` to now(): any authoritative plan write (webhook
 * delivery or reconciliation drift correction) means the stored plan now matches
 * Shopify, so the freshness clock should reset and avoid a redundant reconcile.
 */
export async function updateShopPlanByDomain(
  domain: string,
  plan: string,
): Promise<{ id: string; domain: string; plan: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { plan, planReconciledAt: new Date() },
    select: { id: true, domain: true, plan: true },
  });
}

/**
 * Stamp `planReconciledAt` to now() WITHOUT changing the plan.
 *
 * Used by the reconciler on a no-op match (stored plan already equals Shopify's
 * active subscription state) so the freshness clock still advances and the next
 * app load skips the reconciliation query.
 *
 * Returns null if the shop domain is not found.
 */
export async function stampPlanReconciledAt(domain: string): Promise<{ id: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { planReconciledAt: new Date() },
    select: { id: true },
  });
}

/**
 * Record the timestamp of the most recent themes/publish webhook for a shop.
 * Used by the dashboard to surface a nudge banner when a theme change occurred
 * since the last completed scan.
 *
 * Returns null if the shop domain is not found — callers must still return 200
 * to Shopify even when no record is updated.
 */
export async function updateThemePublishTimestamp(
  domain: string,
): Promise<{ id: string; domain: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { lastThemePublishAt: new Date() },
    select: { id: true, domain: true },
  });
}

/**
 * Permanently mark that a shop has seen (and dismissed) the App Store review prompt.
 * Once set to true, the banner will never be shown again for this shop.
 *
 * Returns null if the shop is not found — callers must handle the null case.
 */
export async function dismissReviewPrompt(shopId: string): Promise<{ id: string } | null> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop) return null;

  return db.shop.update({
    where: { id: shopId },
    data: { hasSeenReviewPrompt: true },
    select: { id: true },
  });
}

/**
 * Hard-delete a shop and all its data atomically inside a single transaction.
 *
 * Deletion order:
 *   1. Sessions  — no FK to Shop (plain string `shop` field), must be deleted explicitly.
 *   2. Shop      — PostgreSQL cascades handle all child tables automatically.
 *
 * Cascade map (all have onDelete: Cascade on their Shop or Scan FK):
 *   Shop → Scans → Findings
 *   Shop → Scans → UnknownScripts → SignatureSubmissions
 *   Shop → BillingEvents
 *
 * Returns null if the domain is not found, so callers can log and still
 * return 200 without throwing.
 */
export async function deleteShopData(domain: string) {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  console.log("[gdpr]", { event: "delete_shop_data_start", domain, shopId: shop.id });

  await db.$transaction([
    // Sessions use a plain string `shop` field (no FK) — must delete explicitly.
    db.session.deleteMany({ where: { shop: domain } }),
    // Shop delete cascades to: Scans → Findings, UnknownScripts → SignatureSubmissions,
    // and BillingEvents (all have onDelete: Cascade on their Shop/Scan FK).
    db.shop.delete({ where: { domain } }),
  ]);

  console.log("[gdpr]", { event: "delete_shop_data_complete", domain, shopId: shop.id });

  return shop;
}
