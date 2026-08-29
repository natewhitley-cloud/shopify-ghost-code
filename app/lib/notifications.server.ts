/**
 * Notification scaffolding for operational alerts.
 *
 * notifyFunctionFailure emits a structured error log (also forwarded to Sentry
 * by logger.error) AND sends an operator email via the ops-alert channel. The
 * email path is inert by default: it is a pure no-op unless OPS_ALERT_EMAIL and
 * RESEND_API_KEY are set in Railway, so local/CI/build stay silent.
 *
 * Design:
 *   - notifyFunctionFailure is async and fire-and-forget from callers.
 *   - Any error thrown inside this function is caught and logged — it must
 *     never propagate back to the Inngest middleware and affect job execution.
 *   - sendOpsAlert itself never throws; the surrounding try/catch is a
 *     belt-and-suspenders guard for the log path.
 */

import { logger } from "./logger.server";
import { OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";
import { sendOpsAlert } from "../services/ops-alert.server";

export interface FunctionFailureContext {
  functionId: string;
  eventName: string;
  error: string;
  runId: string;
  attemptNumber?: number;
  /** Shop domain, when the failing job carries one. */
  shop?: string;
}

/**
 * Notify on an Inngest function failure.
 *
 * Always logs a structured error entry (which logger.error also forwards to
 * Sentry) and sends an operator email via the ops-alert channel. The email is
 * inert unless OPS_ALERT_EMAIL and RESEND_API_KEY are configured in Railway.
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
      shop: ctx.shop,
    });

    // Operator email alert. sendOpsAlert is a no-op unless the ops-alert env
    // vars are set, so this is safe and silent in local/CI/build.
    const subject = `Inngest function failed: ${ctx.functionId}`;
    const bodyLines = [
      `Function: ${ctx.functionId}`,
      `Event: ${ctx.eventName}`,
      `Run ID: ${ctx.runId}`,
    ];
    if (ctx.attemptNumber !== undefined) {
      bodyLines.push(`Attempt: ${ctx.attemptNumber}`);
    }
    if (ctx.shop) {
      bodyLines.push(`Shop: ${ctx.shop}`);
    }
    bodyLines.push(`Error: ${ctx.error}`);
    await sendOpsAlert(subject, bodyLines.join("\n"));

    // Persist the failure to the unified OpsEvent log. This is what the future
    // daily ops digest counts (function_failure events per window). recordOpsEvent
    // is best-effort and never throws, so it is additive to the email + log above.
    const metadata: Record<string, string | number> = {
      eventName: ctx.eventName,
      runId: ctx.runId,
    };
    if (ctx.attemptNumber !== undefined) {
      metadata.attemptNumber = ctx.attemptNumber;
    }
    if (ctx.shop) {
      metadata.shop = ctx.shop;
    }
    await recordOpsEvent({
      eventType: OPS_EVENT_TYPES.FUNCTION_FAILURE,
      key: ctx.functionId,
      message: ctx.error,
      metadata,
    });
  } catch (err) {
    // Swallow errors — notification failure must not affect job execution.
    logger.warn("notification-dispatch-failed", {
      functionId: ctx.functionId,
      runId: ctx.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
