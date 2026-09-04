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
 *   3. Compare theme updatedAt against the latest SUCCESSFUL scan's createdAt
 *      (FAILED scans are ignored so a failed scan never suppresses re-scans).
 *   4. If stale (or no prior successful scan), create a scan record.
 *   5. Dispatch `scan/requested` to trigger the scan pipeline. Steps 4 and 5
 *      are separate so each is idempotent on retry (a send failure never
 *      re-runs createScan).
 */

import { ScanOrigin, ScanStatus } from "@prisma/client";

import { createScan, getLatestSuccessfulScanForTheme } from "../../app/models/scan.server";
import { inngest } from "../client";

export const pollCheckShop = inngest.createFunction(
  {
    id: "poll-check-shop",
    name: "Poll: Check Single Shop for Theme Changes",
    // Shares the account-wide 5-slot Inngest pool across the 3 sibling apps; capped
    // at 3 to reserve cron headroom, matching scan-theme.
    concurrency: { limit: 3 },
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
        const { logger } = await import("../../app/lib/logger.server");
        logger.info("main theme fetched", {
          function: "poll-check-shop",
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
    // Step 3: Compare theme updatedAt against the latest SUCCESSFUL scan
    //
    // Only COMPLETED/PARTIAL scans count as a baseline here (LOG-7). A FAILED
    // latest scan is ignored — otherwise its createdAt (always after the theme
    // update that triggered it) would make this conclude "up to date" forever,
    // and a shop whose last scheduled scan failed would never be auto-re-scanned
    // until the merchant next edited the theme. Treating a FAILED (or absent)
    // latest successful scan as "needs scan" lets the watchdog-expired case
    // recover on the next poll.
    // -------------------------------------------------------------------------
    const needsScan = await step.run("check-theme-staleness", async () => {
      const latestSuccessfulScan = await getLatestSuccessfulScanForTheme(shopId, themeId);

      return (
        latestSuccessfulScan === null ||
        new Date(themeUpdatedAt) > new Date(latestSuccessfulScan.createdAt)
      );
    });

    if (!needsScan) {
      logger.info(`[poll-check-shop] ${shopDomain}: skipped — theme up to date`);
      return {
        domain: shopDomain,
        outcome: "skipped_up_to_date" as const,
      };
    }

    // -------------------------------------------------------------------------
    // Step 4: Create the scan record (idempotent on retry)
    //
    // Split from the event-send below so each step is independently idempotent
    // (LOG-8). Inngest memoizes a step's successful output, so once this step
    // commits the scan row and returns its id, a failure/retry of the
    // event-send step will NOT re-run createScan — avoiding the deterministic
    // "A scan is already in progress for this shop." error that a retried
    // create-then-send-in-one-step would hit against the PENDING row it just
    // created, and the orphan PENDING scan that previously blocked the shop.
    //
    // Using createScan() from the model layer so any future model-level
    // logic (e.g. audit hooks, default fields) applies to cron-created scans.
    // -------------------------------------------------------------------------
    const scanId = await step.run("create-scan", async () => {
      const createStart = Date.now();
      // SCHEDULED origin: this cron-created scan is exempt from the manual
      // weekly quota (GC-iji) so it can never block a merchant's manual scan.
      const scan = await createScan(shopId, themeId, themeName, ScanOrigin.SCHEDULED);

      const createMs = Date.now() - createStart;
      const { logger } = await import("../../app/lib/logger.server");
      logger.info("scan created", {
        function: "poll-check-shop",
        event: "create_scan",
        shopDomain,
        scanId: scan.id,
        durationMs: createMs,
      });

      return scan.id;
    });

    // -------------------------------------------------------------------------
    // Step 5: Dispatch the scan pipeline event
    //
    // step.sendEvent is Inngest's idempotent event-send primitive: it is a
    // first-class step, so a transient failure retries ONLY the send (the
    // memoized scanId from Step 4 is reused) rather than re-running createScan.
    // -------------------------------------------------------------------------
    await step.sendEvent("send-scan-requested", {
      name: "scan/requested",
      data: {
        shopId,
        themeId,
        scanId,
      },
    });

    logger.info(`[poll-check-shop] ${shopDomain}: dispatch_triggered — scan ${scanId}`);

    return {
      domain: shopDomain,
      outcome: "dispatch_triggered" as const,
      scanId,
    };
  },
);
