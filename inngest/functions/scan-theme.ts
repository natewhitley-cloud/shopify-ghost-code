/**
 * Inngest function: scan-theme
 *
 * Core async scan workflow. Triggered by the `scan/requested` event when a
 * merchant initiates a new scan from the dashboard.
 *
 * Step breakdown:
 *   1. update-status-in-progress — marks the scan as started
 *   2. fetch-and-scan            — pulls theme files via Shopify Admin API,
 *                                  runs the detection engine, and persists findings.
 *                                  Combined into one step to avoid exceeding
 *                                  Inngest's 4MB step output size limit (theme
 *                                  file contents are large and don't need to be
 *                                  serialized between steps).
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

      // Step 2: Fetch theme files, scan them, and save findings.
      // Combined into one step because theme file contents can exceed
      // Inngest's 4MB step output serialization limit.
      const findingCount = await step.run("fetch-and-scan", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) {
          throw new Error(`Shop ${shopId} not found — cannot fetch theme files`);
        }

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        const files = await fetchThemeFiles(admin, themeId);

        const findings = scanThemeFiles(files);

        // Both writes are wrapped in a single $transaction inside
        // completeScanWithFindings. This prevents duplicate findings if
        // Inngest retries after createFindings succeeds but the status
        // update fails.
        await completeScanWithFindings(scanId, findings);

        // Return only the count — not the full findings array
        return findings.length;
      });

      return {
        scanId,
        findingCount,
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
