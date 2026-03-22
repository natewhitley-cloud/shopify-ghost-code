import { getPlanFeatures } from "./billing.server";
import db from "../db.server";
import { countScansForShopSince, hasCompletedScans } from "../models/scan.server";

/**
 * Return the start of the current ISO week (Monday 00:00:00 UTC).
 */
export function getWeekStartUTC(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay() returns 0 (Sunday) – 6 (Saturday). Shift so Monday = 0.
  const dayOfWeek = d.getUTCDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday = 0 offset
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/**
 * Check whether a shop is allowed to start a new scan under their current plan.
 *
 * - Free plan: first scan ever is always allowed (onboarding); after that, 1 scan per calendar month.
 * - Standard: 1 scan per week (resets Monday 00:00 UTC).
 * - Professional: unlimited scans.
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

  const usage = await getScanUsage(shopId, planName);

  // Professional plan (or any plan with no quota): no cap.
  if (!usage) {
    return { allowed: true };
  }

  // Weekly limit check (Standard plan).
  if (usage.period === "week") {
    if (usage.used >= usage.limit) {
      return {
        allowed: false,
        reason: `Weekly scan limit reached (${usage.used} of ${usage.limit} used). Upgrade to Professional for unlimited scans.`,
      };
    }

    return { allowed: true };
  }

  // Monthly limit check (Free plan).
  // The very first scan is always allowed regardless of the monthly quota.
  // This is the onboarding moment — merchants need to see a scan result
  // before they can evaluate the product.
  const alreadyScanned = await hasCompletedScans(shopId);
  if (!alreadyScanned) {
    return { allowed: true };
  }

  if (usage.used >= usage.limit) {
    return {
      allowed: false,
      reason: `Free plan limit: ${usage.limit} scan per month. Upgrade to Standard or Professional for more scans.`,
    };
  }

  return { allowed: true };
}

/**
 * Return the scan usage for a shop under its current plan.
 *
 * Computes the billing period start (week for Standard, month for Free),
 * counts scans in that period, and returns the limit. Both the dashboard
 * loader and canStartScan delegate here to avoid duplicating the
 * period/limit calculation.
 *
 * Returns null for plans with no quota (Professional / unlimited).
 */
export async function getScanUsage(
  shopId: string,
  planName: string,
): Promise<{ used: number; limit: number; period: "week" | "month"; periodStart: Date } | null> {
  const features = getPlanFeatures(planName);

  // Professional plan (both limits at Infinity): no quota.
  if (features.maxScansPerMonth === Infinity && features.maxScansPerWeek === Infinity) {
    return null;
  }

  if (features.maxScansPerWeek !== Infinity) {
    // Weekly limit (Standard plan).
    const periodStart = getWeekStartUTC();
    const used = await countScansForShopSince(shopId, periodStart);
    return { used, limit: features.maxScansPerWeek, period: "week", periodStart };
  }

  // Monthly limit (Free plan).
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const used = await countScansForShopSince(shopId, periodStart);
  return { used, limit: features.maxScansPerMonth, period: "month", periodStart };
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
