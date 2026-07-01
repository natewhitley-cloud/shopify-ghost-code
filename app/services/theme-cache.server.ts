/**
 * Cached dashboard theme reads.
 *
 * The dashboard loader (`app/routes/app._index.tsx`) renders the shop's MAIN
 * theme and theme list on every navigation. Those reads hit the Shopify theme
 * GraphQL API and block the loader each time. These wrappers add a short TTL
 * cache so repeated dashboard views within a browsing session don't re-fetch.
 *
 * IMPORTANT — cache only the dashboard READ path. The dashboard action's
 * theme-list validation (a security check on a merchant-submitted themeId) and
 * the daily poll cron (which reads `updatedAt` to detect re-scan need) call the
 * raw `theme-fetcher.server` functions directly so their reads are always
 * fresh. Do not route those callers through here.
 */

import { fetchAllThemes, fetchMainTheme } from "./theme-fetcher.server";
import type { MainTheme, ThemeSummary } from "./theme-fetcher.server";
import { createTtlCache } from "../lib/ttl-cache.server";
import type { AdminApiContext } from "../types/shopify";

/**
 * TTL for cached dashboard theme reads. 60s keeps repeated dashboard views
 * within a browsing session cheap while staying fresh enough that a merchant
 * who just published a theme sees the change on their next visit soon after.
 */
const THEME_CACHE_TTL_MS = 60_000; // 60s

// Separate namespaces so main-theme and all-themes reads never collide.
// Keyed by shop domain (never a global key) so one shop can never read
// another shop's themes out of the cache.
const mainThemeCache = createTtlCache<MainTheme | null>(THEME_CACHE_TTL_MS);
const allThemesCache = createTtlCache<ThemeSummary[]>(THEME_CACHE_TTL_MS);

/**
 * Dashboard-loader read of the MAIN theme, cached per shop for {@link
 * THEME_CACHE_TTL_MS}. A `null` result (no published theme) is cached too — it
 * reads back as a hit, distinct from an `undefined` miss.
 *
 * A thrown fetch error propagates WITHOUT populating the cache, so a transient
 * API failure is never cached and the next dashboard view retries.
 */
export async function getCachedMainTheme(
  admin: AdminApiContext,
  shopKey: string,
): Promise<MainTheme | null> {
  const cached = mainThemeCache.get(shopKey);
  if (cached !== undefined) return cached;

  const mainTheme = await fetchMainTheme(admin);
  mainThemeCache.set(shopKey, mainTheme);
  return mainTheme;
}

/**
 * Dashboard-loader read of all themes, cached per shop for {@link
 * THEME_CACHE_TTL_MS}. Not for the action's validation path — that must stay
 * fresh (a stale list could validate a deleted theme or reject a new one).
 *
 * A thrown fetch error propagates WITHOUT populating the cache.
 */
export async function getCachedAllThemes(
  admin: AdminApiContext,
  shopKey: string,
): Promise<ThemeSummary[]> {
  const cached = allThemesCache.get(shopKey);
  if (cached !== undefined) return cached;

  const allThemes = await fetchAllThemes(admin);
  allThemesCache.set(shopKey, allThemes);
  return allThemes;
}

/** Test-only: clear both caches so module state doesn't leak across tests. */
export function resetThemeCaches(): void {
  mainThemeCache.clear();
  allThemesCache.clear();
}
