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
 */

import { InngestMiddleware } from "inngest";

import { logger } from "../app/lib/logger.server";
import { notifyFunctionFailure } from "../app/lib/notifications.server";

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

/**
 * failureLoggingMiddleware
 *
 * Intercepts function failures and emits a structured log entry with
 * job-specific context (functionId, eventName, runId). The log entry is
 * queryable in Railway log aggregation via the `event` field.
 *
 * Also calls notifyFunctionFailure() — fire-and-forget — which emits a
 * structured error log and sends an operator email via the ops-alert channel.
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
