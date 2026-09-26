/**
 * Loader-side trial eligibility (gc-97k.8), shared by the scan page teaser and
 * the Settings plan tiles.
 *
 * A paid shop, or a Free shop whose Shop.everPaidAt is already set, is never
 * eligible, so the BillingEvent read runs only for a Free shop with no
 * everPaidAt. NEVER THROWS: if the read fails the shop gets the non-trial copy
 * (promise nothing we cannot confirm) and the error is logged.
 */
import { logger } from "../lib/logger.server";
import { PLANS } from "../lib/plans";
import { isTrialEligible } from "../lib/trial-cta";
import { hasBillingHistory } from "../models/billing-event.server";

export async function getTrialEligibility(shop: {
  id: string;
  plan: string;
  everPaidAt: Date | null;
}): Promise<boolean> {
  if (shop.plan !== PLANS.FREE || shop.everPaidAt !== null) return false;
  try {
    return isTrialEligible({
      plan: shop.plan,
      everPaidAt: shop.everPaidAt,
      hasBillingHistory: await hasBillingHistory(shop.id),
    });
  } catch (err) {
    logger.error("trial-eligibility-read-failed", {
      shopId: shop.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
