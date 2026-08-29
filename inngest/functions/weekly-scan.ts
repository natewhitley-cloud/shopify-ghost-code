/**
 * Inngest function: weekly-scan (coordinator)
 *
 * Weekly cron that fans out a `poll/check-shop` event for every active
 * Standard-plan shop. The actual per-shop check logic lives in
 * poll-check-shop.ts (the worker function), which handles the staleness
 * check and scan dispatch — no need to duplicate that logic here.
 *
 * Why a separate coordinator (not merged into poll-theme-changes)?
 *   poll-theme-changes runs daily for Professional shops only. Standard shops
 *   run weekly. Separate coordinators keep the cron schedules and shop cohorts
 *   independent. Both fan out to the same poll-check-shop worker.
 *
 * Schedule:
 *   Sunday 6 AM UTC — same time as the daily poll, but the two coordinators
 *   target disjoint plan cohorts (Standard vs Professional) so their worker
 *   invocations never overlap. Inngest queues invocations independently.
 *
 * Fan-out pattern (mirrors poll-theme-changes.ts):
 *   1. Coordinator (this function): fast — one DB read + N event sends.
 *   2. Worker (poll-check-shop.ts): one function invocation per shop, up to
 *      5 running concurrently.
 */

import { PLANS } from "../../app/lib/billing.server";
import { inngest } from "../client";
import { fanOutShopChecks } from "../lib/fan-out";
import { withCronHeartbeat } from "../lib/heartbeat";

export const weeklyScan = inngest.createFunction(
  { id: "weekly-scan", name: "Weekly Scheduled Scan (Coordinator)" },
  { cron: "0 6 * * 0" }, // Sunday 6 AM UTC
  withCronHeartbeat("weekly-scan", async ({ step, logger }) => {
    // -------------------------------------------------------------------------
    // Step 1: Fetch all Standard-plan shops
    // -------------------------------------------------------------------------
    const shops = await step.run("fetch-standard-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      // Only Standard-plan shops receive weekly scheduled scans.
      // Free-plan shops must trigger scans manually.
      // Professional-plan shops are covered by the daily poll-theme-changes cron.
      return db.shop.findMany({
        // exclude uninstalled-pending-redact shops (gc-grd)
        where: { plan: PLANS.STANDARD, uninstalledAt: null },
        select: { id: true, domain: true },
      });
    });

    logger.info(`[weekly-scan] Fanning out ${shops.length} shop checks`);

    if (shops.length === 0) {
      return { total: 0, dispatched: 0 };
    }

    // -------------------------------------------------------------------------
    // Step 2: Fan out one `poll/check-shop` event per shop. Reuses the same
    // worker as poll-theme-changes — no duplication of per-shop logic. The
    // shared helper chunks at 500 events/send to respect Inngest's 512-event
    // send() cap (a hard cap, not auto-batching) and sends each chunk in its
    // own named step for retry-safe redelivery. See inngest/lib/fan-out.ts.
    // -------------------------------------------------------------------------
    await fanOutShopChecks(step, shops);

    logger.info("[weekly-scan] Coordinator complete", {
      total: shops.length,
      dispatched: shops.length,
    });

    return { total: shops.length, dispatched: shops.length };
  }),
);
