/**
 * Inngest function: poll-theme-changes (daily stale-scan sweep)
 *
 * Daily backstop that expires scans stuck in PENDING/IN_PROGRESS past their
 * per-status thresholds (DEFAULT_STALE_SCAN_THRESHOLDS, LOG-6). The per-scan
 * check-scan-stale function handles the normal case; this sweep covers a scan
 * whose `scan/requested` send failed, so no per-scan check was scheduled.
 * An expired scan unblocks the shop: createScan refuses while one is active.
 *
 * History (gc-iefo, 2026-10-09): this cron used to also fan out the daily
 * Professional theme-change poll. Scheduled scans now run on the plan cadence
 * from weekly-scan (Professional) and monthly-scan (Standard), regardless of
 * theme changes. The function id is kept (renaming an Inngest id orphans the
 * cron registration and its heartbeat key), so the name is historical.
 */

import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

// Daily 06:00 UTC. Unchanged by gc-ngx6; other daily crons stagger around it.
export const POLL_THEME_CHANGES_CRON = "0 6 * * *";

export const pollThemeChanges = inngest.createFunction(
  { id: "poll-theme-changes", name: "Daily Stale-Scan Sweep" },
  { cron: POLL_THEME_CHANGES_CRON },
  withCronHeartbeat("poll-theme-changes", async ({ step, logger }) => {
    const expiredCount = await step.run("expire-stale-scans", async () => {
      const { expireStaleScans, DEFAULT_STALE_SCAN_THRESHOLDS } =
        await import("../../app/models/scan.server");
      return expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS);
    });

    if (expiredCount > 0) {
      logger.warn(`[poll-theme-changes] expired ${expiredCount} stale scan(s)`);
    }

    return { expired: expiredCount };
  }),
);
