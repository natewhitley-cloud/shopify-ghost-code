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
 *   2b. fetch-granted-scopes     — ONE currentAppInstallation.accessScopes
 *                                  lookup per scan (gc-5l9). The optional audits
 *                                  below only probe scopes it reports granted,
 *                                  so an ungranted scope costs no query (and no
 *                                  ACCESS_DENIED in the Partner Dashboard). A
 *                                  failed lookup returns null → every audit
 *                                  probes as before.
 *   3–8. optional audit steps    — each checks for an optional scope, fetches
 *                                  data, runs a detector, and persists findings.
 *                                  Uses runAuditStep() to avoid boilerplate. Each
 *                                  reports whether it was skipped for missing
 *                                  scope; the JSON-LD live-price and dangling-
 *                                  reference audits also report whether a size
 *                                  cap truncated them (gc-11f).
 *   8b. storefront-script-tags   — DARK (SCRIPT_TAG_SUNSET_LIVE_ENABLED): reads
 *                                  the public storefront homepage for other
 *                                  apps' ScriptTags and, from that same page,
 *                                  the Liquid errors shoppers can see
 *                                  (LIQUID_ERROR_RENDERED, gc-i6du). Flag off =
 *                                  the step does not exist (no request, no
 *                                  category, no finding). An unreadable
 *                                  storefront records both categories in
 *                                  `unreachableCategories`; it never fails the
 *                                  scan. Also matches that page against the
 *                                  known-malicious list while
 *                                  RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED is on
 *                                  (gc-0htk, see persistHomepageMalicious).
 *   9. finalize-scan             — sets the terminal status to COMPLETED. The
 *                                  core theme audit ran, so success is COMPLETED
 *                                  even when optional categories were skipped for
 *                                  missing scope or capped; `skippedCategories`
 *                                  (scope-only) and `cappedCategories` (size
 *                                  caps, gc-11f) record which ones (for the diff
 *                                  engine and the scan-detail notices). This is
 *                                  the ONLY place the scan leaves IN_PROGRESS on
 *                                  success.
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

import { FindingType, type Prisma, ScanOrigin, ScanStatus } from "@prisma/client";
import { NonRetriableError } from "inngest";

import {
  HOMEPAGE_MALICIOUS_COVERAGE_KEY,
  HOMEPAGE_MALICIOUS_FILENAME,
  isStorefrontFinding,
} from "../../app/lib/finding-classification";
import {
  type PaginateStats,
  type QueryCostStats,
  sumQueryCost,
} from "../../app/lib/graphql-pagination.server";
import { logger } from "../../app/lib/logger.server";
import type { ThrottleSnapshot } from "../../app/lib/rate-limit-monitor.server";
import {
  CORE_STEP_OUTPUT_BUDGET_BYTES,
  DANGLING_MAX_OCCURRENCES_PER_HANDLE,
  JSONLD_PRICE_CANDIDATE_CAP,
  MAX_FINDINGS_PER_FILE_PER_TYPE,
  PRODUCT_WALK_CHUNK,
  PRODUCT_WALK_TIME_BUDGET_MS,
  REDIRECT_GROUPS_BUDGET_BYTES,
  REDIRECT_WALK_CHUNK,
  REDIRECT_WALK_TIME_BUDGET_MS,
  WALK_STEP_TIME_BUDGET_MS,
} from "../../app/lib/scan-limits";
import type { GrantedOptionalScopes } from "../../app/lib/scope-check.server";
import { readThemeInfo } from "../../app/lib/theme-info";
import {
  buildManifestEntries,
  extractAppBlockRefs,
  manifestBytes,
} from "../../app/lib/theme-manifest";
import {
  type ScanWalkCoverage,
  WALK_FINDING_TYPES,
  type WalkCoverage,
  type WalkName,
} from "../../app/lib/walk-coverage";
import type { CreateFindingInput } from "../../app/models/finding.server";
import { saveThemeFindings } from "../../app/models/finding.server";
import { createScanDomains } from "../../app/models/scan-domain.server";
import { upsertScanManifest } from "../../app/models/scan-manifest.server";
import {
  finalizeScan,
  getPreviousScanForTheme,
  getScanById,
  getScanIdsForThemeBetween,
  markScanStarted,
  updateScanStatus,
} from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import { dropAdvisoryUnknownScripts } from "../../app/services/app-incident-advisory.server";
import {
  findCorroboratedApps,
  identifyAppFromFilename,
  identifyAppFromSnippetName,
} from "../../app/services/app-lookup.server";
import {
  CHECKOUT_LIQUID_PATH,
  detectCheckoutSunset,
} from "../../app/services/checkout-sunset-detector.server";
import {
  compareByFileThenLine,
  extractDanglingReferences,
} from "../../app/services/dangling-reference-extractor.server";
import { buildMissingSnippetIndex } from "../../app/services/liquid-error-detector.server";
import type { MenuFetchResult } from "../../app/services/menu-fetcher.server";
import type { BulkRedirectGroups } from "../../app/services/redirect-detector.server";
import type { HomepageMaliciousHit } from "../../app/services/runtime-malicious.server";
import {
  enabledAppEmbedApps,
  observedEmbedApps,
  isScannableFile,
  MAX_SCANNABLE_FILE_BYTES,
} from "../../app/services/scan-engine.server";
import { scanThemeFilesInPool } from "../../app/services/scan-pool.server";
import {
  isAdvisoryCheckLive,
  isMenuInjectionLive,
  isScriptTagSunsetLive,
  isSoftLaunchLive,
} from "../../app/services/soft-launch-flags.server";
import type { StorefrontScriptTagResult } from "../../app/services/storefront-fetcher.server";
import {
  fetchMainTheme,
  fetchThemeFiles,
  type ThemeFileMeta,
  ThemeTooLargeError,
} from "../../app/services/theme-fetcher.server";
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
};

/**
 * Result of an optional audit step that can also be cut short by a SIZE cap
 * (gc-11f): the JSON-LD live-price audit and the dangling-reference audit.
 *
 * `capped` is true when the audit ran (scope granted) but a cap left part of
 * the category unchecked: a candidate/handle/occurrence cap, a lookup budget,
 * or the step-output budget. It drives `cappedCategories`, which the differ
 * excludes from "resolved" alongside `skippedCategories`, but which does NOT
 * trigger the permissions banner (the merchant already granted access). It is
 * independent of `skipped`: both are true only when both happened.
 *
 * Distinct from `truncated` (gc-1bd product/redirect walks, Option C): a walk
 * truncation is telemetry only and never enters either category list.
 */
type CappableAuditStepResult = AuditStepResult & { capped: boolean };

/**
 * Build a category list from `[flag, category]` pairs, keeping the categories
 * whose flag is true. Shared by the `skippedCategories` and `cappedCategories`
 * builders so both lists are derived the same way.
 */
function flaggedCategories(pairs: Array<[boolean, FindingType]>): string[] {
  return pairs.filter(([flagged]) => flagged).map(([, category]) => category);
}

/**
 * What an audit's `fetchAndDetect` returns. The capped product and redirect
 * walks have their own chunked steps (gc-747u), so no runAuditStep audit has
 * walk observability to report.
 */
type AuditFetchResult = {
  findings: CreateFindingInput[];
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
  /**
   * Narrows the idempotency delete to the rows THIS call owns (gc-747u): a
   * later chunk of a walk split across steps must not delete the findings an
   * earlier chunk persisted. Omitted = every finding of the type (one-shot
   * audits, and a walk's first chunk).
   */
  deleteScope?: Prisma.FindingWhereInput;
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
      ...opts.deleteScope,
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
 * Known malicious code seen on the served homepage (gc-0htk): persist one
 * MALICIOUS_SCRIPT finding per listed domain the page uses, filed under
 * HOMEPAGE_MALICIOUS_FILENAME, except domains this scan's theme files already
 * report (the theme finding is where the merchant can remove it). The delete
 * is scoped to the homepage rows, so the theme detector's MALICIOUS_SCRIPT
 * rows are never touched. Returns how many were persisted.
 */
async function persistHomepageMalicious(opts: {
  scanId: string;
  shopId: string;
  hits: HomepageMaliciousHit[];
}): Promise<number> {
  const db = (await import("../../app/db.server")).default;
  const { homepageMaliciousFindings, themeMaliciousDomains } =
    await import("../../app/services/runtime-malicious.server");
  const themeRows = await db.finding.findMany({
    where: {
      scanId: opts.scanId,
      findingType: FindingType.MALICIOUS_SCRIPT,
      NOT: { filename: HOMEPAGE_MALICIOUS_FILENAME },
    },
    select: { description: true },
  });
  const findings = homepageMaliciousFindings(
    opts.hits,
    themeMaliciousDomains(themeRows.map((r) => r.description)),
  );
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.MALICIOUS_SCRIPT,
    findings,
    event: "homepage_malicious_findings",
    logMessage: "homepage malicious findings persisted",
    deleteScope: { filename: HOMEPAGE_MALICIOUS_FILENAME },
  });
  return findings.length;
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

  const { findings } = await opts.fetchAndDetect(admin);

  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: opts.findingType,
    findings,
    event: `${opts.stepName}_findings`,
    logMessage: "audit step findings persisted",
  });

  // Scope was present (the scope-absence early return above is the ONLY skip
  // path), so this category was audited: `skipped` is false.
  return { findingCount: findings.length, skipped: false };
}

/**
 * What the menu audit step returns (gc-7gjj.1). `audited` is true only when
 * the walk ran (flag on, shop found, scope granted): a scan where it is false
 * records MENU_INJECTION as not live, so the differ treats the type as
 * un-audited (never new, never fixed). `skipped` (scope missing) and `capped`
 * (MENU_CAP / MENU_ITEM_CAP hit) feed skippedCategories / cappedCategories.
 */
type MenuAuditStepResult = CappableAuditStepResult & {
  audited: boolean;
  itemCount: number;
  pageCount: number;
  throttleSleepMs: number;
  cost: QueryCostStats;
};

/** Wait before the menu audit's one retry of a transient scope probe (gc-7gjj.1). */
const MENU_SCOPE_RETRY_MS = 250;

/**
 * The menu-label injection audit (gc-7gjj.1, spike §2.5): read every menu
 * item's title and URL (Admin `menus`, read_online_store_navigation, the
 * redirect audit's scope and probe) and persist one MENU_INJECTION finding per
 * item that holds code. Dark behind MENU_INJECTION_LIVE_ENABLED: off = inert,
 * no request at all, and neither a scope skip nor capped.
 */
async function runMenuAudit(opts: {
  scanId: string;
  shopId: string;
  grantedOptionalScopes: GrantedOptionalScopes;
  /**
   * Whether MENU_INJECTION is in the live set fetch-and-scan recorded for
   * this scan. The step runs only then, so a flag flipped on mid-run can
   * never persist findings the scan records as not live (audit fix).
   */
  live: boolean;
}): Promise<MenuAuditStepResult> {
  const none = {
    findingCount: 0,
    skipped: false,
    capped: false,
    audited: false,
    itemCount: 0,
    pageCount: 0,
    throttleSleepMs: 0,
    cost: sumQueryCost([]),
  };
  if (!opts.live || !isMenuInjectionLive()) return none;

  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  // No shop record: a no-op, not a scope skip.
  if (!shop) return none;

  // A failed admin context, scope probe or menus read must not fail the
  // whole scan (theme findings, malicious code): the menus query's cost and
  // failure modes are unmeasured (gc-7gjj.5). Recorded as not run: not live,
  // so no prior finding resolves.
  const stats: PaginateStats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
  let fetched: MenuFetchResult | null;
  try {
    const { unauthenticated } = await import("../../app/shopify.server");
    const { admin } = await unauthenticated.admin(shop.domain);
    const { hasNavigationScope } = await import("../../app/services/redirect-fetcher.server");
    const { TransientScopeCheckError } = await import("../../app/lib/scope-check.server");
    // A transient probe failure (THROTTLED, network, 5xx) is retried once
    // before the check is recorded as not run (deferred LOW, gc-7gjj.1).
    const probe = () => hasNavigationScope(admin, opts.grantedOptionalScopes);
    const granted = await probe().catch(async (err: unknown) => {
      if (!(err instanceof TransientScopeCheckError)) throw err;
      await new Promise((resolve) => setTimeout(resolve, MENU_SCOPE_RETRY_MS));
      return probe();
    });
    if (!granted) {
      const { logger } = await import("../../app/lib/logger.server");
      logger.info("scope not available — skipping audit step", {
        function: "scan-theme",
        stepName: "menu-audit",
        shopId: opts.shopId,
      });
      fetched = null;
    } else {
      const { fetchMenuItems } = await import("../../app/services/menu-fetcher.server");
      fetched = await fetchMenuItems(admin, stats);
    }
  } catch (err) {
    const { logger } = await import("../../app/lib/logger.server");
    const { safeErrorFields } = await import("../../app/lib/safe-error");
    // error, not warn: with the flag on this silently turns the check off
    // for the scan, so it must be visible (it can also be a code fault).
    logger.error("menu audit failed; menu labels recorded as not checked", {
      function: "scan-theme",
      stepName: "menu-audit",
      shopId: opts.shopId,
      ...safeErrorFields(err),
    });
    // An earlier attempt of this step may have persisted rows before failing:
    // the type is recorded as not live now, so leave none behind.
    await db.finding.deleteMany({
      where: { scanId: opts.scanId, findingType: FindingType.MENU_INJECTION },
    });
    return none;
  }
  // Scope not granted: NOT audited (skippedCategories keeps prior findings).
  if (fetched === null) return { ...none, skipped: true };
  const { items } = fetched;
  const { detectMenuInjection } = await import("../../app/services/menu-injection-detector.server");
  const { findings, truncated } = detectMenuInjection(items);
  const capped = fetched.capped || truncated;

  // persistAuditFindings skips its delete on an empty batch. A retry of this
  // step can find nothing where an earlier attempt persisted rows (a menu
  // edited in between), so clear this type first (re-audit fix).
  if (findings.length === 0) {
    await db.finding.deleteMany({
      where: { scanId: opts.scanId, findingType: FindingType.MENU_INJECTION },
    });
  }
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.MENU_INJECTION,
    findings,
    event: "menu-audit_findings",
    logMessage: "audit step findings persisted",
  });

  return {
    findingCount: findings.length,
    skipped: false,
    capped,
    audited: true,
    itemCount: items.length,
    pageCount: stats.pageCount,
    throttleSleepMs: stats.throttleSleepMs,
    cost: sumQueryCost([stats.cost]),
  };
}

// ---------------------------------------------------------------------------
// Capped product / redirect walks, split across steps (gc-747u)
// ---------------------------------------------------------------------------

/**
 * Where a walk resumes in its next step. Only a cursor (and, for redirects,
 * the bulk tally) crosses the step boundary: product nodes and redirect lists
 * stay inside the step that fetched them. `after` is null only when the walk's
 * first request was THROTTLED past the step deadline (retry from the start).
 */
type WalkResume = { after: string | null };

/** What one product-walk step returns (all small scalars, gc-747u). */
type ProductChunkResult = {
  tagCount: number;
  priceCount: number;
  metafieldCount: number;
  scopeAbsent: boolean;
  /** The PLAN cap stopped the walk while more products existed (final step). */
  truncated: boolean;
  tagGap: boolean;
  priceGap: boolean;
  metafieldGap: boolean;
  pageCount: number;
  throttleSleepMs: number;
  /** Wall-clock of this step's walk, measured inside the step (memoized). */
  walkMs: number;
  /** The plan cap, read ONCE by the first step and reused by the rest. */
  cap: number;
  /** Products checked so far, across every step of the walk. */
  checked: number;
  /** Resume point for the next step; null = the walk is over. */
  next: WalkResume | null;
  /** Set by the final step when the walk ran (scope granted, shop found). */
  coverage: WalkCoverage | null;
  /** Last throttle status seen; the next step waits on it first (audit #3). */
  throttle: ThrottleSnapshot | null;
  /** Epoch ms the whole walk stops paging, set ONCE by step 0 (audit #1). */
  walkDeadline: number;
  /** Query cost of this step's pages (audit #7). */
  cost: QueryCostStats;
  /** GID of the last product checked so far, across every step. */
  lastId: string | null;
};

/**
 * True when a walk that stopped with records left could not be resumed (no
 * cursor) or reached `cap`: either way the records past it were not checked,
 * so the walk counts as truncated (never a silent partial walk). A THROTTLED
 * stop (audit #2) is always resumable: its cursor, even null, is a retry point.
 */
function walkStoppedShort(
  hasMore: boolean,
  checked: number,
  cap: number,
  cursor: string | null,
  throttleStopped: boolean,
) {
  return hasMore && (checked >= cap || (cursor === null && !throttleStopped));
}

/**
 * Idempotency delete scope for a LATER step of a walk (gc-747u audit #5). The
 * step owns its own fetched records' rows (`ownFilenames`) AND every row of
 * this walk's types for a record with an ID above `afterId`, the last record
 * the earlier steps checked. Scoping by fetched filenames alone missed a row
 * a failed earlier attempt of this step wrote for a record deleted from the
 * store before the retry. The range is open above: later steps have not run
 * yet (steps are sequential), so every row past `afterId` is this attempt's to
 * replace. Rows at or below `afterId` (earlier steps) and unparseable
 * filenames are never touched. `afterId` null with nothing checked yet: any
 * parseable row is this step's. An UNKNOWN boundary (unparseable, or null
 * although records were checked: an earlier step memoized before lastId was
 * carried) falls back to own filenames only, never wiping earlier rows.
 */
async function laterStepDeleteScope(
  scanId: string,
  walk: WalkName,
  afterId: string | null,
  checkedSoFar: number,
  ownFilenames: string[],
): Promise<Prisma.FindingWhereInput> {
  const db = (await import("../../app/db.server")).default;
  const { gidNumber, walkRecordOf } = await import("../../app/services/scan-differ.server");
  const floor = afterId === null ? null : gidNumber(afterId);
  const boundaryUnknown = afterId === null ? checkedSoFar > 0 : floor === null;
  const rows = boundaryUnknown
    ? []
    : await db.finding.findMany({
        where: { scanId, findingType: { in: WALK_FINDING_TYPES[walk] as FindingType[] } },
        select: { id: true, filename: true, findingType: true },
      });
  const pastBoundary = rows
    .filter((r) => {
      const id = walkRecordOf(r)?.id ?? null;
      return id !== null && (floor === null || id > floor);
    })
    .map((r) => r.id);
  return { OR: [{ filename: { in: ownFilenames } }, { id: { in: pastBoundary } }] };
}

/** One walk's query cost for the scan_signal (audit #7): avg over its pages. */
function walkCostSignal(cost: QueryCostStats, pageCount: number) {
  return {
    requestedMax: cost.requestedMax,
    requestedAvg: pageCount > 0 ? Math.round(cost.requestedSum / pageCount) : 0,
    actualSum: cost.actualSum,
  };
}

/**
 * Deadlines for one walk step (gc-747u audit #1). `walk` is the whole walk's
 * deadline: step 0 sets it (now + budget) and returns it in its memoized
 * output, and every later step reuses that number, so a replay or a retried
 * step never starts a fresh budget. `page` bounds this step's paging: its own
 * WALK_STEP_TIME_BUDGET_MS, never past the walk deadline. Call at step start.
 */
function walkStepDeadlines(walkDeadline: number | null, budgetMs: number) {
  const now = Date.now();
  const walk = walkDeadline ?? now + budgetMs;
  return { walk, page: Math.min(now + WALK_STEP_TIME_BUDGET_MS, walk) };
}

/**
 * One step of the consolidated product walk (gc-1bd + gc-747u). Step 0 probes
 * `read_products` and reads the plan's cap; every step fetches at most
 * PRODUCT_WALK_CHUNK products within WALK_STEP_TIME_BUDGET_MS, runs the three
 * detectors on them (each is per-product, so a chunk is self-contained), and
 * persists their findings. Step 0's persist deletes the type's prior rows (as
 * the single-step audit did); later steps delete only rows for their own
 * products, so a retried step never duplicates or wipes an earlier step's.
 */
async function runProductAuditChunk(opts: {
  scanId: string;
  shopId: string;
  grantedOptionalScopes: GrantedOptionalScopes;
  index: number;
  after: string | null;
  checkedSoFar: number;
  cap: number | null;
  throttle: ThrottleSnapshot | null;
  walkDeadline: number | null;
  lastIdSoFar: string | null;
}): Promise<ProductChunkResult> {
  const deadlines = walkStepDeadlines(opts.walkDeadline, PRODUCT_WALK_TIME_BUDGET_MS);
  const empty = (scopeAbsent: boolean): ProductChunkResult => ({
    tagCount: 0,
    priceCount: 0,
    metafieldCount: 0,
    scopeAbsent,
    truncated: false,
    tagGap: false,
    priceGap: false,
    metafieldGap: false,
    pageCount: 0,
    throttleSleepMs: 0,
    walkMs: 0,
    cap: opts.cap ?? 0,
    checked: opts.checkedSoFar,
    next: null,
    coverage: null,
    throttle: null,
    walkDeadline: deadlines.walk,
    lastId: opts.lastIdSoFar,
    cost: sumQueryCost([]),
  });

  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  // No shop record: no-op, not a scope skip (mirrors runAuditStep).
  if (!shop) return empty(false);

  const { unauthenticated } = await import("../../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);
  const { hasProductScope, fetchProductAuditData, fetchProductsTotal } =
    await import("../../app/services/product-fetcher.server");
  const { logger } = await import("../../app/lib/logger.server");

  if (opts.index === 0) {
    const hasScope = await hasProductScope(admin, opts.grantedOptionalScopes);
    if (!hasScope) {
      logger.info("read_products scope not available — skipping product audits", {
        function: "scan-theme",
        stepName: "product-audit",
        shopId: opts.shopId,
      });
      // Scope not granted → all THREE product categories un-audited.
      return empty(true);
    }
  }

  // ONE number per scan: step 0 reads the plan's cap, later steps reuse it, so
  // a plan change mid-scan cannot make the walk and its coverage disagree.
  const { getPlanFeatures } = await import("../../app/lib/billing.server");
  const cap = opts.cap ?? getPlanFeatures(shop.plan).productAuditCap;

  const walkStart = Date.now();
  const { tags, prices, metafields, pageCount, throttleSleepMs, ...walk } =
    await fetchProductAuditData(admin, Math.min(PRODUCT_WALK_CHUNK, cap - opts.checkedSoFar), {
      after: opts.after,
      deadline: deadlines.page,
      throttle: opts.throttle,
    });
  const walkMs = Date.now() - walkStart;

  const checked = opts.checkedSoFar + walk.checked;
  const lastId = walk.lastId ?? opts.lastIdSoFar;
  // Out of walk time with products left: truncated like a cap hit (audit #1).
  const outOfTime = walk.hasMore && Date.now() >= deadlines.walk;
  const truncated =
    outOfTime || walkStoppedShort(walk.hasMore, checked, cap, walk.endCursor, walk.throttleStopped);
  const next = walk.hasMore && !truncated ? { after: walk.endCursor } : null;

  if (truncated) {
    // Observable cap (gc-1bd): never silently drop the tail of the catalog.
    logger.warn(
      outOfTime
        ? "product-audit walk ran out of time; products beyond it were not scanned"
        : "product-audit walk hit the cap; products beyond it were not scanned",
      {
        function: "scan-theme",
        stepName: "product-audit",
        shopId: opts.shopId,
        cap,
        checked,
      },
    );
  }

  const { detectOrphanedProductTags } =
    await import("../../app/services/product-tag-detector.server");
  const { detectPersistentDiscounts } = await import("../../app/services/price-detector.server");
  const { detectOrphanedMetafields } = await import("../../app/services/metafield-detector.server");

  // Per-detector isolation: a throw in one detector must not sink the other
  // two. A throw records that category as a coverage gap (a category we could
  // not verify at all this run — unlike truncation, which still fully audited
  // the scanned subset), so the differ never false-resolves its prior findings
  // from a run we could not fully verify.
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
        shopId: opts.shopId,
        detector: label,
        error: err instanceof Error ? err.message : String(err),
      });
      return { findings: [], gap: true };
    }
  };

  const tagOut = runDetector(() => detectOrphanedProductTags(tags), "GHOST_TAG");
  const priceOut = runDetector(() => detectPersistentDiscounts(prices), "GHOST_PRICE");
  const metafieldOut = runDetector(() => detectOrphanedMetafields(metafields), "GHOST_METAFIELD");

  // Later chunks own only their own products' rows (see the doc comment).
  // `tags` holds every product in the chunk, unfiltered.
  const deleteScope: Prisma.FindingWhereInput | undefined =
    opts.index === 0
      ? undefined
      : await laterStepDeleteScope(
          opts.scanId,
          "products",
          opts.lastIdSoFar,
          opts.checkedSoFar,
          tags.flatMap((p) => [`products/${p.id}`, `products/${p.id}/metafields`]),
        );

  // Persist ALL THREE FindingTypes (invariant a). Each delete-then-create is
  // scoped to its own type, so the three never clobber each other and a retry
  // stays idempotent. persistAuditFindings no-ops on an empty batch, exactly as
  // the three legacy steps did.
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.GHOST_TAG,
    findings: tagOut.findings,
    event: "product_tag_findings",
    logMessage: "product tag findings persisted",
    deleteScope,
  });
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.GHOST_PRICE,
    findings: priceOut.findings,
    event: "product_price_findings",
    logMessage: "product price findings persisted",
    deleteScope,
  });
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.GHOST_METAFIELD,
    findings: metafieldOut.findings,
    event: "product_metafield_findings",
    logMessage: "product metafield findings persisted",
    deleteScope,
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
    walkMs,
    cap,
    checked,
    next,
    // The total is read only when it will be shown (a truncated walk).
    coverage:
      next === null
        ? {
            checked,
            total: truncated ? await fetchProductsTotal(admin) : null,
            truncated,
            lastId: truncated ? lastId : null,
          }
        : null,
    throttle: walk.throttle,
    walkDeadline: deadlines.walk,
    lastId,
    cost: walk.cost,
  };
}

/** What one redirect-walk step returns (gc-747u). */
type RedirectChunkResult = {
  findingCount: number;
  skipped: boolean;
  /** Bulk detection was abandoned (tally over budget): GHOST_REDIRECT capped. */
  capped: boolean;
  truncated: boolean;
  pageCount: number;
  throttleSleepMs: number;
  walkMs: number;
  cap: number;
  checked: number;
  /** Resume point plus the bulk tally so far (null groups = abandoned). */
  next: (WalkResume & { groups: BulkRedirectGroups | null }) | null;
  coverage: WalkCoverage | null;
  /** Last throttle status seen; the next step waits on it first (audit #3). */
  throttle: ThrottleSnapshot | null;
  /** Epoch ms the whole walk stops paging, set ONCE by step 0 (audit #1). */
  walkDeadline: number;
  /** Query cost of this step's pages (audit #7). */
  cost: QueryCostStats;
  /** GID of the last redirect checked so far, across every step. */
  lastId: string | null;
};

/**
 * Keep the bulk-redirect tally inside REDIRECT_GROUPS_BUDGET_BYTES before it
 * crosses a step boundary (gc-747u): drop the display samples first (the
 * finding's identity is its prefix, not its samples), then give up on bulk
 * detection for this scan (null) rather than risk the run-state limit.
 */
function boundBulkGroups(groups: BulkRedirectGroups): BulkRedirectGroups | null {
  const fits = () =>
    Buffer.byteLength(JSON.stringify(groups), "utf8") <= REDIRECT_GROUPS_BUDGET_BYTES;
  if (fits()) return groups;
  for (const group of Object.values(groups)) group.samples = [];
  return fits() ? groups : null;
}

/**
 * One step of the redirect walk (gc-747u), the redirect twin of
 * runProductAuditChunk. App-pattern redirects (one finding per redirect) are
 * detected and persisted per chunk; bulk patterns need every unmatched
 * redirect's prefix, so each step adds its chunk to a compact per-prefix tally
 * that rides to the next step, and the final step turns it into findings.
 */
async function runRedirectAuditChunk(opts: {
  scanId: string;
  shopId: string;
  grantedOptionalScopes: GrantedOptionalScopes;
  index: number;
  after: string | null;
  checkedSoFar: number;
  cap: number | null;
  groups: BulkRedirectGroups | null;
  throttle: ThrottleSnapshot | null;
  walkDeadline: number | null;
  lastIdSoFar: string | null;
}): Promise<RedirectChunkResult> {
  const deadlines = walkStepDeadlines(opts.walkDeadline, REDIRECT_WALK_TIME_BUDGET_MS);
  const empty = (skipped: boolean): RedirectChunkResult => ({
    findingCount: 0,
    skipped,
    capped: false,
    truncated: false,
    pageCount: 0,
    throttleSleepMs: 0,
    walkMs: 0,
    cap: opts.cap ?? 0,
    checked: opts.checkedSoFar,
    next: null,
    coverage: null,
    throttle: null,
    walkDeadline: deadlines.walk,
    lastId: opts.lastIdSoFar,
    cost: sumQueryCost([]),
  });

  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  // No shop record: treat as no-op, not a scope skip (do not mark PARTIAL).
  if (!shop) return empty(false);

  const { unauthenticated } = await import("../../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);
  const { hasNavigationScope, fetchRedirects, fetchRedirectsTotal } =
    await import("../../app/services/redirect-fetcher.server");

  if (opts.index === 0 && !(await hasNavigationScope(admin, opts.grantedOptionalScopes))) {
    const { logger } = await import("../../app/lib/logger.server");
    logger.info("scope not available — skipping audit step", {
      function: "scan-theme",
      stepName: "redirect-audit",
      shopId: opts.shopId,
    });
    return empty(true);
  }

  const { getPlanFeatures } = await import("../../app/lib/billing.server");
  const cap = opts.cap ?? getPlanFeatures(shop.plan).redirectAuditCap;

  const stats: PaginateStats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
  const walkStart = Date.now();
  const redirects = await fetchRedirects(
    admin,
    Math.min(REDIRECT_WALK_CHUNK, cap - opts.checkedSoFar),
    stats,
    { after: opts.after, deadline: deadlines.page, throttle: opts.throttle },
  );
  const walkMs = Date.now() - walkStart;

  const checked = opts.checkedSoFar + redirects.length;
  const lastId = redirects[redirects.length - 1]?.id ?? opts.lastIdSoFar;
  const endCursor = stats.endCursor ?? null;
  const hasMore = stats.hasMore === true;
  // Out of walk time with redirects left: truncated like a cap hit (audit #1).
  const outOfTime = hasMore && Date.now() >= deadlines.walk;
  const truncated =
    outOfTime || walkStoppedShort(hasMore, checked, cap, endCursor, stats.throttleStopped === true);
  const last = !hasMore || truncated;

  const { addToBulkRedirectGroups, bulkRedirectFindings, detectAppPatternRedirects } =
    await import("../../app/services/redirect-detector.server");
  let groups = opts.index === 0 ? {} : opts.groups;
  if (groups) addToBulkRedirectGroups(groups, redirects);
  if (groups && !last) groups = boundBulkGroups(groups);

  const findings = [
    ...detectAppPatternRedirects(redirects),
    ...(last && groups ? bulkRedirectFindings(groups) : []),
  ];

  // Later chunks own only their own redirects' rows (plus the ID range past
  // the earlier steps, audit #5), plus (final chunk) the bulk rows, which only
  // the final chunk ever writes.
  const ownScope =
    opts.index === 0
      ? undefined
      : await laterStepDeleteScope(
          opts.scanId,
          "redirects",
          opts.lastIdSoFar,
          opts.checkedSoFar,
          redirects.map((r) => `redirects/${r.id}`),
        );
  await persistAuditFindings({
    scanId: opts.scanId,
    shopId: opts.shopId,
    findingType: FindingType.GHOST_REDIRECT,
    findings,
    event: "redirect-audit_findings",
    logMessage: "audit step findings persisted",
    deleteScope: ownScope && {
      OR: [ownScope, ...(last ? [{ filename: { startsWith: "redirects/bulk/" } }] : [])],
    },
  });

  if (truncated) {
    const { logger } = await import("../../app/lib/logger.server");
    logger.warn(
      outOfTime
        ? "redirect-audit walk ran out of time; redirects beyond it were not scanned"
        : "redirect-audit walk hit the cap; redirects beyond it were not scanned",
      {
        function: "scan-theme",
        stepName: "redirect-audit",
        shopId: opts.shopId,
        cap,
        checked,
      },
    );
  }

  return {
    findingCount: findings.length,
    skipped: false,
    capped: groups === null,
    truncated,
    pageCount: stats.pageCount,
    throttleSleepMs: stats.throttleSleepMs,
    walkMs,
    cap,
    checked,
    next: last ? null : { after: endCursor, groups },
    coverage: last
      ? {
          checked,
          total: truncated ? await fetchRedirectsTotal(admin) : null,
          truncated,
          lastId: truncated ? lastId : null,
        }
      : null,
    throttle: stats.throttle ?? null,
    walkDeadline: deadlines.walk,
    lastId,
    cost: sumQueryCost([stats.cost]),
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
/**
 * Applies SOFT_LAUNCH_FLAGS in ONE place (gc-rvo0): each flag is read exactly
 * once, and the SAME reads decide both which findings persist and which types
 * are recorded as LIVE for the scan. Returns the kept findings, the suppressed
 * counts per type, and `liveFindingTypes` = every FindingType except those a
 * flag suppressed. The live set is stored on the scan at finalize so the
 * summary-email diff can ignore types the baseline scan could not have
 * contained (flag flipped on, or detector shipped, since). Plan/scope gating is
 * NOT part of it (skippedCategories/cappedCategories cover that).
 *
 * `advisoryApplies` (gc-14x5): an affected-app advisory is about shoppers and
 * checkout, so it is only true of the PUBLISHED theme. When false (a draft
 * theme, or the published theme could not be confirmed) the advisory type is
 * treated as not live for this scan: nothing is persisted and the type is
 * left out of the live set, so the differ never reports new or fixed across
 * a draft / live pair of scans.
 */
function applySoftLaunchFlags<T extends { findingType: FindingType }>(
  findings: readonly T[],
  advisoryApplies: boolean,
): { kept: T[]; suppressedDetectorHits: Record<string, number>; liveFindingTypes: string[] } {
  const isLive = new Map<FindingType, boolean>();
  for (const type of Object.values(FindingType)) {
    isLive.set(
      type,
      isSoftLaunchLive(type) && (type !== FindingType.APP_INCIDENT_ADVISORY || advisoryApplies),
    );
  }
  const suppressedDetectorHits: Record<string, number> = {};
  const kept = findings.filter((f) => {
    if (isLive.get(f.findingType)) return true;
    suppressedDetectorHits[f.findingType] = (suppressedDetectorHits[f.findingType] ?? 0) + 1;
    return false;
  });
  const liveFindingTypes = Object.values(FindingType).filter((t) => isLive.get(t));
  return { kept, suppressedDetectorHits, liveFindingTypes };
}

/**
 * Whether the scanned theme is the shop's published (MAIN) theme: one small
 * Admin query per scan, made once inside fetch-and-scan and shared by the
 * affected-app advisory gate (gc-14x5) and the change-log manifest (gc-rrh.4,
 * `isPublishedTheme`). Before gc-rrh.4 the read was made only while the
 * advisory check was live; with it live (production) the count is unchanged.
 *
 * One retry: the error is swallowed (the scan must not fail over this), so the
 * step's own Inngest retries never see it. A single throttle or network blip
 * should not cost the merchant the advisory for this scan. Two failures =
 * null (unknown).
 */
async function readIsPublishedTheme(
  admin: Parameters<typeof fetchMainTheme>[0],
  themeId: string,
  shopId: string,
): Promise<boolean | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return (await fetchMainTheme(admin))?.id === themeId;
    } catch (err) {
      if (attempt === 1) continue;
      const { logger } = await import("../../app/lib/logger.server");
      logger.warn(
        "published theme read failed twice; advisory check recorded as not run, change log theme unknown",
        {
          function: "scan-theme",
          event: "advisory_published_theme_unknown",
          shopId,
          errorName: err instanceof Error ? err.name : typeof err,
        },
      );
    }
  }
  return null;
}

/**
 * Whether an affected-app advisory may be recorded for this scan (gc-14x5):
 * the check is live AND the scanned theme is confirmed as the published
 * theme. Unknown (the read failed twice) or no published theme = no: an
 * advisory is never shown on an unconfirmed theme, and the scan itself is
 * unaffected. The advisory is then absent for that one scan and the type is
 * not live for it, so nothing reads as fixed; it returns on the next scan.
 */
function advisoryAppliesToTheme(isPublishedTheme: boolean | null): boolean {
  return isAdvisoryCheckLive() && isPublishedTheme === true;
}

/**
 * The app that owns a theme file, for the change-log manifest (gc-rrh.4, spec
 * 1.3): the filename pattern first, then, for snippets/ and sections/ files,
 * the exact snippet name (generic names only when the theme corroborates the
 * app, gc-c4k). Never the file's content; `files` is read only for that
 * theme-wide corroboration, computed once and only if a lookup needs it.
 */
export function createManifestOwnerResolver(
  files: ReadonlyArray<{ filename: string; content: string }>,
): (path: string) => string | null {
  let corroborated: Set<string> | null = null;
  return (path) => {
    const byFile = identifyAppFromFilename(path);
    if (byFile) return byFile.appName;
    if (!path.startsWith("snippets/") && !path.startsWith("sections/")) return null;
    const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    if (basename === "") return null;
    corroborated ??= findCorroboratedApps(files);
    return identifyAppFromSnippetName(basename, corroborated);
  };
}

/**
 * Build and persist this scan's theme file manifest (gc-rrh.4). Hashes and
 * metadata only. Never throws: the change log ships dark and must never fail
 * or alter a scan, so any error is logged and the scan carries on without a
 * manifest (its next check is then a baseline). Returns the step-output
 * telemetry, or nulls when nothing was persisted.
 */
async function persistScanManifest(args: {
  scanId: string;
  shopId: string;
  themeId: string;
  fileMetas: readonly ThemeFileMeta[];
  files: ReadonlyArray<{ filename: string; content: string }>;
}): Promise<{ manifestFileCount: number | null; manifestBytes: number | null }> {
  try {
    const entries = buildManifestEntries(args.fileMetas, createManifestOwnerResolver(args.files));
    await upsertScanManifest(args.scanId, {
      shopId: args.shopId,
      themeId: args.themeId,
      entries,
      appBlocks: extractAppBlockRefs(args.files),
    });
    return { manifestFileCount: entries.length, manifestBytes: manifestBytes(entries) };
  } catch (err) {
    logger.warn("scan manifest not persisted; scan continues", {
      function: "scan-theme",
      event: "manifest_persist_failed",
      shopId: args.shopId,
      scanId: args.scanId,
      errorName: err instanceof Error ? err.name : typeof err,
      // Capped: a Prisma error message can echo the (large) call arguments.
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    return { manifestFileCount: null, manifestBytes: null };
  }
}

const DANGLING_SUBTYPE_META: Record<string, { segment: string; label: string }> = {
  product: { segment: "products", label: "product" },
  collection: { segment: "collections", label: "collection" },
  page: { segment: "pages", label: "page" },
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * OpsEvent key for a failed app-removal detection (gc-frda): a function_failure
 * the operator digest counts, kept apart from "scan-theme" so it never
 * dedup-suppresses a real scan failure alert.
 */
export const APP_REMOVALS_FAILURE_KEY = "scan-theme/app-removals";

/**
 * OpsEvent key for a failed change computation (gc-rrh.4): a function_failure
 * under its own key, mirroring APP_REMOVALS_FAILURE_KEY, so it never
 * dedup-suppresses a real scan failure alert. No new OpsEvent type (spec 8).
 */
export const CHANGE_LOG_FAILURE_KEY = "scan-theme/change-log";

/** Bound on a logged or recorded error message: a Prisma error can echo its arguments. */
const MAX_LOGGED_ERROR_CHARS = 500;

const cappedErrorMessage = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_LOGGED_ERROR_CHARS);

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
      //
      // gc-i3vk: the transition is conditional (PENDING -> IN_PROGRESS only). If
      // the scan sat in the concurrency backlog past the stale threshold,
      // check-scan-stale already marked it FAILED; reviving it here would leave a
      // possibly-hung IN_PROGRESS scan that only the daily sweep re-checks. So a
      // scan that is no longer PENDING exits cleanly, BEFORE any theme fetch. We
      // return (never throw) so Inngest does not retry, and the outer catch (which
      // would write FAILED) is not entered. The merchant simply rescans.
      //
      // Replay: Inngest memoizes completed steps, so once this step has
      // transitioned the scan, every later retry of the function replays the
      // stored `{ started: true }` result without re-running the DB write (which
      // would now see IN_PROGRESS and report a false skip).
      const start = await step.run("update-status-in-progress", () => markScanStarted(scanId));
      if (!start.started) {
        logger.warn("scan-theme skipped: scan is no longer PENDING", {
          function: "scan-theme",
          event: "scan_not_pending",
          scanId,
          status: start.status,
        });
        return { scanId, skipped: "not_pending" as const, status: start.status };
      }

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
        suspiciousCode,
        menuLabels,
        suppressedDetectorHits,
        liveFindingTypes: persistedLiveFindingTypes,
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
        enabledEmbedApps,
        missingSnippetRenders,
        missingSnippetsCapped,
        appsWithEnabledEmbed,
        themeInfo,
        isPublishedTheme,
        manifestFileCount,
        manifestBytes: manifestByteCount,
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
        // Theme files that exist but are not in `files` (their body was not
        // returned as text). Names only, and only for this step: the Liquid
        // error check must not take such a snippet for a missing one (gc-wr81).
        const filenamesWithoutText: string[] = [];
        // Every file's checksum / size / updatedAt, text or binary, for the
        // change-log manifest (gc-rrh.4). Small scalars, this step only.
        const fileMetas: ThemeFileMeta[] = [];
        try {
          files = await fetchThemeFiles(admin, themeId, shop.domain, {
            onFileWithoutText: (filename) => filenamesWithoutText.push(filename),
            onFileMeta: (meta) => fileMetas.push(meta),
          });
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
          unknownScripts: collectedUnknownScripts,
          skippedFiles,
          staticProductCandidates,
          benignLibrarySkips,
          thirdPartyDomains,
          findingCapHits,
          suspiciousCode,
          menuLabels,
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
        const allThemeFindings = [...findings, ...checkoutSunsetFindings];

        // Soft-launched detectors (SOFT_LAUNCH_FLAGS: SETTINGS_DRIFT gc-ecr,
        // APP_EMBED_OFF / GHOST_APP_EMBED gc-fed; spec 5.6): their first real
        // output is unreviewed. They still RUN, but their findings are persisted
        // only when the type's env flag === "true". The suppressed counts are
        // threaded to the scan_signal detectorHits (which otherwise histograms
        // persisted rows only) so precision review can read them before the
        // flag is turned on.
        // One published-theme read per scan, shared by the advisory gate and
        // the change log (gc-rrh.4). null = unknown (read failed twice).
        const isPublishedTheme = await readIsPublishedTheme(admin, themeId, shopId);
        const {
          kept: themeFindings,
          suppressedDetectorHits,
          liveFindingTypes: scanLiveFindingTypes,
        } = applySoftLaunchFlags(allThemeFindings, advisoryAppliesToTheme(isPublishedTheme));
        // No double report (gc-14x5): a host this scan reports as an advisory
        // is not also listed as an unrecognized script. Only for advisories
        // that are actually persisted, so with the check dark, on a draft
        // theme or after expiry the rows are exactly as before.
        const unknownScripts = dropAdvisoryUnknownScripts(collectedUnknownScripts, themeFindings);

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

        // Change-log manifest (gc-rrh.4, dark): file hashes + metadata, the
        // owner app per file and the app blocks referenced by editor data,
        // built while the files are in memory and persisted here (upsert, so
        // a step retry is idempotent). Never fails the scan: on error it logs
        // and the scan carries on exactly as before. Only two counts cross
        // the step boundary, never the manifest.
        const manifest = await persistScanManifest({
          scanId,
          shopId,
          themeId,
          fileMetas,
          files,
        });

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
        // deterministic; a cap hit marks the price audit capped (below, gc-11f).
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

        // Signature names of apps with an ENABLED theme app embed (small).
        const embedApps = [...enabledAppEmbedApps(files)].sort();
        // Built only while the storefront audit is live (see the keys below).
        const missingSnippets = isScriptTagSunsetLive()
          ? buildMissingSnippetIndex(files, filenamesWithoutText)
          : null;
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
          // gc-dcyh Phase 0 (dark): present only while its flag is on.
          ...(suspiciousCode ? { suspiciousCode } : {}),
          // gc-7gjj.2 Phase 0 (dark): present only while its flag is on.
          ...(menuLabels ? { menuLabels } : {}),
          suppressedDetectorHits,
          // Recorded on the scan by finalize-scan (gc-rvo0); computed from the
          // same flag reads as the persistence filter above. Small string[].
          liveFindingTypes: scanLiveFindingTypes,
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
          // Signature names of apps with an ENABLED theme app embed, for the
          // storefront script-tag audit below (theme files cannot cross the
          // step boundary). Present ONLY while SCRIPT_TAG_SUNSET is live, so a
          // dark scan's step output is unchanged; its presence is also what
          // schedules that audit step, so the decision is made once, here,
          // inside this memoized step.
          ...(isScriptTagSunsetLive() ? { enabledEmbedApps: embedApps } : {}),
          // Snippets this theme renders but does not contain, with the files
          // that render them (gc-i6du): what confirms a missing-snippet Liquid
          // error read from the homepage in the storefront step below. Small
          // and bounded: at most 50 snippets x 50 files of at most ~130
          // characters each, about 350 KB against the 3 MB budget below.
          // `missingSnippetsCapped` = the index was cut (more than 50 missing
          // snippets, or a snippet rendered by more than 50 files), so the
          // check may be recorded as capped (gc-wr81, gc-wnhs M3). Like
          // the key above, both are present ONLY while the storefront audit
          // is live.
          ...(missingSnippets
            ? {
                missingSnippetRenders: missingSnippets.renders,
                missingSnippetsCapped: missingSnippets.capped,
              }
            : {}),
          // App-removal detection (gc-frda) records this as the scan's embed
          // live hooks. null = settings_data.json not observed (missing,
          // unparseable, or no `current` object), never [] (observedEmbedApps).
          appsWithEnabledEmbed: observedEmbedApps(files),
          // Theme health (gc-i6du): the theme's name / version / author and
          // whether it is Online Store 2.0, from files already in memory. Four
          // short bounded values; recorded on the scan by finalize-scan.
          themeInfo: readThemeInfo(files),
          // Change log (gc-rrh.4): whether this theme is the published one
          // (null = unknown), and the persisted manifest's size (nulls = not
          // persisted). Three scalars; read by the compute-changes step.
          isPublishedTheme,
          manifestFileCount: manifest.manifestFileCount,
          manifestBytes: manifest.manifestBytes,
        };

        // Defensive step-output budget (gc-4ce). The caps keep the worst case
        // far below Inngest's 4 MB limit, but if the output is still over
        // budget, drop the dangling candidates for this scan rather than fail
        // the whole scan, then RE-MEASURE; if still over, drop the static
        // JSON-LD candidates too. Each dropped audit reports its category
        // capped (gc-11f) so the differ keeps its prior findings.
        const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
        if (outputBytes <= CORE_STEP_OUTPUT_BUDGET_BYTES) return output;

        logger.warn("fetch-and-scan output over step-output budget; dropping dangling candidates", {
          function: "scan-theme",
          event: "dangling_output_truncated",
          shopId,
          outputBytes,
          budgetBytes: CORE_STEP_OUTPUT_BUDGET_BYTES,
          danglingOccurrenceCount: dangling.occurrences.length,
        });
        const withoutDangling = {
          ...output,
          danglingOccurrences: [],
          danglingDistinctHandles: [],
          danglingTruncated: true,
        };
        const bytesWithoutDangling = Buffer.byteLength(JSON.stringify(withoutDangling), "utf8");
        if (bytesWithoutDangling <= CORE_STEP_OUTPUT_BUDGET_BYTES) return withoutDangling;

        logger.warn(
          "fetch-and-scan output still over step-output budget; dropping static JSON-LD candidates",
          {
            function: "scan-theme",
            event: "static_candidates_output_truncated",
            shopId,
            outputBytes: bytesWithoutDangling,
            budgetBytes: CORE_STEP_OUTPUT_BUDGET_BYTES,
            staticCandidateCount: boundedStaticCandidates.length,
          },
        );
        return {
          ...withoutDangling,
          staticProductCandidates: [],
          staticCandidatesCapped: true,
        };
      });

      // Step 2b: ONE granted-scope lookup per scan (gc-5l9), shared by every
      // optional audit below. Its own step so Inngest memoizes it: retries of a
      // later step reuse this result instead of re-querying. The output is tiny
      // (at most the four optional scope handles, or null when the lookup
      // failed, in which case every scope check falls back to its probe).
      const { grantedOptionalScopes } = await step.run("fetch-granted-scopes", async () => {
        const db = (await import("../../app/db.server")).default;
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        // No shop record: the audit steps no-op anyway; null = "unknown".
        if (!shop) return { grantedOptionalScopes: null };

        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(shop.domain);
        const { fetchGrantedOptionalScopes } = await import("../../app/lib/scope-check.server");
        return { grantedOptionalScopes: await fetchGrantedOptionalScopes(admin, shopId) };
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

        const hasScope = await hasTranslationScope(admin, grantedOptionalScopes);
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
      //
      // Plan-aware caps, split across steps (gc-747u): a paid plan walks up to
      // 10x the Free cap, which can take minutes under the rate limit, so the
      // walk runs in steps of at most WALK_STEP_TIME_BUDGET_MS each. Step 0
      // keeps the original "product-audit" id (a Free walk usually fits in it,
      // exactly as before); each later step resumes from the previous one's
      // memoized cursor, so replays are deterministic.
      const productsStart = Date.now();
      const productChunks: ProductChunkResult[] = [];
      let productChunk = await step.run("product-audit", () =>
        runProductAuditChunk({
          scanId,
          shopId,
          grantedOptionalScopes,
          index: 0,
          after: null,
          checkedSoFar: 0,
          cap: null,
          throttle: null,
          walkDeadline: null,
          lastIdSoFar: null,
        }),
      );
      productChunks.push(productChunk);
      while (productChunk.next) {
        const prev = productChunk;
        const index = productChunks.length;
        productChunk = await step.run(`product-audit-${index + 1}`, () =>
          runProductAuditChunk({
            scanId,
            shopId,
            grantedOptionalScopes,
            index,
            after: prev.next!.after,
            checkedSoFar: prev.checked,
            cap: prev.cap,
            // Absent on a step memoized before audit #3: no carried wait.
            throttle: prev.throttle ?? null,
            // Step 0's memoized deadline (audit #1); absent only on a step
            // memoized before it, which then starts the budget here.
            walkDeadline: prev.walkDeadline ?? null,
            lastIdSoFar: prev.lastId ?? null,
          }),
        );
        productChunks.push(productChunk);
      }
      const sumProducts = (pick: (c: ProductChunkResult) => number) =>
        productChunks.reduce((total, c) => total + pick(c), 0);
      const productResult = {
        tagCount: sumProducts((c) => c.tagCount),
        priceCount: sumProducts((c) => c.priceCount),
        metafieldCount: sumProducts((c) => c.metafieldCount),
        scopeAbsent: productChunks[0].scopeAbsent,
        truncated: productChunk.truncated,
        tagGap: productChunks.some((c) => c.tagGap),
        priceGap: productChunks.some((c) => c.priceGap),
        metafieldGap: productChunks.some((c) => c.metafieldGap),
        pageCount: sumProducts((c) => c.pageCount),
        throttleSleepMs: sumProducts((c) => c.throttleSleepMs),
        walkMs: sumProducts((c) => c.walkMs ?? 0),
        cost: sumQueryCost(productChunks.map((c) => c.cost)),
        steps: productChunks.length,
        // Absent on a run memoized before gc-747u: no coverage recorded.
        coverage: productChunk.coverage ?? null,
      };
      const productsMs = Date.now() - productsStart;

      // Per-category skip (gc-1bd): a product category is un-audited (excluded
      // from the differ's resolved-detection) when the scope was absent (applies
      // to all three uniformly), OR that specific detector threw. Truncation is
      // deliberately NOT here (Option C): a cap-truncated walk still fully audited
      // the scanned subset, so its findings must diff normally — treating it as a
      // coverage gap dropped the prior findings for that subset and reported the
      // still-present current ones as "new" every rescan. Records PAST the cap are
      // handled per record instead (gc-747u): the walk's coverage window is
      // stored on the scan (`walkCoverage`) and the differ never resolves a prior
      // finding beyond it.
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
            return hasContentScope(admin, grantedOptionalScopes);
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

      // Redirect walk, plan-aware and split across steps like the product walk
      // (gc-747u). Truncation stays telemetry for the CATEGORY (Option C); the
      // per-record window is recorded in walkCoverage for the differ.
      const redirectsStart = Date.now();
      const redirectChunks: RedirectChunkResult[] = [];
      let redirectChunk = await step.run("redirect-audit", () =>
        runRedirectAuditChunk({
          scanId,
          shopId,
          grantedOptionalScopes,
          index: 0,
          after: null,
          checkedSoFar: 0,
          cap: null,
          groups: null,
          throttle: null,
          walkDeadline: null,
          lastIdSoFar: null,
        }),
      );
      redirectChunks.push(redirectChunk);
      while (redirectChunk.next) {
        const prev = redirectChunk;
        const index = redirectChunks.length;
        redirectChunk = await step.run(`redirect-audit-${index + 1}`, () =>
          runRedirectAuditChunk({
            scanId,
            shopId,
            grantedOptionalScopes,
            index,
            after: prev.next!.after,
            checkedSoFar: prev.checked,
            cap: prev.cap,
            groups: prev.next!.groups,
            throttle: prev.throttle ?? null,
            walkDeadline: prev.walkDeadline ?? null,
            lastIdSoFar: prev.lastId ?? null,
          }),
        );
        redirectChunks.push(redirectChunk);
      }
      const sumRedirects = (pick: (c: RedirectChunkResult) => number) =>
        redirectChunks.reduce((total, c) => total + pick(c), 0);
      const redirectResult = {
        findingCount: sumRedirects((c) => c.findingCount),
        skipped: redirectChunks[0].skipped,
        capped: redirectChunks.some((c) => c.capped === true),
        truncated: redirectChunk.truncated === true,
        pageCount: sumRedirects((c) => c.pageCount ?? 0),
        throttleSleepMs: sumRedirects((c) => c.throttleSleepMs ?? 0),
        walkMs: sumRedirects((c) => c.walkMs ?? 0),
        cost: sumQueryCost(redirectChunks.map((c) => c.cost)),
        steps: redirectChunks.length,
        // Absent on a run memoized before gc-747u: no coverage recorded.
        coverage: redirectChunk.coverage ?? null,
      };

      const redirectsMs = Date.now() - redirectsStart;

      // Menu-label injection audit (gc-7gjj.1): one walk, no chunking (the
      // caps bound it to MENU_CAP / MENU_PAGE_SIZE pages). Dark unless
      // MENU_INJECTION_LIVE_ENABLED is "true" (inert: no request).
      const menusStart = Date.now();
      const menuResult = await step.run("menu-audit", () =>
        runMenuAudit({
          scanId,
          shopId,
          grantedOptionalScopes,
          live:
            Array.isArray(persistedLiveFindingTypes) &&
            persistedLiveFindingTypes.includes(FindingType.MENU_INJECTION),
        }),
      );
      const menusMs = Date.now() - menusStart;

      // What the capped walks covered (gc-747u), for the differ and the scan
      // page disclosure. Only walks that ran get a key. A walk whose first step
      // was memoized before gc-747u (no `cap` in its output) walked the old
      // Free caps without recording a window, so it gets no key: per walk
      // (audit #4), so a run that straddled the deploy keeps the other walk's
      // window. The differ reads a missing key in a baseline as legacy for that
      // walk. Both walks old: the column stays NULL (a legacy scan).
      const productWalkNew = productChunks[0].cap !== undefined;
      const redirectWalkNew = redirectChunks[0].cap !== undefined;
      const walkCoverage: ScanWalkCoverage | undefined =
        !productWalkNew && !redirectWalkNew
          ? undefined
          : {
              ...(productWalkNew && productResult.coverage
                ? { products: productResult.coverage }
                : {}),
              ...(redirectWalkNew && redirectResult.coverage
                ? { redirects: redirectResult.coverage }
                : {}),
            };

      // Step 9: Live-price audit for stale static JSON-LD (optional — requires
      // read_products scope AND the JSONLD_LIVE_PRICE_ENABLED flag). Modeled on
      // translation-audit: it has extra pre-conditions (flag + candidate list),
      // so it does not use runAuditStep.
      //
      // Double-inert soft-launch (gc-47c.10): when the flag is OFF the step is
      // fully inert and returns skipped:false (NOT a scope skip — the category is
      // not "un-audited due to missing scope", it is deliberately disabled). Only
      // once the flag is ON does a genuinely missing read_products scope report
      // skipped:true → skippedCategories, and a size cap report capped:true →
      // cappedCategories (gc-11f).
      const jsonLdPriceResult: CappableAuditStepResult = await step.run(
        "product-price-audit",
        async () => {
          const { logger } = await import("../../app/lib/logger.server");

          if (process.env.JSONLD_LIVE_PRICE_ENABLED !== "true") {
            // Flag off: inert. Not a scope skip, not capped.
            return { findingCount: 0, skipped: false, capped: false };
          }

          // Nothing to correlate — the theme had no unsigned static Product
          // JSON-LD. Audited (nothing to check), not a scope skip. Unless the
          // step-output budget dropped every candidate (gc-4ce): then nothing was
          // checked, so the category is capped and prior findings are kept.
          if (staticProductCandidates.length === 0) {
            return { findingCount: 0, skipped: false, capped: staticCandidatesCapped };
          }

          const db = (await import("../../app/db.server")).default;
          const shop = await db.shop.findUnique({ where: { id: shopId } });
          if (!shop) return { findingCount: 0, skipped: false, capped: false };

          const { unauthenticated } = await import("../../app/shopify.server");
          const { admin } = await unauthenticated.admin(shop.domain);

          const { hasProductScope } = await import("../../app/services/product-fetcher.server");
          const hasScope = await hasProductScope(admin, grantedOptionalScopes);
          if (!hasScope) {
            logger.info("read_products scope not available — skipping live-price audit", {
              function: "scan-theme",
              stepName: "product-price-audit",
              shopId,
            });
            // Scope not granted → category NOT audited (recorded in skippedCategories).
            // The candidate cap may ALSO have dropped some (recorded in cappedCategories).
            return { findingCount: 0, skipped: true, capped: staticCandidatesCapped };
          }

          const { auditStaticJsonLdPrices } =
            await import("../../app/services/jsonld-price-audit.server");
          const {
            findings: priceFindings,
            skipped: auditSkipped,
            capped: auditCapped,
          } = await auditStaticJsonLdPrices(admin, staticProductCandidates, shopId);

          await persistAuditFindings({
            scanId,
            shopId,
            findingType: FindingType.JSON_LD_PRICE_CONFLICT,
            findings: priceFindings,
            event: "jsonld_price_findings",
            logMessage: "live-price JSON-LD findings persisted",
          });

          // The audit could not fully cover the candidates for one of two
          // distinct reasons (gc-11f), each recorded so the differ does not
          // false-resolve the prior findings we could not re-check:
          //   - skipped: read_products revoked mid-scan (a scope problem →
          //     skippedCategories, drives the permissions banner);
          //   - capped:  lookup-budget truncation, or the candidate cap dropped
          //     some before the audit (gc-4ce) (a size cap → cappedCategories).
          return {
            findingCount: priceFindings.length,
            skipped: auditSkipped,
            capped: auditCapped || staticCandidatesCapped,
          };
        },
      );

      // Step 10: Dangling-reference audit (optional — requires a Standard+ plan
      // AND read_products and/or read_content scope AND the
      // DANGLING_REFERENCE_LIVE_ENABLED flag). Modeled on the live-price audit:
      // it has extra pre-conditions (flag + plan + candidate list + per-entity
      // scope gates), so it does not use runAuditStep.
      //
      // Double-inert soft-launch (gc-m4h.5): when the flag is OFF the step is
      // fully inert — it does NOT resolve, persist, or count — and returns
      // skipped:false (flag-off is a deliberate disable, not an un-audited scope
      // skip). Only once the flag is ON does a missing scope report
      // skipped:true → skippedCategories, and a lookup-budget / handle /
      // occurrence / step-output cap report capped:true → cappedCategories
      // (gc-11f).
      const danglingRefResult: CappableAuditStepResult = await step.run(
        "dangling-reference-audit",
        async () => {
          if (process.env.DANGLING_REFERENCE_LIVE_ENABLED !== "true") {
            // Flag off: inert. Not a scope skip, not capped.
            return { findingCount: 0, skipped: false, capped: false };
          }

          // No static references in the theme — nothing to resolve. Audited
          // (nothing to check), not a scope skip. (Candidates dropped by the
          // step-output budget are NOT "nothing to check"; handled below.)
          if (danglingDistinctHandles.length === 0 && !danglingTruncated) {
            return { findingCount: 0, skipped: false, capped: false };
          }

          const db = (await import("../../app/db.server")).default;
          const shop = await db.shop.findUnique({ where: { id: shopId } });
          if (!shop) return { findingCount: 0, skipped: false, capped: false };

          // Plan gate (gc-m4h.7): dangling-reference detection is Standard+.
          // For Free shops the step is inert exactly like the flag-off path — no
          // resolve, no persist, no count. This is NOT a scope skip: the category
          // is deliberately withheld by plan (like flag-off), not left un-audited
          // for lack of scope, so it must NOT enter skippedCategories or
          // cappedCategories (that would misreport an un-run category and
          // suppress the differ's resolved-detection).
          // Checked before any Admin API work so the cheap gate short-circuits first.
          const { canDetectDanglingReferences } = await import("../../app/lib/plan-gating.server");
          if (!canDetectDanglingReferences(shop.plan)) {
            return { findingCount: 0, skipped: false, capped: false };
          }

          // Candidates were dropped by the step-output budget (gc-4ce): nothing
          // was checked, so the category is un-audited this scan and prior
          // DANGLING_REFERENCE findings must not be false-resolved. A size cap,
          // not a scope problem → capped (gc-11f).
          if (danglingTruncated) {
            return { findingCount: 0, skipped: false, capped: true };
          }

          const { unauthenticated } = await import("../../app/shopify.server");
          const { admin } = await unauthenticated.admin(shop.domain);

          const { resolveDanglingReferences } =
            await import("../../app/services/dangling-reference-resolver.server");
          const { missing, scopeStatus, truncated } = await resolveDanglingReferences(
            admin,
            danglingDistinctHandles,
            shopId,
            grantedOptionalScopes,
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

          // Precise-skip rule (spike §D / R1), split by reason (gc-11f):
          //   - skipped (scope): a static ref of a type whose scope is absent
          //     was present.
          //   - capped (size): the lookup budget truncated, OR the extractor
          //     dropped handles (gc-4ce), OR a MISSING handle had occurrences
          //     past the per-handle cap (those got no finding).
          // An EXISTING handle over the per-handle cap loses nothing, so it must
          // not cap: that would drop the category from the diff, re-reporting
          // every finding as new and never resolving fixes.
          const missingOverOccurrenceCap = missing.some(
            (m) =>
              (occurrenceCounts.get(`${m.entityType} ${m.handle}`) ?? 0) >
              DANGLING_MAX_OCCURRENCES_PER_HANDLE,
          );
          const skipped = scopeStatus.products === "absent" || scopeStatus.content === "absent";
          const capped = truncated || danglingCapped || missingOverOccurrenceCap;
          return { findingCount: danglingFindings.length, skipped, capped };
        },
      );

      // Step 11: Storefront script-tag audit (SCRIPT_TAG_SUNSET). DARK: it runs
      // only when fetch-and-scan recorded `enabledEmbedApps`, which it does only
      // while SCRIPT_TAG_SUNSET_LIVE_ENABLED === "true". Flag off = no step, no
      // Admin query, no storefront request, no category, no finding (the
      // fetcher re-checks the flag before any request, belt and braces).
      //
      // Not scope-gated. Only the PUBLISHED (MAIN) theme is checked, since the
      // storefront renders only that one; any other theme is skipped silently.
      // When the public storefront cannot be read (password page, timeout,
      // non-2xx, blocked address, not a Shopify page, unparseable block) the
      // category is recorded in `unreachableCategories` so the differ keeps
      // its prior findings; that is not a scope problem (no banner, no PARTIAL).
      //
      // `audited` is false when nothing was checked (flag flipped off mid-run,
      // unpublished theme, no shop): finalize then drops SCRIPT_TAG_SUNSET from
      // the scan's live set so the differ treats the type as un-audited.
      //
      // Failure split: a failure while READING (Admin lookup, fetch) is caught
      // and reported unreachable, never failing the scan. Persistence runs
      // outside that guard: a DB failure throws so Inngest retries the step,
      // and the retry starts by clearing this scan's SCRIPT_TAG_SUNSET rows, so
      // it never duplicates or leaves stale rows.
      //
      // Homepage Liquid errors (LIQUID_ERROR_RENDERED, gc-i6du) ride on this
      // step: the fetcher parses missing-snippet errors from the SAME page in
      // memory and hands back only parsed parts (never HTML or page text), and
      // a finding is kept only when the theme confirms it. Everything above
      // applies unchanged: same flag, published theme only, both categories
      // unreachable together, dropped from the live set when not checked, and
      // the same clear-then-persist retry rule.
      const scriptTagResult: {
        findingCount: number;
        unreachable: boolean;
        audited: boolean;
        // LIQUID_ERROR_RENDERED rows persisted (gc-i6du). Absent for a run
        // memoized before the field: read as 0.
        liquidErrorCount?: number;
        // Set when the storefront was read: whether the Liquid error check
        // actually ran (false: its parser or the corroboration failed, or the
        // theme-side index was not available). false = the type is dropped
        // from the scan's live set, so it is never "fixed" and never shown as
        // clean. Absent when the storefront was unreachable (the category is
        // recorded in unreachableCategories instead) or not checked at all.
        liquidAudited?: boolean;
        // Set when liquidAudited: whether the index's cuts could have changed
        // this page's result (liquidCheckCapped, gc-wnhs M3). Absent for a run
        // memoized before the field: the old category-wide rule applies.
        liquidCapped?: boolean;
        // App names loading through a storefront ScriptTag (gc-frda live hook).
        // Present only when the storefront was read and no detector cap hit;
        // absent = not observed (also for a run memoized before the field).
        scriptTagApps?: string[];
        // gc-0htk: homepage MALICIOUS_SCRIPT rows persisted. Present only when
        // the runtime check actually matched a readable page; absent = not
        // checked (flag off, unreachable, or the match failed), so the scan
        // records no homepage coverage (finalLiveFindingTypes).
        homepageMaliciousCount?: number;
      } = Array.isArray(enabledEmbedApps)
        ? await step.run("storefront-script-tags", async () => {
            const { logger } = await import("../../app/lib/logger.server");
            const db = (await import("../../app/db.server")).default;
            const shop = await db.shop.findUnique({ where: { id: shopId } });
            if (!shop) return { findingCount: 0, unreachable: false, audited: false };
            let storefront: StorefrontScriptTagResult;
            try {
              const { unauthenticated } = await import("../../app/shopify.server");
              const { admin } = await unauthenticated.admin(shop.domain);
              const { fetchStorefrontScriptTags } =
                await import("../../app/services/storefront-fetcher.server");
              storefront = await fetchStorefrontScriptTags(admin, { shopId, themeId });
            } catch (err) {
              // Name + a short message only: a library error can echo values.
              logger.warn("storefront script-tag read failed, recorded as unreachable", {
                function: "scan-theme",
                stepName: "storefront-script-tags",
                shopId,
                errorName: err instanceof Error ? err.name : typeof err,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
              });
              storefront = { status: "unreachable", reason: "network" };
            }
            // gc-0htk / gc-3y89 item 1: clear an earlier attempt's homepage
            // rows on EVERY attempt, whatever the runtime flag says now and
            // before any early return: a flag turned off between a failed
            // attempt and its retry must not leave those rows behind. Only the
            // homepage rows, never the theme's MALICIOUS_SCRIPT.
            await db.finding.deleteMany({
              where: {
                scanId,
                findingType: FindingType.MALICIOUS_SCRIPT,
                filename: HOMEPAGE_MALICIOUS_FILENAME,
              },
            });
            // Flag flipped off mid-scan, or not the published theme: nothing
            // was requested and nothing is recorded.
            if (storefront.status === "disabled" || storefront.status === "not_published") {
              return { findingCount: 0, unreachable: false, audited: false };
            }

            // Idempotent on retry: clear any rows an earlier attempt wrote.
            await db.finding.deleteMany({
              where: { scanId, findingType: FindingType.SCRIPT_TAG_SUNSET },
            });
            await db.finding.deleteMany({
              where: { scanId, findingType: FindingType.LIQUID_ERROR_RENDERED },
            });
            if (storefront.status === "unreachable") {
              return { findingCount: 0, unreachable: true, audited: true, liquidErrorCount: 0 };
            }

            const { detectScriptTagSunset } =
              await import("../../app/services/script-tag-sunset-detector.server");
            const groups = detectScriptTagSunset(storefront.urls, new Set(enabledEmbedApps));
            // Same soft-launch filter as every other detector (gc-rvo0).
            const findings = groups.filter((f) => isSoftLaunchLive(f.findingType));
            // Live hooks come from every group (persisted or not): this set
            // is what was observed on the storefront, not what is shown.
            const { scriptTagHookApps } = await import("../../app/services/app-removal.server");
            const scriptTagApps = scriptTagHookApps(storefront.urls, groups);

            await persistAuditFindings({
              scanId,
              shopId,
              findingType: FindingType.SCRIPT_TAG_SUNSET,
              findings,
              event: "script_tag_sunset_findings",
              logMessage: "script tag sunset findings persisted",
            });
            // Missing-snippet Liquid errors printed on the same page (gc-i6du),
            // kept ONLY when the theme confirms them: the snippet is absent
            // from the scanned theme and a theme file renders it
            // (missingSnippetRenders, built in fetch-and-scan where the theme
            // files were in memory). Isolated: a failure here is logged,
            // yields no Liquid finding and marks the check as not run; it
            // never touches the script-tag result or fails the scan.
            let liquidErrorFindings: CreateFindingInput[] = [];
            let liquidAudited = false;
            let liquidCapped = false;
            if (storefront.liquidErrors !== null && Array.isArray(missingSnippetRenders)) {
              try {
                const { detectLiquidErrors, liquidCheckCapped } =
                  await import("../../app/services/liquid-error-detector.server");
                liquidErrorFindings = detectLiquidErrors(
                  storefront.liquidErrors,
                  missingSnippetRenders,
                ).filter((f) => isSoftLaunchLive(f.findingType));
                liquidCapped = liquidCheckCapped(
                  storefront.liquidErrors,
                  missingSnippetRenders,
                  missingSnippetsCapped === true,
                );
                liquidAudited = true;
              } catch (err) {
                liquidErrorFindings = [];
                logger.warn("liquid error check failed, recorded as not run", {
                  function: "scan-theme",
                  stepName: "storefront-script-tags",
                  shopId,
                  errorName: err instanceof Error ? err.name : typeof err,
                });
              }
            }
            await persistAuditFindings({
              scanId,
              shopId,
              findingType: FindingType.LIQUID_ERROR_RENDERED,
              findings: liquidErrorFindings,
              event: "liquid_error_findings",
              logMessage: "rendered liquid error findings persisted",
            });
            const homepageMaliciousCount = Array.isArray(storefront.maliciousHits)
              ? await persistHomepageMalicious({ scanId, shopId, hits: storefront.maliciousHits })
              : undefined;
            return {
              findingCount: findings.length,
              unreachable: false,
              audited: true,
              liquidErrorCount: liquidErrorFindings.length,
              liquidAudited,
              ...(liquidAudited ? { liquidCapped } : {}),
              ...(scriptTagApps ? { scriptTagApps } : {}),
              ...(homepageMaliciousCount !== undefined ? { homepageMaliciousCount } : {}),
            };
          })
        : { findingCount: 0, unreachable: false, audited: false };

      const totalFindings =
        findingCount +
        translationResult.findingCount +
        productResult.tagCount +
        productResult.priceCount +
        pageResult.findingCount +
        productResult.metafieldCount +
        redirectResult.findingCount +
        jsonLdPriceResult.findingCount +
        danglingRefResult.findingCount +
        scriptTagResult.findingCount +
        (scriptTagResult.liquidErrorCount ?? 0) +
        (scriptTagResult.homepageMaliciousCount ?? 0);

      // Collect the optional categories that were skipped because their scope
      // was not granted. Each entry maps 1:1 to a FindingType so the differ can
      // exclude that category's prior findings from "resolved" (LOG-4). The scan
      // still finalizes COMPLETED (below); this list drives the scan-detail
      // permissions banner, so it is SCOPE-ONLY (gc-11f; the product detector-
      // throw gaps above are the one pre-existing non-scope entry).
      // NOTE (gc-47c.10): the live-price audit emits JSON_LD_PRICE_CONFLICT, a
      // type EXCLUSIVE to it (the worker's same-file conflict detector uses the
      // separate JSON_LD_CONFLICT type). So listing JSON_LD_PRICE_CONFLICT here
      // when the audit is skipped (scope not granted, or mid-scan revocation)
      // excludes exactly this audit's prior findings from resolved-detection
      // (LOG-4) without touching the worker's rows.
      const skippedCategories: string[] = flaggedCategories([
        [translationResult.skipped, FindingType.GHOST_TRANSLATION],
        [tagSkipped, FindingType.GHOST_TAG],
        [priceSkipped, FindingType.GHOST_PRICE],
        [pageResult.skipped, FindingType.GHOST_PAGE],
        [metafieldSkipped, FindingType.GHOST_METAFIELD],
        [redirectResult.skipped, FindingType.GHOST_REDIRECT],
        [jsonLdPriceResult.skipped, FindingType.JSON_LD_PRICE_CONFLICT],
        [danglingRefResult.skipped, FindingType.DANGLING_REFERENCE],
        // gc-7gjj.1: its own type, so a missing navigation scope never makes
        // the theme or homepage MALICIOUS_SCRIPT findings un-audited.
        [menuResult.skipped, FindingType.MENU_INJECTION],
      ]);

      // Categories whose audit ran (scope granted) but a SIZE cap left part of
      // it unchecked (gc-11f). The differ excludes these from "resolved" too
      // (via unauditedCategories), but they drive an info notice, never the
      // permissions banner, and never change the status. A category is in both
      // lists only when both happened this scan.
      const cappedCategories: string[] = flaggedCategories([
        [jsonLdPriceResult.capped, FindingType.JSON_LD_PRICE_CONFLICT],
        [danglingRefResult.capped, FindingType.DANGLING_REFERENCE],
        // gc-747u: the bulk-redirect tally outgrew its step-boundary budget, so
        // bulk patterns were not checked this scan.
        [redirectResult.capped, FindingType.GHOST_REDIRECT],
        // gc-7gjj.1: MENU_CAP or MENU_ITEM_CAP left some menu items unread.
        [menuResult.capped, FindingType.MENU_INJECTION],
        // gc-wr81: the missing-snippet index was cut (more missing snippets
        // than it keeps, or a snippet rendered by more files than it keeps),
        // so an error naming one past a cut could not be confirmed. gc-wnhs
        // M3: only when such an error is actually on the page (liquidCapped);
        // a run memoized before that field keeps the category-wide rule. Only
        // when the Liquid check actually ran: an unreadable storefront is
        // recorded as unreachable (below), a failed or dark check as not run.
        [
          missingSnippetsCapped === true &&
            scriptTagResult.liquidAudited === true &&
            scriptTagResult.liquidCapped !== false,
          FindingType.LIQUID_ERROR_RENDERED,
        ],
      ]);

      // Categories whose check could not run because the public storefront could
      // not be read. Un-audited for the differ (unauditedCategories), but never
      // the permissions banner and never PARTIAL. Always empty while dark.
      const unreachableCategories: string[] = flaggedCategories([
        [scriptTagResult.unreachable, FindingType.SCRIPT_TAG_SUNSET],
        // Read from the same page (gc-i6du): unreadable together.
        [scriptTagResult.unreachable, FindingType.LIQUID_ERROR_RENDERED],
      ]);

      // Walks that hit their cap this scan (gc-1bd). Surfaced in scan_signal for
      // observability (Option C): truncation is deliberately NOT reflected in
      // skippedCategories or cappedCategories, so the differ still diffs the
      // scanned subset normally. The per-record window is `walkCoverage`
      // (gc-747u), which also drives the scan page's "checked N of M" notice.
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
      // scope or capped. `skippedCategories` / `cappedCategories` (built above)
      // record which, for (a) the diff engine (LOG-4) and (b) the scan-detail
      // permissions warning / cap notice. Caps never change status (gc-11f).
      const finalStatus = ScanStatus.COMPLETED;

      // The scan's live set (gc-rvo0), from the fetch-and-scan flag reads, minus
      // the storefront findings (isStorefrontFinding: SCRIPT_TAG_SUNSET and
      // LIQUID_ERROR_RENDERED, both read by the one storefront step) when that
      // step did not actually check anything (flag flipped off mid-run,
      // unpublished theme, no shop): the differ then treats the types as
      // un-audited, so their prior findings are neither resolved nor new. A
      // no-op while dark (the types are not live then). NULL (undefined) for
      // an in-flight run memoized before the field existed.
      // gc-0htk: plus the homepage malicious check's coverage key, only when
      // it actually matched a readable page this scan.
      const finalLiveFindingTypes = Array.isArray(persistedLiveFindingTypes)
        ? [
            ...persistedLiveFindingTypes.filter(
              (t) =>
                (!isStorefrontFinding(t) ||
                  (scriptTagResult.audited &&
                    (t !== FindingType.LIQUID_ERROR_RENDERED ||
                      scriptTagResult.liquidAudited !== false))) &&
                // gc-7gjj.1: the menu audit is live for this scan only when
                // its walk actually ran (flag flipped mid-run, no shop: not).
                (t !== FindingType.MENU_INJECTION || menuResult.audited === true),
            ),
            ...(scriptTagResult.homepageMaliciousCount !== undefined
              ? [HOMEPAGE_MALICIOUS_COVERAGE_KEY]
              : []),
          ]
        : undefined;
      // What THIS scan audited, for every diff below (finalize + summary email).
      const currentCoverage = {
        skippedCategories,
        cappedCategories,
        unreachableCategories,
        skippedFiles: skippedFilePaths,
        liveFindingTypes: finalLiveFindingTypes,
        walkCoverage,
      };

      // FINAL step: compute resolution counts vs the previous scan, then set the
      // terminal status. This is the ONLY place the scan leaves IN_PROGRESS on the
      // success path (LOG-4). Idempotent on retry.
      await step.run("finalize-scan", async () => {
        const db = (await import("../../app/db.server")).default;

        // Diff this scan's persisted findings against the previous completed scan
        // for this theme (Feature 3). REUSE the differ so scope-skipped and
        // capped categories and unscanned oversized files are excluded from
        // "resolved" (LOG-4, gc-11f).
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
          const { diffScans, scanDiffOptions } =
            await import("../../app/services/scan-differ.server");
          // Coverage gaps on either side (scanDiffOptions): un-audited now =
          // never resolved; un-audited in the baseline = never new.
          const diff = diffScans(
            currentFindings,
            previousScan.findings,
            scanDiffOptions(currentCoverage, previousScan),
          );
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

        const { computeAppSignatureFingerprints } =
          await import("../../app/services/app-removal.server");
        const appSignatureFingerprints = computeAppSignatureFingerprints();
        // Live hooks observed this scan (gc-frda). null = source not observed:
        // the embed set is null when settings_data.json could not be read
        // (observedEmbedApps) or absent for a run memoized before the field;
        // the ScriptTag set needs a storefront read that was not capped.
        const liveAppHooks = {
          embedApps: Array.isArray(appsWithEnabledEmbed) ? appsWithEnabledEmbed : null,
          scriptTagApps:
            scriptTagResult.audited &&
            !scriptTagResult.unreachable &&
            Array.isArray(scriptTagResult.scriptTagApps)
              ? scriptTagResult.scriptTagApps
              : null,
        };

        const finalized = await finalizeScan(scanId, {
          status: finalStatus,
          findingCount: totalFindings,
          skippedCategories,
          cappedCategories,
          skippedFiles: skippedFilePaths,
          // Only sent when non-empty (the column defaults to []), so a dark
          // scan's finalize write is unchanged.
          ...(unreachableCategories.length > 0 ? { unreachableCategories } : {}),
          newFindingCount,
          resolvedFindingCount,
          persistedFindingCount,
          // From the fetch-and-scan output (same flag reads as persistence), see
          // finalLiveFindingTypes. An in-flight run memoized before this field
          // existed lacks it: record NULL so the scan stays unversioned and the
          // summary-email step skips it.
          liveFindingTypes: finalLiveFindingTypes,
          // Signature version per app, for app-removal detection (gc-frda).
          appSignatureFingerprints,
          liveAppHooks,
          // What the capped walks covered (gc-747u): the differ's record windows
          // and the scan page's "checked N of M" notice.
          walkCoverage,
          // Theme health (gc-i6du). Absent for a run memoized before the
          // field: the column stays NULL.
          ...(themeInfo ? { themeInfo } : {}),
        });

        // App-removal detection (gc-frda). Never fails or retries the scan: the
        // scan is already finalized, so any error is logged and swallowed. Runs
        // only when THIS attempt finalized the scan (a watchdog-FAILED scan is
        // not a baseline) and a baseline exists (no baseline = nothing to
        // compare, and no open record can be judged).
        if (finalized?.finalized && previousScan) {
          try {
            const [{ planAppRemovals }, appRemovals, { getIgnoredFindingsForShop }] =
              await Promise.all([
                import("../../app/services/app-removal.server"),
                import("../../app/models/app-removal.server"),
                import("../../app/models/ignored-finding.server"),
              ]);
            const [ignores, openRemovals] = await Promise.all([
              getIgnoredFindingsForShop(shopId),
              appRemovals.getOpenAppRemovals(shopId, themeId),
            ]);
            const plan = planAppRemovals({
              currentScanId: scanId,
              current: {
                ...currentCoverage,
                findings: currentFindings,
                appSignatureFingerprints,
                liveAppHooks,
              },
              previous: previousScan,
              openRemovals,
              ignores,
            });
            const written = await appRemovals.applyAppRemovalPlan({
              shopId,
              themeId,
              scanId,
              previousScanId: previousScan.id,
              plan,
            });
            if (written.created > 0 || written.updated > 0) {
              logger.info("app removals recorded", {
                function: "scan-theme",
                event: "app_removals",
                scanId,
                shopId,
                removedApps: plan.creates.map((c) => c.appName),
                created: written.created,
                updated: written.updated,
              });
            }
          } catch (err) {
            logger.error("app-removal detection failed, scan unaffected", {
              function: "scan-theme",
              event: "app_removals_failed",
              scanId,
              shopId,
              error: err instanceof Error ? err.message : String(err),
            });
            // Detection cannot be recomputed later (the hooks are per scan), so
            // the operator digest must see it: a function_failure OpsEvent under
            // its own constant key (never dedups a real scan-theme failure
            // alert), internal ids only. recordOpsEvent never throws.
            try {
              const { recordOpsEvent, OPS_EVENT_TYPES } =
                await import("../../app/models/ops-event.server");
              await recordOpsEvent({
                eventType: OPS_EVENT_TYPES.FUNCTION_FAILURE,
                key: APP_REMOVALS_FAILURE_KEY,
                message: err instanceof Error ? err.message : String(err),
                metadata: { scanId, shopId },
              });
            } catch {
              // Never let the alert path fail the finalized scan.
            }
          }
        }
      });

      // "What changed" (gc-rrh.4, dark): compute and save this check's change
      // set, then prune the theme's manifests to the newest two successful
      // ones (spec 1.4). Runs after finalize-scan so this scan's AppRemoval
      // rows exist. Gated on the scan's PERSISTED status, not on whether this
      // attempt's finalize write landed: a retried finalize finds the scan
      // already COMPLETED and must still get its change set, while a
      // watchdog-FAILED scan is skipped (getScanForChangeLog returns null). NEVER throws and
      // never changes the scan, its findings or any alert: a failure is
      // logged (message capped) and recorded as a function_failure under
      // CHANGE_LOG_FAILURE_KEY, and the scan stays finalized. Idempotent on a
      // re-run: the change set is upserted on the scan id against the same
      // baseline (only earlier scans are considered, and the prune keeps it).
      // Returns a few scalars for scan_signal.
      const changeLog = await step.run("compute-changes", async () => {
        const startedAt = Date.now();
        let outcome:
          | { status: "saved"; kind: string; changeCount: number; worthALookCount: number }
          | { status: "skipped"; reason: string }
          | { status: "failed" };
        try {
          if (typeof manifestFileCount !== "number") {
            // No manifest was persisted (or a run memoized before it existed):
            // nothing to compare, and the next check compares to the last one.
            outcome = { status: "skipped", reason: "no_manifest" };
          } else {
            const { recordChangeSetForScan } = await import("../../app/services/change-log.server");
            outcome = await recordChangeSetForScan({
              scanId,
              shopId,
              themeId,
              isPublishedTheme: typeof isPublishedTheme === "boolean" ? isPublishedTheme : null,
            });
          }
        } catch (err) {
          outcome = { status: "failed" };
          logger.error("change log not computed; scan unaffected", {
            function: "scan-theme",
            event: "change_log_failed",
            scanId,
            shopId,
            errorName: err instanceof Error ? err.name : typeof err,
            error: cappedErrorMessage(err),
          });
          try {
            const { recordOpsEvent, OPS_EVENT_TYPES } =
              await import("../../app/models/ops-event.server");
            await recordOpsEvent({
              eventType: OPS_EVENT_TYPES.FUNCTION_FAILURE,
              key: CHANGE_LOG_FAILURE_KEY,
              message: cappedErrorMessage(err),
              metadata: { scanId, shopId },
            });
          } catch {
            // Never let the alert path fail the finalized scan.
          }
        }
        // Keep-2 manifest retention (spec 1.4), whatever the computation did,
        // so a failing computation can never let manifests pile up.
        try {
          const { pruneScanManifests } = await import("../../app/models/scan-manifest.server");
          await pruneScanManifests(shopId, themeId);
        } catch (err) {
          logger.warn("manifest prune failed; scan unaffected", {
            function: "scan-theme",
            event: "manifest_prune_failed",
            scanId,
            shopId,
            errorName: err instanceof Error ? err.name : typeof err,
            error: cappedErrorMessage(err),
          });
        }
        return { ...outcome, computeMs: Date.now() - startedAt };
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
          // Detected-but-not-persisted hits from soft-launched detectors
          // (SOFT_LAUNCH_FLAGS types): counted here so the histogram stays
          // truthful while the flag is off. Empty once the flag is on.
          for (const [type, count] of Object.entries(suppressedDetectorHits ?? {})) {
            detectorHits[type] = (detectorHits[type] ?? 0) + count;
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
              // Obfuscated / pirated-marker asset JS (gc-dcyh Phase 0, dark,
              // FP measurement). Absent while SUSPICIOUS_CODE_SIGNAL_ENABLED is off.
              ...(suspiciousCode ? { suspiciousCode } : {}),
              // Liquid printing a menu label without `| escape` (gc-7gjj.2
              // Phase 0, dark), with the theme's name so the share of hits can
              // be read per theme. Absent while MENU_LABEL_SIGNAL_ENABLED is off.
              ...(menuLabels
                ? { menuLabels: { ...menuLabels, themeName: themeInfo?.name ?? null } }
                : {}),
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
              // C) — truncation is NOT reflected in skipped/cappedCategories, so the differ
              // still diffs the scanned subset of a truncated category normally.
              phaseMs: {
                themeFetch: themeFetchMs,
                themeScan: themeScanMs,
                products: productsMs,
                pages: pagesMs,
                redirects: redirectsMs,
                // gc-7gjj.1: menu fields only when the audit ran (audit fix:
                // a dark flag adds nothing to scan_signal).
                ...(menuResult.audited ? { menus: menusMs } : {}),
              },
              pageCounts: {
                products: productResult.pageCount,
                redirects: redirectResult.pageCount,
                ...(menuResult.audited ? { menus: menuResult.pageCount } : {}),
              },
              throttleSleepMs: productResult.throttleSleepMs + redirectResult.throttleSleepMs,
              truncatedWalks,
              // gc-747u: walk wall-clock measured INSIDE the steps (memoized, so
              // true on replay, unlike phaseMs) and how many steps each walk took.
              walkMs: { products: productResult.walkMs, redirects: redirectResult.walkMs },
              walkSteps: { products: productResult.steps, redirects: redirectResult.steps },
              // gc-747u audit #7: what each walk's pages cost and how long it
              // waited on the rate limit, so the first real Pro scan confirms
              // the walk-duration estimate behind the walk time budgets.
              queryCost: {
                products: walkCostSignal(productResult.cost, productResult.pageCount),
                redirects: walkCostSignal(redirectResult.cost, redirectResult.pageCount),
                // gc-7gjj.1: the menus query's cost is undocumented; this is
                // where the first live scans measure it (with gc-7gjj.5).
                ...(menuResult.audited
                  ? { menus: walkCostSignal(menuResult.cost, menuResult.pageCount) }
                  : {}),
              },
              // gc-7gjj.1: menu items read (counts only, no menu text).
              ...(menuResult.audited ? { menuItemCount: menuResult.itemCount } : {}),
              walkThrottleSleepMs: {
                products: productResult.throttleSleepMs,
                redirects: redirectResult.throttleSleepMs,
              },
              // Step-output bounds (gc-4ce): a cap dropped dangling handles /
              // occurrences, the byte budget dropped ALL dangling candidates, or
              // the static JSON-LD candidate cap dropped some.
              danglingCapped,
              danglingTruncated,
              staticCandidatesCapped,
              // "What changed" pipeline health (gc-rrh.4, spec 8): additive.
              // From the compute-changes step's memoized result, so no query.
              changes: {
                status: changeLog.status,
                kind: "kind" in changeLog ? changeLog.kind : null,
                changeCount: "changeCount" in changeLog ? changeLog.changeCount : null,
                worthALookCount: "worthALookCount" in changeLog ? changeLog.worthALookCount : null,
                manifestFiles: typeof manifestFileCount === "number" ? manifestFileCount : null,
                manifestBytes: typeof manifestByteCount === "number" ? manifestByteCount : null,
                computeMs: "computeMs" in changeLog ? changeLog.computeMs : null,
              },
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

      // Merchant summary email (gc-ol95, replaces the gc-syz.5 per-change
      // alert): the terminal step. After a SCHEDULED scan only (manual and
      // AUTO_PUBLISH scans never email), sends ONE summary of what changed
      // since the last summary, and nothing when nothing changed. NEVER throws
      // (a failed email must not fail or retry the scan) and returns a small
      // serializable outcome so the reason shows in Inngest. Cheap gates
      // (env, origin, shop consent, idempotency, throttle) run before any diff.
      const summaryOutcome: { sent: boolean; reason: string } = await step.run(
        "send-summary-email",
        async () => {
          try {
            const { getMerchantAlertConfigStatus } =
              await import("../../app/services/merchant-alert.server");
            // Dark by default: skip all work (queries, diff) until configured.
            const config = getMerchantAlertConfigStatus();
            if (!config.configured) return { sent: false, reason: config.reason };

            const db = (await import("../../app/db.server")).default;
            const scan = await db.scan.findUnique({
              where: { id: scanId },
              select: { origin: true, createdAt: true, liveFindingTypes: true },
            });
            if (!scan) return { sent: false, reason: "scan_not_found" };
            if (scan.origin !== ScanOrigin.SCHEDULED) {
              return { sent: false, reason: "origin_not_eligible" };
            }

            const shop = await db.shop.findUnique({ where: { id: shopId } });
            if (!shop) return { sent: false, reason: "shop_not_found" };
            const summary = await import("../../app/services/summary-email.server");
            // Uninstalled, plan, toggle, consent: bail before any query or
            // Admin call (sendScanSummary re-checks).
            const shopSkip = summary.summaryShopSkipReason(shop);
            if (shopSkip) return { sent: false, reason: shopSkip };

            const { getLatestMerchantAlert } =
              await import("../../app/models/merchant-alert.server");
            const lastSummary = await getLatestMerchantAlert(shopId);
            const rateSkip = summary.summaryRateSkipReason(shop.plan, scanId, lastSummary);
            if (rateSkip) return { sent: false, reason: rateSkip };

            // Baseline = the scan the LAST SUMMARY covered when it still
            // exists, is for this shop + theme and predates this scan, so
            // nothing already reported is reported again. Otherwise (no
            // summary yet, scan deleted, theme switched) the previous scan.
            // getScanById includes findings by default; its return type is a
            // union only because of the optional includeFindings flag.
            const summaryScan = lastSummary
              ? ((await getScanById(lastSummary.scanId)) as Awaited<
                  ReturnType<typeof getPreviousScanForTheme>
                >)
              : null;
            const summaryIsBaseline =
              !!summaryScan &&
              summaryScan.shopId === shopId &&
              summaryScan.themeId === themeId &&
              summaryScan.createdAt < scan.createdAt;
            const baselineScan: Awaited<ReturnType<typeof getPreviousScanForTheme>> =
              summaryIsBaseline
                ? summaryScan
                : await getPreviousScanForTheme(shopId, themeId, scan.createdAt);
            // A first-ever scan has nothing to compare against: no summary.
            if (!baselineScan) return { sent: false, reason: "no_baseline" };

            const [{ getIgnoredFindingsForShop }, appRemovals] = await Promise.all([
              import("../../app/models/ignored-finding.server"),
              import("../../app/models/app-removal.server"),
            ]);
            const currentFindings = await db.finding.findMany({ where: { scanId } });
            const findingChanges = summary.computeFindingChanges({
              currentFindings,
              currentCoverage,
              currentLiveFindingTypes: scan.liveFindingTypes,
              baseline: baselineScan,
              // Same as the diff route: suppressed findings never count.
              ignores: await getIgnoredFindingsForShop(shopId),
            });
            if (!findingChanges.ok) return { sent: false, reason: findingChanges.reason };

            // App changes recorded on any scan after the baseline, up to this one.
            const periodScanIds = await getScanIdsForThemeBetween(
              shopId,
              themeId,
              baselineScan.createdAt,
              scan.createdAt,
            );
            const removalRows = await appRemovals.getAppRemovalsTouchedByScans(
              shopId,
              themeId,
              periodScanIds,
            );
            // gc-2wnf: the speed section (null unless live, a plan with the
            // report (Standard or Professional, gc-d0ui), fresh for its
            // cadence, and first-or-material). A material change alone sends.
            const { loadSummarySpeed } = await import("../../app/services/summary-speed.server");
            const changes = {
              newCount: findingChanges.newCount,
              fixedCount: findingChanges.fixedCount,
              openCount: findingChanges.openCount,
              ...summary.summarizeAppRemovals(removalRows, new Set(periodScanIds)),
              speed: await loadSummarySpeed(shop, lastSummary?.sentAt ?? null),
            };
            // Nothing changed: no email, and no Admin call.
            if (!summary.hasSummaryChanges(changes)) {
              return { sent: false, reason: "nothing_changed" };
            }

            // Admin client only to refresh the owner email. A dead offline token
            // (gc-4hk) must not fail the step: fall back to the cached email.
            let admin: AdminApiContext | null = null;
            try {
              const { unauthenticated } = await import("../../app/shopify.server");
              admin = (await unauthenticated.admin(shop.domain)).admin;
            } catch (err) {
              logger.warn("summary email: admin client unavailable, using cached email", {
                function: "scan-theme",
                scanId,
                shopId,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            const outcome = await summary.sendScanSummary({
              shop,
              scan: { id: scanId },
              changes,
              baseline: summaryIsBaseline ? "last_summary" : "previous_scan",
              admin,
              // Already loaded above: the service must not re-query it.
              latestSummary: lastSummary,
            });
            // Reason only: never log the recipient address.
            logger.info("summary email outcome", {
              function: "scan-theme",
              event: "summary_email",
              scanId,
              shopId,
              sent: outcome.sent,
              reason: outcome.reason,
            });
            return { sent: outcome.sent, reason: outcome.reason };
          } catch (err) {
            logger.warn("summary email step failed, scan unaffected", {
              function: "scan-theme",
              event: "summary_email_failed",
              scanId,
              shopId,
              error: err instanceof Error ? err.message : String(err),
            });
            return { sent: false, reason: "exception" };
          }
        },
      );

      logger.info("scan completed", {
        function: "scan-theme",
        event: "completed",
        scanId,
        shopId,
        status: finalStatus,
        findingCount: totalFindings,
        skippedCategories,
        cappedCategories,
        ...(unreachableCategories.length > 0 ? { unreachableCategories } : {}),
        skippedFiles: skippedFilePaths,
        translationFindings: translationResult.findingCount,
        tagFindings: productResult.tagCount,
        priceFindings: productResult.priceCount,
        pageFindings: pageResult.findingCount,
        metafieldFindings: productResult.metafieldCount,
        redirectFindings: redirectResult.findingCount,
        jsonLdPriceFindings: jsonLdPriceResult.findingCount,
        danglingRefFindings: danglingRefResult.findingCount,
        summaryEmail: summaryOutcome.reason,
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
