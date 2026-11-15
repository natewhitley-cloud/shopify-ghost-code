/**
 * Store speed's value action (gc-np1d.6, docs/ux/page-map.md "Store speed"):
 * the costliest app links to its leftover code on the scan page. This reads
 * the leftover counts for the apps the page names, from the latest successful
 * scan of the live theme.
 *
 * Counts only what Home's "leftover items" counts (leftover types with a
 * consequence lane; never security findings) and leaves out the shop's
 * ignored findings, so the number matches what the filtered scan page lists.
 *
 * Query budget: only when the page names a costliest app. The live theme via
 * Home's 60s cache, then the ignores and the latest scan id in parallel, then
 * ONE groupBy (or, for a shop with ignores, that scan's findings). Never
 * throws: a failed read shows no link and the page still renders.
 */
import { getCachedMainTheme } from "./theme-cache.server";
import { leftoversByApp, leftoversByAppForScan } from "./value-action.server";
import { logger } from "../lib/logger.server";
import { matchSpeedLeftoverApp, type SpeedAppLeftovers } from "../lib/speed-report";
import { getFindingsForScan } from "../models/finding.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { getLatestSuccessfulScanIdForTheme } from "../models/scan.server";
import type { AdminApiContext } from "../types/shopify";

export async function readSpeedAppLeftovers(input: {
  shopId: string;
  /** session.shop: the theme cache key. */
  shopDomain: string;
  admin: AdminApiContext;
  /** The speed rows' names to match (the costliest app per section). */
  appNames: readonly string[];
}): Promise<SpeedAppLeftovers | null> {
  const { shopId, shopDomain, admin, appNames } = input;
  if (appNames.length === 0) return null;
  try {
    const mainTheme = await getCachedMainTheme(admin, shopDomain);
    if (!mainTheme) return null;
    const [scanId, ignores] = await Promise.all([
      getLatestSuccessfulScanIdForTheme(shopId, mainTheme.id),
      getIgnoredFindingsForShop(shopId),
    ]);
    if (!scanId) return null;
    const hasIgnores = ignores.fingerprints.size > 0 || ignores.appNames.size > 0;
    const leftovers = hasIgnores
      ? leftoversByApp(await getFindingsForScan(scanId), ignores)
      : await leftoversByAppForScan(scanId);
    // Only the apps the page names are sent to the page.
    const apps = leftovers.apps.filter((app) =>
      appNames.some((name) => matchSpeedLeftoverApp(name, [app]) !== null),
    );
    return apps.length > 0 ? { scanId, apps } : null;
  } catch (error) {
    logger.warn("speed leftovers unavailable", {
      function: "readSpeedAppLeftovers",
      shopId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
