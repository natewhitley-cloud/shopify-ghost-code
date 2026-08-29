/**
 * Ops-alert channel (gc-06e.1).
 *
 * A single, in-house sender for OPERATOR (not merchant) alerts: failing
 * Inngest crons and other observability breaches that must reach a human.
 * Deliberately minimal, one email channel, no schema, no queue.
 *
 * INERT BY DEFAULT: if `OPS_ALERT_EMAIL` is unset this is a pure no-op that
 * only logs, so local/CI/build stay clean and nothing is sent until Nathan
 * sets the env var in Railway. Transport is Resend's HTTP API (no new
 * dependency, a single `fetch`, mirroring how the app already calls out to
 * external services).
 *
 * NEVER THROWS. Ops alerting is best-effort observability; a failure to send
 * must never break the caller (a failing Inngest cron must still complete its
 * failure path, a GDPR webhook must still return its 500). Every path returns
 * a result and swallows errors into a logged line.
 */

import { logger } from "../lib/logger.server";

// All ops-alert subjects carry this prefix so they are trivially filterable
// in the operator's inbox and never collide with any future merchant email.
const SUBJECT_PREFIX = "[GhostCode Ops]";

// Resend's shared onboarding sender works out-of-box once RESEND_API_KEY is
// set, so the channel is functional without also configuring a verified
// domain. Override with OPS_ALERT_FROM once a branded domain is verified.
const DEFAULT_FROM = "GhostCode Ops <onboarding@resend.dev>";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Bounds worst-case latency of the outbound send inside the cron/webhook.
const SEND_TIMEOUT_MS = 5000;

export interface OpsAlertResult {
  sent: boolean;
  /** Why it was (not) sent. */
  reason: "sent" | "disabled" | "no_transport" | "http_error" | "exception";
}

export interface OpsAlertConfigStatus {
  configured: boolean;
  reason: "ok" | "no_recipient" | "no_transport";
}

/**
 * Report whether the ops-alert path is actually wired (both env vars present),
 * WITHOUT sending. Every operator page funnels through `sendOpsAlert`, which
 * silently degrades to a no-op / log-only line if either var is unset, so a
 * typo turns off ALL paging with no signal. A dead-man's-switch heartbeat or
 * self-check can call this to prove the alert path is live before relying on
 * it (a "no_transport" reason surfaces in the logged body even when email can
 * not be sent).
 */
export function getOpsAlertConfigStatus(): OpsAlertConfigStatus {
  if (!process.env.OPS_ALERT_EMAIL) {
    return { configured: false, reason: "no_recipient" };
  }
  if (!process.env.RESEND_API_KEY) {
    return { configured: false, reason: "no_transport" };
  }
  return { configured: true, reason: "ok" };
}

/**
 * Send a single operator alert email to OPS_ALERT_EMAIL.
 *
 * @param subject short one-line summary (SUBJECT_PREFIX is added automatically)
 * @param body    plaintext body
 */
export async function sendOpsAlert(subject: string, body: string): Promise<OpsAlertResult> {
  const to = process.env.OPS_ALERT_EMAIL;

  // Master switch. Unset => inert no-op (log only). Keeps build/CI/local
  // silent and the whole feature dormant until Nathan opts in.
  if (!to) {
    logger.info("Ops alert suppressed (OPS_ALERT_EMAIL unset)", {
      context: "ops-alert",
      subject,
    });
    return { sent: false, reason: "disabled" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Recipient configured but no transport key, surface the alert content
    // to the logs (so it is not lost) and warn that delivery is misconfigured.
    logger.warn("Ops alert not delivered (RESEND_API_KEY unset)", {
      context: "ops-alert",
      subject,
      body,
    });
    return { sent: false, reason: "no_transport" };
  }

  const from = process.env.OPS_ALERT_FROM || DEFAULT_FROM;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `${SUBJECT_PREFIX} ${subject}`,
        text: body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error("Ops alert send returned non-OK", {
        context: "ops-alert",
        subject,
        status: response.status,
      });
      return { sent: false, reason: "http_error" };
    }

    return { sent: true, reason: "sent" };
  } catch (error) {
    logger.error("Ops alert send failed", {
      context: "ops-alert",
      subject,
      error,
    });
    return { sent: false, reason: "exception" };
  }
}
