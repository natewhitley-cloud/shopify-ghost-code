import db from "../db.server";

/**
 * The subset of shop fields returned by getShopMetadata.
 */
export type ShopMetadata = {
  id: string;
  domain: string;
  plan: string;
  installedAt: Date;
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
      installedAt: true,
      lastThemePublishAt: true,
      hasSeenReviewPrompt: true,
    },
  });
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
    update: {},
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
