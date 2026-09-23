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
import { NonRetriableError } from "inngest";

import { logger } from "../../app/lib/logger.server";
import {
  CORE_STEP_OUTPUT_BUDGET_BYTES,
  DANGLING_MAX_OCCURRENCES_PER_HANDLE,
  JSONLD_PRICE_CANDIDATE_CAP,
  MAX_FINDINGS_PER_FILE_PER_TYPE,
  PRODUCT_AUDIT_CAP,
} from "../../app/lib/scan-limits";
import type { CreateFindingInput } from "../../app/models/finding.server";
import { saveThemeFindings } from "../../app/models/finding.server";
import { createScanDomains } from "../../app/models/scan-domain.server";
import {
  finalizeScan,
  getPreviousScanForTheme,
  updateScanStatus,
} from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import {
  CHECKOUT_LIQUID_PATH,
  detectCheckoutSunset,
} from "../../app/services/checkout-sunset-detector.server";
import {
  compareByFileThenLine,
  extractDanglingReferences,
} from "../../app/services/dangling-reference-extractor.server";
import { isScannableFile, MAX_SCANNABLE_FILE_BYTES } from "../../app/services/scan-engine.server";
import { scanThemeFilesInPool } from "../../app/services/scan-pool.server";
import { fetchThemeFiles, ThemeTooLargeError } from "../../app/services/theme-fetcher.server";
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
type AuditStepResult = {
  findingCount: number;
  skipped: boolean;
  /**
   * True when the audit's paginated walk hit its cap and left records
   * un-scanned (gc-1bd). Strictly distinct from `skipped`: truncation is
   * TELEMETRY ONLY (Option C) — it drives the `truncatedWalks` metadata and a
   * logger.warn, but it does NOT enter `skippedCategories`. Only a genuinely
   * absent scope marks a category skipped. Absent for audits with no bounded walk.
   */
  truncated?: boolean;
  /** GraphQL page requests the walk made (walk observability, gc-1bd). */
  pageCount?: number;
  /** Accumulated proactive rate-limit backoff for this walk, ms (gc-1bd). */
  throttleSleepMs?: number;
};

/**
 * What an audit's `fetchAndDetect` returns. `truncated`/`pageCount`/
 * `throttleSleepMs` are optional walk observability (gc-1bd) — an audit whose
 * fetch has no bounded pagination simply returns `{ findings }`.
 */
type AuditFetchResult = {
  findings: CreateFindingInput[];
  truncated?: boolean;
  pageCount?: number;
  throttleSleepMs?: number;
};

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
  fetchAndDetect: (admin: AdminApiContext) => Promise<AuditFetchResult>;
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

  const { findings, truncated, pageCount, throttleSleepMs } = await opts.fetchAndDetect(admin);

  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: opts.findingType,
    findings,
    event: `${opts.stepName}_findings`,
    logMessage: "audit step findings persisted",
  });

  // Scope was present (the scope-absence early return above is the ONLY skip
  // path), so this category was audited: `skipped` is false. A truncated walk is
  // TELEMETRY ONLY (gc-1bd, Option C) — it flows to `truncated`/`truncatedWalks`
  // and the logger.warn, but must NOT enter skippedCategories. Feeding truncation
  // into the diff's coverage-gap filter drops the prior findings for the scanned
  // subset while their still-present current findings persist, so an unchanged
  // finding in a truncated category reported as "new" on every rescan.
  return {
    findingCount: findings.length,
    skipped: false,
    truncated: truncated ?? false,
    pageCount,
    throttleSleepMs,
  };
}

// ---------------------------------------------------------------------------
// Dangling-reference finding presentation (gc-m4h.5)
// ---------------------------------------------------------------------------

/**
 * Storefront URL segment + human label per dangling entity subtype. Used to
 * render the matched literal + verdict in a DANGLING_REFERENCE finding's
 * description, and the subtype tag carried in `appName` (spike §E).
 */
const DANGLING_SUBTYPE_META: Record<string, { segment: string; label: string }> = {
  product: { segment: "products", label: "product" },
  collection: { segment: "collections", label: "collection" },
  page: { segment: "pages", label: "page" },
};

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
      const {
        findingCount,
        fileCount,
        scannableFileCount,
        skippedFilePaths,
        skippedFileCount,
        benignLibrarySkips,
        findingCapHits,
        unknownScriptCount,
        thirdPartyDomainCount,
        staticProductCandidates,
        staticCandidatesCapped,
        danglingOccurrences,
        danglingDistinctHandles,
        danglingCapped,
        danglingTruncated,
        themeFetchMs,
        themeScanMs,
        totalTextBytes,
        largestFileBytes,
        scannableTextBytes,
      } = await step.run("fetch-and-scan", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        if (!shop) {
          throw new Error(`Shop ${shopId} not found — cannot fetch theme files`);
        }

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        // Per-phase timing (gc-1bd): wall-clock the fetch and the scan separately
        // so the scan_signal can attribute duration to network vs CPU.
        const { logger } = await import("../../app/lib/logger.server");
        const themeFetchStart = Date.now();
        let files: Awaited<ReturnType<typeof fetchThemeFiles>>;
        try {
          files = await fetchThemeFiles(admin, themeId, shop.domain);
        } catch (err) {
          // gc-8s2: an over-ceiling theme is deterministic, so a retry would only
          // refetch up to the cap again. Fail the scan once; the outer catch
          // marks it FAILED and prior findings are kept (never a false-clean).
          if (err instanceof ThemeTooLargeError) {
            logger.warn("theme exceeds total text ceiling; scan aborted", {
              function: "scan-theme",
              event: "theme_too_large",
              shopId,
              maxTotalBytes: err.maxTotalBytes,
              bytesAtAbort: err.bytesAtAbort,
            });
            // gc-d4e follow-up: without this row an over-cap theme is invisible
            // to scripts/theme-size-report.ts, which could then never show the
            // cap is too LOW. Reuses the scan_signal type with the SAME key
            // (scanId) and identity field (metadata.shopId) as the success-path
            // emit, so the existing GDPR redact + prune coverage applies — no
            // new OpsEvent type. recordOpsEvent never throws, so the
            // NonRetriableError below is unaffected. Idempotency: this write
            // re-executes only if the step re-runs, and NonRetriableError
            // prevents retries, so it is written at most once per scan in
            // practice; any duplicate is harmless (consumers take one row per
            // scanId, as for the success-path row).
            const { recordOpsEvent, OPS_EVENT_TYPES } =
              await import("../../app/models/ops-event.server");
            await recordOpsEvent({
              eventType: OPS_EVENT_TYPES.SCAN_SIGNAL,
              key: scanId,
              metadata: {
                shopId,
                scanId,
                plan: shop.plan,
                themeId,
                aborted: "theme_too_large",
                bytesAtAbort: err.bytesAtAbort,
                maxTotalBytes: err.maxTotalBytes,
              },
            });
            throw new NonRetriableError(err.message, { cause: err });
          }
          throw err;
        }
        const themeFetchMs = Date.now() - themeFetchStart;
        logger.info("theme files fetched", {
          function: "scan-theme",
          event: "files_fetched",
          shopId,
          fileCount: files.length,
        });

        const themeScanStart = Date.now();
        const {
          findings,
          unknownScripts,
          skippedFiles,
          staticProductCandidates,
          benignLibrarySkips,
          thirdPartyDomains,
          findingCapHits,
        } = await scanThemeFilesInPool(files);
        const themeScanMs = Date.now() - themeScanStart;

        // Checkout-extensibility sunset audit (gc-b3c): PURE, static, no Admin
        // API — it reads only the theme files already in scope here, so it runs
        // inline in this core step rather than as a separate fetch step. Plan-
        // gated to Standard+ (mirrors dangling-reference gating gc-m4h.7): for
        // Free shops the detector is not run, so no CHECKOUT_SUNSET findings are
        // produced. Emits at most one finding (checkout.liquid present + non-
        // trivial); its rows are persisted with the theme findings below, under
        // saveThemeFindings' scan-scoped idempotency guard.
        const { canDetectCheckoutSunset } = await import("../../app/lib/plan-gating.server");
        const runCheckoutSunset = canDetectCheckoutSunset(shop.plan);
        const checkoutSunsetFindings = runCheckoutSunset ? detectCheckoutSunset(files) : [];
        const themeFindings = [...findings, ...checkoutSunsetFindings];

        // The detector runs here on the main thread, not in the scan worker, so
        // it does not analyze a checkout.liquid over the per-file cap (gc-4yg);
        // it only emits the presence finding. Surface that reduced coverage.
        const checkoutLiquid = files.find((f) => f.filename === CHECKOUT_LIQUID_PATH);
        if (
          runCheckoutSunset &&
          checkoutLiquid &&
          checkoutLiquid.content.length > MAX_SCANNABLE_FILE_BYTES
        ) {
          logger.warn("checkout sunset analysis skipped for oversized checkout.liquid", {
            function: "scan-theme",
            event: "checkout_sunset_oversized",
            shopId,
            size: checkoutLiquid.content.length,
            cap: MAX_SCANNABLE_FILE_BYTES,
          });
        }

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

        // Surface files whose findings of a type hit the per-file cap (gc-ypk) so
        // the truncation is never silent. Real themes never hit it (prod max is
        // ~26 findings per scan), so a hit means a pathological file. Telemetry
        // only: the cap is deterministic (first N by line), so the differ still
        // diffs the kept findings normally; it is NOT a skipped category.
        if (findingCapHits && Object.keys(findingCapHits).length > 0) {
          logger.warn("theme scan capped findings per file", {
            function: "scan-theme",
            event: "findings_capped_per_file",
            shopId,
            cap: MAX_FINDINGS_PER_FILE_PER_TYPE,
            findingCapHits,
          });
        }

        // Surface benign public-CDN libraries / web fonts dropped by the
        // collectors so the suppression is observable, never silent (gc-tus A2).
        // Info-level: unlike an oversized-file skip this is expected/benign.
        if (benignLibrarySkips && benignLibrarySkips > 0) {
          logger.info("theme scan suppressed benign libraries", {
            function: "scan-theme",
            event: "benign_libraries_suppressed",
            shopId,
            benignLibrarySkips,
          });
        }

        logger.info("theme scan complete", {
          function: "scan-theme",
          event: "scan_complete",
          shopId,
          findingCount: themeFindings.length,
          unknownScriptCount: unknownScripts.length,
        });

        // Persist the theme findings in a single $transaction (idempotency
        // guard inside) but DELIBERATELY leave the scan IN_PROGRESS. The
        // terminal status is set only in the finalize step after every audit
        // has run, so a late audit failure can still mark the scan FAILED
        // (LOG-4).
        await saveThemeFindings(scanId, themeFindings);

        // Persist unknown scripts separately (not part of the transaction —
        // these are informational and don't affect scan correctness).
        await createUnknownScripts(scanId, unknownScripts);

        // Persist the third-party domain graph (Feature 1). Informational /
        // non-blocking like unknown scripts — a failure must not affect scan
        // correctness. Delete-then-insert idempotency lives inside the model.
        await createScanDomains(scanId, thirdPartyDomains ?? []);

        // Extract DANGLING_REFERENCE candidates (pure, static) here while the
        // theme files are in scope. Only the handle/occurrence arrays (handles +
        // file/line + snippet — NOT raw file content) cross the step boundary;
        // existence is resolved via the Admin API in the dangling-reference-audit
        // step below (gc-m4h.5). The extractor caps both arrays (gc-4ce): a file
        // dense with references otherwise produced tens of MB of step output.
        const dangling = extractDanglingReferences(files);

        // Cap static JSON-LD candidates for the live-price audit (gc-4ce): each
        // carries a ~300-char snippet and a file packed with tiny JSON-LD blocks
        // can yield thousands. Sorted before truncating so the kept set is
        // deterministic; a cap hit marks the price audit skipped (below).
        const allStaticCandidates = staticProductCandidates ?? [];
        const staticCandidatesCapped = allStaticCandidates.length > JSONLD_PRICE_CANDIDATE_CAP;
        const boundedStaticCandidates = staticCandidatesCapped
          ? [...allStaticCandidates]
              .sort(compareByFileThenLine)
              .slice(0, JSONLD_PRICE_CANDIDATE_CAP)
          : allStaticCandidates;

        // Return only the counts and the (tiny) list of skipped file paths — not
        // the full findings array (Inngest's 4MB step-output limit). fileCount
        // drives the zero-file sanity guard below; skippedFilePaths is persisted
        // on the scan so the differ can exclude unscanned oversized files from
        // "resolved" (gc-06e.19). A skip is anomalous, so this list is normally
        // empty and at most a handful of paths.
        const skippedFilePaths = (skippedFiles ?? []).map((f) => f.filename);

        // Theme-size calibration data (gc-d4e): sum/max of file content length
        // (string length, UTF-16 code units — same unit as MAX_THEME_TOTAL_TEXT_BYTES)
        // computed once from the `files` array already in scope, reusing the same
        // isScannableFile predicate as scannableFileCount above. These are tiny
        // scalars (like fileCount/scannableFileCount), safe across the 4MB step
        // boundary.
        let totalTextBytes = 0;
        let largestFileBytes = 0;
        let scannableTextBytes = 0;
        for (const f of files) {
          const bytes = f.content.length;
          totalTextBytes += bytes;
          if (bytes > largestFileBytes) largestFileBytes = bytes;
          if (isScannableFile(f.filename)) scannableTextBytes += bytes;
        }

        const output = {
          findingCount: themeFindings.length,
          fileCount: files.length,
          // Theme-shape scalars threaded to the finalize step's scan_signal
          // OpsEvent (Feature 2). All tiny — safe across the 4MB step boundary.
          scannableFileCount: files.filter((f) => isScannableFile(f.filename)).length,
          totalTextBytes,
          largestFileBytes,
          scannableTextBytes,
          skippedFilePaths,
          skippedFileCount: skippedFilePaths.length,
          benignLibrarySkips: benignLibrarySkips ?? 0,
          // Per type: files that hit MAX_FINDINGS_PER_FILE_PER_TYPE (gc-ypk). At
          // most one key per finding type — safe across the step boundary.
          findingCapHits: findingCapHits ?? {},
          unknownScriptCount: unknownScripts.length,
          // Scalar count only — the full domain array is NOT returned across the
          // step boundary (already persisted above via createScanDomains).
          thirdPartyDomainCount: (thirdPartyDomains ?? []).length,
          // Normally a handful per theme; capped at JSONLD_PRICE_CANDIDATE_CAP
          // (gc-4ce). Threaded into the live-price audit step below (gc-47c.10).
          staticProductCandidates: boundedStaticCandidates,
          staticCandidatesCapped,
          // Dangling-reference candidates (gc-m4h.5): distinct handles for the
          // resolver + per-occurrence hits (file/line/snippet) for the findings.
          // Capped by the extractor (gc-4ce); `danglingCapped` marks a cap hit.
          danglingOccurrences: dangling.occurrences,
          danglingDistinctHandles: dangling.distinctHandles,
          danglingCapped: dangling.capped === true,
          danglingTruncated: false,
          // Per-phase timing (gc-1bd) — tiny scalars, safe across the boundary.
          themeFetchMs,
          themeScanMs,
        };

        // Defensive step-output budget (gc-4ce). The caps keep the worst case
        // far below Inngest's 4 MB limit, but if the output is still over
        // budget, drop the dangling candidates for this scan rather than fail
        // the whole scan. The dangling audit then reports its category skipped
        // so the differ keeps prior DANGLING_REFERENCE findings.
        const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
        if (outputBytes > CORE_STEP_OUTPUT_BUDGET_BYTES) {
          logger.warn(
            "fetch-and-scan output over step-output budget; dropping dangling candidates",
            {
              function: "scan-theme",
              event: "dangling_output_truncated",
              shopId,
              outputBytes,
              budgetBytes: CORE_STEP_OUTPUT_BUDGET_BYTES,
              danglingOccurrenceCount: dangling.occurrences.length,
            },
          );
          return {
            ...output,
            danglingOccurrences: [],
            danglingDistinctHandles: [],
            danglingTruncated: true,
          };
        }
        return output;
      });

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

      // CONSOLIDATED product audit (gc-1bd). The tag, price, and metafield audits
      // used to be three separate steps that each exchanged a token, probed
      // read_products, and paginated the SAME `products` connection — three full
      // catalog walks by construction, the dominant cost of a scoped scan. This
      // ONE step does a single walk (fetchProductAuditData) and fans it out to
      // the three detectors. It emits GHOST_TAG, GHOST_PRICE, and GHOST_METAFIELD,
      // each persisted with its own delete-then-create idempotency guard so a
      // re-scan never duplicates or orphans findings (per-type, never clobbering
      // another producer). Failure isolation: a SHARED fetch failure legitimately
      // makes all three unavailable (they share the data source) and propagates so
      // Inngest retries; but a single DETECTOR throwing is caught and recorded as a
      // coverage gap for just that category, leaving the other two intact.
      const productsStart = Date.now();
      const productResult = await step.run("product-audit", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        // No shop record: no-op, not a scope skip (mirrors runAuditStep).
        if (!shop) {
          return {
            tagCount: 0,
            priceCount: 0,
            metafieldCount: 0,
            scopeAbsent: false,
            truncated: false,
            tagGap: false,
            priceGap: false,
            metafieldGap: false,
            pageCount: 0,
            throttleSleepMs: 0,
          };
        }

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        const { hasProductScope, fetchProductAuditData } =
          await import("../../app/services/product-fetcher.server");
        const { logger } = await import("../../app/lib/logger.server");

        const hasScope = await hasProductScope(admin);
        if (!hasScope) {
          logger.info("read_products scope not available — skipping product audits", {
            function: "scan-theme",
            stepName: "product-audit",
            shopId,
          });
          // Scope not granted → all THREE product categories un-audited.
          return {
            tagCount: 0,
            priceCount: 0,
            metafieldCount: 0,
            scopeAbsent: true,
            truncated: false,
            tagGap: false,
            priceGap: false,
            metafieldGap: false,
            pageCount: 0,
            throttleSleepMs: 0,
          };
        }

        // ONE catalog walk feeds all three detectors.
        const { tags, prices, metafields, truncated, pageCount, throttleSleepMs } =
          await fetchProductAuditData(admin);

        if (truncated) {
          // Observable cap (gc-1bd): never silently drop the tail of the catalog.
          logger.warn("product-audit walk hit the cap; products beyond it were not scanned", {
            function: "scan-theme",
            stepName: "product-audit",
            shopId,
            cap: PRODUCT_AUDIT_CAP,
            pageCount,
          });
        }

        const { detectOrphanedProductTags } =
          await import("../../app/services/product-tag-detector.server");
        const { detectPersistentDiscounts } =
          await import("../../app/services/price-detector.server");
        const { detectOrphanedMetafields } =
          await import("../../app/services/metafield-detector.server");

        // Per-detector isolation: a throw in one detector must not sink the other
        // two. A throw records that category as a coverage gap (a category we
        // could not verify at all this run — unlike truncation, which still fully
        // audited the scanned subset), so the differ never false-resolves its
        // prior findings from a run we could not fully verify.
        const runDetector = (
          fn: () => CreateFindingInput[],
          label: string,
        ): { findings: CreateFindingInput[]; gap: boolean } => {
          try {
            return { findings: fn(), gap: false };
          } catch (err) {
            logger.warn("product detector threw — recording category as a coverage gap", {
              function: "scan-theme",
              stepName: "product-audit",
              shopId,
              detector: label,
              error: err instanceof Error ? err.message : String(err),
            });
            return { findings: [], gap: true };
          }
        };

        const tagOut = runDetector(() => detectOrphanedProductTags(tags), "GHOST_TAG");
        const priceOut = runDetector(() => detectPersistentDiscounts(prices), "GHOST_PRICE");
        const metafieldOut = runDetector(
          () => detectOrphanedMetafields(metafields),
          "GHOST_METAFIELD",
        );

        // Persist ALL THREE FindingTypes (invariant a). Each delete-then-create is
        // scoped to its own type, so the three never clobber each other and a
        // retry stays idempotent. persistAuditFindings no-ops on an empty batch,
        // exactly as the three legacy steps did.
        await persistAuditFindings({
          scanId,
          shopId,
          findingType: FindingType.GHOST_TAG,
          findings: tagOut.findings,
          event: "product_tag_findings",
          logMessage: "product tag findings persisted",
        });
        await persistAuditFindings({
          scanId,
          shopId,
          findingType: FindingType.GHOST_PRICE,
          findings: priceOut.findings,
          event: "product_price_findings",
          logMessage: "product price findings persisted",
        });
        await persistAuditFindings({
          scanId,
          shopId,
          findingType: FindingType.GHOST_METAFIELD,
          findings: metafieldOut.findings,
          event: "product_metafield_findings",
          logMessage: "product metafield findings persisted",
        });

        return {
          tagCount: tagOut.findings.length,
          priceCount: priceOut.findings.length,
          metafieldCount: metafieldOut.findings.length,
          scopeAbsent: false,
          truncated,
          tagGap: tagOut.gap,
          priceGap: priceOut.gap,
          metafieldGap: metafieldOut.gap,
          pageCount,
          throttleSleepMs,
        };
      });
      const productsMs = Date.now() - productsStart;

      // Per-category skip (gc-1bd): a product category is un-audited (excluded
      // from the differ's resolved-detection) when the scope was absent (applies
      // to all three uniformly), OR that specific detector threw. Truncation is
      // deliberately NOT here (Option C): a cap-truncated walk still fully audited
      // the scanned subset, so its findings must diff normally — treating it as a
      // coverage gap dropped the prior findings for that subset and reported the
      // still-present current ones as "new" every rescan. Truncation is telemetry
      // only (see `truncatedWalks` below + the logger.warn in the walk).
      const tagSkipped = productResult.scopeAbsent || productResult.tagGap;
      const priceSkipped = productResult.scopeAbsent || productResult.priceGap;
      const metafieldSkipped = productResult.scopeAbsent || productResult.metafieldGap;

      const pagesStart = Date.now();
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
            return { findings: detectOrphanedPages(pages) };
          },
        }),
      );
      const pagesMs = Date.now() - pagesStart;

      const redirectsStart = Date.now();
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
            const { REDIRECT_CAP } = await import("../../app/lib/scan-limits");
            const { fetchRedirects } = await import("../../app/services/redirect-fetcher.server");
            // Thread a stats out-param so a cap-truncated redirect walk surfaces in
            // `truncatedWalks` telemetry (gc-1bd). Telemetry ONLY (Option C): the
            // truncation does NOT mark GHOST_REDIRECT skipped — runAuditStep audited
            // the scanned subset, which must diff normally.
            const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
            const redirects = await fetchRedirects(admin, REDIRECT_CAP, stats);
            const { detectOrphanedRedirects } =
              await import("../../app/services/redirect-detector.server");
            return {
              findings: detectOrphanedRedirects(redirects),
              truncated: stats.truncated,
              pageCount: stats.pageCount,
              throttleSleepMs: stats.throttleSleepMs,
            };
          },
        }),
      );
      const redirectsMs = Date.now() - redirectsStart;

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
        const { findings: priceFindings, skipped: auditSkipped } = await auditStaticJsonLdPrices(
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
        // (lookup-budget truncation, read_products revoked mid-scan, or the
        // candidate cap dropped some before the audit, gc-4ce), so the category
        // is recorded in skippedCategories and the differ does not false-resolve
        // the prior findings we could not re-check.
        const skipped = auditSkipped || staticCandidatesCapped;
        return { findingCount: priceFindings.length, skipped };
      });

      // Step 10: Dangling-reference audit (optional — requires a Standard+ plan
      // AND read_products and/or read_content scope AND the
      // DANGLING_REFERENCE_LIVE_ENABLED flag). Modeled on the live-price audit:
      // it has extra pre-conditions (flag + plan + candidate list + per-entity
      // scope gates), so it does not use runAuditStep.
      //
      // Double-inert soft-launch (gc-m4h.5): when the flag is OFF the step is
      // fully inert — it does NOT resolve, persist, or count — and returns
      // skipped:false (flag-off is a deliberate disable, not an un-audited scope
      // skip). Only once the flag is ON does a missing scope / lookup-budget
      // truncation report skipped:true → skippedCategories.
      const danglingRefResult: AuditStepResult = await step.run(
        "dangling-reference-audit",
        async () => {
          if (process.env.DANGLING_REFERENCE_LIVE_ENABLED !== "true") {
            // Flag off: inert. Not a scope skip.
            return { findingCount: 0, skipped: false };
          }

          // No static references in the theme — nothing to resolve. Audited
          // (nothing to check), not a scope skip. (Candidates dropped by the
          // step-output budget are NOT "nothing to check"; handled below.)
          if (danglingDistinctHandles.length === 0 && !danglingTruncated) {
            return { findingCount: 0, skipped: false };
          }

          const db = (await import("../../app/db.server")).default;
          const shop = await db.shop.findUnique({ where: { id: shopId } });
          if (!shop) return { findingCount: 0, skipped: false };

          // Plan gate (gc-m4h.7): dangling-reference detection is Standard+.
          // For Free shops the step is inert exactly like the flag-off path — no
          // resolve, no persist, no count. This is NOT a scope skip: the category
          // is deliberately withheld by plan (like flag-off), not left un-audited
          // for lack of scope, so it must NOT enter skippedCategories (that would
          // misreport an un-run category and suppress the differ's resolved-detection).
          // Checked before any Admin API work so the cheap gate short-circuits first.
          const { canDetectDanglingReferences } = await import("../../app/lib/plan-gating.server");
          if (!canDetectDanglingReferences(shop.plan)) {
            return { findingCount: 0, skipped: false };
          }

          // Candidates were dropped by the step-output budget (gc-4ce): nothing
          // was checked, so the category is un-audited this scan and prior
          // DANGLING_REFERENCE findings must not be false-resolved.
          if (danglingTruncated) {
            return { findingCount: 0, skipped: true };
          }

          const { unauthenticated } = await import("../../app/shopify.server");
          const { admin } = await unauthenticated.admin(shop.domain);

          const { resolveDanglingReferences } =
            await import("../../app/services/dangling-reference-resolver.server");
          const { missing, scopeStatus, truncated } = await resolveDanglingReferences(
            admin,
            danglingDistinctHandles,
            shopId,
          );

          // Map the resolver's distinct `missing` set back to ONE finding per
          // OCCURRENCE (the same handle can be linked from several files/lines,
          // and each broken link is its own finding). Key on (entityType, handle).
          const missingKeys = new Set(missing.map((m) => `${m.entityType} ${m.handle}`));
          // TRUE occurrence count per handle (gc-4ce): the extractor keeps at most
          // DANGLING_MAX_OCCURRENCES_PER_HANDLE occurrences, so the description
          // states the real total rather than the truncated list length.
          const occurrenceCounts = new Map(
            danglingDistinctHandles.map((h) => [`${h.entityType} ${h.handle}`, h.occurrenceCount]),
          );
          const { classifySeverity } =
            await import("../../app/services/severity-classifier.server");
          const danglingFindings: CreateFindingInput[] = danglingOccurrences
            .filter((occ) => missingKeys.has(`${occ.entityType} ${occ.handle}`))
            .map((occ) => {
              const meta = DANGLING_SUBTYPE_META[occ.entityType];
              const total = occurrenceCounts.get(`${occ.entityType} ${occ.handle}`) ?? 0;
              const countNote =
                total > DANGLING_MAX_OCCURRENCES_PER_HANDLE
                  ? ` This ${meta.label} is referenced ${total} times in the theme; the first ${DANGLING_MAX_OCCURRENCES_PER_HANDLE} are listed.`
                  : "";
              return {
                filename: occ.filename,
                lineNumber: occ.lineNumber,
                codeSnippet: occ.snippet,
                findingType: FindingType.DANGLING_REFERENCE,
                severity: classifySeverity(FindingType.DANGLING_REFERENCE, occ.snippet),
                // Structured subtype tag (spike §E): the UI can badge subtype
                // without parsing the description.
                appName: occ.entityType,
                description: `Broken ${meta.label} link: /${meta.segment}/${occ.handle}. This ${meta.label} no longer exists (verified via Admin API).${countNote}`,
              };
            });

          await persistAuditFindings({
            scanId,
            shopId,
            findingType: FindingType.DANGLING_REFERENCE,
            findings: danglingFindings,
            event: "dangling_reference_findings",
            logMessage: "dangling-reference findings persisted",
          });

          // Precise-skip rule (spike §D / R1): mark the category skipped iff a
          // static ref of a type whose scope is absent was present, OR the
          // lookup budget truncated, OR the extractor dropped handles (gc-4ce),
          // OR a MISSING handle had occurrences past the per-handle cap (those
          // got no finding). An EXISTING handle over the per-handle cap loses
          // nothing, so it must not skip: that would drop the category from the
          // diff, re-reporting every finding as new and never resolving fixes.
          const missingOverOccurrenceCap = missing.some(
            (m) =>
              (occurrenceCounts.get(`${m.entityType} ${m.handle}`) ?? 0) >
              DANGLING_MAX_OCCURRENCES_PER_HANDLE,
          );
          const skipped =
            scopeStatus.products === "absent" ||
            scopeStatus.content === "absent" ||
            truncated ||
            danglingCapped ||
            missingOverOccurrenceCap;
          return { findingCount: danglingFindings.length, skipped };
        },
      );

      const totalFindings =
        findingCount +
        translationResult.findingCount +
        productResult.tagCount +
        productResult.priceCount +
        pageResult.findingCount +
        productResult.metafieldCount +
        redirectResult.findingCount +
        jsonLdPriceResult.findingCount +
        danglingRefResult.findingCount;

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
        [tagSkipped, FindingType.GHOST_TAG],
        [priceSkipped, FindingType.GHOST_PRICE],
        [pageResult.skipped, FindingType.GHOST_PAGE],
        [metafieldSkipped, FindingType.GHOST_METAFIELD],
        [redirectResult.skipped, FindingType.GHOST_REDIRECT],
        [jsonLdPriceResult.skipped, FindingType.JSON_LD_PRICE_CONFLICT],
        [danglingRefResult.skipped, FindingType.DANGLING_REFERENCE],
      ]
        .filter(([skipped]) => skipped)
        .map(([, category]) => category as string);

      // Walks that hit their cap this scan (gc-1bd). Surfaced in scan_signal for
      // observability ONLY (Option C): truncation is deliberately NOT reflected in
      // skippedCategories, so the differ still diffs the scanned subset normally.
      const truncatedWalks: string[] = [];
      if (productResult.truncated) truncatedWalks.push("products");
      if (redirectResult.truncated) truncatedWalks.push("redirects");

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

      // FINAL step: compute resolution counts vs the previous scan, then set the
      // terminal status. This is the ONLY place the scan leaves IN_PROGRESS on the
      // success path (LOG-4). Idempotent on retry.
      await step.run("finalize-scan", async () => {
        const db = (await import("../../app/db.server")).default;

        // Diff this scan's persisted findings against the previous completed scan
        // for this theme (Feature 3). REUSE the differ so scope-skipped categories
        // and unscanned oversized files are excluded from "resolved" (LOG-4).
        const currentScan = await db.scan.findUnique({
          where: { id: scanId },
          select: { createdAt: true },
        });
        const currentFindings = await db.finding.findMany({ where: { scanId } });
        const previousScan = currentScan
          ? await getPreviousScanForTheme(shopId, themeId, currentScan.createdAt)
          : null;

        let newFindingCount: number;
        let resolvedFindingCount: number;
        let persistedFindingCount: number;
        if (previousScan) {
          const { diffScans } = await import("../../app/services/scan-differ.server");
          const diff = diffScans(currentFindings, previousScan.findings, {
            skippedCategories,
            skippedFiles: skippedFilePaths,
          });
          newFindingCount = diff.newFindings.length;
          resolvedFindingCount = diff.resolvedFindings.length;
          persistedFindingCount = diff.unchangedCount;
        } else {
          // First-ever scan for this theme: no baseline to diff against, so every
          // finding is new and nothing can be resolved or carried forward.
          newFindingCount = totalFindings;
          resolvedFindingCount = 0;
          persistedFindingCount = 0;
        }

        await finalizeScan(scanId, {
          status: finalStatus,
          findingCount: totalFindings,
          skippedCategories,
          skippedFiles: skippedFilePaths,
          newFindingCount,
          resolvedFindingCount,
          persistedFindingCount,
        });
      });

      // Emit ONE scan_signal OpsEvent per completed scan (Feature 2). Runs AFTER
      // finalize-scan so completedAt/startedAt are set and every finding is
      // persisted. The ENTIRE body is guarded: a groupBy or write failure must
      // NEVER throw out of finalize — scan correctness must not depend on
      // telemetry (recordOpsEvent already never throws; the groupBy needs the
      // guard too).
      await step.run("emit-scan-signal", async () => {
        try {
          // Append-only: OpsEvent has no unique constraint on (eventType, key),
          // so an Inngest step re-run can write a duplicate scan_signal row for
          // the same scanId. Downstream consumers must take the LATEST row per
          // scanId (consistent with the existing OpsEvent append-only pattern).
          const db = (await import("../../app/db.server")).default;
          const { recordOpsEvent, OPS_EVENT_TYPES } =
            await import("../../app/models/ops-event.server");

          const scan = await db.scan.findUnique({
            where: { id: scanId },
            select: { startedAt: true, completedAt: true },
          });
          const shop = await db.shop.findUnique({
            where: { id: shopId },
            select: { plan: true },
          });

          // Authoritative per-detector histogram from the DB (over the logged
          // per-step counts).
          const detectorRows = await db.finding.groupBy({
            by: ["findingType"],
            where: { scanId },
            _count: true,
          });
          const detectorHits: Record<string, number> = {};
          for (const row of detectorRows) {
            detectorHits[row.findingType] = row._count;
          }

          const durationMs =
            scan?.completedAt && scan?.startedAt
              ? scan.completedAt.getTime() - scan.startedAt.getTime()
              : null;

          await recordOpsEvent({
            eventType: OPS_EVENT_TYPES.SCAN_SIGNAL,
            key: scanId,
            metadata: {
              shopId,
              scanId,
              plan: shop?.plan ?? null,
              themeId,
              fileCount,
              scannableFileCount,
              totalTextBytes,
              largestFileBytes,
              scannableTextBytes,
              skippedFileCount,
              benignLibrarySkips,
              // Per type: files that hit the per-file finding cap (gc-ypk).
              // Telemetry only; {} on every real theme.
              findingCapHits,
              unknownScriptCount,
              thirdPartyDomainCount,
              detectorHits,
              findingCount: totalFindings,
              durationMs,
              // Per-phase observability (gc-1bd). Additive JSON only — existing
              // scan_signal consumers keep working. `phaseMs` attributes wall-clock
              // to each major step; `pageCounts`/`throttleSleepMs` expose the
              // consolidated product walk + redirect walk cost; `truncatedWalks`
              // names any walk that hit its cap. This is observability ONLY (Option
              // C) — truncation is NOT reflected in skippedCategories, so the differ
              // still diffs the scanned subset of a truncated category normally.
              phaseMs: {
                themeFetch: themeFetchMs,
                themeScan: themeScanMs,
                products: productsMs,
                pages: pagesMs,
                redirects: redirectsMs,
              },
              pageCounts: {
                products: productResult.pageCount,
                redirects: redirectResult.pageCount ?? 0,
              },
              throttleSleepMs:
                productResult.throttleSleepMs + (redirectResult.throttleSleepMs ?? 0),
              truncatedWalks,
              // Step-output bounds (gc-4ce): a cap dropped dangling handles /
              // occurrences, the byte budget dropped ALL dangling candidates, or
              // the static JSON-LD candidate cap dropped some.
              danglingCapped,
              danglingTruncated,
              staticCandidatesCapped,
            },
          });
        } catch (err) {
          logger.warn("scan_signal emit failed — telemetry only, scan unaffected", {
            function: "scan-theme",
            event: "scan_signal_failed",
            scanId,
            shopId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
        tagFindings: productResult.tagCount,
        priceFindings: productResult.priceCount,
        pageFindings: pageResult.findingCount,
        metafieldFindings: productResult.metafieldCount,
        redirectFindings: redirectResult.findingCount,
        jsonLdPriceFindings: jsonLdPriceResult.findingCount,
        danglingRefFindings: danglingRefResult.findingCount,
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
