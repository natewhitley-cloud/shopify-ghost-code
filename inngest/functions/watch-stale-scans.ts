/**
 * Inngest function: watch-stale-scans
 *
 * Lightweight cron that runs every 10 minutes and expires scans that are stuck
 * in PENDING or IN_PROGRESS status. This is a faster safety net than the daily
 * poll-theme-changes coordinator, which only runs once per day.
 *
 * Why this threshold is 15 minutes:
 *   A normal scan (fetch + parse + store) completes well under 5 minutes for
 *   most themes. 15 minutes is generous enough to allow slow or large themes
 *   to complete normally, but tight enough to unblock merchants quickly when a
 *   worker crashes mid-scan.
 *
 * Early-exit optimisation:
 *   Before calling expireStaleScans (which issues an UPDATE), the function
 *   queries for a count of qualifying scans. If zero are found it returns
 *   immediately and neither issues the UPDATE nor logs any noise.
 *
 * Schedule: every 10 minutes
 */

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";

const STALE_AGE_MINUTES = 15;

export const watchStaleScans = inngest.createFunction(
  { id: "watch-stale-scans", name: "Watch for Stale Scans" },
  { cron: "*/10 * * * *" }, // every 10 minutes
  async ({ step }) => {
    // Step 1: Count qualifying stale scans without modifying anything.
    // If none exist we short-circuit to avoid an unnecessary UPDATE query.
    const staleCount = await step.run("count-stale-scans", async () => {
      const db = (await import("../../app/db.server")).default;
      const { ScanStatus } = await import("@prisma/client");
      const cutoff = new Date(Date.now() - STALE_AGE_MINUTES * 60 * 1000);
      return db.scan.count({
        where: {
          status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] },
          createdAt: { lt: cutoff },
        },
      });
    });

    if (staleCount === 0) {
      logger.info("watch-stale-scans: no stale scans found, skipping");
      return { staleCount: 0, expiredCount: 0 };
    }

    // Step 2: Expire all qualifying scans.
    const expiredCount = await step.run("expire-stale-scans", async () => {
      const { expireStaleScans } = await import("../../app/models/scan.server");
      return expireStaleScans(STALE_AGE_MINUTES);
    });

    logger.warn("watch-stale-scans: expired stale scan(s)", {
      staleCount,
      expiredCount,
      maxAgeMinutes: STALE_AGE_MINUTES,
    });

    return { staleCount, expiredCount };
  },
);
