/**
 * Support inbox transport (gc-3twe): Help page messages go to SUPPORT_EMAIL,
 * not to the ops alert channel.
 *
 * Sent From the VERIFIED merchant-mail sender (MERCHANT_ALERT_FROM, the one the
 * summary and guard emails use). Never the ops fallback onboarding@resend.dev:
 * Resend's sandbox sender delivers only to the account owner, so mail to the
 * support inbox would be dropped. Not gated on MERCHANT_ALERTS_ENABLED: that
 * switch is for mail TO merchants; this goes to us.
 *
 * `replyTo` (the merchant's address) is set only when the merchant gave an
 * email AND consented to be contacted; the caller enforces that pairing. If
 * Resend rejects the request (4xx) while reply_to was set, the send is retried
 * ONCE without it, so an address Resend dislikes cannot lose the message (the
 * body's "Reply to:" line still names it).
 *
 * NEVER THROWS (mirrors ops-alert / merchant-alert). The DB row is the source
 * of truth; a message that does not reach the inbox (no transport, no sender,
 * non-OK response, network error) is logged AND recorded as a durable
 * api_error (code SUPPORT_EMAIL_FAILURE_CODE, metadata.shopDomain, which
 * deleteShopData purges on redact; api_error is never pruned and is capped per
 * code per hour), so the operator digest can surface it. Logs and the record
 * never carry the body or the reply-to address.
 */
import { SUPPORT_EMAIL } from "../lib/help";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { recordApiError } from "../models/ops-event.server";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 5000;

/** The api_error code (OpsEvent key) of a Help message that missed the inbox. */
export const SUPPORT_EMAIL_FAILURE_CODE = "support_email_delivery_failed";

export interface SupportEmailInput {
  subject: string;
  text: string;
  /** The merchant's consented address; null = no reply_to. */
  replyTo: string | null;
  /** session.shop unchanged (the failure record's metadata.shopDomain). */
  shopDomain: string;
  /** The Help topic, for the failure record. */
  topic: string;
}

export type SupportEmailFailure = "no_transport" | "no_sender" | "http_error" | "exception";

export interface SupportEmailResult {
  sent: boolean;
  /** sent_without_reply_to: delivered on the retry after a 4xx with reply_to. */
  reason: "sent" | "sent_without_reply_to" | SupportEmailFailure;
}

/** Send one message to the support inbox via Resend. Never throws. */
export async function sendSupportEmail(input: SupportEmailInput): Promise<SupportEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MERCHANT_ALERT_FROM;
  if (!apiKey || !from) {
    const reason = !apiKey ? "no_transport" : "no_sender";
    logger.warn("Support email not delivered (transport not configured)", {
      context: "support-email",
      reason,
      subject: input.subject,
    });
    return fail(input, reason);
  }

  const post = (replyTo: string | null) =>
    fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: SUPPORT_EMAIL,
        subject: input.subject,
        text: input.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

  try {
    let response = await post(input.replyTo);
    let reason: SupportEmailResult["reason"] = "sent";
    if (!response.ok && input.replyTo && response.status >= 400 && response.status < 500) {
      logger.warn("Support email rejected with reply_to; retrying without it", {
        context: "support-email",
        subject: input.subject,
        status: response.status,
      });
      response = await post(null);
      reason = "sent_without_reply_to";
    }
    if (!response.ok) {
      logger.error("Support email send returned non-OK", {
        context: "support-email",
        subject: input.subject,
        status: response.status,
      });
      return fail(input, "http_error", { status: response.status });
    }
    return { sent: true, reason };
  } catch (error) {
    logger.error("Support email send failed", {
      context: "support-email",
      subject: input.subject,
      ...safeErrorFields(error),
    });
    return fail(input, "exception");
  }
}

/** Record the missed delivery durably (never throws) and return the failure. */
async function fail(
  input: SupportEmailInput,
  reason: SupportEmailFailure,
  detail?: { status: number },
): Promise<SupportEmailResult> {
  try {
    await recordApiError({
      level: "error",
      code: SUPPORT_EMAIL_FAILURE_CODE,
      shopDomain: input.shopDomain,
      message: `Help message not delivered to the support inbox (${reason}); the MerchantFeedback row has it`,
      metadata: { reason, topic: input.topic, ...detail },
    });
  } catch (error) {
    logger.error("Support email failure record failed", {
      context: "support-email",
      ...safeErrorFields(error),
    });
  }
  return { sent: false, reason };
}
