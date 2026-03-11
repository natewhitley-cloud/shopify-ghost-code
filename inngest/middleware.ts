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

export const loggingMiddleware = new InngestMiddleware({
  name: "logging",
  init() {
    return {
      onFunctionRun({ fn }) {
        const startTime = Date.now();
        return {
          afterExecution() {
            const duration = Date.now() - startTime;
            console.log(`[inngest] ${fn.name} completed in ${duration}ms`);
          },
        };
      },
    };
  },
});
