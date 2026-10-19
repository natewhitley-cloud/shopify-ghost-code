import { getPlanFeatures } from "./billing.server";
import { PLANS } from "./plans";
import { getNextScanPeriodStart, getScanQuotaPeriod } from "./scan-quota";
import type { ScanQuotaPeriod } from "./scan-quota";
import db from "../db.server";
import { countScansForShopSince, hasCompletedScans } from "../models/scan.server";

// The pure period helpers live in ./scan-quota (no DB); re-exported here for
// existing import sites.
export {
  getDayStartUTC,
  getNextScanPeriodStart,
  getScanQuotaPeriod,
  getWeekStartUTC,
} from "./scan-quota";
export type { ScanQuotaPeriod } from "./scan-quota";

/**
 * Check whether a shop is allowed to start a new MANUAL scan under their plan.
 *
 * - Free plan: first scan ever is always allowed (onboarding); after that, 1 scan per calendar month.
 * - Standard: 1 scan per week (resets Monday 00:00 UTC).
 * - Professional: 5 scans per UTC day (resets 00:00 UTC, gc-d0ui).
 *
 * Only manual scans count; scheduled and publish-triggered scans never call
 * this and are never blocked by a quota.
 *
 * Returns { allowed: true } or { allowed: false, reason: "<human-readable message>" }.
 * A QUOTA block also returns `nextScanAt`, the start of the next quota period
 * (getNextScanPeriodStart); a scan already in progress does not.
 */
export async function canStartScan(
  shopId: string,
  planName: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean; reason?: string; nextScanAt?: Date }> {
  // Guard against duplicate concurrent scans regardless of plan tier.
  const activeScans = await db.scan.findFirst({
    where: { shopId, status: { in: ["PENDING", "IN_PROGRESS"] } },
  });
  if (activeScans) {
    return { allowed: false, reason: "A scan is already in progress." };
  }

  const usage = await getScanUsage(shopId, planName, now);

  // A plan with no quota: no cap.
  if (!usage) {
    return { allowed: true };
  }

  // Daily limit check (Professional). No upgrade path: just the reset time.
  if (usage.period === "day") {
    if (usage.used >= usage.limit) {
      return {
        allowed: false,
        reason: `Daily scan limit reached (${usage.used} of ${usage.limit} used). Your next scan is available at 00:00 UTC.`,
        nextScanAt: getNextScanPeriodStart(usage.period, usage.periodStart),
      };
    }
    return { allowed: true };
  }

  // Weekly limit check (Standard plan).
  if (usage.period === "week") {
    if (usage.used >= usage.limit) {
      return {
        allowed: false,
        reason: `Weekly scan limit reached (${usage.used} of ${usage.limit} used). Upgrade to Professional for up to ${getPlanFeatures(PLANS.PROFESSIONAL).maxScansPerDay} scans a day.`,
        nextScanAt: getNextScanPeriodStart(usage.period, usage.periodStart),
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
      nextScanAt: getNextScanPeriodStart(usage.period, usage.periodStart),
    };
  }

  return { allowed: true };
}

/**
 * Return the manual-scan usage for a shop under its current plan: the quota
 * period (getScanQuotaPeriod), the MANUAL scans counted in it, and the limit.
 * Both the dashboard loader and canStartScan delegate here.
 *
 * Returns null for plans with no quota.
 */
export async function getScanUsage(
  shopId: string,
  planName: string,
  now: Date = new Date(),
): Promise<{ used: number; limit: number; period: ScanQuotaPeriod; periodStart: Date } | null> {
  const quota = getScanQuotaPeriod(getPlanFeatures(planName), now);
  if (!quota) return null;
  const used = await countScansForShopSince(shopId, quota.periodStart);
  return { used, limit: quota.limit, period: quota.period, periodStart: quota.periodStart };
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

/**
 * Whether the plan includes dangling-reference (Broken Links) detection.
 * Paid-only (Standard and above); Free does not get this audit (gc-m4h.7).
 */
export function canDetectDanglingReferences(planName: string): boolean {
  return getPlanFeatures(planName).canDetectDanglingReferences;
}

/**
 * Whether the plan includes checkout-extensibility sunset (Checkout Sunset)
 * detection. Paid-only (Standard and above); Free does not get this audit
 * (gc-b3c), mirroring canDetectDanglingReferences.
 */
export function canDetectCheckoutSunset(planName: string): boolean {
  return getPlanFeatures(planName).canDetectCheckoutSunset;
}

/**
 * Whether the plan can scan more than one theme (multi-theme support).
 *
 * Derived from the plan matrix's `maxThemes` (single source of truth in
 * billing.server.ts): Professional gets unlimited themes; Free and Standard are
 * capped at 1. Used to gate the theme picker and the Standard→Professional
 * multi-theme upgrade nudge.
 */
export function canUseMultipleThemes(planName: string): boolean {
  return getPlanFeatures(planName).maxThemes > 1;
}

/** Whether the plan can export a scan as a branded PDF report. Professional-only (gc-rrh.1). */
export function canExportPdf(planName: string): boolean {
  return getPlanFeatures(planName).exportPdf;
}

/**
 * Whether the plan can receive merchant "new findings" alert emails (gc-syz.3).
 * Alerts ride the scheduled-scan cadence, so Free (none) is excluded.
 */
export function canReceiveAlerts(planName: string): boolean {
  return getPlanFeatures(planName).alertCadence !== "none";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between two alert emails to one shop (the throttle window), derived
 * from the plan's alertCadence: weekly -> 7 days, monthly -> 28 days (the
 * shortest gap between two runs on the 1st, February), none -> null (the plan
 * receives no alerts).
 */
export function getAlertWindowMs(planName: string): number | null {
  switch (getPlanFeatures(planName).alertCadence) {
    case "weekly":
      return 7 * DAY_MS;
    case "monthly":
      return 28 * DAY_MS;
    case "none":
      return null;
  }
}
