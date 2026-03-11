import { getPlanFeatures } from "./billing.server";
import { countScansForShopSince } from "../models/scan.server";

/**
 * Check whether a shop is allowed to start a new scan under their current plan.
 *
 * - Free plan: 1 scan per calendar month.
 * - Standard / Professional: unlimited scans (maxScansPerMonth === Infinity).
 *
 * Returns { allowed: true } or { allowed: false, reason: "<human-readable message>" }.
 */
export async function canStartScan(
  shopId: string,
  planName: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const features = getPlanFeatures(planName);

  if (features.maxScansPerMonth === Infinity) {
    return { allowed: true };
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const usedThisMonth = await countScansForShopSince(shopId, monthStart);

  if (usedThisMonth >= features.maxScansPerMonth) {
    return {
      allowed: false,
      reason: `Free plan limit: ${features.maxScansPerMonth} scan per month. Upgrade to Standard or Professional for unlimited scans.`,
    };
  }

  return { allowed: true };
}

/**
 * Whether the plan includes full finding details (code snippets, line numbers, etc.).
 * Free plan hides details to incentivise upgrade.
 */
export function canViewFindingDetails(planName: string): boolean {
  return getPlanFeatures(planName).showFindingDetails;
}

/**
 * Whether the plan supports scanning more than one theme.
 */
export function canUseMultipleThemes(planName: string): boolean {
  return getPlanFeatures(planName).maxThemes > 1;
}

/**
 * Whether the plan includes automatic re-scanning on theme publish events.
 */
export function canUseAutoRescan(planName: string): boolean {
  return getPlanFeatures(planName).autoRescan;
}

/**
 * Whether the plan includes scan diffing (before/after comparison between scans).
 */
export function canUseScanDiffing(planName: string): boolean {
  return getPlanFeatures(planName).scanDiffing;
}
