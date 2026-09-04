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
 *   9. finalize-scan             — sets the terminal status to COMPLETED. The
 *                                  core theme audit ran, so success is COMPLETED
 *                                  even when optional categories were skipped for
 *                                  missing scope; `skippedCategories` still
 *                                  records which ones were skipped (for the diff
 *                                  engine and a future "enable more checks"
 *                                  nudge). This is the ONLY place the scan leaves
 *                                  IN_PROGRESS on success.
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
import { MAX_SCANNABLE_FILE_BYTES } from "../../app/services/scan-engine.server";
import { scanThemeFilesInPool } from "../../app/services/scan-pool.server";
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
 * was not granted (a genuine ACCESS_DENIED). It drives which categories land in
 * `skippedCategories`, which powers the diff engine's exclusion of un-audited
 * categories (LOG-4) and a future "enable more checks" nudge. An
 * audit that ran but found nothing (or had no data to check) is NOT skipped.
 */
type AuditStepResult = { findingCount: number; skipped: boolean };

/**
 * Persist a batch of audit findings with the delete-then-create idempotency
 * guard, then recount the scan total and log the result.
 *
 * Shared by `runAuditStep` (the generic optional audits) and the bespoke
 * translation-audit step, which both end with the identical persist/recount/log
 * tail. Only the `findingType`, `event`, and `logMessage` vary by call site, so
 * those are parameters — everything else is byte-for-byte identical.
 *
 * No-ops when `findings` is empty: an audit that found nothing must leave the
 * scan record (and its findingCount) untouched.
 */
async function persistAuditFindings(opts: {
  scanId: string;
  shopId: string;
  findingType: FindingType;
  findings: CreateFindingInput[];
  event: string;
  logMessage: string;
}): Promise<void> {
  if (opts.findings.length === 0) return;

  const db = (await import("../../app/db.server")).default;

  // Idempotency guard: delete any previous findings of this type before
  // inserting, so Inngest retries don't create duplicates. Each audit owns its
  // FindingType exclusively, so deleting by type never clobbers another
  // producer's rows.
  await db.finding.deleteMany({
    where: {
      scanId: opts.scanId,
      findingType: opts.findingType,
    },
  });
  const { createFindings } = await import("../../app/models/finding.server");
  await createFindings(opts.scanId, opts.findings);

  // Recount all findings to be accurate (avoids drift from retries)
  const totalCount = await db.finding.count({ where: { scanId: opts.scanId } });
  await db.scan.update({
    where: { id: opts.scanId },
    data: { findingCount: totalCount },
  });

  const { logger } = await import("../../app/lib/logger.server");
  logger.info(opts.logMessage, {
    function: "scan-theme",
    event: opts.event,
    shopId: opts.shopId,
    count: opts.findings.length,
  });
}

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

  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: opts.findingType,
    findings,
    event: `${opts.stepName}_findings`,
    logMessage: "audit step findings persisted",
  });

  return { findingCount: findings.length, skipped: false };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export const scanTheme = inngest.createFunction(
  {
    id: "scan-theme",
    name: "Scan Theme for Ghost Code",
    // Bound the number of concurrent scans BELOW the shared Inngest pool size.
    // The Inngest Hobby plan grants only 5 concurrent steps ACCOUNT-WIDE, and that
    // single pool is SHARED across all three sibling apps (Ghost Code + ClearSignal
    // + TaxDelta). This is a heavy ~11-step fan-out function; capping it at 3 (below
    // the pool of 5) reserves headroom so cron heartbeats can't be starved by a scan
    // burst here or in a sibling app — starvation would trip the deep-health
    // dead-man's-switch alert. Mirrors poll-check-shop's limit. The complementary
    // event-loop offload (moving scan work off the main thread) is tracked separately
    // in GC-8uw / PRF-1b.
    concurrency: { limit: 3 },
  },
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
      const { findingCount, fileCount, skippedFilePaths, staticProductCandidates } = await step.run(
        "fetch-and-scan",
        async () => {
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

          const { findings, unknownScripts, skippedFiles, staticProductCandidates } =
            await scanThemeFilesInPool(files);

          // Surface any files skipped for exceeding the per-file size cap so the
          // drop is never silent (gc-06e.2). Real theme Liquid files are far under
          // the cap; a skip here is anomalous and worth an ops signal.
          if (skippedFiles && skippedFiles.length > 0) {
            logger.warn("theme scan skipped oversized files", {
              function: "scan-theme",
              event: "files_skipped_oversized",
              shopId,
              cap: MAX_SCANNABLE_FILE_BYTES,
              skippedFiles,
            });
          }

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

          // Return only the counts and the (tiny) list of skipped file paths — not
          // the full findings array (Inngest's 4MB step-output limit). fileCount
          // drives the zero-file sanity guard below; skippedFilePaths is persisted
          // on the scan so the differ can exclude unscanned oversized files from
          // "resolved" (gc-06e.19). A skip is anomalous, so this list is normally
          // empty and at most a handful of paths.
          return {
            findingCount: findings.length,
            fileCount: files.length,
            skippedFilePaths: (skippedFiles ?? []).map((f) => f.filename),
            // Tiny (a handful per theme), so it safely crosses the step boundary
            // unlike the full findings array. Threaded into the live-price audit
            // step below (gc-47c.10).
            staticProductCandidates: staticProductCandidates ?? [],
          };
        },
      );

      // Step 3: Translation audit (optional — requires read_translations scope)
      // Slightly different from generic audit steps because it has extra logic
      // (empty-translations check). When scope is genuinely missing it reports
      // skipped:true so the category is recorded in skippedCategories.
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
          // Scope not granted → this category was NOT audited (recorded in skippedCategories).
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

        await persistAuditFindings({
          scanId,
          shopId,
          findingType: FindingType.GHOST_TRANSLATION,
          findings: translationFindings,
          event: "translation_findings",
          logMessage: "translation findings persisted",
        });

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

      // Step 9: Live-price audit for stale static JSON-LD (optional — requires
      // read_products scope AND the JSONLD_LIVE_PRICE_ENABLED flag). Modeled on
      // translation-audit: it has extra pre-conditions (flag + candidate list),
      // so it does not use runAuditStep.
      //
      // Double-inert soft-launch (gc-47c.10): when the flag is OFF the step is
      // fully inert and returns skipped:false (NOT a scope skip — the category is
      // not "un-audited due to missing scope", it is deliberately disabled). Only
      // once the flag is ON does a genuinely missing read_products scope report
      // skipped:true → skippedCategories.
      const jsonLdPriceResult: AuditStepResult = await step.run("product-price-audit", async () => {
        const { logger } = await import("../../app/lib/logger.server");

        if (process.env.JSONLD_LIVE_PRICE_ENABLED !== "true") {
          // Flag off: inert. Not a scope skip.
          return { findingCount: 0, skipped: false };
        }

        // Nothing to correlate — the theme had no unsigned static Product
        // JSON-LD. Audited (nothing to check), not a scope skip.
        if (staticProductCandidates.length === 0) {
          return { findingCount: 0, skipped: false };
        }

        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) return { findingCount: 0, skipped: false };

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);

        const { hasProductScope } = await import("../../app/services/product-fetcher.server");
        const hasScope = await hasProductScope(admin);
        if (!hasScope) {
          logger.info("read_products scope not available — skipping live-price audit", {
            function: "scan-theme",
            stepName: "product-price-audit",
            shopId,
          });
          // Scope not granted → category NOT audited (recorded in skippedCategories).
          return { findingCount: 0, skipped: true };
        }

        const { auditStaticJsonLdPrices } =
          await import("../../app/services/jsonld-price-audit.server");
        const { findings: priceFindings, skipped } = await auditStaticJsonLdPrices(
          admin,
          staticProductCandidates,
          shopId,
        );

        await persistAuditFindings({
          scanId,
          shopId,
          findingType: FindingType.JSON_LD_PRICE_CONFLICT,
          findings: priceFindings,
          event: "jsonld_price_findings",
          logMessage: "live-price JSON-LD findings persisted",
        });

        // `skipped` is true when the audit could not fully cover the candidates
        // (lookup-budget truncation or read_products revoked mid-scan), so the
        // category is recorded in skippedCategories and the differ does not
        // false-resolve the prior findings we could not re-check.
        return { findingCount: priceFindings.length, skipped };
      });

      const totalFindings =
        findingCount +
        translationResult.findingCount +
        tagResult.findingCount +
        priceResult.findingCount +
        pageResult.findingCount +
        metafieldResult.findingCount +
        redirectResult.findingCount +
        jsonLdPriceResult.findingCount;

      // Collect the optional categories that were skipped because their scope
      // was not granted. Each entry maps 1:1 to a FindingType so the differ can
      // exclude that category's prior findings from "resolved" (LOG-4). The scan
      // still finalizes COMPLETED (below); this list also seeds a future
      // "enable more checks" nudge.
      // NOTE (gc-47c.10): the live-price audit emits JSON_LD_PRICE_CONFLICT, a
      // type EXCLUSIVE to it (the worker's same-file conflict detector uses the
      // separate JSON_LD_CONFLICT type). So listing JSON_LD_PRICE_CONFLICT here
      // when the audit is skipped (scope not granted, lookup-budget truncation,
      // or mid-scan revocation) excludes exactly this audit's prior findings from
      // resolved-detection (LOG-4) without touching the worker's rows.
      const skippedCategories: string[] = [
        [translationResult.skipped, FindingType.GHOST_TRANSLATION],
        [tagResult.skipped, FindingType.GHOST_TAG],
        [priceResult.skipped, FindingType.GHOST_PRICE],
        [pageResult.skipped, FindingType.GHOST_PAGE],
        [metafieldResult.skipped, FindingType.GHOST_METAFIELD],
        [redirectResult.skipped, FindingType.GHOST_REDIRECT],
        [jsonLdPriceResult.skipped, FindingType.JSON_LD_PRICE_CONFLICT],
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

      // Always COMPLETED on the success path: the core theme audit ran, so the
      // scan succeeded even if optional categories were skipped for missing
      // scope. `skippedCategories` (built above) still records which optional
      // categories were skipped, for (a) the diff engine (LOG-4) and (b) a
      // future "enable more checks" nudge.
      const finalStatus = ScanStatus.COMPLETED;

      // FINAL step: set the terminal status. This is the ONLY place the scan
      // leaves IN_PROGRESS on the success path (LOG-4). Idempotent on retry.
      await step.run("finalize-scan", async () => {
        await finalizeScan(scanId, {
          status: finalStatus,
          findingCount: totalFindings,
          skippedCategories,
          skippedFiles: skippedFilePaths,
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
        skippedFiles: skippedFilePaths,
        translationFindings: translationResult.findingCount,
        tagFindings: tagResult.findingCount,
        priceFindings: priceResult.findingCount,
        pageFindings: pageResult.findingCount,
        metafieldFindings: metafieldResult.findingCount,
        redirectFindings: redirectResult.findingCount,
        jsonLdPriceFindings: jsonLdPriceResult.findingCount,
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
