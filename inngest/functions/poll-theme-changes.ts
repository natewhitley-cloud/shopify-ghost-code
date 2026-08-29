/**
 * Inngest function: poll-theme-changes (coordinator)
 *
 * Daily cron fallback that guards against webhook delivery failures.
 * Runs once daily at 6 AM UTC and fans out a `poll/check-shop` event for
 * every active Professional-plan shop. The actual per-shop check logic lives
 * in poll-check-shop.ts (the worker function), which Inngest runs in parallel
 * with a concurrency cap to avoid overwhelming the Shopify API.
 *
 * Why this exists:
 *   Shopify webhook delivery is best-effort — network blips, Shopify outages,
 *   or app downtime can silently drop theme update events. This cron ensures
 *   shops are never stuck with stale scan data for more than ~24 hours even
 *   when the theme-changed webhook fails to arrive.
 *
 * Fan-out pattern:
 *   1. Coordinator (this function): fast — one DB read + N event sends.
 *   2. Worker (poll-check-shop.ts): one function invocation per shop, up to
 *      5 running concurrently. Each has independent retry semantics.
 *
 * This replaces the previous sequential for-loop approach, which would not
 * scale beyond ~100 shops within a single 6 AM window.
 */

import { PLANS } from "../../app/lib/billing.server";
import { inngest } from "../client";
import { fanOutShopChecks } from "../lib/fan-out";
import { withCronHeartbeat } from "../lib/heartbeat";

export const pollThemeChanges = inngest.createFunction(
  { id: "poll-theme-changes", name: "Daily Theme Change Poll (Coordinator)" },
  { cron: "0 6 * * *" },
  withCronHeartbeat("poll-theme-changes", async ({ step, logger }) => {
    // -------------------------------------------------------------------------
    // Step 0: Expire stale scans stuck in PENDING/IN_PROGRESS past their
    // per-status thresholds (PENDING aged from createdAt, IN_PROGRESS from
    // startedAt — see DEFAULT_STALE_SCAN_THRESHOLDS / LOG-6). This unblocks shops
    // whose scan jobs crashed or timed out before we fan out new per-shop checks
    // — otherwise createScan will throw on the next run.
    // -------------------------------------------------------------------------
    const expiredCount = await step.run("expire-stale-scans", async () => {
      const { expireStaleScans, DEFAULT_STALE_SCAN_THRESHOLDS } =
        await import("../../app/models/scan.server");
      return expireStaleScans(DEFAULT_STALE_SCAN_THRESHOLDS);
    });

    if (expiredCount > 0) {
      logger.warn(`[poll-theme-changes] expired ${expiredCount} stale scan(s)`);
    }

    // -------------------------------------------------------------------------
    // Step 1: Fetch all Professional-plan shops
    // -------------------------------------------------------------------------
    const shops = await step.run("fetch-all-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      // Only Professional-plan shops receive automatic daily re-scans.
      // Free-plan shops must trigger scans manually from the dashboard.
      // Use PLANS.PROFESSIONAL ("Professional") to match the canonical stored value
      // set during plan upgrade (see billing.server.ts and billing webhook handler).
      return db.shop.findMany({
        where: { plan: PLANS.PROFESSIONAL },
        select: { id: true, domain: true },
      });
    });

    logger.info(`[poll-theme-changes] Fanning out ${shops.length} shop checks`);

    if (shops.length === 0) {
      return { total: 0, dispatched: 0 };
    }

    // -------------------------------------------------------------------------
    // Step 2: Fan out one `poll/check-shop` event per shop. The shared helper
    // chunks at 500 events/send to respect Inngest's 512-event send() cap (a
    // hard cap, not auto-batching) and sends each chunk in its own named step
    // for retry-safe redelivery. See inngest/lib/fan-out.ts.
    // -------------------------------------------------------------------------
    await fanOutShopChecks(step, shops);

    logger.info("[poll-theme-changes] Coordinator complete", {
      total: shops.length,
      dispatched: shops.length,
    });

    return { total: shops.length, dispatched: shops.length };
  }),
);
