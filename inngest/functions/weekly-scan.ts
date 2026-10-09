/**
 * Inngest function: weekly-scan (coordinator)
 *
 * Professional plan's scheduled scan, once a week (gc-iefo, 2026-10-09; it
 * was the Standard cohort before). Runs whether or not the theme changed.
 * Professional also gets the instant AUTO_PUBLISH rescan on theme publish
 * (webhook), so a weekly sweep is the backstop, not the only path.
 * See inngest/lib/plan-scan-coordinator.ts.
 */

import { PLANS } from "../../app/lib/billing.server";
import { createPlanScanCoordinator } from "../lib/plan-scan-coordinator";

// Sunday 06:40 UTC (gc-ngx6): staggered after the 06:00 / 06:20 daily crons
// and ClearSignal's 06:00 cluster on the shared Inngest account.
export const WEEKLY_SCAN_CRON = "40 6 * * 0";

export const weeklyScan = createPlanScanCoordinator({
  id: "weekly-scan",
  name: "Weekly Scheduled Scan: Professional (Coordinator)",
  cron: WEEKLY_SCAN_CRON,
  plan: PLANS.PROFESSIONAL,
});
