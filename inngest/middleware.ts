/**
 * Inngest middleware definitions for Ghost Code.
 *
 * Middleware is applied globally to the Inngest client in client.ts so every
 * function benefits automatically without per-function boilerplate.
 *
 * loggingMiddleware:
 *   Wraps every function execution with duration tracking. Logs a single line
 *   on completion that includes the function name and wall-clock duration.
 *   The `afterExecution` hook is a BlankHook (no arguments) per the Inngest
 *   SDK contract — duration is captured via closure over `startTime`.
 *
 *   Note: `afterExecution` fires after new code executes (i.e. on the step
 *   that actually runs new work), not on memoization replays. This keeps log
 *   volume proportional to real work rather than step replays.
 *
 * sentryMiddleware:
 *   Captures unhandled errors thrown during Inngest function execution and
 *   forwards them to Sentry. captureException is a no-op when SENTRY_DSN is
 *   not configured, so this never affects app behaviour.
 *
 *   Uses `transformOutput` to inspect the execution result. When the result
 *   contains an error, it is forwarded to Sentry before the output is passed
 *   back to the Inngest SDK unchanged.
 */

import { InngestMiddleware } from "inngest";

import { logger } from "../app/lib/logger.server";
import { notifyFunctionFailure } from "../app/lib/notifications.server";
import { captureException } from "../app/lib/sentry.server";

export const loggingMiddleware = new InngestMiddleware({
  name: "logging",
  init() {
    return {
      onFunctionRun({ fn }) {
        const startTime = Date.now();
        return {
          afterExecution() {
            const duration = Date.now() - startTime;
            logger.info("inngest function completed", { function: fn.name, durationMs: duration });
          },
        };
      },
    };
  },
});

export const sentryMiddleware = new InngestMiddleware({
  name: "sentry",
  init() {
    return {
      onFunctionRun({ fn }) {
        return {
          transformOutput(ctx) {
            // ctx.result.error is set when the function throws an unhandled error.
            if (ctx.result.error) {
              captureException(ctx.result.error, {
                inngestFunction: fn.name,
              });
            }
            // Return undefined to leave the output unchanged.
            return undefined;
          },
        };
      },
    };
  },
});

/**
 * failureLoggingMiddleware
 *
 * Intercepts function failures and emits a structured log entry with
 * job-specific context (functionId, eventName, runId). The log entry is
 * queryable in Railway log aggregation via the `event` field.
 *
 * Also calls notifyFunctionFailure() — fire-and-forget — which is the hook
 * point for future Slack/email alerting when those integrations are wired up.
 *
 * This is ADDITIVE to sentryMiddleware. Both middlewares are registered and
 * each handles its own concern:
 *   - sentryMiddleware: forwards raw Error objects to Sentry
 *   - failureLoggingMiddleware: structured logs + notification dispatch
 */
export const failureLoggingMiddleware = new InngestMiddleware({
  name: "failure-logging",
  init() {
    return {
      onFunctionRun({ fn, ctx }) {
        const functionId = fn.id();
        const eventName = ctx.event.name;
        const runId = ctx.runId;

        return {
          transformOutput(outputCtx) {
            if (outputCtx.result.error) {
              const error =
                outputCtx.result.error instanceof Error
                  ? outputCtx.result.error.message
                  : String(outputCtx.result.error);

              // Fire-and-forget — must not block the Inngest response path.
              void notifyFunctionFailure({ functionId, eventName, error, runId });
            }
            // Return undefined to leave the output unchanged.
            return undefined;
          },
        };
      },
    };
  },
});
