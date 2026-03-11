import { getPlanFeatures } from "./billing.server";
import { countScansForShopSince, hasCompletedScans } from "../models/scan.server";
import db from "../db.server";

/**
 * Check whether a shop is allowed to start a new scan under their current plan.
 *
 * - Free plan: first scan ever is always allowed (onboarding); after that, 1 scan per calendar month.
 * - Standard / Professional: unlimited scans (maxScansPerMonth === Infinity).
 *
 * Returns { allowed: true } or { allowed: false, reason: "<human-readable message>" }.
 */
export async function canStartScan(
  shopId: string,
  planName: string,
): Promise<{ allowed: boolean; reason?: string }> {
  // Guard against duplicate concurrent scans regardless of plan tier.
  const activeScans = await db.scan.findFirst({
    where: { shopId, status: { in: ["PENDING", "IN_PROGRESS"] } },
  });
  if (activeScans) {
    return { allowed: false, reason: "A scan is already in progress." };
  }

  const features = getPlanFeatures(planName);

  if (features.maxScansPerMonth === Infinity) {
    return { allowed: true };
  }

  // Free plan: the very first scan is always allowed regardless of the monthly
  // quota. This is the onboarding moment — merchants need to see a scan result
  // before they can evaluate the product. Subsequent scans fall under the
  // normal 1/month cap.
  const alreadyScanned = await hasCompletedScans(shopId);
  if (!alreadyScanned) {
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
