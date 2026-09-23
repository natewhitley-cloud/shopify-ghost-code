/**
 * Inngest function: monitor-scan-failures
 *
 * Cron that runs every 6 hours and logs the scan failure rate over the
 * trailing 24-hour window. This is an operational signal — data lives in
 * structured logs, not a database table.
 *
 * Thresholds:
 *   > 10% failure rate  → warn  (elevated — investigate if sustained)
 *   > 25% failure rate  → error (critical — surfaces in structured logs), AND
 *                          if >= MIN_FAILURES_TO_PAGE scans failed, a durable
 *                          function_failure + ops page (at most once per 24h).
 *                          The floor stops a 1-of-3 small-sample spike from
 *                          paging at today's install count (gc-i1n).
 *
 * Schedule: every 6 hours (`0 * /6 * * *`)
 */

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

const WINDOW_HOURS = 24;
const WARN_THRESHOLD = 0.1; // 10%
const CRITICAL_THRESHOLD = 0.25; // 25%
const MIN_FAILURES_TO_PAGE = 3;
const ESCALATION_DEDUPE_MS = 24 * 60 * 60 * 1000;
const FUNCTION_ID = "monitor-scan-failures";

export const monitorScanFailures = inngest.createFunction(
  { id: FUNCTION_ID, name: "Scan Failure Rate Monitor" },
  { cron: "0 */6 * * *" }, // every 6 hours
  withCronHeartbeat(FUNCTION_ID, async ({ step }) => {
    const stats = await step.run("compute-failure-rate", async () => {
      const { getFailureRateStats } = await import("../../app/models/scan.server");
      return getFailureRateStats(WINDOW_HOURS);
    });

    const { total, failed, rate } = stats;
    const context = { total, failed, rate, windowHours: WINDOW_HOURS };

    if (rate > CRITICAL_THRESHOLD) {
      logger.error("scan-failure-rate-critical", context);
      if (failed >= MIN_FAILURES_TO_PAGE) {
        await step.run("escalate-critical-failure-rate", () =>
          escalateCritical(total, failed, rate),
        );
      }
    } else if (rate > WARN_THRESHOLD) {
      logger.warn("scan-failure-rate-elevated", context);
    } else {
      logger.info("scan-failure-rate-check", context);
    }

    return stats;
  }),
);

/**
 * Record a durable function_failure + page the operator, at most once per 24h.
 * Mirrors scan-pool's maybeEscalateWorkerFallbacks: notifyFunctionFailure writes
 * the function_failure row keyed to FUNCTION_ID, which doubles as the dedupe
 * marker. Best-effort: never throws, so it cannot fail the cron.
 */
async function escalateCritical(total: number, failed: number, rate: number): Promise<void> {
  try {
    const { getLatestOpsEvent, OPS_EVENT_TYPES } =
      await import("../../app/models/ops-event.server");
    const last = await getLatestOpsEvent(OPS_EVENT_TYPES.FUNCTION_FAILURE, FUNCTION_ID);
    if (last && Date.now() - new Date(last.createdAt).getTime() < ESCALATION_DEDUPE_MS) return;

    const { notifyFunctionFailure } = await import("../../app/lib/notifications.server");
    await notifyFunctionFailure({
      functionId: FUNCTION_ID,
      eventName: "scan-failure-rate-critical",
      error:
        `scan failure rate ${(rate * 100).toFixed(1)}% (${failed} of ${total}) over the last ` +
        `${WINDOW_HOURS}h exceeds the ${CRITICAL_THRESHOLD * 100}% critical threshold`,
      runId: `${FUNCTION_ID}-${Date.now()}`,
    });
  } catch (err) {
    logger.warn("scan-failure-rate escalation failed", {
      function: FUNCTION_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
