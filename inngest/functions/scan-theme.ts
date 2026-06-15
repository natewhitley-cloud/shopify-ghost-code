/**
 * Inngest function: scan-theme
 *
 * Core async scan workflow. Triggered by the `scan/requested` event when a
 * merchant initiates a new scan from the dashboard.
 *
 * Step breakdown:
 *   1. update-status-in-progress — marks the scan as started
 *   2. fetch-and-scan            — pulls theme files via Shopify Admin API,
 *                                  runs the detection engine, and persists
 *                                  findings. Combined into one step to avoid
 *                                  exceeding Inngest's 4MB step output size limit
 *                                  (theme file contents are large and don't need
 *                                  to be serialized between steps). This step
 *                                  leaves the scan IN_PROGRESS on purpose.
 *   3–8. optional audit steps    — each checks for an optional scope, fetches
 *                                  data, runs a detector, and persists findings.
 *                                  Uses runAuditStep() to avoid boilerplate. Each
 *                                  reports whether it was skipped for missing
 *                                  scope.
 *   9. finalize-scan             — sets the terminal status: PARTIAL if any
 *                                  optional category was skipped for missing
 *                                  scope, otherwise COMPLETED. This is the ONLY
 *                                  place the scan leaves IN_PROGRESS on success.
 *
 * Why completion is decoupled from persistence (LOG-4): if the scan were marked
 * COMPLETED inside step 2, a failure in steps 3–8 could not mark it FAILED (the
 * catch guard would see COMPLETED), and the diff baseline could treat a
 * partially-audited scan as a full one — falsely reporting un-audited categories
 * as "resolved".
 *
 * Error handling: any unhandled step error triggers Inngest's automatic retry.
 * The outer try/catch marks the scan FAILED unless it already reached a
 * successful terminal status (COMPLETED/PARTIAL) on an earlier attempt.
 */

import { FindingType, ScanStatus } from "@prisma/client";

import { logger } from "../../app/lib/logger.server";
import type { CreateFindingInput } from "../../app/models/finding.server";
import { saveThemeFindings } from "../../app/models/finding.server";
import {
  finalizeScan,
  getPreviousScanForTheme,
  updateScanStatus,
} from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
import { fetchThemeFiles } from "../../app/services/theme-fetcher.server";
import type { AdminApiContext } from "../../app/types/shopify";
import { inngest } from "../client";

// ---------------------------------------------------------------------------
// Audit step helper — eliminates boilerplate across steps 3–8
// ---------------------------------------------------------------------------

/**
 * Result of an optional audit step.
 *
 * `skipped` is true ONLY when the audit was skipped because its required scope
 * was not granted (a genuine ACCESS_DENIED). It drives both the PARTIAL status
 * decision and the diff engine's exclusion of un-audited categories (LOG-4). An
 * audit that ran but found nothing (or had no data to check) is NOT skipped.
 */
type AuditStepResult = { findingCount: number; skipped: boolean };

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
 * @returns `{ findingCount, skipped }`. `skipped` is true only when the scope
 *   was not granted (ACCESS_DENIED); transient scope errors propagate so the
 *   Inngest step retries (never silently skipped).
 */
async function runAuditStep(opts: {
  scanId: string;
  shopId: string;
  stepName: string;
  findingType: FindingType;
  checkScope: (admin: AdminApiContext) => Promise<boolean>;
  fetchAndDetect: (admin: AdminApiContext) => Promise<CreateFindingInput[]>;
}): Promise<AuditStepResult> {
  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  // No shop record: treat as no-op, not a scope skip (do not mark PARTIAL).
  if (!shop) return { findingCount: 0, skipped: false };

  const { unauthenticated } = await import("../../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);

  const hasScope = await opts.checkScope(admin);
  if (!hasScope) {
    const { logger } = await import("../../app/lib/logger.server");
    logger.info("scope not available — skipping audit step", {
      function: "scan-theme",
      stepName: opts.stepName,
      shopId: opts.shopId,
    });
    return { findingCount: 0, skipped: true };
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

    const { logger } = await import("../../app/lib/logger.server");
    logger.info("audit step findings persisted", {
      function: "scan-theme",
      event: `${opts.stepName}_findings`,
      shopId: opts.shopId,
      count: findings.length,
    });
  }

  return { findingCount: findings.length, skipped: false };
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
      const { findingCount, fileCount } = await step.run("fetch-and-scan", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) {
          throw new Error(`Shop ${shopId} not found — cannot fetch theme files`);
        }

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        const files = await fetchThemeFiles(admin, themeId, shop.domain);
        const { logger } = await import("../../app/lib/logger.server");
        logger.info("theme files fetched", {
          function: "scan-theme",
          event: "files_fetched",
          shopId,
          fileCount: files.length,
        });

        const { findings, unknownScripts } = scanThemeFiles(files);
        logger.info("theme scan complete", {
          function: "scan-theme",
          event: "scan_complete",
          shopId,
          findingCount: findings.length,
          unknownScriptCount: unknownScripts.length,
        });

        // Persist the theme findings in a single $transaction (idempotency
        // guard inside) but DELIBERATELY leave the scan IN_PROGRESS. The
        // terminal status is set only in the finalize step after every audit
        // has run, so a late audit failure can still mark the scan FAILED
        // (LOG-4).
        await saveThemeFindings(scanId, findings);

        // Persist unknown scripts separately (not part of the transaction —
        // these are informational and don't affect scan correctness).
        await createUnknownScripts(scanId, unknownScripts);

        // Return only the counts — not the full findings array (Inngest's 4MB
        // step-output limit). fileCount drives the zero-file sanity guard below.
        return { findingCount: findings.length, fileCount: files.length };
      });

      // Step 3: Translation audit (optional — requires read_translations scope)
      // Slightly different from generic audit steps because it has extra logic
      // (empty-translations check). When scope is genuinely missing it reports
      // skipped:true so the scan finalizes PARTIAL.
      const translationResult: AuditStepResult = await step.run("translation-audit", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) return { findingCount: 0, skipped: false };

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);

        const { hasTranslationScope, auditTranslations } =
          await import("../../app/services/translation-fetcher.server");

        const { logger } = await import("../../app/lib/logger.server");

        const hasScope = await hasTranslationScope(admin);
        if (!hasScope) {
          logger.info("read_translations scope not available — skipping translation audit", {
            function: "scan-theme",
            stepName: "translation-audit",
            shopId,
          });
          // Scope not granted → this category was NOT audited (drives PARTIAL).
          return { findingCount: 0, skipped: true };
        }

        const audit = await auditTranslations(admin);
        if (audit.totalTranslations === 0) {
          logger.info("no translations found — skipping translation detection", {
            function: "scan-theme",
            stepName: "translation-audit",
            shopId,
          });
          // The category WAS audited (we had scope) — there was simply nothing
          // to check. Not a scope skip.
          return { findingCount: 0, skipped: false };
        }

        // There is no reliable signal that translation content is genuinely
        // orphaned (no provenance on the Translation object, app-installation
        // data is restricted), so the detector surfaces it informationally for
        // the merchant to review rather than pretending to filter by installed
        // apps.
        const { detectTranslationContent } =
          await import("../../app/services/translation-detector.server");
        const translationFindings = detectTranslationContent(audit);

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

          logger.info("translation findings persisted", {
            function: "scan-theme",
            event: "translation_findings",
            shopId,
            count: translationFindings.length,
          });
        }

        return { findingCount: translationFindings.length, skipped: false };
      });

      // Steps 4–8: Optional API-based audit steps (use runAuditStep helper)

      const tagResult = await step.run("product-tag-audit", () =>
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

      const priceResult = await step.run("price-audit", () =>
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

      const pageResult = await step.run("page-audit", () =>
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

      const metafieldResult = await step.run("metafield-audit", () =>
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

      const redirectResult = await step.run("redirect-audit", () =>
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
        translationResult.findingCount +
        tagResult.findingCount +
        priceResult.findingCount +
        pageResult.findingCount +
        metafieldResult.findingCount +
        redirectResult.findingCount;

      // Collect the optional categories that were skipped because their scope
      // was not granted. Each entry maps 1:1 to a FindingType so the differ can
      // exclude that category's prior findings from "resolved" (LOG-4). The
      // list is the basis for the PARTIAL-vs-COMPLETED decision below.
      const skippedCategories: string[] = [
        [translationResult.skipped, FindingType.GHOST_TRANSLATION],
        [tagResult.skipped, FindingType.GHOST_TAG],
        [priceResult.skipped, FindingType.GHOST_PRICE],
        [pageResult.skipped, FindingType.GHOST_PAGE],
        [metafieldResult.skipped, FindingType.GHOST_METAFIELD],
        [redirectResult.skipped, FindingType.GHOST_REDIRECT],
      ]
        .filter(([skipped]) => skipped)
        .map(([, category]) => category as string);

      // Zero-file sanity guard (LOG-5): a theme fetch that returns ZERO files is
      // suspicious for any real theme. If the most recent prior successful scan
      // for this shop+theme had findings, an empty fetch is almost certainly a
      // transient API soft-failure or a theme that vanished mid-pipeline — NOT a
      // genuinely clean theme. Completing the scan here would delete the prior
      // findings and the scan-detail diff would falsely report them all as
      // "resolved". Throw instead so the scan is marked FAILED (and Inngest
      // retries the transient case first). This is a defensive backstop beyond
      // the null-themeData throw in fetchThemeFiles. A legitimately empty theme
      // with no prior findings still completes normally.
      if (fileCount === 0) {
        await step.run("zero-file-sanity-guard", async () => {
          const db = (await import("../../app/db.server")).default;
          const currentScan = await db.scan.findUnique({
            where: { id: scanId },
            select: { createdAt: true },
          });
          const priorScan = currentScan
            ? await getPreviousScanForTheme(shopId, themeId, currentScan.createdAt)
            : null;
          if (priorScan && priorScan.findingCount > 0) {
            throw new Error(
              `Refusing to complete scan ${scanId} as clean: fetched 0 theme files for ` +
                `theme ${themeId}, but the prior successful scan had ${priorScan.findingCount} ` +
                `finding(s). Treating the empty fetch as a transient failure to avoid wiping prior findings.`,
            );
          }
        });
      }

      // PARTIAL when one or more optional categories were skipped for missing
      // scope; COMPLETED when every category was audited (a full audit).
      const finalStatus = skippedCategories.length > 0 ? ScanStatus.PARTIAL : ScanStatus.COMPLETED;

      // FINAL step: set the terminal status. This is the ONLY place the scan
      // leaves IN_PROGRESS on the success path (LOG-4). Idempotent on retry.
      await step.run("finalize-scan", async () => {
        await finalizeScan(scanId, {
          status: finalStatus,
          findingCount: totalFindings,
          skippedCategories,
        });
      });

      logger.info("scan completed", {
        function: "scan-theme",
        event: "completed",
        scanId,
        shopId,
        status: finalStatus,
        findingCount: totalFindings,
        skippedCategories,
        translationFindings: translationResult.findingCount,
        tagFindings: tagResult.findingCount,
        priceFindings: priceResult.findingCount,
        pageFindings: pageResult.findingCount,
        metafieldFindings: metafieldResult.findingCount,
        redirectFindings: redirectResult.findingCount,
      });

      return {
        scanId,
        findingCount: totalFindings,
        status: finalStatus,
      };
    } catch (err) {
      // Mark the scan FAILED so the UI can surface an actionable error state
      // rather than leaving the scan stuck in IN_PROGRESS indefinitely.
      // Guard: if the scan already reached a successful terminal status (a late
      // Inngest retry that re-ran past the persisted COMPLETED/PARTIAL state),
      // do not overwrite it with FAILED.
      // Re-throw so Inngest still sees the error and logs it correctly.
      try {
        const db = (await import("../../app/db.server")).default;
        const currentScan = await db.scan.findUnique({
          where: { id: scanId },
          select: { status: true },
        });
        const alreadySucceeded =
          currentScan?.status === ScanStatus.COMPLETED ||
          currentScan?.status === ScanStatus.PARTIAL;
        if (currentScan && !alreadySucceeded) {
          await updateScanStatus(scanId, "FAILED").catch(() => {
            // Best-effort — if the status update itself fails we still want to
            // propagate the original error.
          });
        }
      } catch {
        // If DB access fails in the error handler, still propagate the original error.
      }
      throw err;
    }
  },
);
