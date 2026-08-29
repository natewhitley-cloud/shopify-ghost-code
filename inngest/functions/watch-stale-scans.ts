/**
 * Inngest function: watch-stale-scans
 *
 * Lightweight cron that runs every 10 minutes and expires scans that are stuck
 * in PENDING or IN_PROGRESS status. This is a faster safety net than the daily
 * poll-theme-changes coordinator, which only runs once per day.
 *
 * Why two per-status thresholds (LOG-6, #2-A):
 *   PENDING and IN_PROGRESS scans are aged off different clocks because they
 *   represent different failure modes:
 *     - PENDING (pendingMaxAgeMinutes, from createdAt): a scan that has not even
 *       started within ~15 minutes is genuinely stuck in the queue. A PENDING
 *       scan has no startedAt, so createdAt is the only clock available.
 *     - IN_PROGRESS (inProgressMaxAgeMinutes, from startedAt): a running scan can
 *       legitimately exceed 15 minutes from createdAt — large themes do
 *       rate-limit sleeps in theme-fetcher, and Inngest's retry backoff after a
 *       transient step failure can alone span many minutes. Aging IN_PROGRESS
 *       scans from startedAt with a longer threshold tolerates these healthy
 *       long runs instead of falsely marking them FAILED (the LOG-6 bug). The
 *       resurrection guard in finalizeScan covers the residual race where a scan
 *       is expired right as it finishes.
 *
 * Early-exit optimisation:
 *   Before calling expireStaleScans (which issues an UPDATE), the function
 *   queries for a count of qualifying scans. The count and the UPDATE share the
 *   SAME predicate via buildStaleScanWhere(STALE_THRESHOLDS) so they can never
 *   disagree. If zero are found it returns immediately and neither issues the
 *   UPDATE nor logs any noise.
 *
 * Schedule: every 10 minutes
 */

import { logger } from "../../app/lib/logger.server";
import { DEFAULT_STALE_SCAN_THRESHOLDS } from "../../app/models/scan.server";
import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

// PENDING scans are aged from createdAt; IN_PROGRESS scans from startedAt with a
// longer threshold to tolerate rate-limit sleeps + Inngest retry backoff on
// legitimately long scans (LOG-6, #2-A). Thresholds live in scan.server so the
// watchdog and the daily coordinator share one definition.
const STALE_THRESHOLDS = DEFAULT_STALE_SCAN_THRESHOLDS;

export const watchStaleScans = inngest.createFunction(
  { id: "watch-stale-scans", name: "Watch for Stale Scans" },
  { cron: "*/10 * * * *" }, // every 10 minutes
  withCronHeartbeat("watch-stale-scans", async ({ step }) => {
    // Step 1: Count qualifying stale scans without modifying anything.
    // If none exist we short-circuit to avoid an unnecessary UPDATE query.
    const staleCount = await step.run("count-stale-scans", async () => {
      const db = (await import("../../app/db.server")).default;
      const { buildStaleScanWhere } = await import("../../app/models/scan.server");
      return db.scan.count({ where: buildStaleScanWhere(STALE_THRESHOLDS) });
    });

    if (staleCount === 0) {
      logger.info("watch-stale-scans: no stale scans found, skipping");
      return { staleCount: 0, expiredCount: 0 };
    }

    // Step 2: Expire all qualifying scans (same predicate as the count above).
    const expiredCount = await step.run("expire-stale-scans", async () => {
      const { expireStaleScans } = await import("../../app/models/scan.server");
      return expireStaleScans(STALE_THRESHOLDS);
    });

    logger.warn("watch-stale-scans: expired stale scan(s)", {
      staleCount,
      expiredCount,
      ...STALE_THRESHOLDS,
    });

    return { staleCount, expiredCount };
  }),
);
