/**
 * Checkout guard incident email (gc-1q1s.7) and its one-time consent notice.
 *
 * WHO (owner decisions 2026-10-26): Standard and Professional only
 * (PlanFeatures.storefrontGuardEmail). Free: in-app only, never email.
 * WHAT: KNOWN_MALICIOUS and confirmed SCRIPT_LOADER incidents only
 * (EMAIL_INCIDENT_KINDS); NEW_SCRIPT_HOST stays in-app.
 * HOW OFTEN: one email per incident episode (StorefrontIncident
 * .emailedOpenedAt), incidents that opened in the same cron run batched into
 * one email, at most GUARD_EMAILS_PER_DAY per shop per 24 h. Never a routine
 * email.
 *
 * CONSENT (Partner Agreement s.2.1.2): nothing is sent unless Home showed the
 * one-time notice "Checkout guard alerts will be emailed to <owner email>"
 * (guardEmailNoticeShownAt, claimed once like summaryNoticeShownAt), the
 * merchant has not pressed its "Turn off" (guardEmailOffAt), and mail is not
 * unsubscribed (alertsEnabled; the email's unsubscribe link turns it off).
 *
 * DARK: STOREFRONT_GUARD_EMAIL_ENABLED (and the guard flag) plus the merchant
 * mail transport (MERCHANT_ALERTS_ENABLED + sender). While dark the notice is
 * not shown either (it would promise email nothing can send).
 *
 * NEVER THROWS: a failed email never fails the cron. Content: hostnames,
 * fixed labels and the steps only; never page text or customer data.
 */

import { createHash } from "node:crypto";

import {
  buildBodyUnsubscribeUrl,
  buildHeaderUnsubscribeUrl,
  buildHomeAdminUrl,
  getMerchantAlertConfigStatus,
  sendMerchantAlert,
} from "./merchant-alert.server";
import { refreshShopContact } from "./shop-alert-email.server";
import { isStorefrontGuardEmailLive } from "./soft-launch-flags.server";
import { toIncidentView } from "./storefront-guard-home.server";
import type { GuardEmailNoticeShop } from "./storefront-guard-notice.server";
import { escapeHtml, SENDER_NAME, storeNameForEmail, SUPPORT_EMAIL } from "./summary-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  GUARD_CHECK_STEPS,
  GUARD_GUIDE_URL,
  guardIncidentTitle,
  guardPagesLabel,
  type GuardIncidentView,
} from "../lib/storefront-guard-copy";
import {
  countGuardAlertsSince,
  ensureUnsubscribeToken,
  GUARD_ALERT_KIND,
  recordMerchantAlert,
} from "../models/merchant-alert.server";
import { loadIncidentsToEmail, markIncidentsEmailed } from "../models/storefront-guard.server";
import type { AdminApiContext } from "../types/shopify";

export const GUARD_EMAILS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** "GhostCode checkout guard alert for {Store Name}". */
export function buildGuardEmailSubject(storeName: string | null, shopDomain: string): string {
  return `GhostCode checkout guard alert for ${storeNameForEmail(storeName, shopDomain)}`;
}

export type GuardEmailBody = {
  storeName: string | null;
  shopDomain: string;
  incidents: readonly GuardIncidentView[];
  homeUrl: string;
  unsubscribeUrl: string;
};

const SHOPIFY_MAY_BLOCK =
  "Shopify may block shoppers from being sent to a domain it has flagged, but this code still runs on your store.";

function incidentLines(i: GuardIncidentView): string[] {
  const lines = [
    `${guardIncidentTitle(i)}.`,
    `Seen on ${guardPagesLabel(i.pages)}: ${i.sourceLabel}.`,
  ];
  if (i.kind === "KNOWN_MALICIOUS") lines.push(SHOPIFY_MAY_BLOCK);
  return lines;
}

function bodyParts(b: GuardEmailBody) {
  return {
    intro:
      `GhostCode's checkout guard found something on the live storefront of ` +
      `${storeNameForEmail(b.storeName, b.shopDomain)} that needs a look today.`,
    incidents: b.incidents.map(incidentLines),
    steps: GUARD_CHECK_STEPS.map((step, n) => `${n + 1}. ${step}`),
  };
}

/** Plain-text body. */
export function buildGuardEmailText(b: GuardEmailBody): string {
  const p = bodyParts(b);
  const lines = [p.intro, ""];
  for (const block of p.incidents) lines.push(...block, "");
  lines.push("What to check:", ...p.steps, "");
  lines.push("See the details in GhostCode:", b.homeUrl, "");
  lines.push("Checklist for a compromised app:", GUARD_GUIDE_URL, "");
  lines.push(
    "You get this email because checkout guard alerts are on. We never send routine updates.",
    "",
    SENDER_NAME,
    SUPPORT_EMAIL,
    `Unsubscribe: ${b.unsubscribeUrl}`,
  );
  return lines.join("\n");
}

/** HTML body (same facts, same order; every value escaped; inline styles only). */
export function buildGuardEmailHtml(b: GuardEmailBody): string {
  const p = bodyParts(b);
  const para = (text: string, pad = "0 0 16px") =>
    `<tr><td style="padding:${pad}">${escapeHtml(text)}</td></tr>`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:#1a56db;text-decoration:underline">${escapeHtml(label)}</a>`;
  const rows = [
    para(p.intro),
    ...p.incidents.map(
      (block) =>
        `<tr><td style="padding:0 0 16px"><strong>${escapeHtml(block[0])}</strong><br>` +
        block.slice(1).map(escapeHtml).join("<br>") +
        `</td></tr>`,
    ),
    `<tr><td style="padding:0 0 16px"><strong>What to check</strong><ol style="margin:4px 0 0;padding:0 0 0 20px">` +
      GUARD_CHECK_STEPS.map((s) => `<li style="margin:0 0 4px">${escapeHtml(s)}</li>`).join("") +
      `</ol></td></tr>`,
    `<tr><td style="padding:0 0 8px">${link(b.homeUrl, "See the details in GhostCode")}</td></tr>`,
    `<tr><td style="padding:0 0 24px">${link(GUARD_GUIDE_URL, "Checklist for a compromised app")}</td></tr>`,
    `<tr><td style="padding:16px 0 0;border-top:1px solid #e5e5e5;font-size:13px;line-height:1.5;color:#555555">` +
      `You get this email because checkout guard alerts are on. We never send routine updates.<br>` +
      `${escapeHtml(SENDER_NAME)}<br>${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)}<br>` +
      `${link(b.unsubscribeUrl, "Unsubscribe")}</td></tr>`,
  ];
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>',
    '<body style="margin:0;padding:0;background:#ffffff">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td align="center" style="padding:24px 16px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;text-align:left">',
    ...rows,
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export type GuardEmailShop = GuardEmailNoticeShop & {
  id: string;
  storeName: string | null;
  uninstalledAt: Date | null;
};

export type GuardEmailSkipReason =
  | "shop_uninstalled"
  | "plan_not_eligible"
  | "shop_opted_out"
  | "guard_email_off"
  | "no_consent";

/** The shop-level gates (no I/O): the first failing reason, or null. */
export function guardEmailShopSkipReason(shop: GuardEmailShop): GuardEmailSkipReason | null {
  if (shop.uninstalledAt) return "shop_uninstalled";
  if (!getPlanFeatures(shop.plan).storefrontGuardEmail) return "plan_not_eligible";
  if (!shop.alertsEnabled) return "shop_opted_out";
  if (shop.guardEmailOffAt) return "guard_email_off";
  if (!shop.guardEmailNoticeShownAt) return "no_consent";
  return null;
}

/** Ledger key for a batch: stable for the same incident episodes (retries). */
export function guardLedgerKey(incidents: ReadonlyArray<{ id: string; openedAt: Date }>): string {
  const parts = incidents.map((i) => `${i.id}:${i.openedAt.toISOString()}`).sort();
  // SHA-256 (not a 32-bit hash): a collision would read as "already sent".
  return `guard:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40)}`;
}

export type GuardEmailOutcome = {
  sent: boolean;
  reason:
    | "sent"
    | "sent_not_recorded"
    | "dark"
    | "disabled"
    | "no_transport"
    | "no_sender"
    | GuardEmailSkipReason
    | "nothing_to_send"
    | "throttled"
    | "no_recipient"
    | "no_app_url"
    | "no_unsubscribe_token"
    | "send_failed"
    | "exception";
  count?: number;
};

/** Prisma unique-constraint violation (the ledger row already exists). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Email one shop about the incidents a cron run opened. Order: flags and
 * transport, shop gates, which incidents still need an email, throttle,
 * recipient, app URL, unsubscribe token, send, ledger, episode stamps.
 * `admin` may be null (the cached owner email is used). Never throws.
 */
export async function sendGuardIncidentEmail(args: {
  shop: GuardEmailShop;
  incidentIds: readonly string[];
  admin: AdminApiContext | null;
  now?: Date;
}): Promise<GuardEmailOutcome> {
  const { shop, admin } = args;
  const now = args.now ?? new Date();
  const skip = (reason: GuardEmailOutcome["reason"]): GuardEmailOutcome => ({
    sent: false,
    reason,
  });
  try {
    if (!isStorefrontGuardEmailLive()) return skip("dark");
    const config = getMerchantAlertConfigStatus();
    if (!config.configured) return skip(config.reason);
    const shopSkip = guardEmailShopSkipReason(shop);
    if (shopSkip) return skip(shopSkip);

    const incidents = await loadIncidentsToEmail(shop.id, args.incidentIds);
    if (incidents.length === 0) return skip("nothing_to_send");
    const recent = await countGuardAlertsSince(shop.id, new Date(now.getTime() - DAY_MS));
    if (recent >= GUARD_EMAILS_PER_DAY) return skip("throttled");

    const fresh = admin ? await refreshShopContact(shop.domain, admin) : null;
    const recipient = fresh?.email ?? shop.alertEmail;
    const storeName = fresh?.storeName ?? shop.storeName;
    if (!recipient) return skip("no_recipient");
    const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/+$/, "");
    if (!appUrl) return skip("no_app_url");
    const token = await ensureUnsubscribeToken(shop.id);
    if (!token) return skip("no_unsubscribe_token");

    const body: GuardEmailBody = {
      storeName,
      shopDomain: shop.domain,
      incidents: incidents.map(toIncidentView),
      homeUrl: buildHomeAdminUrl(shop.domain),
      unsubscribeUrl: buildBodyUnsubscribeUrl(appUrl, token),
    };
    const key = guardLedgerKey(incidents);
    const result = await sendMerchantAlert({
      to: recipient,
      subject: buildGuardEmailSubject(storeName, shop.domain),
      text: buildGuardEmailText(body),
      html: buildGuardEmailHtml(body),
      unsubscribeUrl: buildHeaderUnsubscribeUrl(appUrl, token),
      // Same key on an Inngest retry: Resend returns the original response.
      idempotencyKey: `checkout-guard:${key}`,
    });
    if (!result.sent) return skip("send_failed");

    let reason: GuardEmailOutcome["reason"] = "sent";
    try {
      await recordMerchantAlert({
        shopId: shop.id,
        scanId: key,
        kind: GUARD_ALERT_KIND,
        findingSetHash: key,
        newCount: incidents.length,
        fixedCount: 0,
        inactiveAppCount: 0,
        cleanedAppCount: 0,
        recipient,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        logger.error("Guard email sent but ledger write failed", {
          context: "storefront-guard-email",
          shopId: shop.id,
          ...safeErrorFields(error),
        });
        reason = "sent_not_recorded";
      }
    }
    await markIncidentsEmailed(incidents);
    return { sent: true, reason, count: incidents.length };
  } catch (error) {
    logger.error("Guard email failed", {
      context: "storefront-guard-email",
      shopId: shop.id,
      ...safeErrorFields(error),
    });
    return skip("exception");
  }
}
