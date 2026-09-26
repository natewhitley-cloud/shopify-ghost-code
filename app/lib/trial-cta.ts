/**
 * Free-trial CTA copy (gc-97k.8): one copy source for every upgrade button that
 * could promise the Managed Pricing trial (the scan-page Free teaser and the
 * Settings plan tiles).
 *
 * Pure and client-safe.
 *
 * Shopify grants the trial only to a shop that has not used it, so the app
 * never promises it to a shop that has ever been on a paid plan. The explicit
 * plan-history signal the app keeps is BillingEvent: any row (upgrade,
 * downgrade, cancellation, reactivation) means the shop has had a paid plan.
 * A shop currently on a paid plan has plan history by definition.
 */
import { PLANS } from "./plans";

/** Managed Pricing trial length on both paid tiers (docs/pricing-and-plans.md). */
export const FREE_TRIAL_DAYS = 7;

export type PaidPlan = typeof PLANS.STANDARD | typeof PLANS.PROFESSIONAL;

export type TrialEligibilityInput = {
  /** The shop's stored plan (Shop.plan). */
  plan: string;
  /** The shop has at least one BillingEvent row. */
  hasBillingHistory: boolean;
};

/** True only for a Free shop with no paid-plan history. */
export function isTrialEligible(input: TrialEligibilityInput): boolean {
  return input.plan === PLANS.FREE && !input.hasBillingHistory;
}

/**
 * The upgrade button label for moving to `target`:
 * "Start 7-day free trial" when the trial applies, else "Upgrade to <target>".
 */
export function upgradeCtaLabel(target: PaidPlan, trialEligible: boolean): string {
  return trialEligible ? `Start ${FREE_TRIAL_DAYS}-day free trial` : `Upgrade to ${target}`;
}
