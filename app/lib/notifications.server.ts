/**
 * Notification scaffolding for operational alerts.
 *
 * Currently, all notifications are structured log entries only — queryable in
 * Railway log aggregation via the `event` field. The notification channel
 * integrations (Slack, email) are stubbed with TODO comments for future work.
 *
 * Design:
 *   - notifyFunctionFailure is async and fire-and-forget from callers.
 *   - Any error thrown inside this function is caught and logged — it must
 *     never propagate back to the Inngest middleware and affect job execution.
 *
 * Future integrations:
 *   - SLACK_WEBHOOK_URL env var → post to a Slack channel
 *   - NOTIFICATION_EMAIL env var → send via a transactional email provider
 */

import { logger } from "./logger.server";

export interface FunctionFailureContext {
  functionId: string;
  eventName: string;
  error: string;
  runId: string;
  attemptNumber?: number;
}

/**
 * Notify on an Inngest function failure.
 *
 * Always logs a structured error entry. Additional notification channels
 * (Slack, email) are stubbed below — wire them up when the relevant env vars
 * are configured.
 *
 * This is fire-and-forget — callers should not await this in the hot path.
 */
export async function notifyFunctionFailure(ctx: FunctionFailureContext): Promise<void> {
  try {
    logger.error("inngest-function-failed", {
      functionId: ctx.functionId,
      eventName: ctx.eventName,
      error: ctx.error,
      runId: ctx.runId,
      attemptNumber: ctx.attemptNumber,
    });

    // TODO: Slack integration
    // When SLACK_WEBHOOK_URL is configured, post a message to the ops channel.
    // Example payload:
    //   { text: `Inngest function \`${ctx.functionId}\` failed: ${ctx.error}` }
    // const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    // if (slackWebhookUrl) {
    //   await fetch(slackWebhookUrl, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify({
    //       text: `Inngest function \`${ctx.functionId}\` failed on run \`${ctx.runId}\`: ${ctx.error}`,
    //     }),
    //   });
    // }

    // TODO: Email integration
    // When NOTIFICATION_EMAIL is configured, send an alert via a transactional
    // email provider (e.g. Resend, SendGrid, Postmark).
    // const notificationEmail = process.env.NOTIFICATION_EMAIL;
    // if (notificationEmail) {
    //   await sendEmail({
    //     to: notificationEmail,
    //     subject: `[Ghost Code] Inngest function failed: ${ctx.functionId}`,
    //     text: `Run ID: ${ctx.runId}\nEvent: ${ctx.eventName}\nError: ${ctx.error}`,
    //   });
    // }
  } catch (err) {
    // Swallow errors — notification failure must not affect job execution.
    logger.warn("notification-dispatch-failed", {
      functionId: ctx.functionId,
      runId: ctx.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
