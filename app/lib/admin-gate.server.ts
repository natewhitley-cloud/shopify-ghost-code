/**
 * Admin gate — restricts internal operator routes to a fixed allow-list of
 * shop domains set via environment variable.
 *
 * Configuration:
 *   ADMIN_SHOP_DOMAINS=myshop.myshopify.com,othershop.myshopify.com
 *
 * When the env var is absent or empty, NO shop is treated as admin, so the
 * dashboard is inaccessible in environments where the var is not configured.
 *
 * Domain matching is case-insensitive and trims surrounding whitespace.
 */

/**
 * Return true if the given shop domain is in the ADMIN_SHOP_DOMAINS allow-list.
 *
 * @param domain - The shop domain from the Shopify session (e.g. "myshop.myshopify.com")
 */
export function isAdminShop(domain: string): boolean {
  const raw = process.env.ADMIN_SHOP_DOMAINS ?? "";
  if (!raw.trim()) return false;

  const allowList = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  return allowList.includes(domain.toLowerCase());
}
