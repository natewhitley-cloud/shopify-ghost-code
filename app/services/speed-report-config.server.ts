/**
 * Store speed report runtime config (gc-wt3y): the dark flag, the PageSpeed
 * API key and the global daily call budget. The ONE place these env vars are
 * read.
 *
 * DARK BY DEFAULT: while SPEED_REPORT_LIVE_ENABLED is not exactly "true" there
 * is no PageSpeed call, no cron work and no UI (the route 404s and the nav
 * entry is hidden).
 *
 * The key is returned to the caller that builds the request URL and nowhere
 * else: never log it, never put it in an error, an OpsEvent or a step output.
 */

import { FREE_SPEED_TEST_DAILY_CALL_CEILING } from "../lib/speed-report";

/** Whether the speed report is live (flag exactly "true"). */
export function isSpeedReportLive(): boolean {
  return process.env.SPEED_REPORT_LIVE_ENABLED === "true";
}

/** The PageSpeed Insights API key, or null when unset/blank. */
export function getPageSpeedApiKey(): string | null {
  const key = process.env.PAGESPEED_API_KEY?.trim();
  return key ? key : null;
}

/**
 * Default global PageSpeed calls per UTC day. Google's quota is 25,000/day per
 * project; each report uses at most 6 (3 runs x 2 pages), so 5,000 covers ~830
 * reports a day while leaving most of the quota untouched.
 */
export const DEFAULT_PAGESPEED_DAILY_CALL_BUDGET = 5000;

/**
 * PAGESPEED_DAILY_CALL_BUDGET as a non-negative integer. Unset, blank or not a
 * whole number falls back to the default; "0" is honoured (no calls at all).
 */
export function getDailyCallBudget(): number {
  const raw = process.env.PAGESPEED_DAILY_CALL_BUDGET?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_PAGESPEED_DAILY_CALL_BUDGET;
  return Number.parseInt(raw, 10);
}

/**
 * The daily call count at which free speed tests stop, for a given budget
 * (gc-au2l): FREE_SPEED_TEST_DAILY_CALL_CEILING at the default budget or
 * above, and the same share of a lower budget (rounded down), so a lowered
 * PAGESPEED_DAILY_CALL_BUDGET never lets free tests use up what paying shops'
 * reports need. Pure.
 */
export function freeSpeedTestDailyCallCeiling(budget: number): number {
  return Math.min(
    FREE_SPEED_TEST_DAILY_CALL_CEILING,
    Math.floor((budget * FREE_SPEED_TEST_DAILY_CALL_CEILING) / DEFAULT_PAGESPEED_DAILY_CALL_BUDGET),
  );
}
