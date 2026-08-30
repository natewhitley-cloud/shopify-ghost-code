/**
 * Inngest function: monitor-deep-health (gc-06e.13, sub-item 1).
 *
 * Continuous INTERNAL deep-health probe. /health/deep is otherwise only
 * exercised at deploy by the smoke gate; this cron runs the SAME checks
 * (performDeepHealthChecks, shared with the route) every 15 minutes and, on a
 * degraded/error result, records a function_failure OpsEvent + fires an
 * ops-alert via notifyFunctionFailure. That surfaces a silent post-deploy
 * regression (a cron that stops, sessions that pile up expired, scans stuck
 * PENDING) between deploys instead of only at the next deploy.
 *
 * NOTE: an internal cron CANNOT catch a total-app-down condition (if the app is
 * down, this cron does not run either). A true EXTERNAL uptime monitor hitting
 * /health from outside Railway remains an ops-config task OUTSIDE code — this
 * internal cron COMPLEMENTS, it does not replace, that. The dead-man's-switch
 * (getStaleCrons) is the in-app backstop that flags this monitor itself going
 * silent.
 *
 * Wrapped in withCronHeartbeat: a degraded result is NOT a failure of this
 * monitor (the monitor ran fine; the thing it observed is degraded), so the
 * handler alerts and returns normally and a heartbeat is still recorded. Only a
 * genuine throw in the monitor skips the heartbeat.
 *
 * Schedule: every 15 minutes (`* /15 * * * *`).
 */

import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

export const monitorDeepHealth = inngest.createFunction(
  { id: "monitor-deep-health", name: "Continuous Deep Health Monitor" },
  { cron: "*/15 * * * *" },
  withCronHeartbeat("monitor-deep-health", async ({ step, runId }) => {
    const result = await step.run("run-deep-health-checks", async () => {
      const { performDeepHealthChecks } = await import("../../app/services/deep-health.server");
      return performDeepHealthChecks();
    });

    if (result.status !== "ok") {
      // Route the degraded signal to the EXISTING failure-event log + ops-alert
      // channel. notifyFunctionFailure records a function_failure OpsEvent AND
      // sends the operator email (inert unless the ops-alert env vars are set),
      // and never throws — so a degraded probe cannot fail this cron.
      await step.run("alert-on-degraded", async () => {
        const { notifyFunctionFailure } = await import("../../app/lib/notifications.server");
        await notifyFunctionFailure({
          functionId: "monitor-deep-health",
          eventName: "deep-health-check",
          error: `deep health ${result.status}: ${JSON.stringify(result.checks)}`,
          runId,
        });
      });
    }

    return result;
  }),
);
