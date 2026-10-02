/**
 * Inngest function: monitor-deep-health (gc-06e.13, sub-item 1).
 *
 * Continuous INTERNAL deep-health probe. /health/deep is otherwise only
 * exercised at deploy by the smoke gate; this cron runs the SAME checks
 * (performDeepHealthChecks, shared with the route) hourly and, on a
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
 * Schedule: hourly at :37 (MONITOR_DEEP_HEALTH_CRON).
 */

import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

// Hourly at :37 (gc-ngx6): off :00 and clear of ClearSignal's :02/:07 hourly crons
// on the shared Inngest account. This is now the fastest cron, so it is the
// canary for a total Inngest outage (~2h detection via the 2x grace factor).
export const MONITOR_DEEP_HEALTH_CRON = "37 * * * *";

export const monitorDeepHealth = inngest.createFunction(
  { id: "monitor-deep-health", name: "Continuous Deep Health Monitor" },
  { cron: MONITOR_DEEP_HEALTH_CRON },
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
