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
 * ADDRESS REQUIRED (gc-1q1s.12): guard email goes ONLY to the address the
 * notice (or the Settings toggle) named. So neither is offered, nor can be
 * claimed, without a known owner email: consent is always stored with the
 * hash of a named address, and the sender treats a missing hash as no
 * consent. A stamp WITHOUT a hash (a legacy generic-wording claim from before
 * this rule; guard email was dark, so none should exist in prod) counts as no
 * consent: Home offers the notice again once an address is known, and that
 * claim stamps the hash.
 *
 * NEVER THROWS: a failed read or claim shows or stamps nothing.
 */
import { createHash } from "node:crypto";

import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { isStorefrontGuardEmailLive } from "./soft-launch-flags.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import type { NoticeClaim } from "../lib/notice-claim";
import { safeErrorFields } from "../lib/safe-error";
import {
  claimGuardEmailNoticeShown,
  enableGuardEmail,
  getGuardEmailConsent,
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
  /** guardConsentHash of the address consented to (null: no consent, even when stamped). */
  guardEmailConsentHash: string | null;
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
  "plan" | "alertsEnabled" | "guardEmailNoticeShownAt" | "guardEmailOffAt" | "guardEmailConsentHash"
>;

/** Whether the notice may be shown (and claimed) now. No query. */
function noticeOwed(shop: NoticeEligibility): boolean {
  if (shop.guardEmailOffAt) return false;
  // Already consented: stamped WITH an address hash. A legacy stamp without
  // one is no consent (gc-1q1s.12), so the notice is owed again.
  if (shop.guardEmailNoticeShownAt && shop.guardEmailConsentHash) return false;
  if (!shop.alertsEnabled || !getPlanFeatures(shop.plan).storefrontGuardEmail) return false;
  return isStorefrontGuardEmailLive() && getMerchantAlertConfigStatus().configured;
}

/** The address the notice names: the cached owner email, else a fresh read (null: unknown, no notice). */
async function noticeEmail(
  shop: Pick<GuardEmailNoticeShop, "domain" | "alertEmail">,
  admin: AdminApiContext | null,
): Promise<string | null> {
  return shop.alertEmail ?? (admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
}

/**
 * Home's loader: the notice to render, or null (also when no owner email is
 * known: the notice must name the address, gc-1q1s.12). Writes no consent
 * (the client claims it after render). Never throws.
 */
export async function guardEmailNoticeForHome(
  shop: GuardEmailNoticeShop,
  admin: AdminApiContext | null,
): Promise<{ email: string } | null> {
  // The common case (shown, off, Free, dark) issues no query.
  if (!noticeOwed(shop)) return null;
  try {
    const email = await noticeEmail(shop, admin);
    return email ? { email } : null;
  } catch (err) {
    logger.warn("guard-email-notice-read-failed", { shop: shop.domain, ...safeErrorFields(err) });
    return null;
  }
}

/** Two addresses are the same (trimmed, any case). */
function sameAddress(a: string, b: string | null): boolean {
  return a.trim().toLowerCase() === b?.trim().toLowerCase();
}

/**
 * Home's action, posted by the client once the notice is on screen: stamp
 * guardEmailNoticeShownAt (the consent) with the hash of the address shown.
 * Re-checks every gate on the session shop's row, and claims only when
 * `shownEmail` (what the page displayed) is the address the notice names now,
 * so consent never covers an address the merchant did not see (the next load
 * shows the current one). No known address: never claimed. Atomic: of any
 * number of posts exactly one returns "claimed"; "failed" only when a read or
 * the write failed (the client may retry). Never throws.
 */
export async function claimGuardEmailNoticeRendered(
  shop: GuardEmailNoticeShop,
  shownEmail: string | null,
  admin: AdminApiContext | null,
): Promise<NoticeClaim> {
  if (!noticeOwed(shop)) return "not_claimed";
  try {
    const email = await noticeEmail(shop, admin);
    if (!email || !sameAddress(email, shownEmail)) return "not_claimed";
    return (await claimGuardEmailNoticeShown(shop.domain, guardConsentHash(email)))
      ? "claimed"
      : "not_claimed";
  } catch (err) {
    logger.warn("guard-email-notice-claim-failed", {
      shop: shop.domain,
      ...safeErrorFields(err),
    });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Settings: turn guard email back on (gc-njwa #5)
// ---------------------------------------------------------------------------

/** The Settings control's state. */
export type GuardEmailSetting = {
  /** The address the consent covers (null: unknown; the control cannot be turned on). */
  email: string | null;
  /** Consented (with an address hash) and not turned off. */
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
    on:
      shop.guardEmailNoticeShownAt !== null &&
      !!shop.guardEmailConsentHash &&
      shop.guardEmailOffAt === null,
    mailOn: shop.alertsEnabled,
  };
}

/**
 * Settings' toggle. Off: the notice's "Turn off" (always allowed). On: consent
 * for the address the card showed (`shownEmail`), stamped like the notice
 * (enableGuardEmail; an already-on shop's hash is re-stamped to it), refused
 * when the control is not offered, all mail is off, no owner email is known
 * (gc-1q1s.12), or the address is no longer the one the card would show.
 * Session shop only (the caller passes
 * the session shop's row).
 *
 * The answer is the state stored AFTER the write (wave 3 U5), never the one
 * asked for: a concurrent unsubscribe or turn-off reads as off ("refused"
 * when on was asked), so the card never claims email is on when it is not.
 */
export async function setGuardEmailFromSettings(
  shop: GuardEmailNoticeShop & { id: string },
  enabled: boolean,
  shownEmail: string | null,
  admin: AdminApiContext | null,
): Promise<"on" | "off" | "refused"> {
  if (!enabled) {
    await turnOffGuardEmail(shop.id);
  } else {
    if (!settingOffered(shop) || !shop.alertsEnabled) return "refused";
    const email = await noticeEmail(shop, admin);
    if (!email || !sameAddress(email, shownEmail)) return "refused";
    await enableGuardEmail(shop.id, guardConsentHash(email));
  }
  const stored = await getGuardEmailConsent(shop.id);
  const on =
    !!stored &&
    stored.alertsEnabled &&
    stored.guardEmailNoticeShownAt !== null &&
    !!stored.guardEmailConsentHash &&
    stored.guardEmailOffAt === null;
  if (on) return "on";
  return enabled ? "refused" : "off";
}
