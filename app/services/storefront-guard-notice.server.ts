/**
 * Home's one-time checkout guard email notice (gc-1q1s.7): "Checkout guard
 * alerts will be emailed to <owner email>" with Turn off. Shown only when
 * guard email can actually be sent to this shop: Standard or Professional,
 * both guard flags on, mail transport configured, not unsubscribed, not
 * turned off. Kept apart from the sender so Home does not import the email
 * builders.
 *
 * Render, then stamp (gc-1q1s.11): the loader only OFFERS the notice
 * (guardEmailNoticeForHome, no write). Once it is on screen, Home's client
 * posts "guard-email-notice-shown" from an effect after mount, and the action
 * claims guardEmailNoticeShownAt (claimGuardEmailNoticeRendered): one atomic
 * conditional write, so a double post or two tabs stamp once. That stamp is
 * the merchant's consent (Partner Agreement s.2.1.2), like the summary
 * notice. A lost response or an unmount before paint stamps nothing.
 *
 * NEVER THROWS: a failed read or claim shows or stamps nothing.
 */
import { createHash } from "node:crypto";

import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { isStorefrontGuardEmailLive } from "./soft-launch-flags.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  claimGuardEmailNoticeShown,
  enableGuardEmail,
  turnOffGuardEmail,
} from "../models/merchant-alert.server";
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

type NoticeEligibility = Pick<
  GuardEmailNoticeShop,
  "plan" | "alertsEnabled" | "guardEmailNoticeShownAt" | "guardEmailOffAt"
>;

/** Whether the notice may be shown (and claimed) now. No query. */
function noticeOwed(shop: NoticeEligibility): boolean {
  if (shop.guardEmailNoticeShownAt || shop.guardEmailOffAt) return false;
  if (!shop.alertsEnabled || !getPlanFeatures(shop.plan).storefrontGuardEmail) return false;
  return isStorefrontGuardEmailLive() && getMerchantAlertConfigStatus().configured;
}

/** The address the notice names: the cached owner email, else a fresh read (null: generic wording). */
async function noticeEmail(
  shop: Pick<GuardEmailNoticeShop, "domain" | "alertEmail">,
  admin: AdminApiContext | null,
): Promise<string | null> {
  return shop.alertEmail ?? (admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
}

/**
 * Home's loader: the notice to render, or null. Writes no consent (the
 * client claims it after render). Never throws.
 */
export async function guardEmailNoticeForHome(
  shop: GuardEmailNoticeShop,
  admin: AdminApiContext | null,
): Promise<{ email: string | null } | null> {
  // The common case (shown, off, Free, dark) issues no query.
  if (!noticeOwed(shop)) return null;
  try {
    return { email: await noticeEmail(shop, admin) };
  } catch (err) {
    logger.warn("guard-email-notice-read-failed", { shop: shop.domain, ...safeErrorFields(err) });
    return null;
  }
}

/** Two notice addresses are the same (trimmed, any case; null only matches null). */
function sameAddress(a: string | null, b: string | null): boolean {
  return (a?.trim().toLowerCase() || null) === (b?.trim().toLowerCase() || null);
}

/**
 * Home's action, posted by the client once the notice is on screen: stamp
 * guardEmailNoticeShownAt (the consent) with the hash of the address shown.
 * Re-checks every gate on the session shop's row, and claims only when
 * `shownEmail` (what the page displayed; null for the generic wording) is the
 * address the notice names now, so consent never covers an address the
 * merchant did not see (the next load shows the current one). Atomic: of any
 * number of posts exactly one returns true. Never throws.
 */
export async function claimGuardEmailNoticeRendered(
  shop: GuardEmailNoticeShop,
  shownEmail: string | null,
  admin: AdminApiContext | null,
): Promise<boolean> {
  if (!noticeOwed(shop)) return false;
  try {
    const email = await noticeEmail(shop, admin);
    if (!sameAddress(email, shownEmail)) return false;
    return await claimGuardEmailNoticeShown(shop.domain, email ? guardConsentHash(email) : null);
  } catch (err) {
    logger.warn("guard-email-notice-claim-failed", {
      shop: shop.domain,
      ...safeErrorFields(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings: turn guard email back on (gc-njwa #5)
// ---------------------------------------------------------------------------

/** The Settings control's state. */
export type GuardEmailSetting = {
  /** The address the consent covers (null: the generic wording). */
  email: string | null;
  /** Consented and not turned off. */
  on: boolean;
  /** alertsEnabled: false while all GhostCode mail is off (the control is disabled). */
  mailOn: boolean;
};

/** Whether Settings offers the control: a plan with guard email, and guard email live. No query. */
function settingOffered(shop: Pick<GuardEmailNoticeShop, "plan">): boolean {
  return (
    getPlanFeatures(shop.plan).storefrontGuardEmail &&
    isStorefrontGuardEmailLive() &&
    getMerchantAlertConfigStatus().configured
  );
}

/**
 * Settings' guard email control, or null when it is not offered (Free: in-app
 * only; or guard email dark, when there is nothing to turn on). Never throws.
 */
export async function guardEmailSettingFor(
  shop: GuardEmailNoticeShop & { id: string },
  admin: AdminApiContext | null,
): Promise<GuardEmailSetting | null> {
  if (!settingOffered(shop)) return null;
  let email: string | null = null;
  try {
    email = await noticeEmail(shop, admin);
  } catch (err) {
    logger.warn("guard-email-setting-read-failed", { shop: shop.domain, ...safeErrorFields(err) });
  }
  return {
    email,
    on: shop.guardEmailNoticeShownAt !== null && shop.guardEmailOffAt === null,
    mailOn: shop.alertsEnabled,
  };
}

/**
 * Settings' toggle. Off: the notice's "Turn off" (always allowed). On: consent
 * for the address the card showed (`shownEmail`), stamped like the notice
 * (enableGuardEmail), refused when the control is not offered, all mail is
 * off, or the address is no longer the one the card would show. Session shop
 * only (the caller passes the session shop's row).
 */
export async function setGuardEmailFromSettings(
  shop: GuardEmailNoticeShop & { id: string },
  enabled: boolean,
  shownEmail: string | null,
  admin: AdminApiContext | null,
): Promise<"on" | "off" | "refused"> {
  if (!enabled) {
    await turnOffGuardEmail(shop.id);
    return "off";
  }
  if (!settingOffered(shop) || !shop.alertsEnabled) return "refused";
  const email = await noticeEmail(shop, admin);
  if (!sameAddress(email, shownEmail)) return "refused";
  await enableGuardEmail(shop.id, email ? guardConsentHash(email) : null);
  return "on";
}
