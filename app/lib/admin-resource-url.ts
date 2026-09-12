/**
 * Admin-resource deep-link builder (gc-7h9, fast-follow to gc-3on).
 *
 * Sibling of theme-editor-url.ts: pure, client-safe (no .server.ts suffix, no
 * imports) so it can run in the scan-detail component that renders the findings
 * table. Where theme-editor-url.ts deep-links THEME-FILE findings into the theme
 * code editor, this module deep-links ADMIN-RESOURCE findings (product / page /
 * redirect / metafield / translation) to their best-available Shopify surface.
 *
 * The two finding sets partition the FindingType enum (see
 * finding-classification.ts: THEME_FILE_TYPE_SETS), so a given finding gets at
 * most one deep-link and the caller renders whichever one is non-null.
 *
 * "Best available surface" contract (owner decision): build a precise link when
 * the finding's locator carries enough data (a product / redirect numeric id, a
 * page handle); otherwise fall back to the nearest useful section-level admin
 * page. Return `null` only when nothing is constructible — blank shop handle,
 * a non-admin-resource type, or a locator with no usable id/handle — so the
 * caller renders nothing rather than a broken link (mirrors the null-on-uncertain
 * contract in theme-editor-url.ts).
 *
 * URL forms and how each was decided (VERIFIED = confirmed against Shopify docs;
 * FALLBACK = section-level surface used because the per-resource form could not
 * be verified, per the gc-7h9 brief's "fall back rather than guess" rule):
 *   - GHOST_TAG / GHOST_PRICE  → `{admin}/products/{numericId}`
 *                                (product detail page; stable, well-known form)
 *   - GHOST_METAFIELD          → `{admin}/products/{numericId}` (FALLBACK — a
 *                                product's metafields render inline on its detail
 *                                page; there is no stable dedicated
 *                                `/products/{id}/metafields` admin URL, so we link
 *                                the product page rather than guess one)
 *   - GHOST_PAGE               → `https://{shopDomain}/pages/{handle}` (storefront
 *                                view — the clearest "here is the ghost page"; the
 *                                admin page editor needs a numeric id the locator
 *                                does not carry, only the handle)
 *   - GHOST_REDIRECT           → `{admin}/content/redirects` (FALLBACK — the URL
 *                                redirects list, reached via Content > URL
 *                                redirects. A per-redirect edit URL could not be
 *                                verified, so BOTH single and bulk findings link
 *                                the list rather than guess a per-id form)
 *   - GHOST_TRANSLATION        → `{admin}/settings/languages` (VERIFIED — the
 *                                Shopify Help Center links localization/translation
 *                                to Settings > Languages; list-level surface)
 */

/**
 * Extract the numeric id from a Shopify GID embedded anywhere in a locator string.
 *
 *   "products/gid://shopify/Product/123"             → "123"
 *   "products/gid://shopify/Product/123/metafields"  → "123"
 *   "redirects/gid://shopify/UrlRedirect/456"        → "456"
 *   anything with no gid://shopify/<Type>/<digits>   → null
 *
 * The stored locator prepends a resource prefix to a FULL GID that itself
 * contains slashes (e.g. `products/gid://shopify/Product/123`), so a naive
 * split-on-"/" would not work — we match the `gid://shopify/<Type>/<digits>`
 * shape directly and capture the trailing numeric id, ignoring any prefix or
 * suffix (like `/metafields`). Kept separate and exported so the GID-parsing
 * edge cases are unit-tested in isolation from URL assembly.
 */
export function numericIdFromGidLocator(locator: string | null | undefined): string | null {
  if (!locator) return null;
  const match = locator.match(/gid:\/\/shopify\/[A-Za-z]+\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * The store handle used in `admin.shopify.com/store/{handle}` URLs: the shop's
 * myshopify subdomain with a trailing `.myshopify.com` stripped
 * (e.g. `my-store.myshopify.com` → `my-store`). Duplicated from
 * theme-editor-url.ts rather than shared because both modules are client-bundled
 * and intentionally import-free.
 */
function storeHandleFromDomain(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

/**
 * Extract a page handle from a GHOST_PAGE locator (`pages/{handle}`). Returns
 * null when the locator is absent, not a `pages/` locator, or carries an empty
 * handle. Page handles are single-segment slugs, so everything after the
 * `pages/` prefix is the handle.
 */
function pageHandleFromLocator(locator: string | null | undefined): string | null {
  if (!locator) return null;
  const prefix = "pages/";
  if (!locator.startsWith(prefix)) return null;
  const handle = locator.slice(prefix.length);
  return handle.length > 0 ? handle : null;
}

/**
 * Build the best-available admin/storefront deep-link for an Admin-resource
 * finding. Returns null when the shop handle is blank, the finding type is not an
 * Admin-resource type, or the locator carries no usable id/handle for the
 * precise-link types — the caller renders nothing in that case.
 *
 * GHOST_REDIRECT and GHOST_TRANSLATION are section-level surfaces, so they return
 * a non-null URL for any (even unparseable) locator as long as the shop handle is
 * present.
 */
export function buildAdminResourceUrl(
  shopDomain: string,
  findingType: string,
  locator: string | null | undefined,
): string | null {
  if (!shopDomain) return null;
  const storeHandle = storeHandleFromDomain(shopDomain);
  if (!storeHandle) return null;

  const adminBase = `https://admin.shopify.com/store/${storeHandle}`;

  switch (findingType) {
    // Product-backed types → the product detail page. GHOST_METAFIELD falls back
    // here too (a product's metafields render on its detail page; no stable
    // dedicated metafields URL to link).
    case "GHOST_TAG":
    case "GHOST_PRICE":
    case "GHOST_METAFIELD": {
      const id = numericIdFromGidLocator(locator);
      if (!id) return null;
      return `${adminBase}/products/${id}`;
    }
    // Storefront view of the page — the locator carries only the handle.
    case "GHOST_PAGE": {
      const handle = pageHandleFromLocator(locator);
      if (!handle) return null;
      return `https://${shopDomain}/pages/${encodeURIComponent(handle)}`;
    }
    // Section-level fallback: URL redirects list (per-redirect edit URL
    // unverified — see module doc). Covers both single and bulk redirect findings.
    case "GHOST_REDIRECT":
      return `${adminBase}/content/redirects`;
    // Verified list-level surface: Settings > Languages.
    case "GHOST_TRANSLATION":
      return `${adminBase}/settings/languages`;
    default:
      return null;
  }
}

/**
 * The link label for an Admin-resource finding, keyed on the same finding type as
 * buildAdminResourceUrl. Co-located here (rather than in the component) so the
 * URL and its label stay in sync and are unit-tested together. Unknown types get
 * a generic fallback; in practice the caller only renders this when
 * buildAdminResourceUrl returned a URL, so an Admin-resource label is guaranteed.
 */
export function adminResourceLinkLabel(findingType: string): string {
  switch (findingType) {
    case "GHOST_TAG":
    case "GHOST_PRICE":
    case "GHOST_METAFIELD":
      return "View product";
    case "GHOST_PAGE":
      return "View page";
    case "GHOST_REDIRECT":
      return "Manage URL redirects";
    case "GHOST_TRANSLATION":
      return "Open translations";
    default:
      return "View resource";
  }
}

/**
 * A human-friendly label for an Admin-resource finding's synthetic locator, for
 * the scan-detail findings "File" column. The stored `filename` for these types
 * is developer plumbing (a resource prefix + embedded GID, e.g.
 * `products/gid://shopify/Product/8234567890`), which is meaningless to a
 * merchant, so this maps it to a plain-language description.
 *
 * Locator formats are the ones the Admin-resource detectors emit (documented in
 * finding-classification.ts). Only the FILE-CELL text is affected — the raw
 * locator is still what the exporter and deep-link builder consume.
 *
 * Mapping:
 *   - GHOST_TAG / GHOST_PRICE (`products/{gid}`)            → "Product"
 *   - GHOST_METAFIELD (`products/{gid}/metafields`)         → "Product metafield"
 *   - GHOST_PAGE (`pages/{handle}`)                         → "Page: /pages/{handle}"
 *   - GHOST_REDIRECT single (`redirects/{gid}`)             → "URL redirect"
 *   - GHOST_REDIRECT bulk (`redirects/bulk/{prefix}`)       → "URL redirects: {prefix}"
 *                                                             (the stored prefix has `/`
 *                                                             replaced by `_`; restored here)
 *   - GHOST_TRANSLATION (`translations/{locale}/{resource}`)→ "Translation: {locale} / {resource}"
 *
 * Anything unknown or unparseable falls back to the raw locator (or the finding
 * type if the locator is blank) so the cell is never empty.
 */
export function adminResourceLocatorLabel(
  findingType: string,
  locator: string | null | undefined,
): string {
  const fallback = locator && locator.length > 0 ? locator : findingType;

  switch (findingType) {
    case "GHOST_TAG":
    case "GHOST_PRICE":
      return "Product";
    case "GHOST_METAFIELD":
      return "Product metafield";
    case "GHOST_PAGE": {
      const handle = pageHandleFromLocator(locator);
      return handle ? `Page: /pages/${handle}` : fallback;
    }
    case "GHOST_REDIRECT": {
      const bulkPrefix = "redirects/bulk/";
      if (locator && locator.startsWith(bulkPrefix)) {
        // Restore the `/` the detector replaced with `_` when storing the prefix.
        const prefix = locator.slice(bulkPrefix.length).replace(/_/g, "/");
        return prefix.length > 0 ? `URL redirects: ${prefix}` : "URL redirects";
      }
      return "URL redirect";
    }
    case "GHOST_TRANSLATION": {
      const prefix = "translations/";
      if (locator && locator.startsWith(prefix)) {
        const rest = locator.slice(prefix.length);
        const slash = rest.indexOf("/");
        // Require a non-empty locale AND resource on either side of the slash.
        if (slash > 0 && slash < rest.length - 1) {
          const locale = rest.slice(0, slash);
          const resource = rest.slice(slash + 1);
          return `Translation: ${locale} / ${resource}`;
        }
      }
      return fallback;
    }
    default:
      return fallback;
  }
}
