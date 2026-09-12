/**
 * Optional Shopify access scopes — the single source of truth shared by the
 * settings Permissions card and the scan-detail "checks skipped" banner.
 *
 * The scope handles MUST stay in sync with `optional_scopes` in
 * `shopify.app.toml` — that TOML list is the authoritative set the App Bridge
 * `shopify.scopes.request()` modal is allowed to ask for. The server-side probes
 * in `app/services/*-fetcher.server.ts` use these SAME handles as their
 * `scopeLabel` (e.g. `hasTranslationScope` probes `read_translations`), so a scan
 * that skips a category maps back to exactly one of these handles — even though
 * the underlying Admin API field for translations is gated by
 * `read_locales`/`read_markets`, the scope the merchant grants (and the one to
 * request) is `read_translations`.
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
};

/**
 * Reverse map: each skippable finding-type category → the optional scope(s) that
 * unlock it, plus a human label. Sourced from the scan engine's
 * `skippedCategories` builder (`inngest/functions/scan-theme.ts`) and each
 * detector's scope gate:
 *   - GHOST_TRANSLATION                              → read_translations            (hasTranslationScope)
 *   - GHOST_TAG / GHOST_PRICE / GHOST_METAFIELD,
 *     JSON_LD_PRICE_CONFLICT                         → read_products                (hasProductScope)
 *   - GHOST_PAGE                                     → read_content                 (hasContentScope)
 *   - GHOST_REDIRECT                                 → read_online_store_navigation (hasNavigationScope)
 *   - DANGLING_REFERENCE                             → read_products + read_content (either unlocks part)
 *
 * The `optional-scopes.test.ts` drift guard reads the scan engine and asserts
 * every category it can emit into `skippedCategories` is covered here, so a new
 * skipped category can never render as an unlabeled banner.
 */
export const SKIPPABLE_CATEGORY_INFO: Record<string, { label: string; scopes: OptionalScope[] }> = {
  GHOST_TRANSLATION: { label: "Translations", scopes: ["read_translations"] },
  GHOST_TAG: { label: "Product tags", scopes: ["read_products"] },
  GHOST_PRICE: { label: "Compare-at prices", scopes: ["read_products"] },
  GHOST_METAFIELD: { label: "Metafields", scopes: ["read_products"] },
  JSON_LD_PRICE_CONFLICT: { label: "Structured-data prices", scopes: ["read_products"] },
  GHOST_PAGE: { label: "Content pages", scopes: ["read_content"] },
  GHOST_REDIRECT: { label: "URL redirects", scopes: ["read_online_store_navigation"] },
  DANGLING_REFERENCE: { label: "Broken links", scopes: ["read_products", "read_content"] },
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
 * Whether a scan skipped any optional audit for a missing scope. Drives the
 * scan-detail Permissions banner.
 *
 * `PARTIAL` is the terminal status reserved for a scope-skip, and
 * `skippedCategories` is the precise per-category signal. Either is sufficient:
 * the engine currently finalizes `COMPLETED` even when categories were skipped,
 * so `skippedCategories.length > 0` is the real-world trigger today; the
 * `PARTIAL` check is a defensive belt-and-braces guard for the schema's intended
 * semantics.
 */
export function scanSkippedForScopes(scan: {
  status: string;
  skippedCategories: readonly string[];
}): boolean {
  return scan.status === "PARTIAL" || scan.skippedCategories.length > 0;
}

/**
 * Distinct human labels for a scan's skipped categories, in first-seen order.
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
