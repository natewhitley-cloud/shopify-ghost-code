/**
 * Home's one-time "Summary emails are on" notice (gc-ol95).
 *
 * Summary emails default ON for a paid plan, but nobody may get one without
 * knowing. A shop that moved Free -> paid after this shipped (or opted in while
 * sending was not configured) has summaryNoticePendingAt set. Its next Home
 * load offers the notice (summaryNoticeForHome, no write); once it is on
 * screen the client posts "summary-notice-shown" from an effect after mount
 * and the action claims summaryNoticeShownAt (claimSummaryNoticeRendered,
 * gc-1q1s.11: render, then stamp, the same pattern as the guard notice). That
 * stamp is what makes the shop eligible; one atomic conditional write, so a
 * double post or two tabs stamp once.
 *
 * Rendered only when it is true: a paid plan, the toggle on, and sending
 * configured. While dark the notice stays pending (it would claim "on" while
 * nothing can be sent), so it shows once sending goes live. Not an
 * interruptive prompt: a consent notice is never capped or deferred.
 *
 * NEVER THROWS: a failed read or claim shows or stamps nothing.
 */

import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import type { SummaryCadence } from "../lib/summary-email-copy";
import { claimSummaryNoticeShown } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

export type SummaryNotice = { email: string | null; cadence: SummaryCadence };

type SummaryNoticeShop = {
  domain: string;
  plan: string;
  alertsEnabled: boolean;
  alertEmail: string | null;
  summaryNoticePendingAt: Date | null;
  summaryNoticeShownAt: Date | null;
};

/** The plan's cadence when the notice is owed and true now, else null. No query. */
function owedCadence(shop: SummaryNoticeShop): SummaryCadence | null {
  // The common case (nothing owed, or already shown) issues no query.
  if (!shop.summaryNoticePendingAt || shop.summaryNoticeShownAt) return null;
  if (!shop.alertsEnabled) return null;
  const cadence = getPlanFeatures(shop.plan).alertCadence;
  if (cadence === "none") return null;
  if (!getMerchantAlertConfigStatus().configured) return null;
  return cadence;
}

/** Home's loader: the notice to render, or null. Writes no consent. Never throws. */
export async function summaryNoticeForHome(
  shop: SummaryNoticeShop,
  admin: AdminApiContext | null,
): Promise<SummaryNotice | null> {
  const cadence = owedCadence(shop);
  if (!cadence) return null;
  // Name the address we will use. Read it now if it was never cached
  // (refreshShopAlertEmail never throws; null falls back to generic copy).
  const email = shop.alertEmail ?? (admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
  return { email, cadence };
}

/**
 * Home's action, posted by the client once the notice is on screen (and by
 * Dismiss, which proves it was shown): stamp summaryNoticeShownAt. Re-checks
 * the gates on the session shop's row. True IFF this call stamped it. Never
 * throws.
 */
export async function claimSummaryNoticeRendered(shop: SummaryNoticeShop): Promise<boolean> {
  if (!owedCadence(shop)) return false;
  try {
    return await claimSummaryNoticeShown(shop.domain);
  } catch (err) {
    logger.warn("summary-notice-claim-failed", {
      shop: shop.domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
