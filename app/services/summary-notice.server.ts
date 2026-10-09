/**
 * Home's one-time "Summary emails are on" notice (gc-ol95).
 *
 * Summary emails default ON for a paid plan, but nobody may get one without
 * knowing. A shop that moved Free -> paid after this shipped (or opted in while
 * sending was not configured) has summaryNoticePendingAt set. On its next Home
 * load the notice renders ONCE: the load that wins the summaryNoticeShownAt
 * claim renders it, and that stamp is what makes the shop eligible.
 *
 * Rendered only when it is true: a paid plan, the toggle on, and sending
 * configured. While dark the notice stays pending (it would claim "on" while
 * nothing can be sent), so it shows once sending goes live. Not an
 * interruptive prompt: a consent notice is never capped or deferred.
 *
 * NEVER THROWS: a failed claim simply shows nothing this load.
 */

import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import type { SummaryCadence } from "../lib/summary-email-copy";
import { claimSummaryNoticeShown } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

export type SummaryNotice = { email: string | null; cadence: SummaryCadence };

export async function claimSummaryNoticeForHome(
  shop: {
    domain: string;
    plan: string;
    alertsEnabled: boolean;
    alertEmail: string | null;
    summaryNoticePendingAt: Date | null;
    summaryNoticeShownAt: Date | null;
  },
  admin: AdminApiContext | null,
): Promise<SummaryNotice | null> {
  // The common case (nothing owed, or already shown) issues no query.
  if (!shop.summaryNoticePendingAt || shop.summaryNoticeShownAt) return null;
  if (!shop.alertsEnabled) return null;
  const cadence = getPlanFeatures(shop.plan).alertCadence;
  if (cadence === "none") return null;
  if (!getMerchantAlertConfigStatus().configured) return null;

  try {
    if (!(await claimSummaryNoticeShown(shop.domain))) return null;
  } catch (err) {
    logger.warn("summary-notice-claim-failed", {
      shop: shop.domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // Name the address we will use. Read it now if it was never cached
  // (refreshShopAlertEmail never throws; null falls back to generic copy).
  const email = shop.alertEmail ?? (admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
  return { email, cadence };
}
