/**
 * Settings plan tiles (gc-4wvb): the one source for each plan's name, price and
 * feature bullets. The bullets are the LIVE App Store plan cards (Partner
 * Dashboard, 2026-10-19), so the in-app tiles and the listing say the same
 * thing; `docs/pricing-and-plans.md` "App listing features" mirrors these lists
 * and a test keeps them equal.
 *
 * Pure and client-safe.
 */
import { PLANS } from "./plans";
import {
  FREE_SPEED_TEST_BULLET,
  MONTHLY_SPEED_REPORT_BULLET,
  WEEKLY_SPEED_REPORT_BULLET,
} from "./speed-report";
import { FREE_TRIAL_DAYS } from "./trial-cta";

export type TilePlan = typeof PLANS.FREE | typeof PLANS.STANDARD | typeof PLANS.PROFESSIONAL;

/** Tile order, low to high. */
export const TILE_PLANS: readonly TilePlan[] = [PLANS.FREE, PLANS.STANDARD, PLANS.PROFESSIONAL];

export const PLAN_TILE_META: Record<TilePlan, { name: string; price: string }> = {
  [PLANS.FREE]: { name: "Free", price: "$0 / month" },
  [PLANS.STANDARD]: { name: "Standard", price: "$9 / month" },
  [PLANS.PROFESSIONAL]: { name: "Professional", price: "$29 / month" },
};

/** The listing bullets, in card order (max 40 chars each, Managed Pricing limit). */
export const PLAN_LISTING_BULLETS: Record<TilePlan, readonly string[]> = {
  [PLANS.FREE]: [
    "First scan always free",
    "1 scan per month after first",
    "Findings grouped by impact, with counts",
    "Up to 5 findings shown in full",
    "Single theme scanning",
    FREE_SPEED_TEST_BULLET,
    "Malicious code and app incident alerts",
    "Ask Sidekick about your scan results",
  ],
  [PLANS.STANDARD]: [
    "All features in Free",
    "Full finding details with code",
    "Catch broken links from old apps",
    "Find dead checkout.liquid code",
    "Monthly auto-scan + findings trend",
    MONTHLY_SPEED_REPORT_BULLET,
  ],
  [PLANS.PROFESSIONAL]: [
    "All features in Standard",
    "Up to 5 manual theme scans a day",
    "Auto-rescan on theme publish",
    "Weekly automatic scans",
    WEEKLY_SPEED_REPORT_BULLET,
    "Scan diffing (New/Resolved)",
    "Scan every theme in your store",
  ],
};

/** Each plan's speed bullet, shown in-app only while the speed report is live. */
const SPEED_BULLET: Record<TilePlan, string> = {
  [PLANS.FREE]: FREE_SPEED_TEST_BULLET,
  [PLANS.STANDARD]: MONTHLY_SPEED_REPORT_BULLET,
  [PLANS.PROFESSIONAL]: WEEKLY_SPEED_REPORT_BULLET,
};

export const TRIAL_BULLET = `${FREE_TRIAL_DAYS}-day free trial`;

/**
 * The bullets one tile shows: the listing bullets, minus the speed bullet while
 * that plan's speed feature is not live, plus the trial bullet on a paid tile
 * when the shop is trial-eligible (the same eligibility as the buttons, so the
 * tile never promises a trial the button won't give).
 */
export function planTileBullets(
  plan: TilePlan,
  opts: { speedLive: boolean; trialEligible: boolean },
): string[] {
  const bullets = PLAN_LISTING_BULLETS[plan].filter(
    (b) => opts.speedLive || b !== SPEED_BULLET[plan],
  );
  if (opts.trialEligible && plan !== PLANS.FREE) bullets.push(TRIAL_BULLET);
  return bullets;
}

export type TileCta = { label: string; variant: "primary" | "secondary" };

/**
 * The CTA on `tile` for a shop on `current`: none on the current plan, a
 * secondary "Downgrade to X" below it, the primary upgrade label above it.
 */
export function planTileCta(
  tile: TilePlan,
  current: string,
  upgradeLabel: (target: Exclude<TilePlan, typeof PLANS.FREE>) => string,
): TileCta | null {
  // An unrecognised stored plan gates like Free (getPlanFeatures does the same).
  const currentRank = Math.max(0, TILE_PLANS.indexOf(current as TilePlan));
  const tileRank = TILE_PLANS.indexOf(tile);
  if (tileRank === currentRank) return null;
  if (tileRank < currentRank) {
    return { label: `Downgrade to ${PLAN_TILE_META[tile].name}`, variant: "secondary" };
  }
  return { label: upgradeLabel(tile as Exclude<TilePlan, typeof PLANS.FREE>), variant: "primary" };
}
