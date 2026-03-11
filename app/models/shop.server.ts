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
 * Update the billing plan tier for a shop.
 * Called by billing webhook handlers when a subscription is activated or cancelled.
 */
export async function updateShopPlan(shopId: string, plan: string) {
  return db.shop.update({
    where: { id: shopId },
    data: { plan },
  });
}

/**
 * Hard-delete a shop and all its data (scans + findings via cascade).
 * Called by the GDPR customers/redact webhook. Returns null if domain not found
 * rather than throwing, so the webhook handler can log and respond 200.
 */
export async function deleteShopData(domain: string) {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  // Findings are cascade-deleted when scans are deleted.
  // Scans are cascade-deleted when the shop is deleted.
  return db.shop.delete({ where: { domain } });
}
