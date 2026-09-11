/**
 * Theme code editor deep-link builder.
 *
 * Pure, client-safe (no .server.ts suffix, no imports) so it can run in the
 * scan-detail component that renders the findings table. Given a shop domain, a
 * theme GID, and a theme file path, it produces the Shopify admin theme code
 * editor URL that opens that exact file:
 *
 *   https://admin.shopify.com/store/{storeHandle}/themes/{numericThemeId}/editor?key={filename}
 *
 * Returns `null` for any input it cannot turn into a valid URL (missing/malformed
 * theme id, blank shop handle, or blank filename) so the caller can simply skip
 * rendering a link rather than emit a broken one.
 */

/**
 * Extract the numeric theme id from a Shopify OnlineStoreTheme GID.
 *
 *   "gid://shopify/OnlineStoreTheme/123456789" → "123456789"
 *   "123456789"                                → "123456789"  (already numeric)
 *   anything else / null / undefined           → null
 *
 * Kept separate (and exported) so the GID-parsing edge cases are unit-tested in
 * isolation from URL assembly.
 */
export function themeIdToNumeric(themeId: string | null | undefined): string | null {
  if (!themeId) return null;
  // Already a bare numeric id.
  if (/^\d+$/.test(themeId)) return themeId;
  // Standard GID form — take the trailing numeric segment.
  const match = themeId.match(/^gid:\/\/shopify\/OnlineStoreTheme\/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * The store handle used in `admin.shopify.com/store/{handle}` URLs: the shop's
 * myshopify subdomain with a trailing `.myshopify.com` stripped
 * (e.g. `my-store.myshopify.com` → `my-store`). Mirrors the identical extraction
 * in `buildPricingPlansUrl` (billing.server.ts); duplicated here rather than
 * imported because that helper is server-only and this module is client-bundled.
 */
function storeHandleFromDomain(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

/**
 * Build the theme code editor deep-link for a single theme file. Returns null
 * when the theme id is missing/malformed, the shop domain is blank, or the
 * filename is blank — the caller renders nothing in that case.
 */
export function buildThemeEditorUrl(
  shopDomain: string,
  themeId: string | null | undefined,
  filename: string,
): string | null {
  const numericThemeId = themeIdToNumeric(themeId);
  if (!numericThemeId) return null;

  const storeHandle = storeHandleFromDomain(shopDomain);
  if (!storeHandle || !filename) return null;

  return `https://admin.shopify.com/store/${storeHandle}/themes/${numericThemeId}/editor?key=${encodeURIComponent(
    filename,
  )}`;
}
