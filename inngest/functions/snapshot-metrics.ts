/**
 * Inngest function: snapshot-metrics
 *
 * Daily cron that computes current app-wide metrics from the DB and writes
 * a MetricSnapshot row. One snapshot per UTC day — upsert semantics mean
 * running this multiple times in a day is safe (later run overwrites earlier).
 *
 * This is a single-step function: no fan-out needed because it queries
 * aggregate data rather than per-shop data.
 *
 * Schedule: 6 AM UTC daily (`0 6 * * *`)
 */

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";

export const snapshotMetrics = inngest.createFunction(
  { id: "snapshot-metrics", name: "Daily Metrics Snapshot" },
  { cron: "0 6 * * *" },
  async ({ step }) => {
    const snapshot = await step.run("compute-and-store-metrics", async () => {
      const { computeCurrentMetrics, createMetricSnapshot } =
        await import("../../app/models/metric-snapshot.server");

      const metrics = await computeCurrentMetrics();
      const saved = await createMetricSnapshot(metrics);

      logger.info("snapshot-metrics-complete", {
        snapshotDate: metrics.snapshotDate.toISOString(),
        totalShops: metrics.totalShops,
        activeShops: metrics.activeShops,
        totalScans: metrics.totalScans,
        completionRate: metrics.completionRate,
      });

      return saved;
    });

    return snapshot;
  },
);
