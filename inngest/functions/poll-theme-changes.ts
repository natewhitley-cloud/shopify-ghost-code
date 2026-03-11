/**
 * Inngest function: poll-theme-changes
 *
 * Daily cron fallback that guards against webhook delivery failures.
 * Runs once daily at 6 AM UTC and checks every active shop for theme
 * modifications since the last scan.
 *
 * Why this exists:
 *   Shopify webhook delivery is best-effort — network blips, Shopify outages,
 *   or app downtime can silently drop theme update events. This cron ensures
 *   shops are never stuck with stale scan data for more than ~24 hours even
 *   when the theme-changed webhook fails to arrive.
 *
 * Processing model:
 *   Each shop is processed in its own step.run() so that a single shop
 *   failure (e.g. expired token, Shopify API error) does not abort the
 *   entire batch. Steps are also individually retryable by Inngest.
 *
 * Rate-limit strategy:
 *   Shops are processed sequentially (one step per shop in a for-loop)
 *   rather than concurrently. This trades latency for safety — with many
 *   shops concurrently hitting the Shopify API we would quickly exhaust
 *   per-shop and global rate budgets. For small-to-medium shop counts
 *   the daily window is more than wide enough for sequential processing.
 */

import { inngest } from "../client";
import { ScanStatus } from "@prisma/client";
import { createScan } from "../../app/models/scan.server";

const THEMES_QUERY = `
  {
    themes(first: 1, roles: MAIN) {
      nodes {
        id
        name
        updatedAt
      }
    }
  }
`;

export const pollThemeChanges = inngest.createFunction(
  { id: "poll-theme-changes", name: "Daily Theme Change Poll" },
  { cron: "0 6 * * *" },
  async ({ step, logger }) => {
    // -------------------------------------------------------------------------
    // Step 1: Fetch all active shops
    // -------------------------------------------------------------------------
    const shops = await step.run("fetch-all-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      // Only Professional-plan shops receive automatic daily re-scans.
      // Free-plan shops must trigger scans manually from the dashboard.
      // The plan field is stored as a plain string; "professional" matches
      // the value set during plan upgrade (see billing webhook handler).
      return db.shop.findMany({
        where: { plan: "professional" },
        select: { id: true, domain: true, accessToken: true },
      });
    });

    logger.info(`[poll-theme-changes] Checking ${shops.length} shops`);

    const results: {
      domain: string;
      outcome: "skipped_no_token" | "skipped_in_progress" | "skipped_up_to_date" | "dispatch_triggered" | "error";
      reason?: string;
    }[] = [];

    // -------------------------------------------------------------------------
    // Step 2–4 (per shop): Fetch theme, compare timestamps, dispatch if stale.
    // Processing sequentially to respect Shopify API rate limits.
    // -------------------------------------------------------------------------
    for (const shop of shops) {
      // Sanitise the domain for use in the step ID (must be stable + URL-safe).
      const safeId = shop.domain.replace(/[^a-z0-9-]/gi, "-");

      const outcome = await step.run(`check-shop-${safeId}`, async () => {
        // Guard: incomplete installs — skip shops without an access token.
        if (!shop.accessToken) {
          return { outcome: "skipped_no_token" as const, reason: "no accessToken" };
        }

        // Fetch the main theme's updatedAt from Shopify.
        let themeId: string;
        let themeName: string;
        let themeUpdatedAt: Date;

        try {
          const { unauthenticated } = await import("../../app/shopify.server");
          const { admin } = await unauthenticated.admin(shop.domain);

          const response = await admin.graphql(THEMES_QUERY);
          const json = await response.json();

          const themeNode = json?.data?.themes?.nodes?.[0];
          if (!themeNode) {
            return {
              outcome: "error" as const,
              reason: "no main theme found in Shopify response",
            };
          }

          themeId = themeNode.id as string;
          themeName = themeNode.name as string;
          themeUpdatedAt = new Date(themeNode.updatedAt as string);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { outcome: "error" as const, reason: `Shopify API error: ${message}` };
        }

        // Check for an active in-progress scan so we don't double-dispatch.
        const db = (await import("../../app/db.server")).default;
        const inProgressScan = await db.scan.findFirst({
          where: {
            shopId: shop.id,
            themeId,
            status: ScanStatus.IN_PROGRESS,
          },
          select: { id: true },
        });

        if (inProgressScan) {
          return {
            outcome: "skipped_in_progress" as const,
            reason: `scan ${inProgressScan.id} already in progress`,
          };
        }

        // Compare theme's updatedAt against the most recent scan for this theme.
        const latestScan = await db.scan.findFirst({
          where: { shopId: shop.id, themeId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });

        const needsScan =
          latestScan === null || themeUpdatedAt > latestScan.createdAt;

        if (!needsScan) {
          return { outcome: "skipped_up_to_date" as const };
        }

        // Theme was modified after the last scan — create a scan record and
        // dispatch the `scan/requested` event to trigger the scan pipeline.
        // Using createScan() from the model layer so any future model-level
        // logic (e.g. audit hooks, default fields) applies to cron-created scans.
        const newScan = await createScan(shop.id, themeId, themeName);

        await (
          await import("../client")
        ).inngest.send({
          name: "scan/requested",
          data: {
            shopId: shop.id,
            themeId,
            scanId: newScan.id,
          },
        });

        return { outcome: "dispatch_triggered" as const };
      });

      results.push({ domain: shop.domain, ...outcome });

      logger.info(`[poll-theme-changes] ${shop.domain}: ${outcome.outcome}`, {
        reason: "reason" in outcome ? outcome.reason : undefined,
      });
    }

    // Summary log for observability.
    const summary = results.reduce(
      (acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    logger.info("[poll-theme-changes] Daily poll complete", { summary, total: shops.length });

    return { total: shops.length, summary, results };
  },
);
