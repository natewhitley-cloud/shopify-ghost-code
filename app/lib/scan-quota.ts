/**
 * Manual-scan quota periods (pure, no DB): the day / week / month a plan's
 * manual scans are counted in, and when the next one starts. Used by
 * plan-gating.server (canStartScan, getScanUsage) and Home's scan action.
 */
import type { PlanFeatures } from "./billing.server";

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

/** Start of the current UTC day (00:00:00 UTC). */
export function getDayStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type ScanQuotaPeriod = "day" | "week" | "month";

/**
 * The start of the quota period AFTER the one starting at `periodStart`: when
 * a quota-blocked shop can next scan (gc-mgi). `period` and `periodStart` come
 * from getScanQuotaPeriod, the single source of the period logic.
 *   - day (Professional): the next day, 00:00 UTC (gc-d0ui).
 *   - week (Standard): the following Monday, 00:00 UTC.
 *   - month (Free): the 1st of the following month, 00:00 UTC.
 */
export function getNextScanPeriodStart(period: ScanQuotaPeriod, periodStart: Date): Date {
  if (period === "month") {
    return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  }
  const next = new Date(periodStart);
  next.setUTCDate(next.getUTCDate() + (period === "day" ? 1 : 7));
  return next;
}

/**
 * The plan's manual-scan quota period, from its features: which period
 * applies, when the current one started, and how many MANUAL scans it allows.
 * null = no quota. The single source for getScanUsage (advisory, UX) and the
 * Home action's atomic quota (createScan), so the two can never disagree:
 *   - Professional: 5 a day (resets 00:00 UTC, gc-d0ui);
 *   - Standard: 1 a week (resets Monday 00:00 UTC);
 *   - Free: 1 a month (resets on the 1st, 00:00 UTC).
 * A limit that is not a finite number (Infinity, or absent) means no cap for
 * that period.
 */
export function getScanQuotaPeriod(
  features: Pick<PlanFeatures, "maxScansPerDay" | "maxScansPerWeek" | "maxScansPerMonth">,
  now: Date = new Date(),
): { period: ScanQuotaPeriod; periodStart: Date; limit: number } | null {
  if (Number.isFinite(features.maxScansPerDay)) {
    return { period: "day", periodStart: getDayStartUTC(now), limit: features.maxScansPerDay };
  }
  if (Number.isFinite(features.maxScansPerWeek)) {
    return { period: "week", periodStart: getWeekStartUTC(now), limit: features.maxScansPerWeek };
  }
  if (Number.isFinite(features.maxScansPerMonth)) {
    return {
      period: "month",
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      limit: features.maxScansPerMonth,
    };
  }
  return null;
}
