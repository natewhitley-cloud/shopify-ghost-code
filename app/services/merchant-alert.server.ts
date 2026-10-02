/**
 * Merchant "new findings" monitoring alerts (gc-syz.4).
 *
 * Sends the shop owner ONE plain transactional email when a scheduled or
 * auto-publish rescan surfaces new leftover-code findings. Framing is
 * "continuous monitoring": Shopify never tells us when ANOTHER app is
 * uninstalled, so this rides the periodic rescan + diff and never claims to be
 * an instant on-uninstall alert.
 *
 * DARK BY DEFAULT: nothing is sent unless MERCHANT_ALERTS_ENABLED === "true"
 * AND RESEND_API_KEY AND MERCHANT_ALERT_FROM are all set. Merchant mail NEVER
 * falls back to the ops sender (onboarding@resend.dev): a merchant-facing From
 * must be a verified, reputation-isolated domain.
 *
 * NEVER THROWS (mirrors ops-alert.server.ts): a failed alert must never fail or
 * retry a scan. Every path returns a typed outcome.
 */

import { djb2Hex } from "./scan-differ.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { sortDiffFindingsBySeverity } from "../lib/finding-sort";
import { findingTypeLabel } from "../lib/finding-type-labels";
import { logger } from "../lib/logger.server";
import { canReceiveAlerts, getAlertWindowMs } from "../lib/plan-gating.server";
import { APP_HANDLE } from "../lib/plans";
import { storeHandleFromDomain } from "../lib/theme-editor-url";
import {
  ensureUnsubscribeToken,
  getLatestMerchantAlert,
  recordMerchantAlert,
} from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 5000;
/** Findings listed in the email body; the rest are summarized as "and N more". */
export const MAX_FINDINGS_IN_EMAIL = 5;
/**
 * Throttle only inside this fraction of the plan window. Scheduled scans recur
 * at exactly the window length, so scheduler jitter (a scan a few minutes
 * early) must not throttle the alert.
 */
export const ALERT_WINDOW_TOLERANCE = 0.9;

export type NewFinding = {
  filename: string;
  findingType: string;
  severity: string;
  appName: string | null;
  description: string;
};

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

export type MerchantAlertConfigStatus =
  | { configured: true }
  | { configured: false; reason: "disabled" | "no_transport" | "no_sender" };

/** Report whether merchant mail may be sent, WITHOUT sending. */
export function getMerchantAlertConfigStatus(): MerchantAlertConfigStatus {
  if (process.env.MERCHANT_ALERTS_ENABLED !== "true") {
    return { configured: false, reason: "disabled" };
  }
  if (!process.env.RESEND_API_KEY) return { configured: false, reason: "no_transport" };
  if (!process.env.MERCHANT_ALERT_FROM) return { configured: false, reason: "no_sender" };
  return { configured: true };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendMerchantAlertInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  unsubscribeUrl: string;
  idempotencyKey: string;
}

export interface SendMerchantAlertResult {
  sent: boolean;
  reason: "sent" | "disabled" | "no_transport" | "no_sender" | "http_error" | "exception";
}

/**
 * Send one merchant alert via Resend. Never throws.
 *
 * Headers:
 *   - List-Unsubscribe + List-Unsubscribe-Post: RFC 8058 one-click unsubscribe
 *     (the POST target is the slice C /unsubscribe/:token route).
 *   - Idempotency-Key (verified in the Resend docs): keys are kept 24 hours, max
 *     256 chars. The same key with the same payload returns the original
 *     response (no second email), which makes an Inngest step retry after a
 *     successful send-but-failed-record safe. The same key with a DIFFERENT
 *     payload returns 409 invalid_idempotent_request: treated as a failed send
 *     and never recorded. https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export async function sendMerchantAlert(
  input: SendMerchantAlertInput,
): Promise<SendMerchantAlertResult> {
  const config = getMerchantAlertConfigStatus();
  if (!config.configured) return { sent: false, reason: config.reason };

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.MERCHANT_ALERT_FROM,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Status (and Resend's error code on a 409): never log the recipient.
      let code: string | undefined;
      if (response.status === 409) {
        try {
          const body = (await response.json()) as { name?: string; code?: string };
          code = body?.name ?? body?.code;
        } catch {
          code = undefined;
        }
      }
      logger.error("Merchant alert send returned non-OK", {
        context: "merchant-alert",
        status: response.status,
        ...(code ? { code } : {}),
      });
      return { sent: false, reason: "http_error" };
    }
    return { sent: true, reason: "sent" };
  } catch (error) {
    logger.error("Merchant alert send failed", { context: "merchant-alert", error });
    return { sent: false, reason: "exception" };
  }
}

// ---------------------------------------------------------------------------
// Finding-set hash + copy
// ---------------------------------------------------------------------------

/**
 * Stable hash of a set of new findings: djb2 over the SORTED (filename,
 * findingType) tuples. Order-independent; carries no snippet or line (the diff's
 * newFindings do not have them). Equal hash to the latest sent alert = the same
 * set again, so no repeat email.
 */
export function buildFindingSetHash(
  newFindings: ReadonlyArray<Pick<NewFinding, "filename" | "findingType">>,
): string {
  const tuples = newFindings.map((f) => `${f.filename}\0${f.findingType}`).sort();
  return djb2Hex(tuples.join("\n"));
}

/** Deep link to a scan in the embedded admin (the app route is /app/scans/:id). */
export function buildScanAdminUrl(shopDomain: string, scanId: string): string {
  return `https://admin.shopify.com/store/${storeHandleFromDomain(shopDomain)}/apps/${APP_HANDLE}/app/scans/${scanId}`;
}

export function buildAlertSubject(count: number, shopDomain: string): string {
  const noun = count === 1 ? "issue" : "issues";
  return `Ghost Code found ${count} new leftover code ${noun} in ${shopDomain}`;
}

/** Plain-text body: type label + filename only, never a code snippet. */
export function buildAlertText(opts: {
  shopDomain: string;
  newFindings: NewFinding[];
  scanUrl: string;
  unsubscribeUrl: string;
}): string {
  const sorted = [...opts.newFindings];
  sortDiffFindingsBySeverity(sorted);
  const shown = sorted.slice(0, MAX_FINDINGS_IN_EMAIL);
  const extra = sorted.length - shown.length;
  const noun = sorted.length === 1 ? "issue" : "issues";

  const lines = [
    `Ghost Code's continuous monitoring found ${sorted.length} new leftover code ${noun} in ${opts.shopDomain}.`,
    "",
    "New since your last scan:",
    ...shown.map((f) => `- ${findingTypeLabel(f.findingType)}: ${f.filename}`),
  ];
  if (extra > 0) lines.push(`- and ${extra} more`);
  lines.push(
    "",
    "Review them in Ghost Code:",
    opts.scanUrl,
    "",
    `You're getting this email because continuous monitoring is on for ${opts.shopDomain}. Ghost Code rescans your theme on a schedule and emails you when something new shows up.`,
    "",
    `Turn off these emails: ${opts.unsubscribeUrl}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type NotifyShop = {
  id: string;
  domain: string;
  plan: string;
  alertsEnabled: boolean;
  alertEmail: string | null;
};

export type NotifyOutcomeReason =
  | "sent"
  | "sent_not_recorded"
  | "disabled"
  | "no_transport"
  | "no_sender"
  | "plan_not_eligible"
  | "shop_opted_out"
  | "no_new_findings"
  | "no_recipient"
  | "duplicate_set"
  | "throttled"
  | "no_app_url"
  | "no_unsubscribe_token"
  | "send_failed"
  | "exception";

export interface NotifyOutcome {
  sent: boolean;
  reason: NotifyOutcomeReason;
}

const skip = (reason: NotifyOutcomeReason): NotifyOutcome => ({ sent: false, reason });

/**
 * Run the full gating chain and, if everything passes, email the shop owner.
 * Order: env gates, plan, shop opt-out, has new findings, recipient, dedup, rate
 * window, unsubscribe token, send, then record the ledger row ONLY on a
 * successful send. `admin` may be null (offline token unusable): the cached
 * Shop.alertEmail is then the recipient. Never throws.
 */
export async function notifyNewFindings(args: {
  shop: NotifyShop;
  scan: { id: string };
  newFindings: NewFinding[];
  admin: AdminApiContext | null;
}): Promise<NotifyOutcome> {
  const { shop, scan, newFindings, admin } = args;
  try {
    const config = getMerchantAlertConfigStatus();
    if (!config.configured) return skip(config.reason);
    if (!canReceiveAlerts(shop.plan)) return skip("plan_not_eligible");
    if (!shop.alertsEnabled) return skip("shop_opted_out");
    if (newFindings.length === 0) return skip("no_new_findings");

    // refreshShopAlertEmail never throws and returns null on any failure.
    const fresh = admin ? await refreshShopAlertEmail(shop.domain, admin) : null;
    const recipient = fresh ?? shop.alertEmail;
    if (!recipient) return skip("no_recipient");

    const findingSetHash = buildFindingSetHash(newFindings);
    const latest = await getLatestMerchantAlert(shop.id);
    if (latest?.findingSetHash === findingSetHash) return skip("duplicate_set");

    const windowMs = getAlertWindowMs(shop.plan);
    if (windowMs === null) return skip("plan_not_eligible");
    if (latest && Date.now() - latest.sentAt.getTime() < windowMs * ALERT_WINDOW_TOLERANCE)
      return skip("throttled");

    const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/+$/, "");
    if (!appUrl) return skip("no_app_url");
    const token = await ensureUnsubscribeToken(shop.id);
    if (!token) return skip("no_unsubscribe_token");
    const unsubscribeUrl = `${appUrl}/unsubscribe/${token}`;

    const result = await sendMerchantAlert({
      to: recipient,
      subject: buildAlertSubject(newFindings.length, shop.domain),
      text: buildAlertText({
        shopDomain: shop.domain,
        newFindings,
        scanUrl: buildScanAdminUrl(shop.domain, scan.id),
        unsubscribeUrl,
      }),
      unsubscribeUrl,
      idempotencyKey: `merchant-alert:${scan.id}`,
    });
    if (!result.sent) return skip("send_failed");

    try {
      await recordMerchantAlert({
        shopId: shop.id,
        scanId: scan.id,
        findingSetHash,
        newCount: newFindings.length,
        recipient,
      });
    } catch (error) {
      // Mail is out but the ledger write failed: the Resend idempotency key
      // covers a retry within 24h; surface it loudly (no PII).
      logger.error("Merchant alert sent but ledger write failed", {
        context: "merchant-alert",
        scanId: scan.id,
        error,
      });
      return { sent: true, reason: "sent_not_recorded" };
    }
    return { sent: true, reason: "sent" };
  } catch (error) {
    logger.error("Merchant alert notify failed", { context: "merchant-alert", error });
    return skip("exception");
  }
}
