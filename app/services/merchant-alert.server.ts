/**
 * Merchant email transport (gc-syz.4), used by the summary email (gc-ol95,
 * app/services/summary-email.server.ts): env gates, the Resend send, and the
 * deep-link / unsubscribe URL builders. The old per-change "new findings"
 * alert was replaced by one summary per scheduled scan.
 *
 * DARK BY DEFAULT: nothing is sent unless MERCHANT_ALERTS_ENABLED === "true"
 * AND RESEND_API_KEY, MERCHANT_ALERT_FROM and MERCHANT_EMAIL_POSTAL_ADDRESS
 * are all set. Merchant mail NEVER falls back to the ops sender
 * (onboarding@resend.dev): a merchant-facing From must be a verified,
 * reputation-isolated domain. The postal address is the sender identity the
 * footer must carry, so without it nothing is "configured".
 *
 * NEVER THROWS (mirrors ops-alert.server.ts): a failed email must never fail or
 * retry a scan. Every path returns a typed outcome.
 */

import { logger } from "../lib/logger.server";
import { APP_HANDLE } from "../lib/plans";
import { safeErrorFields } from "../lib/safe-error";
import { storeHandleFromDomain } from "../lib/theme-editor-url";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 5000;
/**
 * Throttle only inside this fraction of the plan window. Scheduled scans recur
 * at exactly the window length, so scheduler jitter (a scan a few minutes
 * early) must not throttle the alert.
 */
export const ALERT_WINDOW_TOLERANCE = 0.9;

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

export type MerchantAlertConfigStatus =
  | { configured: true }
  | {
      configured: false;
      reason: "disabled" | "no_transport" | "no_sender" | "no_postal_address";
    };

/** Report whether merchant mail may be sent, WITHOUT sending. */
export function getMerchantAlertConfigStatus(): MerchantAlertConfigStatus {
  if (process.env.MERCHANT_ALERTS_ENABLED !== "true") {
    return { configured: false, reason: "disabled" };
  }
  if (!process.env.RESEND_API_KEY) return { configured: false, reason: "no_transport" };
  if (!process.env.MERCHANT_ALERT_FROM) return { configured: false, reason: "no_sender" };
  if (!getMerchantPostalAddress()) return { configured: false, reason: "no_postal_address" };
  return { configured: true };
}

/** The sender's postal address for the email footer, or null when unset/blank. */
export function getMerchantPostalAddress(): string | null {
  const value = process.env.MERCHANT_EMAIL_POSTAL_ADDRESS?.trim();
  return value ? value : null;
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
  reason:
    | "sent"
    | "disabled"
    | "no_transport"
    | "no_sender"
    | "no_postal_address"
    | "http_error"
    | "exception";
}

/**
 * Send one merchant alert via Resend. Never throws.
 *
 * Headers:
 *   - List-Unsubscribe + List-Unsubscribe-Post: RFC 8058 one-click unsubscribe
 *     (the POST target is the /unsubscribe/:token route; the human link in the body is /unsubscribe#t=token, see buildBodyUnsubscribeUrl).
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
    logger.error("Merchant alert send failed", {
      context: "merchant-alert",
      ...safeErrorFields(error),
    });
    return { sent: false, reason: "exception" };
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Deep link to a scan in the embedded admin (the app route is /app/scans/:id). */
export function buildScanAdminUrl(shopDomain: string, scanId: string): string {
  return `https://admin.shopify.com/store/${storeHandleFromDomain(shopDomain)}/apps/${APP_HANDLE}/app/scans/${scanId}`;
}

/**
 * Human unsubscribe link for the email body. The token rides in the URL
 * FRAGMENT, which browsers never send to the server, so it cannot reach access
 * logs. The /unsubscribe page reads it client-side and POSTs it in a body.
 */
export function buildBodyUnsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl}/unsubscribe#t=${token}`;
}

/** RFC 8058 List-Unsubscribe header target: must identify the shop by itself. */
export function buildHeaderUnsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl}/unsubscribe/${token}`;
}
