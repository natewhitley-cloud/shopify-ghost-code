/**
 * Inngest function: snapshot-metrics
 *
 * Daily cron that computes current app-wide metrics from the DB and writes
 * a MetricSnapshot row. One snapshot per UTC day — upsert semantics mean
 * running this multiple times in a day is safe (later run overwrites earlier).
 *
 * No fan-out needed because it queries aggregate data rather than per-shop
 * data. The OpsEvent retention prune runs as a SEPARATE step so a prune failure
 * can never lose the metric snapshot (and vice versa) — Inngest retries each
 * step independently.
 *
 * Schedule: 6 AM UTC daily (`0 6 * * *`)
 */

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

export const snapshotMetrics = inngest.createFunction(
  { id: "snapshot-metrics", name: "Daily Metrics Snapshot" },
  { cron: "0 6 * * *" },
  withCronHeartbeat("snapshot-metrics", async ({ step }) => {
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

    // Separate step: prune stale cron_heartbeat OpsEvents so the table doesn't
    // grow unbounded. Isolated from the snapshot write above so a prune failure
    // doesn't discard the metric snapshot, and its own failure is retried alone.
    await step.run("prune-ops-events", async () => {
      const { pruneOpsEvents } = await import("../../app/models/ops-event.server");

      const deleted = await pruneOpsEvents();

      logger.info("prune-ops-events-complete", { deletedHeartbeats: deleted });

      return deleted;
    });

    return snapshot;
  }),
);
