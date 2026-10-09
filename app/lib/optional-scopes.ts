/**
 * Optional Shopify access scopes — the single source of truth shared by the
 * settings Permissions card and the scan-detail "checks skipped" banner.
 *
 * The scope handles MUST stay in sync with `optional_scopes` in
 * `shopify.app.toml` — that TOML list is the authoritative set the App Bridge
 * `shopify.scopes.request()` modal is allowed to ask for. The server-side probes
 * in `app/services/*-fetcher.server.ts` use these SAME handles as their
 * `scopeLabel` (e.g. `hasTranslationScope` probes under `read_translations`).
 *
 * The translations check needs BOTH `read_translations` and `read_locales`
 * (gc-l1cm): its probe and locale fetch query `shopLocales`, which Shopify gates
 * on `read_locales` ("Required access: read_locales or read_markets_home"), so
 * `read_translations` alone gets ACCESS_DENIED on every scan. A skipped
 * GHOST_TRANSLATION therefore maps back to both handles.
 *
 * Client-safe (no `.server` suffix, no server-only imports): the settings card
 * runs in the browser (App Bridge `shopify.scopes.*`), and the banner runs in
 * both the loader and the client render.
 */

/** Canonical optional scopes, sourced from `shopify.app.toml` `optional_scopes`. */
export const OPTIONAL_SCOPES = [
  "read_translations",
  "read_products",
  "read_content",
  "read_online_store_navigation",
  "read_locales",
] as const;

export type OptionalScope = (typeof OPTIONAL_SCOPES)[number];

/** Human-facing copy for each optional scope in the settings Permissions card. */
export const OPTIONAL_SCOPE_INFO: Record<OptionalScope, { label: string; unlocks: string }> = {
  read_translations: {
    label: "Translations",
    unlocks: "Finds orphaned translation content left behind by uninstalled translation apps.",
  },
  read_products: {
    label: "Products",
    unlocks:
      "Finds orphaned product tags, stale compare-at prices, leftover metafields, and outdated structured-data prices.",
  },
  read_content: {
    label: "Pages & content",
    unlocks: "Finds orphaned content pages and broken links to pages that no longer exist.",
  },
  read_online_store_navigation: {
    label: "URL redirects",
    unlocks: "Finds orphaned URL redirects left behind by uninstalled apps.",
  },
  read_locales: {
    label: "Store languages",
    unlocks:
      "Lets the translations check see which languages your store uses. Needed together with Translations.",
  },
};

/**
 * Broken links (DANGLING_REFERENCE) use read_products / read_content but are a
 * Standard feature BY PLAN (gc-m4h.7), so on Free the Permissions card says so
 * rather than implying a grant adds them (gc-4n0y).
 */
export const BROKEN_LINKS_STANDARD_NOTE =
  "Broken-link checks come with the Standard plan. Granting these permissions doesn't add them on Free.";

/**
 * The Permissions card's "unlocks" line for a scope on the viewer's plan. The
 * read_content line names broken links, which are Standard+ by plan, so a plan
 * without them gets the line without that claim (audit fix, gc-4n0y).
 */
export function optionalScopeUnlocks(scope: OptionalScope, brokenLinksIncluded: boolean): string {
  if (scope === "read_content" && !brokenLinksIncluded) {
    return "Finds orphaned content pages left behind by uninstalled apps.";
  }
  return OPTIONAL_SCOPE_INFO[scope].unlocks;
}

/**
 * Reverse map: each skippable finding-type category → the optional scope(s) that
 * unlock it, plus a human label. Sourced from the scan engine's
 * `skippedCategories` builder (`inngest/functions/scan-theme.ts`) and each
 * detector's scope gate:
 *   - GHOST_TRANSLATION                              → read_translations + read_locales (both needed; hasTranslationScope, gc-l1cm)
 *   - GHOST_TAG / GHOST_PRICE / GHOST_METAFIELD,
 *     JSON_LD_PRICE_CONFLICT                         → read_products                (hasProductScope)
 *   - GHOST_PAGE                                     → read_content                 (hasContentScope)
 *   - GHOST_REDIRECT                                 → read_online_store_navigation (hasNavigationScope)
 *   - DANGLING_REFERENCE                             → read_products + read_content (either unlocks part)
 *   - SCRIPT_TAG_SUNSET                              → none: never scope-skipped, only
 *                                                      `unreachableCategories` (storefront
 *                                                      unreadable); listed for its label
 *
 * The `optional-scopes.test.ts` drift guard reads the scan engine and asserts
 * every category it can emit into `skippedCategories`, `cappedCategories`
 * (gc-11f), or `unreachableCategories` is covered here, so a new category can
 * never render as an unlabeled notice. Only a scope-skippable category (one
 * the engine can put in `skippedCategories`) must name at least one scope.
 */
export const SKIPPABLE_CATEGORY_INFO: Record<string, { label: string; scopes: OptionalScope[] }> = {
  GHOST_TRANSLATION: { label: "Translations", scopes: ["read_translations", "read_locales"] },
  GHOST_TAG: { label: "Product tags", scopes: ["read_products"] },
  GHOST_PRICE: { label: "Compare-at prices", scopes: ["read_products"] },
  GHOST_METAFIELD: { label: "Metafields", scopes: ["read_products"] },
  JSON_LD_PRICE_CONFLICT: { label: "Structured-data prices", scopes: ["read_products"] },
  GHOST_PAGE: { label: "Content pages", scopes: ["read_content"] },
  GHOST_REDIRECT: { label: "URL redirects", scopes: ["read_online_store_navigation"] },
  DANGLING_REFERENCE: { label: "Broken links", scopes: ["read_products", "read_content"] },
  SCRIPT_TAG_SUNSET: { label: "Script tag sunset", scopes: [] },
};

/**
 * Optional scopes NOT present in the granted set, preserving declared order.
 * `granted` is `shopify.scopes.query().granted` (all granted scopes, required +
 * optional), so this is exactly the set to pass to `shopify.scopes.request()`.
 */
export function missingOptionalScopes(granted: readonly string[]): OptionalScope[] {
  const set = new Set(granted);
  return OPTIONAL_SCOPES.filter((scope) => !set.has(scope));
}

/** True when every optional scope has been granted. */
export function allOptionalScopesGranted(granted: readonly string[]): boolean {
  return missingOptionalScopes(granted).length === 0;
}

/**
 * Distinct human labels for a scan's skipped (or capped, gc-11f) categories,
 * in first-seen order.
 * An unknown category falls back to its raw enum name so nothing is silently
 * dropped (the drift-guard test prevents this in practice).
 */
export function skippedCategoryLabels(categories: readonly string[]): string[] {
  const labels: string[] = [];
  for (const category of categories) {
    const info = SKIPPABLE_CATEGORY_INFO[category];
    const label = info ? info.label : category;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}
