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
 *   3. translation-audit         — (optional) queries the Translations API for
 *                                  orphaned translations. Skipped if the
 *                                  read_translations scope is not granted.
 *
 * Error handling: any unhandled step error will trigger Inngest's automatic
 * retry. The outer try/catch marks the scan FAILED only on non-retryable
 * terminal errors (e.g. shop not found).
 */

import { completeScanWithFindings } from "../../app/models/finding.server";
import { updateScanStatus } from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
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
        console.log("[scan-theme]", { event: "files_fetched", shopId, fileCount: files.length });

        const { findings, unknownScripts } = scanThemeFiles(files);
        console.log("[scan-theme]", {
          event: "scan_complete",
          shopId,
          findingCount: findings.length,
          unknownScriptCount: unknownScripts.length,
        });

        // Both writes are wrapped in a single $transaction inside
        // completeScanWithFindings. This prevents duplicate findings if
        // Inngest retries after createFindings succeeds but the status
        // update fails.
        await completeScanWithFindings(scanId, findings);

        // Persist unknown scripts separately (not part of the transaction —
        // these are informational and don't affect scan correctness).
        await createUnknownScripts(scanId, unknownScripts);

        // Return only the count — not the full findings array
        return findings.length;
      });

      // Step 3: Translation audit (optional — requires read_translations scope)
      const translationFindingCount = await step.run("translation-audit", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) return 0;

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);

        const { hasTranslationScope, auditTranslations } =
          await import("../../app/services/translation-fetcher.server");

        const hasScope = await hasTranslationScope(admin);
        if (!hasScope) {
          console.log(
            "[scan-theme] read_translations scope not available — skipping translation audit",
          );
          return 0;
        }

        const audit = await auditTranslations(admin);
        if (audit.totalTranslations === 0) {
          console.log("[scan-theme] No translations found — skipping translation detection");
          return 0;
        }

        // Get installed app names for cross-reference
        const { getInstalledApps } = await import("../../app/models/installed-app.server");
        const installedApps = await getInstalledApps(shopId);
        const installedAppNames = installedApps.map((a) => a.appName);

        const { detectOrphanedTranslations } =
          await import("../../app/services/translation-detector.server");
        const translationFindings = detectOrphanedTranslations(audit, installedAppNames);

        if (translationFindings.length > 0) {
          // Idempotency guard: delete any previous translation findings before
          // inserting, so Inngest retries don't create duplicates.
          await db.finding.deleteMany({
            where: { scanId, findingType: "GHOST_TRANSLATION" },
          });

          const { createFindings } = await import("../../app/models/finding.server");
          await createFindings(scanId, translationFindings);

          // Update the scan's finding count to include translation findings
          const scan = await db.scan.findUnique({
            where: { id: scanId },
            select: { findingCount: true },
          });
          if (scan) {
            // Recount all findings to be accurate (avoids drift from retries)
            const totalCount = await db.finding.count({ where: { scanId } });
            await db.scan.update({
              where: { id: scanId },
              data: { findingCount: totalCount },
            });
          }

          console.log("[scan-theme]", {
            event: "translation_findings",
            shopId,
            count: translationFindings.length,
          });
        }

        return translationFindings.length;
      });

      const totalFindings = findingCount + translationFindingCount;
      console.log("[scan-theme]", {
        event: "completed",
        scanId,
        shopId,
        findingCount: totalFindings,
        translationFindings: translationFindingCount,
      });

      return {
        scanId,
        findingCount: totalFindings,
        status: "COMPLETED",
      };
    } catch (err) {
      // Mark the scan FAILED so the UI can surface an actionable error state
      // rather than leaving the scan stuck in IN_PROGRESS indefinitely.
      // Guard: if the scan already completed successfully (e.g. Inngest retried
      // after a transient error following completeScanWithFindings), do not
      // overwrite the COMPLETED status.
      // Re-throw so Inngest still sees the error and logs it correctly.
      const db = (await import("../../app/db.server")).default;
      const currentScan = await db.scan.findUnique({
        where: { id: scanId },
        select: { status: true },
      });
      if (currentScan && currentScan.status !== "COMPLETED") {
        await updateScanStatus(scanId, "FAILED").catch(() => {
          // Best-effort — if the status update itself fails we still want to
          // propagate the original error.
        });
      }
      throw err;
    }
  },
);
