import db from "../db.server";

/**
 * Find a shop by its Shopify domain (unique field).
 * Returns null if no shop exists — callers must handle the null case.
 */
export async function getShopByDomain(domain: string) {
  return db.shop.findUnique({ where: { domain } });
}

/**
 * Create or update a shop record on install / re-install.
 * Updates the accessToken in place so re-installs don't orphan auth state.
 */
export async function upsertShop(domain: string, accessToken: string) {
  return db.shop.upsert({
    where: { domain },
    create: { domain, accessToken },
    update: { accessToken },
  });
}

/**
 * Update the billing plan tier for a shop by Shopify domain.
 * Used by the app/subscriptions/update webhook, which provides the domain
 * (not the internal shop ID) in the webhook payload.
 *
 * Returns null if the shop is not found — caller is responsible for logging
 * and still returning 200 to Shopify.
 */
export async function updateShopPlanByDomain(
  domain: string,
  plan: string,
): Promise<{ id: string; domain: string; plan: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { plan },
    select: { id: true, domain: true, plan: true },
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
 * Hard-delete a shop and all its data atomically inside a single transaction.
 *
 * Deletion order:
 *   1. Sessions  — revokes API access first
 *   2. Scans     — findings are cascade-deleted from scans via onDelete: Cascade
 *   3. Shop      — must be last; sessions and scans reference it
 *
 * Returns null if the domain is not found, so callers can log and still
 * return 200 without throwing.
 */
export async function deleteShopData(domain: string) {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  await db.$transaction([
    db.session.deleteMany({ where: { shop: domain } }),
    db.scan.deleteMany({ where: { shopId: shop.id } }),
    db.shop.delete({ where: { domain } }),
  ]);

  return shop;
}
