/**
 * Inngest function: poll-check-shop (worker)
 *
 * Processes a single shop's theme change check. Triggered by `poll/check-shop`
 * events emitted by the poll-theme-changes coordinator cron function.
 *
 * Concurrency:
 *   Up to 5 instances run in parallel. This gives controlled Shopify API
 *   parallelism — fast enough to process 100+ shops well within the daily
 *   window, conservative enough to avoid rate-limit exhaustion.
 *
 * Retry semantics:
 *   Inngest retries each invocation up to 3 times (default) on failure.
 *   Because each shop is its own function invocation, one shop's error does
 *   not block others and does not consume the coordinator's retry budget.
 *
 * Per-shop logic:
 *   1. Fetch the main theme from Shopify (updatedAt timestamp).
 *   2. Check for an active (PENDING or IN_PROGRESS) scan → skip if found.
 *   3. Compare theme updatedAt against the latest scan's createdAt.
 *   4. If stale (or no prior scan), create a scan record and dispatch
 *      `scan/requested` to trigger the scan pipeline.
 */

import { ScanStatus } from "@prisma/client";

import { createScan } from "../../app/models/scan.server";
import { inngest } from "../client";

export const pollCheckShop = inngest.createFunction(
  {
    id: "poll-check-shop",
    name: "Poll: Check Single Shop for Theme Changes",
    concurrency: { limit: 5 },
  },
  { event: "poll/check-shop" },
  async ({ event, step, logger }) => {
    const { shopId, shopDomain } = event.data;

    // -------------------------------------------------------------------------
    // Step 1: Fetch the shop's main theme from Shopify
    // -------------------------------------------------------------------------
    const themeResult = await step.run("fetch-main-theme", async () => {
      try {
        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shopDomain);

        const { fetchMainTheme } = await import("../../app/services/theme-fetcher.server");
        const fetchStart = Date.now();
        const mainTheme = await fetchMainTheme(admin);
        const fetchMs = Date.now() - fetchStart;
        console.log("[poll-check-shop]", {
          event: "fetch_main_theme",
          shopDomain,
          durationMs: fetchMs,
          found: mainTheme !== null,
        });

        if (!mainTheme) {
          return {
            ok: false as const,
            outcome: "error" as const,
            reason: "no main theme found in Shopify response",
          };
        }

        return {
          ok: true as const,
          themeId: mainTheme.id,
          themeName: mainTheme.name,
          themeUpdatedAt: mainTheme.updatedAt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false as const,
          outcome: "error" as const,
          reason: `Shopify API error: ${message}`,
        };
      }
    });

    if (!themeResult.ok) {
      logger.warn(`[poll-check-shop] ${shopDomain}: ${themeResult.reason}`);
      return {
        domain: shopDomain,
        outcome: themeResult.outcome,
        reason: themeResult.reason,
      };
    }

    const { themeId, themeName, themeUpdatedAt } = themeResult;

    // -------------------------------------------------------------------------
    // Step 2: Check for an active scan (PENDING or IN_PROGRESS)
    // -------------------------------------------------------------------------
    const activeCheckResult = await step.run("check-active-scan", async () => {
      const db = (await import("../../app/db.server")).default;
      // PENDING is included because a queued scan that hasn't started yet
      // (e.g. Inngest is temporarily down) should suppress a new dispatch —
      // otherwise each poll run would create an orphan PENDING scan while
      // the original one sits idle.
      const inProgressScan = await db.scan.findFirst({
        where: {
          shopId,
          themeId,
          status: { in: [ScanStatus.PENDING, ScanStatus.IN_PROGRESS] },
        },
        select: { id: true },
      });

      return inProgressScan;
    });

    if (activeCheckResult) {
      logger.info(
        `[poll-check-shop] ${shopDomain}: skipped — scan ${activeCheckResult.id} already in progress`,
      );
      return {
        domain: shopDomain,
        outcome: "skipped_in_progress" as const,
        reason: `scan ${activeCheckResult.id} already in progress`,
      };
    }

    // -------------------------------------------------------------------------
    // Step 3: Compare theme updatedAt against the latest scan's createdAt
    // -------------------------------------------------------------------------
    const needsScan = await step.run("check-theme-staleness", async () => {
      const db = (await import("../../app/db.server")).default;
      const latestScan = await db.scan.findFirst({
        where: { shopId, themeId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      return latestScan === null || new Date(themeUpdatedAt) > new Date(latestScan.createdAt);
    });

    if (!needsScan) {
      logger.info(`[poll-check-shop] ${shopDomain}: skipped — theme up to date`);
      return {
        domain: shopDomain,
        outcome: "skipped_up_to_date" as const,
      };
    }

    // -------------------------------------------------------------------------
    // Step 4: Create a scan record and dispatch the scan pipeline event
    // -------------------------------------------------------------------------
    const newScan = await step.run("dispatch-scan", async () => {
      const dispatchStart = Date.now();

      // Using createScan() from the model layer so any future model-level
      // logic (e.g. audit hooks, default fields) applies to cron-created scans.
      const scan = await createScan(shopId, themeId, themeName);

      await (
        await import("../client")
      ).inngest.send({
        name: "scan/requested",
        data: {
          shopId,
          themeId,
          scanId: scan.id,
        },
      });

      const dispatchMs = Date.now() - dispatchStart;
      console.log("[poll-check-shop]", {
        event: "dispatch_scan",
        shopDomain,
        scanId: scan.id,
        durationMs: dispatchMs,
      });

      return scan;
    });

    logger.info(`[poll-check-shop] ${shopDomain}: dispatch_triggered — scan ${newScan.id}`);

    return {
      domain: shopDomain,
      outcome: "dispatch_triggered" as const,
      scanId: newScan.id,
    };
  },
);
