/**
 * Merchant journey milestones and stage label (gc-dpm.3).
 *
 * Pure and client-safe. Derives, from durable Shop/Scan facts only (never the
 * pruned page_visit stream), which journey milestones a shop has EVER reached,
 * and the single furthest stage used as its label in the operator digest.
 *
 * Milestones (in funnel order):
 *   opened          firstOpenedAt, OR lastSeenAt, OR any scan at all. Each one
 *                   implies the app was opened: firstOpenedAt / lastSeenAt are
 *                   stamped by the app loader, MANUAL scans are merchant-started,
 *                   and SCHEDULED / AUTO_PUBLISH scans only run for paid plans,
 *                   which are chosen inside the app.
 *   scanned         at least one SUCCESSFUL (COMPLETED or PARTIAL) scan.
 *   viewedResults   firstResultsViewedAt.
 *   sawUpgrade      EITHER Free upgrade ask was shown: upgradePreviewShownAt
 *                   (inline teaser, gc-97k.4) or upgradeReturnShownAt (return
 *                   banner, gc-97k.9).
 *   clickedUpgrade  EITHER ask was clicked: upgradePreviewClickedAt or
 *                   upgradeReturnClickedAt.
 *   paid            plan is a paid tier (Standard / Professional). Any other
 *                   value counts as free, matching the digest's plan mix.
 *
 * Milestones are NOT forced to be monotonic: a merchant can pay from the
 * Billing page without ever seeing the upgrade preview, so each is reported as
 * observed. The stage label is simply the furthest milestone reached.
 */
import { PLANS } from "./plans";

/** The durable facts the milestones are derived from. */
export interface JourneyFacts {
  plan: string;
  firstOpenedAt: Date | null;
  lastSeenAt: Date | null;
  firstResultsViewedAt: Date | null;
  upgradePreviewShownAt: Date | null;
  upgradePreviewClickedAt: Date | null;
  upgradeReturnShownAt: Date | null;
  upgradeReturnClickedAt: Date | null;
  /** Any Scan row at all, whatever its status. */
  hasAnyScan: boolean;
  /** At least one COMPLETED or PARTIAL scan. */
  hasSuccessfulScan: boolean;
}

/** Which journey milestones a shop has ever reached. */
export interface JourneyMilestones {
  opened: boolean;
  scanned: boolean;
  viewedResults: boolean;
  sawUpgrade: boolean;
  clickedUpgrade: boolean;
  paid: boolean;
}

/**
 * Milestone keys in funnel order, each with its lowercase display name (the
 * digest's per-shop list) and its funnel-line label.
 */
export const JOURNEY_MILESTONES: ReadonlyArray<{
  key: keyof JourneyMilestones;
  name: string;
  funnelLabel: string;
}> = [
  { key: "opened", name: "opened", funnelLabel: "Opened" },
  { key: "scanned", name: "scanned", funnelLabel: "Scanned" },
  { key: "viewedResults", name: "viewed results", funnelLabel: "Viewed results" },
  { key: "sawUpgrade", name: "saw upgrade", funnelLabel: "Saw upgrade" },
  { key: "clickedUpgrade", name: "clicked upgrade", funnelLabel: "Clicked" },
  { key: "paid", name: "paid", funnelLabel: "Paid" },
];

/**
 * Stage labels, least to most advanced. "opened, no scan" means opened with no
 * SUCCESSFUL scan (a shop whose only scans failed lands here).
 */
export const JOURNEY_STAGES = [
  "never opened",
  "opened, no scan",
  "scanned",
  "viewed results",
  "saw upgrade",
  "clicked upgrade",
  "paid",
] as const;

export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** True for a paid plan tier; unknown/legacy values are free (never paid). */
export function isPaidPlan(plan: string): boolean {
  return plan === PLANS.STANDARD || plan === PLANS.PROFESSIONAL;
}

/** Derive the milestones a shop has ever reached from its durable facts. */
export function deriveJourneyMilestones(facts: JourneyFacts): JourneyMilestones {
  return {
    opened: facts.firstOpenedAt !== null || facts.lastSeenAt !== null || facts.hasAnyScan,
    scanned: facts.hasSuccessfulScan,
    viewedResults: facts.firstResultsViewedAt !== null,
    sawUpgrade: facts.upgradePreviewShownAt !== null || facts.upgradeReturnShownAt !== null,
    clickedUpgrade: facts.upgradePreviewClickedAt !== null || facts.upgradeReturnClickedAt !== null,
    paid: isPaidPlan(facts.plan),
  };
}

/**
 * The furthest stage reached. Checked from most to least advanced, so e.g. a
 * paid shop is "paid" even if it never saw the upgrade preview.
 */
export function journeyStage(m: JourneyMilestones): JourneyStage {
  if (m.paid) return "paid";
  if (m.clickedUpgrade) return "clicked upgrade";
  if (m.sawUpgrade) return "saw upgrade";
  if (m.viewedResults) return "viewed results";
  if (m.scanned) return "scanned";
  if (m.opened) return "opened, no scan";
  return "never opened";
}

/** Display names of the milestones reached, in funnel order. */
export function reachedMilestoneNames(m: JourneyMilestones): string[] {
  return JOURNEY_MILESTONES.filter(({ key }) => m[key]).map(({ name }) => name);
}
