/**
 * Home's one-time checkout guard email notice (gc-1q1s.7): "Checkout guard
 * alerts will be emailed to <owner email>" with Turn off. The load that wins
 * the guardEmailNoticeShownAt claim renders it, and that stamp is the
 * merchant's consent (Partner Agreement s.2.1.2), like the summary notice.
 * Shown only when guard email can actually be sent to this shop: Standard or
 * Professional, both guard flags on, mail transport configured, not
 * unsubscribed, not turned off. Kept apart from the sender so Home does not
 * import the email builders.
 *
 * NEVER THROWS: a failed claim shows nothing this load.
 */
import { createHash } from "node:crypto";

import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { isStorefrontGuardEmailLive } from "./soft-launch-flags.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { claimGuardEmailNoticeShown } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

export type GuardEmailNoticeShop = {
  domain: string;
  plan: string;
  alertsEnabled: boolean;
  alertEmail: string | null;
  guardEmailNoticeShownAt: Date | null;
  guardEmailOffAt: Date | null;
};

/**
 * The stored form of the address the notice named: a SHA-256 prefix of the
 * trimmed, lower-cased email (never the email itself). The sender emails only
 * an address with the same hash (audit fix).
 */
export function guardConsentHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * Home's one-time notice: rendered by the load that wins the claim, only when
 * guard email can actually be sent to this shop. Never throws.
 */
export async function claimGuardEmailNoticeForHome(
  shop: GuardEmailNoticeShop,
  admin: AdminApiContext | null,
): Promise<{ email: string | null } | null> {
  // The common case (shown, off, Free, dark) issues no query.
  if (shop.guardEmailNoticeShownAt || shop.guardEmailOffAt) return null;
  if (!shop.alertsEnabled || !getPlanFeatures(shop.plan).storefrontGuardEmail) return null;
  if (!isStorefrontGuardEmailLive() || !getMerchantAlertConfigStatus().configured) return null;
  try {
    // The address is read first so the claim records exactly what is shown.
    const email =
      shop.alertEmail ?? (admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
    const claimed = await claimGuardEmailNoticeShown(
      shop.domain,
      email ? guardConsentHash(email) : null,
    );
    return claimed ? { email } : null;
  } catch (err) {
    logger.warn("guard-email-notice-claim-failed", {
      shop: shop.domain,
      ...safeErrorFields(err),
    });
    return null;
  }
}
