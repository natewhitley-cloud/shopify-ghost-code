/**
 * Inngest function: scan-theme
 *
 * Core async scan workflow. Triggered by the `scan/requested` event when a
 * merchant initiates a new scan from the dashboard.
 *
 * Step breakdown:
 *   1. update-status-in-progress — marks the scan as started
 *   2. fetch-theme-files         — pulls all theme files via Shopify Admin API
 *   3. scan-files                — runs the ghost-code detection engine
 *   4. save-findings             — persists findings and marks scan COMPLETED
 *
 * Each step is independently retryable. Admin API clients are created inside
 * the steps that need them — admin contexts are not serializable across steps.
 *
 * Error handling: any unhandled step error will trigger Inngest's automatic
 * retry. The outer try/catch marks the scan FAILED only on non-retryable
 * terminal errors (e.g. shop not found).
 */

import { completeScanWithFindings } from "../../app/models/finding.server";
import { updateScanStatus } from "../../app/models/scan.server";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
import { fetchThemeFiles } from "../../app/services/theme-fetcher.server";
import { inngest } from "../client";

export const scanTheme = inngest.createFunction(
  { id: "scan-theme", name: "Scan Theme for Ghost Code" },
  { event: "scan/requested" },
  async ({ event, step }) => {
    const { shopId, themeId, scanId } = event.data;

    try {
      // Step 1: Mark scan as in-progress
      await step.run("update-status-in-progress", async () => {
        await updateScanStatus(scanId, "IN_PROGRESS");
      });

      // Step 2: Fetch theme files
      // Admin clients are not serializable, so we create one inside this step
      // rather than passing it from a prior step.
      const files = await step.run("fetch-theme-files", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) {
          throw new Error(`Shop ${shopId} not found — cannot fetch theme files`);
        }

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        return fetchThemeFiles(admin, themeId);
      });

      // Step 3: Run the ghost-code detection engine
      // Pure CPU work — no DB or network access needed.
      const findings = await step.run("scan-files", async () => {
        return scanThemeFiles(files);
      });

      // Step 4: Persist findings and mark scan COMPLETED
      // Both writes are wrapped in a single $transaction inside completeScanWithFindings.
      // This prevents the duplicate-finding problem that would occur if Inngest retried
      // this step after createFindings succeeded but the status update failed.
      await step.run("save-findings", async () => {
        await completeScanWithFindings(scanId, findings);
      });

      return {
        scanId,
        findingCount: findings.length,
        status: "COMPLETED",
      };
    } catch (err) {
      // Mark the scan FAILED so the UI can surface an actionable error state
      // rather than leaving the scan stuck in IN_PROGRESS indefinitely.
      // Re-throw so Inngest still sees the error and logs it correctly.
      await updateScanStatus(scanId, "FAILED").catch(() => {
        // Best-effort — if the status update itself fails we still want to
        // propagate the original error.
      });
      throw err;
    }
  },
);
