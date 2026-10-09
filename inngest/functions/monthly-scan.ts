/**
 * Inngest function: monthly-scan (coordinator)
 *
 * Standard plan's scheduled scan, once a month on the 1st (gc-iefo,
 * 2026-10-09; Standard was weekly before). Runs whether or not the theme
 * changed. See inngest/lib/plan-scan-coordinator.ts.
 */

import { PLANS } from "../../app/lib/billing.server";
import { createPlanScanCoordinator } from "../lib/plan-scan-coordinator";

// 1st of the month, 07:20 UTC (gc-iefo): off :00 and the :02/:07 hourly crons
// (gc-ngx6), and 40 min after weekly-scan's 06:40 when the 1st is a Sunday, so
// the two dispatch waves never start together.
export const MONTHLY_SCAN_CRON = "20 7 1 * *";

export const monthlyScan = createPlanScanCoordinator({
  id: "monthly-scan",
  name: "Monthly Scheduled Scan: Standard (Coordinator)",
  cron: MONTHLY_SCAN_CRON,
  plan: PLANS.STANDARD,
});
