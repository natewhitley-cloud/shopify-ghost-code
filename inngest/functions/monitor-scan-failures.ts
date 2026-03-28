/**
 * Inngest function: monitor-scan-failures
 *
 * Cron that runs every 6 hours and logs the scan failure rate over the
 * trailing 24-hour window. This is an operational signal — data lives in
 * structured logs, not a database table.
 *
 * Thresholds:
 *   > 10% failure rate  → warn  (elevated — investigate if sustained)
 *   > 25% failure rate  → error (critical — Sentry alert fires via logger)
 *
 * The logger.error path automatically forwards to Sentry when SENTRY_DSN is
 * configured, so no explicit Sentry call is needed here.
 *
 * Schedule: every 6 hours (`0 * /6 * * *`)
 */

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";

const WINDOW_HOURS = 24;
const WARN_THRESHOLD = 0.1; // 10%
const CRITICAL_THRESHOLD = 0.25; // 25%

export const monitorScanFailures = inngest.createFunction(
  { id: "monitor-scan-failures", name: "Scan Failure Rate Monitor" },
  { cron: "0 */6 * * *" }, // every 6 hours
  async ({ step }) => {
    const stats = await step.run("compute-failure-rate", async () => {
      const { getFailureRateStats } = await import("../../app/models/scan.server");
      return getFailureRateStats(WINDOW_HOURS);
    });

    const { total, failed, rate } = stats;
    const context = { total, failed, rate, windowHours: WINDOW_HOURS };

    if (rate > CRITICAL_THRESHOLD) {
      logger.error("scan-failure-rate-critical", context);
    } else if (rate > WARN_THRESHOLD) {
      logger.warn("scan-failure-rate-elevated", context);
    } else {
      logger.info("scan-failure-rate-check", context);
    }

    return stats;
  },
);
