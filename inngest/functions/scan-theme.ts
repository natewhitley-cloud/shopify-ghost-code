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
 *   3–8. optional audit steps    — each checks for an optional scope, fetches
 *                                  data, runs a detector, and persists findings.
 *                                  Uses runAuditStep() to avoid boilerplate.
 *
 * Error handling: any unhandled step error will trigger Inngest's automatic
 * retry. The outer try/catch marks the scan FAILED only on non-retryable
 * terminal errors (e.g. shop not found).
 */

import { FindingType } from "@prisma/client";

import type { CreateFindingInput } from "../../app/models/finding.server";
import { completeScanWithFindings } from "../../app/models/finding.server";
import { updateScanStatus } from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
import { fetchThemeFiles } from "../../app/services/theme-fetcher.server";
import type { AdminApiContext } from "../../app/types/shopify";
import { inngest } from "../client";

// ---------------------------------------------------------------------------
// Audit step helper — eliminates boilerplate across steps 3–8
// ---------------------------------------------------------------------------

/**
 * Generic audit step: check scope → fetch data → detect findings → persist.
 *
 * Handles the common pattern shared by all optional API-based detectors:
 *   1. Look up shop + admin context
 *   2. Check if the required scope is granted
 *   3. Fetch data via GraphQL
 *   4. Run the detector function
 *   5. Persist findings with idempotency guard (deleteMany before create)
 *   6. Recount total findings to keep the scan record accurate
 *
 * @returns Number of findings created (0 if scope not available or no findings).
 */
async function runAuditStep(opts: {
  scanId: string;
  shopId: string;
  stepName: string;
  findingType: FindingType;
  checkScope: (admin: AdminApiContext) => Promise<boolean>;
  fetchAndDetect: (admin: AdminApiContext) => Promise<CreateFindingInput[]>;
}): Promise<number> {
  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  if (!shop) return 0;

  const { unauthenticated } = await import("../../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);

  const hasScope = await opts.checkScope(admin);
  if (!hasScope) {
    console.log(`[scan-theme] scope not available — skipping ${opts.stepName}`);
    return 0;
  }

  const findings = await opts.fetchAndDetect(admin);

  if (findings.length > 0) {
    // Idempotency guard: delete any previous findings of this type before
    // inserting, so Inngest retries don't create duplicates.
    await db.finding.deleteMany({
      where: { scanId: opts.scanId, findingType: opts.findingType },
    });
    const { createFindings } = await import("../../app/models/finding.server");
    await createFindings(opts.scanId, findings);

    // Recount all findings to be accurate (avoids drift from retries)
    const totalCount = await db.finding.count({ where: { scanId: opts.scanId } });
    await db.scan.update({
      where: { id: opts.scanId },
      data: { findingCount: totalCount },
    });

    console.log("[scan-theme]", {
      event: `${opts.stepName}_findings`,
      shopId: opts.shopId,
      count: findings.length,
    });
  }

  return findings.length;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

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
      // Slightly different from generic audit steps because it has extra logic
      // (empty-translations check, installed-app list pass-through).
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

        // No installed-app data available (Permission Audit removed — appInstallations
        // query is restricted to Shopify-internal apps). Pass empty array so translation
        // detector treats all translations as potentially orphaned.
        const installedAppNames: string[] = [];

        const { detectOrphanedTranslations } =
          await import("../../app/services/translation-detector.server");
        const translationFindings = detectOrphanedTranslations(audit, installedAppNames);

        if (translationFindings.length > 0) {
          await db.finding.deleteMany({
            where: { scanId, findingType: "GHOST_TRANSLATION" },
          });

          const { createFindings } = await import("../../app/models/finding.server");
          await createFindings(scanId, translationFindings);

          const totalCount = await db.finding.count({ where: { scanId } });
          await db.scan.update({
            where: { id: scanId },
            data: { findingCount: totalCount },
          });

          console.log("[scan-theme]", {
            event: "translation_findings",
            shopId,
            count: translationFindings.length,
          });
        }

        return translationFindings.length;
      });

      // Steps 4–8: Optional API-based audit steps (use runAuditStep helper)

      const tagFindingCount = await step.run("product-tag-audit", () =>
        runAuditStep({
          scanId,
          shopId,
          stepName: "product-tag-audit",
          findingType: FindingType.GHOST_TAG,
          checkScope: async (admin) => {
            const { hasProductScope } = await import("../../app/services/product-fetcher.server");
            return hasProductScope(admin);
          },
          fetchAndDetect: async (admin) => {
            const { fetchProductTags } = await import("../../app/services/product-fetcher.server");
            const products = await fetchProductTags(admin);
            const { detectOrphanedProductTags } =
              await import("../../app/services/product-tag-detector.server");
            return detectOrphanedProductTags(products);
          },
        }),
      );

      const priceFindingCount = await step.run("price-audit", () =>
        runAuditStep({
          scanId,
          shopId,
          stepName: "price-audit",
          findingType: FindingType.GHOST_PRICE,
          checkScope: async (admin) => {
            const { hasProductScope } = await import("../../app/services/product-fetcher.server");
            return hasProductScope(admin);
          },
          fetchAndDetect: async (admin) => {
            const { fetchProductPrices } =
              await import("../../app/services/product-fetcher.server");
            const products = await fetchProductPrices(admin);
            const { detectPersistentDiscounts } =
              await import("../../app/services/price-detector.server");
            return detectPersistentDiscounts(products);
          },
        }),
      );

      const pageFindingCount = await step.run("page-audit", () =>
        runAuditStep({
          scanId,
          shopId,
          stepName: "page-audit",
          findingType: FindingType.GHOST_PAGE,
          checkScope: async (admin) => {
            const { hasContentScope } = await import("../../app/services/content-fetcher.server");
            return hasContentScope(admin);
          },
          fetchAndDetect: async (admin) => {
            const { fetchPages } = await import("../../app/services/content-fetcher.server");
            const pages = await fetchPages(admin);
            const { detectOrphanedPages } = await import("../../app/services/page-detector.server");
            return detectOrphanedPages(pages);
          },
        }),
      );

      const metafieldFindingCount = await step.run("metafield-audit", () =>
        runAuditStep({
          scanId,
          shopId,
          stepName: "metafield-audit",
          findingType: FindingType.GHOST_METAFIELD,
          checkScope: async (admin) => {
            const { hasProductScope } = await import("../../app/services/product-fetcher.server");
            return hasProductScope(admin);
          },
          fetchAndDetect: async (admin) => {
            const { fetchProductMetafields } =
              await import("../../app/services/product-fetcher.server");
            const products = await fetchProductMetafields(admin);
            const { detectOrphanedMetafields } =
              await import("../../app/services/metafield-detector.server");
            return detectOrphanedMetafields(products);
          },
        }),
      );

      const redirectFindingCount = await step.run("redirect-audit", () =>
        runAuditStep({
          scanId,
          shopId,
          stepName: "redirect-audit",
          findingType: FindingType.GHOST_REDIRECT,
          checkScope: async (admin) => {
            const { hasNavigationScope } =
              await import("../../app/services/redirect-fetcher.server");
            return hasNavigationScope(admin);
          },
          fetchAndDetect: async (admin) => {
            const { fetchRedirects } = await import("../../app/services/redirect-fetcher.server");
            const redirects = await fetchRedirects(admin);
            const { detectOrphanedRedirects } =
              await import("../../app/services/redirect-detector.server");
            return detectOrphanedRedirects(redirects);
          },
        }),
      );

      const totalFindings =
        findingCount +
        translationFindingCount +
        tagFindingCount +
        priceFindingCount +
        pageFindingCount +
        metafieldFindingCount +
        redirectFindingCount;

      console.log("[scan-theme]", {
        event: "completed",
        scanId,
        shopId,
        findingCount: totalFindings,
        translationFindings: translationFindingCount,
        tagFindings: tagFindingCount,
        priceFindings: priceFindingCount,
        pageFindings: pageFindingCount,
        metafieldFindings: metafieldFindingCount,
        redirectFindings: redirectFindingCount,
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
