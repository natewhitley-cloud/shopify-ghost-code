/**
 * Integration tests for the scan-theme Inngest function.
 *
 * Strategy:
 *   - Mock all I/O boundaries (db.server, shopify.server, service functions,
 *     model functions) so the test exercises only the orchestration logic in
 *     scan-theme.ts.
 *   - Call the function handler directly via `scanTheme.fn({ event, step })`
 *     to avoid the Inngest SDK's runtime machinery.
 *   - The step mock from createMockInngestStep() executes each callback
 *     immediately and returns its result, so multi-step sequencing works
 *     without any SDK wiring.
 */

import { FindingType, Severity } from "@prisma/client";
import { NonRetriableError } from "inngest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// These are hoisted by Vitest to the top of the file before any imports.
// They shadow the real modules for the entire test file.

vi.mock("../../app/db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(),
    },
    scan: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    finding: {
      deleteMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("../../app/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/services/theme-fetcher.server", async (importOriginal) => ({
  // Keep the real ThemeTooLargeError class so instanceof checks are meaningful.
  ...(await importOriginal<typeof import("../../app/services/theme-fetcher.server")>()),
  fetchThemeFiles: vi.fn(),
}));

vi.mock("../../app/services/scan-engine.server", () => ({
  scanThemeFiles: vi.fn(),
  MAX_SCANNABLE_FILE_BYTES: 1_000_000,
  // Used by the real (unmocked) checkout-sunset detector.
  buildSnippet: (content: string) => content.slice(0, 300),
  // Real-behaviour stub so the core step's scannableFileCount is meaningful.
  isScannableFile: (filename: string) =>
    filename.endsWith(".liquid") &&
    ["templates/", "sections/", "snippets/", "layout/"].some((p) => filename.startsWith(p)),
}));

vi.mock("../../app/services/scan-pool.server", () => ({
  scanThemeFilesInPool: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  createUnknownScripts: vi.fn(),
}));

vi.mock("../../app/models/scan-domain.server", () => ({
  createScanDomains: vi.fn(),
}));

// scan_signal telemetry (Feature 2): mock the sink so the emitted metadata can be
// asserted. OPS_EVENT_TYPES is re-declared minimally — only SCAN_SIGNAL is read.
vi.mock("../../app/models/ops-event.server", () => ({
  recordOpsEvent: vi.fn(),
  OPS_EVENT_TYPES: { SCAN_SIGNAL: "scan_signal" },
}));

vi.mock("../../app/models/scan.server", () => ({
  updateScanStatus: vi.fn(),
  finalizeScan: vi.fn(),
  getPreviousScanForTheme: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  saveThemeFindings: vi.fn(),
  createFindings: vi.fn(),
}));

// Audit service boundaries — mocked so the optional audit steps actually run
// with controllable scope + data (TST-2). Previously these were left unmocked,
// so every scope probe threw, the error was swallowed (LOG-9), and each audit
// short-circuited to 0 — masking whether the audits ran at all.

vi.mock("../../app/services/translation-fetcher.server", () => ({
  hasTranslationScope: vi.fn(),
  auditTranslations: vi.fn(),
}));

vi.mock("../../app/services/translation-detector.server", () => ({
  detectTranslationContent: vi.fn(),
}));

vi.mock("../../app/services/product-fetcher.server", () => ({
  hasProductScope: vi.fn(),
  // gc-1bd: the three product walks are now ONE consolidated fetch.
  fetchProductAuditData: vi.fn(),
}));

vi.mock("../../app/services/product-tag-detector.server", () => ({
  detectOrphanedProductTags: vi.fn(),
}));

vi.mock("../../app/services/price-detector.server", () => ({
  detectPersistentDiscounts: vi.fn(),
}));

vi.mock("../../app/services/content-fetcher.server", () => ({
  hasContentScope: vi.fn(),
  fetchPages: vi.fn(),
}));

vi.mock("../../app/services/page-detector.server", () => ({
  detectOrphanedPages: vi.fn(),
}));

vi.mock("../../app/services/metafield-detector.server", () => ({
  detectOrphanedMetafields: vi.fn(),
}));

vi.mock("../../app/services/redirect-fetcher.server", () => ({
  hasNavigationScope: vi.fn(),
  fetchRedirects: vi.fn(),
}));

vi.mock("../../app/services/redirect-detector.server", () => ({
  detectOrphanedRedirects: vi.fn(),
}));

vi.mock("../../app/services/jsonld-price-audit.server", () => ({
  auditStaticJsonLdPrices: vi.fn(),
}));

// Dangling-reference audit boundaries (gc-m4h.5). The extractor MUST be mocked:
// its real module imports isScannableFile/buildSnippet from the (mocked)
// scan-engine.server, so leaving it real would call undefined mock members. The
// resolver is mocked like auditStaticJsonLdPrices — the worker test controls
// which handles are "missing" without touching the Admin API.
vi.mock("../../app/services/dangling-reference-extractor.server", async (importOriginal) => ({
  // Real comparator (pure) — the worker reuses it to cap static candidates.
  ...(await importOriginal<
    typeof import("../../app/services/dangling-reference-extractor.server")
  >()),
  extractDanglingReferences: vi.fn(),
}));

vi.mock("../../app/services/dangling-reference-resolver.server", () => ({
  resolveDanglingReferences: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { logger } from "../../app/lib/logger.server";
import {
  CORE_STEP_OUTPUT_BUDGET_BYTES,
  DANGLING_LOOKUP_CAP,
  DANGLING_MAX_OCCURRENCES_PER_HANDLE,
  JSONLD_PRICE_CANDIDATE_CAP,
  MAX_FINDINGS_PER_FILE_PER_TYPE,
} from "../../app/lib/scan-limits";
import { TransientScopeCheckError } from "../../app/lib/scope-check.server";
import { saveThemeFindings, createFindings } from "../../app/models/finding.server";
import { recordOpsEvent } from "../../app/models/ops-event.server";
import { createScanDomains } from "../../app/models/scan-domain.server";
import {
  finalizeScan,
  updateScanStatus,
  getPreviousScanForTheme,
} from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import { hasContentScope, fetchPages } from "../../app/services/content-fetcher.server";
import { extractDanglingReferences } from "../../app/services/dangling-reference-extractor.server";
import { resolveDanglingReferences } from "../../app/services/dangling-reference-resolver.server";
import { auditStaticJsonLdPrices } from "../../app/services/jsonld-price-audit.server";
import { detectOrphanedMetafields } from "../../app/services/metafield-detector.server";
import { detectOrphanedPages } from "../../app/services/page-detector.server";
import { detectPersistentDiscounts } from "../../app/services/price-detector.server";
import { hasProductScope, fetchProductAuditData } from "../../app/services/product-fetcher.server";
import { detectOrphanedProductTags } from "../../app/services/product-tag-detector.server";
import { detectOrphanedRedirects } from "../../app/services/redirect-detector.server";
import { hasNavigationScope, fetchRedirects } from "../../app/services/redirect-fetcher.server";
import { diffScans } from "../../app/services/scan-differ.server";
import { scanThemeFilesInPool } from "../../app/services/scan-pool.server";
import { fetchThemeFiles, ThemeTooLargeError } from "../../app/services/theme-fetcher.server";
import { detectTranslationContent } from "../../app/services/translation-detector.server";
import {
  hasTranslationScope,
  auditTranslations,
} from "../../app/services/translation-fetcher.server";
import { unauthenticated } from "../../app/shopify.server";
import { scanTheme } from "../../inngest/functions/scan-theme";
import { createMockInngestStep, createMockInngestEvent, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDb = db as unknown as {
  shop: { findUnique: ReturnType<typeof vi.fn> };
  scan: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  finding: {
    deleteMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
};
const mockUnauthenticated = unauthenticated as unknown as { admin: ReturnType<typeof vi.fn> };
const mockFetchThemeFiles = fetchThemeFiles as ReturnType<typeof vi.fn>;
const mockScanThemeFiles = scanThemeFilesInPool as ReturnType<typeof vi.fn>;
const mockUpdateScanStatus = updateScanStatus as ReturnType<typeof vi.fn>;
const mockFinalizeScan = finalizeScan as ReturnType<typeof vi.fn>;
const mockGetPreviousScanForTheme = getPreviousScanForTheme as ReturnType<typeof vi.fn>;
const mockSaveThemeFindings = saveThemeFindings as ReturnType<typeof vi.fn>;
const mockCreateFindings = createFindings as ReturnType<typeof vi.fn>;
const mockCreateUnknownScripts = createUnknownScripts as ReturnType<typeof vi.fn>;
const mockCreateScanDomains = createScanDomains as ReturnType<typeof vi.fn>;
const mockRecordOpsEvent = recordOpsEvent as ReturnType<typeof vi.fn>;

// Audit scope checks
const mockHasTranslationScope = hasTranslationScope as ReturnType<typeof vi.fn>;
const mockHasProductScope = hasProductScope as ReturnType<typeof vi.fn>;
const mockHasContentScope = hasContentScope as ReturnType<typeof vi.fn>;
const mockHasNavigationScope = hasNavigationScope as ReturnType<typeof vi.fn>;

// Audit fetchers
const mockAuditTranslations = auditTranslations as ReturnType<typeof vi.fn>;
const mockFetchProductAuditData = fetchProductAuditData as ReturnType<typeof vi.fn>;
const mockFetchPages = fetchPages as ReturnType<typeof vi.fn>;
const mockFetchRedirects = fetchRedirects as ReturnType<typeof vi.fn>;

// Audit detectors
const mockDetectTranslationContent = detectTranslationContent as ReturnType<typeof vi.fn>;
const mockDetectOrphanedProductTags = detectOrphanedProductTags as ReturnType<typeof vi.fn>;
const mockDetectPersistentDiscounts = detectPersistentDiscounts as ReturnType<typeof vi.fn>;
const mockDetectOrphanedPages = detectOrphanedPages as ReturnType<typeof vi.fn>;
const mockDetectOrphanedMetafields = detectOrphanedMetafields as ReturnType<typeof vi.fn>;
const mockDetectOrphanedRedirects = detectOrphanedRedirects as ReturnType<typeof vi.fn>;
const mockAuditStaticJsonLdPrices = auditStaticJsonLdPrices as ReturnType<typeof vi.fn>;
const mockExtractDanglingReferences = extractDanglingReferences as ReturnType<typeof vi.fn>;
const mockResolveDanglingReferences = resolveDanglingReferences as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc-123";
const THEME_ID = "gid://shopify/Theme/456";
const SCAN_ID = "scan-xyz-789";

const MOCK_SHOP = {
  id: SHOP_ID,
  domain: "test-shop.myshopify.com",
  accessToken: "test-token",
  // Paid plan by default so the Standard+ dangling-reference gate (gc-m4h.7)
  // grants; a dedicated test overrides findUnique with a Free-plan shop.
  plan: "Standard",
};

const MOCK_ADMIN = {
  graphql: vi.fn(),
};

const MOCK_FILES = [
  { filename: "layout/theme.liquid", content: "<html></html>" },
  { filename: "sections/header.liquid", content: "<header></header>" },
];

const MOCK_FINDINGS = [
  {
    filename: "layout/theme.liquid",
    lineNumber: 3,
    codeSnippet: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    findingType: FindingType.GHOST_SCRIPT,
    severity: Severity.HIGH,
    appName: "Klaviyo",
    description: "Ghost script from Klaviyo detected at layout/theme.liquid:3",
  },
  {
    filename: "sections/header.liquid",
    lineNumber: 7,
    codeSnippet: '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css">',
    findingType: FindingType.GHOST_STYLE,
    severity: Severity.MEDIUM,
    appName: "Judge.me",
    description: "Ghost stylesheet from Judge.me detected at sections/header.liquid:7",
  },
];

// ---------------------------------------------------------------------------
// Helper: build the event payload
// ---------------------------------------------------------------------------

function makeScanEvent(overrides?: Partial<{ shopId: string; themeId: string; scanId: string }>) {
  return createMockInngestEvent("scan/requested", {
    shopId: overrides?.shopId ?? SHOP_ID,
    themeId: overrides?.themeId ?? THEME_ID,
    scanId: overrides?.scanId ?? SCAN_ID,
  });
}

// ---------------------------------------------------------------------------
// Helper: invoke the function handler
// ---------------------------------------------------------------------------

async function runScanTheme(
  eventData?: Partial<{ shopId: string; themeId: string; scanId: string }>,
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const event = makeScanEvent(eventData);
  const step = { ...createMockInngestStep(), ...stepOverrides };
  return getInngestHandler(scanTheme)({ event, step });
}

// ---------------------------------------------------------------------------
// Setup: reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring for db + shopify
  mockDb.shop.findUnique.mockResolvedValue(MOCK_SHOP);
  // db.scan.findUnique is called in the catch block to check status before marking FAILED
  mockDb.scan.findUnique.mockResolvedValue({ status: "IN_PROGRESS" });
  mockDb.scan.update.mockResolvedValue(undefined);
  mockDb.finding.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length);
  // Resolution diff (Feature 3) reads current findings; scan_signal (Feature 2)
  // reads the detector histogram. Default to empty — tests that exercise the
  // diff/histogram override these.
  mockDb.finding.findMany.mockResolvedValue([]);
  mockDb.finding.groupBy.mockResolvedValue([]);
  mockUnauthenticated.admin.mockResolvedValue({ admin: MOCK_ADMIN });

  // Default happy-path wiring for services
  mockFetchThemeFiles.mockResolvedValue(MOCK_FILES);
  mockScanThemeFiles.mockReturnValue({ findings: MOCK_FINDINGS, unknownScripts: [] });

  // Default happy-path wiring for models
  mockUpdateScanStatus.mockResolvedValue(undefined);
  mockFinalizeScan.mockResolvedValue(undefined);
  // No prior scan by default — the zero-file sanity guard is a no-op unless a
  // test wires up a prior successful scan that had findings.
  mockGetPreviousScanForTheme.mockResolvedValue(null);
  mockSaveThemeFindings.mockResolvedValue(undefined);
  mockCreateFindings.mockResolvedValue({ count: 0 });
  mockCreateUnknownScripts.mockResolvedValue({ count: 0 });
  mockCreateScanDomains.mockResolvedValue({ count: 0 });
  mockRecordOpsEvent.mockResolvedValue(undefined);

  // Default audit wiring: every scope IS granted, but the detectors find
  // nothing. This makes the audit steps genuinely run end-to-end (scope probe
  // → fetch → detect → persist) on the happy path while contributing 0
  // findings, so the theme-scan count is the only contributor.
  mockHasTranslationScope.mockResolvedValue(true);
  mockHasProductScope.mockResolvedValue(true);
  mockHasContentScope.mockResolvedValue(true);
  mockHasNavigationScope.mockResolvedValue(true);

  // Translation audit returns no translations by default (early-returns 0).
  mockAuditTranslations.mockResolvedValue({
    locales: [],
    summaries: [],
    totalTranslations: 0,
    totalOutdated: 0,
  });
  mockDetectTranslationContent.mockReturnValue([]);

  mockFetchProductAuditData.mockResolvedValue(makeProductAuditData());
  mockFetchPages.mockResolvedValue([]);
  mockFetchRedirects.mockResolvedValue([]);

  mockDetectOrphanedProductTags.mockReturnValue([]);
  mockDetectPersistentDiscounts.mockReturnValue([]);
  mockDetectOrphanedPages.mockReturnValue([]);
  mockDetectOrphanedMetafields.mockReturnValue([]);
  mockDetectOrphanedRedirects.mockReturnValue([]);

  // Live-price audit: default to no findings. The step is also flag-gated
  // (JSONLD_LIVE_PRICE_ENABLED) — cleared here so it is inert unless a test
  // explicitly enables it.
  mockAuditStaticJsonLdPrices.mockResolvedValue([]);
  delete process.env.JSONLD_LIVE_PRICE_ENABLED;

  // Dangling-reference audit (gc-m4h.5): no candidates + all scopes resolved by
  // default, and the flag is cleared so the step is inert unless a test enables
  // it. The resolver default is only consulted when a test supplies candidates
  // AND turns the flag on.
  mockExtractDanglingReferences.mockReturnValue({ occurrences: [], distinctHandles: [] });
  mockResolveDanglingReferences.mockResolvedValue({
    missing: [],
    scopeStatus: { products: "checked", content: "checked" },
    truncated: false,
  });
  delete process.env.DANGLING_REFERENCE_LIVE_ENABLED;
});

// ---------------------------------------------------------------------------
// Helper: build an audit finding
// ---------------------------------------------------------------------------

function makeAuditFinding(findingType: FindingType, overrides?: Record<string, unknown>) {
  return {
    filename: "n/a",
    lineNumber: 0,
    codeSnippet: "orphaned-resource",
    findingType,
    severity: Severity.MEDIUM,
    description: `Orphaned ${findingType}`,
    ...overrides,
  };
}

// gc-1bd: the consolidated product-audit fetch returns detector-shaped arrays
// plus walk observability. Defaults are an empty, untruncated walk.
function makeProductAuditData(overrides?: Record<string, unknown>) {
  return {
    tags: [],
    prices: [],
    metafields: [],
    truncated: false,
    pageCount: 0,
    throttleSleepMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Function configuration
// ---------------------------------------------------------------------------

describe("scanTheme — function configuration", () => {
  it("caps concurrency at 3 to reserve headroom on the shared Inngest pool (PRF-1)", () => {
    // The Inngest Hobby plan's 5-concurrent-step pool is account-wide and shared
    // across the 3 sibling apps; capping below the pool size keeps cron heartbeats
    // from being starved by a scan burst.
    const opts = (scanTheme as unknown as { opts: { concurrency?: unknown } }).opts;
    expect(opts.concurrency).toEqual({ limit: 3 });
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("scanTheme — happy path", () => {
  it("completes a full scan flow and returns correct result", async () => {
    const result = await runScanTheme();

    expect(result).toEqual({
      scanId: SCAN_ID,
      findingCount: MOCK_FINDINGS.length,
      status: "COMPLETED",
    });
  });

  it("marks the scan IN_PROGRESS as the first step", async () => {
    await runScanTheme();

    // updateScanStatus should have been called with IN_PROGRESS first
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "IN_PROGRESS");
    const firstCall = mockUpdateScanStatus.mock.calls[0];
    expect(firstCall).toEqual([SCAN_ID, "IN_PROGRESS"]);
  });

  it("fetches theme files using the shop domain and themeId", async () => {
    await runScanTheme();

    expect(mockDb.shop.findUnique).toHaveBeenCalledWith({
      where: { id: SHOP_ID },
    });
    expect(mockUnauthenticated.admin).toHaveBeenCalledWith(MOCK_SHOP.domain);
    expect(mockFetchThemeFiles).toHaveBeenCalledWith(MOCK_ADMIN, THEME_ID, MOCK_SHOP.domain);
  });

  it("passes fetched files to the scan engine", async () => {
    await runScanTheme();

    expect(mockScanThemeFiles).toHaveBeenCalledWith(MOCK_FILES);
  });

  it("persists theme findings at step 2 but leaves the scan IN_PROGRESS", async () => {
    await runScanTheme();

    // Persistence no longer marks the scan terminal — finalizeScan does, after
    // all audit steps (LOG-4). Step 2 only saves the theme findings.
    expect(mockSaveThemeFindings).toHaveBeenCalledWith(SCAN_ID, MOCK_FINDINGS);
  });

  it("marks the scan COMPLETED via finalizeScan after all audits when nothing was skipped", async () => {
    await runScanTheme();

    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      skippedCategories: [],
      skippedFiles: [],
      // First-ever scan (no prior) → every finding is new; nothing resolved/carried.
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
  });

  it("threads oversized skipped-file paths from the scan engine into finalizeScan (gc-06e.19)", async () => {
    // The scan engine reports two files skipped for exceeding the size cap. Their
    // paths must be persisted on the scan so the differ can exclude their prior
    // findings from "resolved" (an unscanned file is unknown, not fixed).
    mockScanThemeFiles.mockReturnValueOnce({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      skippedFiles: [
        { filename: "sections/bloated.liquid", size: 2_000_000 },
        { filename: "assets/huge.js", size: 3_500_000 },
      ],
    });

    await runScanTheme();

    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      skippedCategories: [],
      skippedFiles: ["sections/bloated.liquid", "assets/huge.js"],
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
  });

  it("logs an oversized checkout.liquid and still saves its presence finding (gc-4yg)", async () => {
    // The checkout-sunset detector runs on the main thread, so it skips
    // analyzing a checkout.liquid over the cap; the skip must be observable.
    const warnSpy = vi.spyOn(logger, "warn");
    const oversized = { filename: "layout/checkout.liquid", content: "x".repeat(1_000_001) };
    mockFetchThemeFiles.mockResolvedValueOnce([...MOCK_FILES, oversized]);

    await runScanTheme();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("checkout.liquid"),
      expect.objectContaining({
        event: "checkout_sunset_oversized",
        shopId: SHOP_ID,
        size: 1_000_001,
        cap: 1_000_000,
      }),
    );
    const saved = mockSaveThemeFindings.mock.calls[0][1] as Array<{ findingType: string }>;
    expect(saved.filter((f) => f.findingType === FindingType.CHECKOUT_SUNSET)).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("does not log the checkout.liquid skip for a file within the cap", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const normal = { filename: "layout/checkout.liquid", content: "<script>x()</script>" };
    mockFetchThemeFiles.mockResolvedValueOnce([...MOCK_FILES, normal]);

    await runScanTheme();

    expect(
      warnSpy.mock.calls.some(
        ([, meta]) => (meta as { event?: string })?.event === "checkout_sunset_oversized",
      ),
    ).toBe(false);
    warnSpy.mockRestore();
  });

  it("executes the core steps in order: IN_PROGRESS, fetch, scan, save, then finalize last", async () => {
    const callOrder: string[] = [];

    mockUpdateScanStatus.mockImplementation(async (_id: string, status: string) => {
      callOrder.push(`updateScanStatus:${status}`);
    });
    mockFetchThemeFiles.mockImplementation(async () => {
      callOrder.push("fetchThemeFiles");
      return MOCK_FILES;
    });
    mockScanThemeFiles.mockImplementation(() => {
      callOrder.push("scanThemeFiles");
      return { findings: MOCK_FINDINGS, unknownScripts: [] };
    });
    mockSaveThemeFindings.mockImplementation(async () => {
      callOrder.push("saveThemeFindings");
    });
    mockFinalizeScan.mockImplementation(async () => {
      callOrder.push("finalizeScan");
    });

    await runScanTheme();

    // finalizeScan must come AFTER saveThemeFindings (and after the audit steps,
    // which are not instrumented here) — the core LOG-4 guarantee.
    expect(callOrder).toEqual([
      "updateScanStatus:IN_PROGRESS",
      "fetchThemeFiles",
      "scanThemeFiles",
      "saveThemeFindings",
      "finalizeScan",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Happy path — zero findings
// ---------------------------------------------------------------------------

describe("scanTheme — zero findings", () => {
  beforeEach(() => {
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
  });

  it("returns findingCount of 0 and COMPLETED status", async () => {
    const result = await runScanTheme();

    expect(result).toEqual({
      scanId: SCAN_ID,
      findingCount: 0,
      status: "COMPLETED",
    });
  });

  it("calls saveThemeFindings with empty array", async () => {
    await runScanTheme();

    expect(mockSaveThemeFindings).toHaveBeenCalledWith(SCAN_ID, []);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("scanTheme — error paths", () => {
  it("marks scan FAILED and re-throws when shop is not found", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await expect(runScanTheme()).rejects.toThrow("Shop shop-abc-123 not found");

    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("marks scan FAILED and re-throws when fetchThemeFiles throws", async () => {
    const fetchError = new Error("Shopify API unavailable");
    mockFetchThemeFiles.mockRejectedValue(fetchError);

    await expect(runScanTheme()).rejects.toThrow("Shopify API unavailable");

    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  // gc-8s2: an over-ceiling theme is deterministic; retrying would just refetch
  // up to the cap again. It must fail the scan once, as NonRetriableError.
  it("converts ThemeTooLargeError to NonRetriableError and marks scan FAILED (no retries)", async () => {
    mockFetchThemeFiles.mockRejectedValue(new ThemeTooLargeError("gid://shopify/Theme/1", 50, 57));

    const err = await runScanTheme().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NonRetriableError);
    expect((err as Error).message).toContain("total text ceiling");
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  // gc-d4e follow-up: an over-cap theme must still leave a scan_signal row so
  // the theme-size report can show the cap is too LOW. Same key + identity
  // fields as the success-path scan_signal so existing redact/prune applies.
  it("records an aborted scan_signal (key=scanId, metadata.shopId) before failing over the cap", async () => {
    mockFetchThemeFiles.mockRejectedValue(new ThemeTooLargeError("gid://shopify/Theme/1", 50, 57));

    const err = await runScanTheme().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NonRetriableError);
    expect(recordOpsEvent).toHaveBeenCalledTimes(1);
    expect(recordOpsEvent).toHaveBeenCalledWith({
      eventType: "scan_signal",
      key: SCAN_ID,
      metadata: expect.objectContaining({
        shopId: SHOP_ID,
        scanId: SCAN_ID,
        themeId: THEME_ID,
        aborted: "theme_too_large",
        bytesAtAbort: 57,
        maxTotalBytes: 50,
      }),
    });
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("does NOT record a scan_signal for an ordinary (retriable) fetch error", async () => {
    mockFetchThemeFiles.mockRejectedValue(new Error("Shopify API unavailable"));

    await runScanTheme().catch(() => undefined);

    expect(recordOpsEvent).not.toHaveBeenCalled();
  });

  it("does NOT make an ordinary fetch error non-retriable (transient errors still retry)", async () => {
    mockFetchThemeFiles.mockRejectedValue(new Error("Shopify API unavailable"));

    const err = await runScanTheme().catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NonRetriableError);
  });

  it("marks scan FAILED and re-throws when scanThemeFiles throws", async () => {
    const scanError = new Error("Scan engine crashed");
    mockScanThemeFiles.mockImplementation(() => {
      throw scanError;
    });

    await expect(runScanTheme()).rejects.toThrow("Scan engine crashed");

    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("marks scan FAILED and re-throws when saveThemeFindings throws", async () => {
    const dbError = new Error("DB write failed");
    mockSaveThemeFindings.mockRejectedValue(dbError);

    await expect(runScanTheme()).rejects.toThrow("DB write failed");

    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("still re-throws original error even when FAILED status update itself fails", async () => {
    const fetchError = new Error("Shopify API unavailable");
    mockFetchThemeFiles.mockRejectedValue(fetchError);

    // Allow IN_PROGRESS update to succeed (step 1), but make the FAILED
    // status update (in the catch block) also reject — original error must
    // still propagate thanks to the .catch(() => {}) in the source.
    mockUpdateScanStatus
      .mockResolvedValueOnce(undefined) // step 1: IN_PROGRESS succeeds
      .mockRejectedValue(new Error("DB connection lost")); // catch: FAILED update fails

    await expect(runScanTheme()).rejects.toThrow("Shopify API unavailable");
  });

  it("does not call saveThemeFindings on error paths", async () => {
    mockFetchThemeFiles.mockRejectedValue(new Error("network failure"));

    await expect(runScanTheme()).rejects.toThrow();

    expect(mockSaveThemeFindings).not.toHaveBeenCalled();
  });

  it("marks scan IN_PROGRESS before any failure in step 2", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await expect(runScanTheme()).rejects.toThrow();

    // Step 1 (IN_PROGRESS) should still have been called
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// Optional audit steps (TST-2 / LOG-9)
//
// These prove the audit steps genuinely execute — the scope probe is consulted,
// findings are persisted with the delete-then-create idempotency guard, a
// genuine ACCESS_DENIED skips cleanly, and a transient error is NOT swallowed
// as "scope missing" (so a flaky API can never produce a false-clean scan).
// ---------------------------------------------------------------------------

describe("scanTheme — optional audit steps", () => {
  it("consults every optional scope check on the happy path", async () => {
    await runScanTheme();

    // If a future regression silently swallowed a probe error and returned
    // false, these assertions would still pass — but they document that the
    // probe is part of the happy path, and the dedicated transient/access-
    // denied tests below lock in the distinct behaviors.
    expect(mockHasTranslationScope).toHaveBeenCalledWith(MOCK_ADMIN);
    expect(mockHasProductScope).toHaveBeenCalledWith(MOCK_ADMIN);
    expect(mockHasContentScope).toHaveBeenCalledWith(MOCK_ADMIN);
    expect(mockHasNavigationScope).toHaveBeenCalledWith(MOCK_ADMIN);
  });

  describe("persistence — finds and stores findings", () => {
    it("deletes prior findings, creates new ones, and recounts the total", async () => {
      const tagFinding = makeAuditFinding(FindingType.GHOST_TAG);
      mockFetchProductAuditData.mockResolvedValue(
        makeProductAuditData({ tags: [{ id: "gid://shopify/Product/1" }] }),
      );
      mockDetectOrphanedProductTags.mockReturnValue([tagFinding]);
      // Recount returns the authoritative total across all finding types.
      mockDb.finding.count.mockResolvedValue(3);

      const result = await runScanTheme();

      // Idempotency guard: delete this finding type before inserting.
      expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
        where: { scanId: SCAN_ID, findingType: FindingType.GHOST_TAG },
      });
      expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [tagFinding]);

      // deleteMany must run BEFORE createFindings.
      const deleteOrder = mockDb.finding.deleteMany.mock.invocationCallOrder[0];
      const createOrder = mockCreateFindings.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(createOrder);

      // Recount keeps the scan.findingCount authoritative (no retry drift).
      expect(mockDb.scan.update).toHaveBeenCalledWith({
        where: { id: SCAN_ID },
        data: { findingCount: 3 },
      });

      // Total returned = theme findings (2) + tag finding (1).
      expect(result).toEqual({
        scanId: SCAN_ID,
        findingCount: MOCK_FINDINGS.length + 1,
        status: "COMPLETED",
      });
    });
  });

  describe("translation persistence — shared helper from the translation step", () => {
    // The translation-audit step has bespoke pre-logic but ends with the same
    // persist/recount/log tail as runAuditStep (extracted into persistAuditFindings).
    // These lock in that second call site: correct GHOST_TRANSLATION findingType,
    // delete-then-create ordering, recount, and retry idempotency.
    const TRANSLATION_AUDIT = {
      locales: ["fr"],
      summaries: [],
      totalTranslations: 5,
      totalOutdated: 0,
    };

    it("persists translation findings via the same delete-then-create + recount tail", async () => {
      const translationFinding = makeAuditFinding(FindingType.GHOST_TRANSLATION);
      mockAuditTranslations.mockResolvedValue(TRANSLATION_AUDIT);
      mockDetectTranslationContent.mockReturnValue([translationFinding]);
      mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 1);

      const result = await runScanTheme();

      // Idempotency guard runs for the GHOST_TRANSLATION type before insert.
      expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
        where: { scanId: SCAN_ID, findingType: FindingType.GHOST_TRANSLATION },
      });
      expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [translationFinding]);

      // deleteMany must run BEFORE createFindings.
      const deleteOrder = mockDb.finding.deleteMany.mock.invocationCallOrder[0];
      const createOrder = mockCreateFindings.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(createOrder);

      // Recount keeps the scan.findingCount authoritative (no retry drift).
      expect(mockDb.scan.update).toHaveBeenCalledWith({
        where: { id: SCAN_ID },
        data: { findingCount: MOCK_FINDINGS.length + 1 },
      });

      expect(result).toEqual({
        scanId: SCAN_ID,
        findingCount: MOCK_FINDINGS.length + 1,
        status: "COMPLETED",
      });
    });

    it("delete-then-create keeps exactly one copy of translation findings across two runs", async () => {
      const translationFinding = makeAuditFinding(FindingType.GHOST_TRANSLATION);
      mockAuditTranslations.mockResolvedValue(TRANSLATION_AUDIT);
      mockDetectTranslationContent.mockReturnValue([translationFinding]);

      // Stateful fake table for GHOST_TRANSLATION findings: deleteMany clears it,
      // createFindings appends. Running the step twice must leave one copy.
      let persisted: unknown[] = [];
      mockDb.finding.deleteMany.mockImplementation(
        async ({ where }: { where: { findingType: FindingType } }) => {
          if (where.findingType === FindingType.GHOST_TRANSLATION) persisted = [];
          return { count: 0 };
        },
      );
      mockCreateFindings.mockImplementation(async (_scanId: string, findings: unknown[]) => {
        persisted.push(...findings);
        return { count: findings.length };
      });

      await runScanTheme();
      await runScanTheme();

      // No duplication despite two runs (simulating an Inngest retry).
      expect(persisted).toEqual([translationFinding]);
    });
  });

  describe("retry idempotency — running an audit twice does not duplicate", () => {
    it("delete-then-create keeps exactly one copy of the findings after two runs", async () => {
      const tagFinding = makeAuditFinding(FindingType.GHOST_TAG);
      mockFetchProductAuditData.mockResolvedValue(
        makeProductAuditData({ tags: [{ id: "gid://shopify/Product/1" }] }),
      );
      mockDetectOrphanedProductTags.mockReturnValue([tagFinding]);

      // Stateful fake table for GHOST_TAG findings: deleteMany clears it,
      // createFindings appends. Running the step twice must leave one copy.
      let persistedTagFindings: unknown[] = [];
      mockDb.finding.deleteMany.mockImplementation(
        async ({ where }: { where: { findingType: FindingType } }) => {
          if (where.findingType === FindingType.GHOST_TAG) persistedTagFindings = [];
          return { count: 0 };
        },
      );
      mockCreateFindings.mockImplementation(async (_scanId: string, findings: unknown[]) => {
        persistedTagFindings.push(...findings);
        return { count: findings.length };
      });

      await runScanTheme();
      await runScanTheme();

      // The guard runs every time — once per run for the one type with findings.
      expect(mockDb.finding.deleteMany).toHaveBeenCalledTimes(2);
      // No duplication despite two runs (simulating an Inngest retry).
      expect(persistedTagFindings).toEqual([tagFinding]);
    });
  });

  describe("genuine ACCESS_DENIED — scope not granted", () => {
    it("skips the product-backed audits cleanly and finalizes the scan COMPLETED with those categories recorded", async () => {
      // hasProductScope reports the scope is genuinely missing. The three
      // product-backed audits (tag, price, metafield) share the consolidated
      // walk and all gate on it.
      mockHasProductScope.mockResolvedValue(false);
      // Even though data + detector would yield findings, the audit must skip.
      mockFetchProductAuditData.mockResolvedValue(
        makeProductAuditData({ tags: [{ id: "gid://shopify/Product/1" }] }),
      );
      mockDetectOrphanedProductTags.mockReturnValue([makeAuditFinding(FindingType.GHOST_TAG)]);

      const result = await runScanTheme();

      // Skipped before the consolidated walk / any persist for those audits.
      expect(mockFetchProductAuditData).not.toHaveBeenCalled();
      expect(mockCreateFindings).not.toHaveBeenCalled();
      expect(mockDb.finding.deleteMany).not.toHaveBeenCalled();

      // The core scan succeeded, so the scan finalizes COMPLETED even though
      // three optional categories were skipped for missing scope. Those skipped
      // categories are STILL recorded (COMPLETED + non-empty skippedCategories
      // must coexist) so the differ never marks their prior findings as falsely
      // "resolved" (LOG-4).
      expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
        status: "COMPLETED",
        findingCount: MOCK_FINDINGS.length,
        skippedCategories: [
          FindingType.GHOST_TAG,
          FindingType.GHOST_PRICE,
          FindingType.GHOST_METAFIELD,
        ],
        skippedFiles: [],
        newFindingCount: MOCK_FINDINGS.length,
        resolvedFindingCount: 0,
        persistedFindingCount: 0,
      });

      expect(result).toEqual({
        scanId: SCAN_ID,
        findingCount: MOCK_FINDINGS.length,
        status: "COMPLETED",
      });
    });
  });

  describe("transient error during an audit — must NOT be swallowed", () => {
    it("propagates the transient scope error and marks the scan FAILED", async () => {
      mockHasProductScope.mockRejectedValue(
        new TransientScopeCheckError("read_products", new Error("Throttled")),
      );

      // The transient error must surface (so Inngest retries) — it must NOT be
      // silently treated as "scope missing" and skipped.
      await expect(runScanTheme()).rejects.toThrow(TransientScopeCheckError);

      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
      // It must not falsely persist a clean/resolved result for the audit.
      expect(mockCreateFindings).not.toHaveBeenCalled();
    });
  });

  describe("catch-block COMPLETED guard", () => {
    it("does not overwrite a COMPLETED scan when a late audit error fires", async () => {
      // Simulate a late transient failure after the scan already completed
      // (e.g. an Inngest retry that re-ran past the persisted COMPLETED state).
      mockHasProductScope.mockRejectedValue(
        new TransientScopeCheckError("read_products", new Error("Throttled")),
      );
      mockDb.scan.findUnique.mockResolvedValue({ status: "COMPLETED" });

      await expect(runScanTheme()).rejects.toThrow(TransientScopeCheckError);

      // The guard must prevent a FAILED overwrite of a COMPLETED scan...
      expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
      // ...while step 1 still ran.
      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "IN_PROGRESS");
    });

    it("does not overwrite a PARTIAL scan when a late audit error fires", async () => {
      // PARTIAL is a successful terminal status — a late retry that errors must
      // not clobber it with FAILED (LOG-4).
      mockHasProductScope.mockRejectedValue(
        new TransientScopeCheckError("read_products", new Error("Throttled")),
      );
      mockDb.scan.findUnique.mockResolvedValue({ status: "PARTIAL" });

      await expect(runScanTheme()).rejects.toThrow(TransientScopeCheckError);

      expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
      expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "IN_PROGRESS");
    });
  });
});

// ---------------------------------------------------------------------------
// Consolidated product audit (gc-1bd)
//
// The tag/price/metafield audits are ONE step over ONE catalog walk now. These
// lock in the invariants the consolidation must preserve:
//   (a) all three FindingTypes are delete-then-created (idempotent per type)
//   (e) a cap-truncated walk is TELEMETRY ONLY (Option C): it surfaces in
//       truncatedWalks + a logger.warn, but does NOT enter skippedCategories, so
//       the differ still diffs the scanned subset normally
//   (d) one detector throwing isolates to just its category (others persist)
// plus the redirect-walk truncation, which is likewise telemetry-only.
// ---------------------------------------------------------------------------

describe("scanTheme — consolidated product audit (gc-1bd)", () => {
  it("does ONE product walk and persists all three FindingTypes (invariant a)", async () => {
    const tagFinding = makeAuditFinding(FindingType.GHOST_TAG);
    const priceFinding = makeAuditFinding(FindingType.GHOST_PRICE);
    const metafieldFinding = makeAuditFinding(FindingType.GHOST_METAFIELD);

    mockFetchProductAuditData.mockResolvedValue(
      makeProductAuditData({
        tags: [{ id: "gid://shopify/Product/1", title: "P1", tags: ["bold-x"] }],
        prices: [{ id: "gid://shopify/Product/1" }],
        metafields: [{ id: "gid://shopify/Product/1" }],
      }),
    );
    mockDetectOrphanedProductTags.mockReturnValue([tagFinding]);
    mockDetectPersistentDiscounts.mockReturnValue([priceFinding]);
    mockDetectOrphanedMetafields.mockReturnValue([metafieldFinding]);

    await runScanTheme();

    // A SINGLE consolidated fetch drove all three detectors.
    expect(mockFetchProductAuditData).toHaveBeenCalledTimes(1);

    // Each FindingType is delete-then-created (idempotency scoped per type).
    for (const findingType of [
      FindingType.GHOST_TAG,
      FindingType.GHOST_PRICE,
      FindingType.GHOST_METAFIELD,
    ]) {
      expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
        where: { scanId: SCAN_ID, findingType },
      });
    }
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [tagFinding]);
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [priceFinding]);
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [metafieldFinding]);
  });

  it("treats a truncated product walk as telemetry only — NOT a skipped category (Option C, gc-1bd)", async () => {
    // Cap hit mid-catalog: findings for what WAS scanned still persist AND the
    // category must NOT be marked skipped. Marking it skipped drops the prior
    // findings for the scanned subset from the diff baseline while their still-
    // present current findings persist, reporting an unchanged finding as "new"
    // on every rescan (the exact regression Option C fixes). Detectors find
    // nothing here to keep the assertion focused.
    const warnSpy = vi.spyOn(logger, "warn");
    mockFetchProductAuditData.mockResolvedValue(
      makeProductAuditData({
        tags: [{ id: "gid://shopify/Product/1", title: "P1", tags: [] }],
        truncated: true,
        pageCount: 10,
      }),
    );

    await runScanTheme();

    // NONE of the three product categories are skipped for truncation alone.
    const finalizeArg = mockFinalizeScan.mock.calls[0][1];
    expect(finalizeArg.skippedCategories).not.toContain(FindingType.GHOST_TAG);
    expect(finalizeArg.skippedCategories).not.toContain(FindingType.GHOST_PRICE);
    expect(finalizeArg.skippedCategories).not.toContain(FindingType.GHOST_METAFIELD);
    // The truncation IS surfaced in telemetry.
    const [signal] = mockRecordOpsEvent.mock.calls[0];
    expect(signal.metadata.truncatedWalks).toEqual(["products"]);
    // ...and the observable-cap warning fired so the tail is never silently dropped.
    expect(
      warnSpy.mock.calls.some(([msg]) => String(msg).includes("product-audit walk hit the cap")),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("isolates a throwing detector to its own category and keeps the others (invariant d)", async () => {
    const tagFinding = makeAuditFinding(FindingType.GHOST_TAG);
    const metafieldFinding = makeAuditFinding(FindingType.GHOST_METAFIELD);

    mockFetchProductAuditData.mockResolvedValue(
      makeProductAuditData({
        tags: [{ id: "gid://shopify/Product/1", title: "P1", tags: ["bold-x"] }],
        prices: [{ id: "gid://shopify/Product/1" }],
        metafields: [{ id: "gid://shopify/Product/1" }],
      }),
    );
    mockDetectOrphanedProductTags.mockReturnValue([tagFinding]);
    // The price detector throws — it must NOT sink the tag/metafield detectors.
    mockDetectPersistentDiscounts.mockImplementation(() => {
      throw new Error("price detector boom");
    });
    mockDetectOrphanedMetafields.mockReturnValue([metafieldFinding]);

    const result = await runScanTheme();

    // The other two categories still persist.
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [tagFinding]);
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [metafieldFinding]);
    // GHOST_PRICE alone is recorded as a coverage gap; the scan still COMPLETES.
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [FindingType.GHOST_PRICE] }),
    );
    expect(result.status).toBe("COMPLETED");
  });

  it("treats a truncated redirect walk as telemetry only — NOT a skipped category (Option C, gc-1bd)", async () => {
    // The redirect step threads a stats out-param into fetchRedirects; simulate a
    // cap-truncated walk by having the mock flip stats.truncated. Under Option C
    // the scanned subset was still audited, so GHOST_REDIRECT must NOT be skipped.
    mockFetchRedirects.mockImplementation(
      async (
        _admin: unknown,
        _cap: unknown,
        stats?: { truncated: boolean; pageCount: number; throttleSleepMs: number },
      ) => {
        if (stats) {
          stats.truncated = true;
          stats.pageCount = 3;
        }
        return [];
      },
    );

    await runScanTheme();

    const finalizeArg = mockFinalizeScan.mock.calls[0][1];
    expect(finalizeArg.skippedCategories).not.toContain(FindingType.GHOST_REDIRECT);
    // Truncation is surfaced in telemetry only.
    const [signal] = mockRecordOpsEvent.mock.calls[0];
    expect(signal.metadata.truncatedWalks).toEqual(["redirects"]);
  });

  it("populates per-phase timing + walk observability in the scan_signal (Option 1)", async () => {
    mockFetchProductAuditData.mockResolvedValue(
      makeProductAuditData({ pageCount: 4, throttleSleepMs: 250 }),
    );
    mockDb.finding.groupBy.mockResolvedValue([{ findingType: "GHOST_SCRIPT", _count: 2 }]);

    await runScanTheme();

    const [signal] = mockRecordOpsEvent.mock.calls[0];
    const meta = signal.metadata;
    // phaseMs carries a numeric entry for each major step (wall-clock in prod;
    // ~0 under the synchronous test step, but always present + numeric).
    for (const key of ["themeFetch", "themeScan", "products", "pages", "redirects"]) {
      expect(typeof meta.phaseMs[key]).toBe("number");
    }
    // Consolidated walk cost is surfaced; redirects contributed nothing here.
    expect(meta.pageCounts).toEqual({ products: 4, redirects: 0 });
    expect(meta.throttleSleepMs).toBe(250);
    expect(meta.truncatedWalks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live-price audit for stale static JSON-LD (gc-47c.10)
//
// Double-inert soft-launch: needs BOTH the JSONLD_LIVE_PRICE_ENABLED flag AND a
// granted read_products scope. Emits JSON_LD_PRICE_CONFLICT, a type EXCLUSIVE to
// this audit, so its idempotency delete scopes by findingType alone and never
// touches the worker's same-file JSON_LD_CONFLICT rows.
// ---------------------------------------------------------------------------

describe("scanTheme — live-price JSON-LD audit (gc-47c.10)", () => {
  const PRICE_PREFIX = "Static JSON-LD advertises ";

  const PRICE_CANDIDATE = {
    filename: "sections/product.liquid",
    lineNumber: 3,
    codeSnippet: '<script type="application/ld+json">{"@type":"Product"}</script>',
    handle: "widget",
    staticPrice: "19.99",
    staticPriceCurrency: "USD",
  };

  const PRICE_FINDING = {
    filename: "sections/product.liquid",
    lineNumber: 3,
    codeSnippet: PRICE_CANDIDATE.codeSnippet,
    findingType: FindingType.JSON_LD_PRICE_CONFLICT,
    severity: Severity.HIGH,
    appName: undefined,
    description: `${PRICE_PREFIX}price 19.99 but the live product price is 29.99. An AI shopping agent could quote the stale price.`,
  };

  function withCandidates(candidates: unknown[]) {
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      staticProductCandidates: candidates,
    });
  }

  it("is fully inert when the flag is OFF (no scope probe, no persist, not skipped)", async () => {
    // Flag unset by beforeEach. Candidates present + scope granted, yet the step
    // must not run — verifying the flag gate short-circuits FIRST.
    withCandidates([PRICE_CANDIDATE]);

    const result = await runScanTheme();

    expect(mockAuditStaticJsonLdPrices).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      // JSON_LD_PRICE_CONFLICT must NOT appear — flag-off is not a scope skip.
      skippedCategories: [],
      skippedFiles: [],
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });

  it("audits and persists findings when the flag is ON and scope is granted", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    withCandidates([PRICE_CANDIDATE]);
    mockHasProductScope.mockResolvedValue(true);
    mockAuditStaticJsonLdPrices.mockResolvedValue({ findings: [PRICE_FINDING], skipped: false });
    mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 1);

    const result = await runScanTheme();

    expect(mockAuditStaticJsonLdPrices).toHaveBeenCalledWith(
      MOCK_ADMIN,
      [PRICE_CANDIDATE],
      SHOP_ID,
    );
    // Idempotency delete scopes by findingType alone: JSON_LD_PRICE_CONFLICT is
    // exclusive to this audit, so it never touches the worker's JSON_LD_CONFLICT.
    expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
      where: {
        scanId: SCAN_ID,
        findingType: FindingType.JSON_LD_PRICE_CONFLICT,
      },
    });
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [PRICE_FINDING]);
    expect(result.findingCount).toBe(MOCK_FINDINGS.length + 1);
  });

  it("records JSON_LD_PRICE_CONFLICT in skippedCategories when the audit truncates (cap hit)", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    withCandidates([PRICE_CANDIDATE]);
    mockHasProductScope.mockResolvedValue(true);
    // Flag on + scope granted + findings persisted, but the audit reports it
    // could not fully cover the candidates (lookup-budget truncation), so the
    // category is still recorded for the differ (LOG-4).
    mockAuditStaticJsonLdPrices.mockResolvedValue({ findings: [PRICE_FINDING], skipped: true });
    mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 1);

    await runScanTheme();

    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [PRICE_FINDING]);
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({
        skippedCategories: [FindingType.JSON_LD_PRICE_CONFLICT],
      }),
    );
  });

  it("is inert (not skipped) when the flag is ON but there are no candidates", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    withCandidates([]);
    mockHasProductScope.mockResolvedValue(true);

    const result = await runScanTheme();

    expect(mockAuditStaticJsonLdPrices).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });

  it("records JSON_LD_PRICE_CONFLICT in skippedCategories when scope is NOT granted", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    withCandidates([PRICE_CANDIDATE]);
    // Product scope missing: the three product audits AND the live-price audit
    // all skip. Their categories are recorded so the differ never false-resolves.
    mockHasProductScope.mockResolvedValue(false);

    const result = await runScanTheme();

    expect(mockAuditStaticJsonLdPrices).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      skippedCategories: [
        FindingType.GHOST_TAG,
        FindingType.GHOST_PRICE,
        FindingType.GHOST_METAFIELD,
        FindingType.JSON_LD_PRICE_CONFLICT,
      ],
      skippedFiles: [],
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
    expect(result.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Dangling-reference audit (gc-m4h.5)
//
// Double-inert soft-launch: needs BOTH the DANGLING_REFERENCE_LIVE_ENABLED flag
// AND static candidates. When ON, the resolver's distinct `missing` set is
// mapped back to ONE finding per occurrence; the precise-skip rule marks the
// category skipped iff a needed scope was absent OR the lookup budget truncated.
// ---------------------------------------------------------------------------

describe("scanTheme — dangling-reference audit (gc-m4h.5)", () => {
  const DANGLING_OCCURRENCE = {
    entityType: "collection",
    handle: "summer-sale",
    filename: "sections/footer.liquid",
    lineNumber: 12,
    snippet: '<a href="/collections/summer-sale">Summer Sale</a>',
  };
  const DANGLING_DISTINCT = { entityType: "collection", handle: "summer-sale" };
  const EXPECTED_DESCRIPTION =
    "Broken collection link: /collections/summer-sale. This collection no longer exists (verified via Admin API).";

  function withCandidates(occurrences: unknown[], distinctHandles: unknown[]) {
    mockExtractDanglingReferences.mockReturnValue({ occurrences, distinctHandles });
  }

  it("is fully inert when the flag is OFF (no resolve, no persist, not skipped, findingCount 0)", async () => {
    // Flag unset by beforeEach. Candidates present, yet the step must not run.
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);

    const result = await runScanTheme();

    expect(mockResolveDanglingReferences).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      // Flag-off is a deliberate disable, NOT a scope skip.
      skippedCategories: [],
      skippedFiles: [],
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });

  it("is inert on a Free plan even when the flag is ON (plan gate, not a scope skip)", async () => {
    // Standard+ only (gc-m4h.7). Flag on + candidates present, but a Free shop
    // must NOT run the audit — and the plan gate is a deliberate withhold, so it
    // does NOT enter skippedCategories (mirrors the flag-off path exactly).
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);
    mockDb.shop.findUnique.mockResolvedValue({ ...MOCK_SHOP, plan: "free" });

    const result = await runScanTheme();

    expect(mockResolveDanglingReferences).not.toHaveBeenCalled();
    expect(mockCreateFindings).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: MOCK_FINDINGS.length,
      // Plan gate is a deliberate disable, NOT a scope skip.
      skippedCategories: [],
      skippedFiles: [],
      newFindingCount: MOCK_FINDINGS.length,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });

  it("persists one finding per occurrence for a missing ref and counts it in the total", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);
    mockResolveDanglingReferences.mockResolvedValue({
      missing: [DANGLING_DISTINCT],
      scopeStatus: { products: "checked", content: "checked" },
      truncated: false,
    });
    mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 1);

    const result = await runScanTheme();

    // Resolver is called with the distinct handles + shopId.
    expect(mockResolveDanglingReferences).toHaveBeenCalledWith(
      MOCK_ADMIN,
      [DANGLING_DISTINCT],
      SHOP_ID,
    );

    // Idempotency delete scopes by the exclusive DANGLING_REFERENCE type.
    expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
      where: { scanId: SCAN_ID, findingType: FindingType.DANGLING_REFERENCE },
    });

    // One finding per occurrence, with subtype in appName + description and the
    // occurrence's snippet/file/line carried through. Severity classified MEDIUM.
    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [
      {
        filename: DANGLING_OCCURRENCE.filename,
        lineNumber: DANGLING_OCCURRENCE.lineNumber,
        codeSnippet: DANGLING_OCCURRENCE.snippet,
        findingType: FindingType.DANGLING_REFERENCE,
        severity: Severity.MEDIUM,
        appName: "collection",
        description: EXPECTED_DESCRIPTION,
      },
    ]);

    expect(result.findingCount).toBe(MOCK_FINDINGS.length + 1);
  });

  it("emits ONE finding per occurrence when the same missing handle is linked from multiple lines", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    const secondOccurrence = {
      ...DANGLING_OCCURRENCE,
      filename: "sections/header.liquid",
      lineNumber: 4,
      snippet: "{{ collections['summer-sale'].title }}",
    };
    // Two occurrences, ONE distinct handle → resolver looks it up once, but both
    // broken links become findings.
    withCandidates([DANGLING_OCCURRENCE, secondOccurrence], [DANGLING_DISTINCT]);
    mockResolveDanglingReferences.mockResolvedValue({
      missing: [DANGLING_DISTINCT],
      scopeStatus: { products: "checked", content: "checked" },
      truncated: false,
    });
    mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 2);

    const result = await runScanTheme();

    const persisted = mockCreateFindings.mock.calls[0][1];
    expect(persisted).toHaveLength(2);
    expect(persisted.map((f: { lineNumber: number }) => f.lineNumber)).toEqual([12, 4]);
    expect(result.findingCount).toBe(MOCK_FINDINGS.length + 2);
  });

  it("does NOT flag a handle that still exists (not in the resolver's missing set)", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);
    // Resolver reports nothing missing (the collection still exists).
    mockResolveDanglingReferences.mockResolvedValue({
      missing: [],
      scopeStatus: { products: "checked", content: "checked" },
      truncated: false,
    });

    const result = await runScanTheme();

    // No DANGLING_REFERENCE finding persisted (persistAuditFindings no-ops on []).
    expect(mockCreateFindings).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });

  it("records DANGLING_REFERENCE in skippedCategories when a needed scope is absent (no false findings)", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);
    // read_products absent → the resolver reports the products scope absent and
    // returns NO missing refs for the unchecked type (precise-skip rule R1).
    mockResolveDanglingReferences.mockResolvedValue({
      missing: [],
      scopeStatus: { products: "absent", content: "checked" },
      truncated: false,
    });

    const result = await runScanTheme();

    // Never claim a ref "deleted" from an unchecked scope.
    expect(mockCreateFindings).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({
        skippedCategories: [FindingType.DANGLING_REFERENCE],
      }),
    );
    expect(result.status).toBe("COMPLETED");
  });

  it("records DANGLING_REFERENCE in skippedCategories when the lookup budget truncates", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([DANGLING_OCCURRENCE], [DANGLING_DISTINCT]);
    // Truncated: findings for what WAS checked still persist, but the category is
    // recorded so the differ never false-resolves the refs we could not re-check.
    mockResolveDanglingReferences.mockResolvedValue({
      missing: [DANGLING_DISTINCT],
      scopeStatus: { products: "checked", content: "checked" },
      truncated: true,
    });
    mockDb.finding.count.mockResolvedValue(MOCK_FINDINGS.length + 1);

    await runScanTheme();

    expect(mockCreateFindings).toHaveBeenCalledWith(SCAN_ID, [
      expect.objectContaining({ findingType: FindingType.DANGLING_REFERENCE }),
    ]);
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({
        skippedCategories: [FindingType.DANGLING_REFERENCE],
      }),
    );
  });

  it("is inert (not skipped) when the flag is ON but there are no candidates", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    withCandidates([], []);

    const result = await runScanTheme();

    expect(mockResolveDanglingReferences).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
    expect(result.findingCount).toBe(MOCK_FINDINGS.length);
  });
});

// ---------------------------------------------------------------------------
// Step-output budget (gc-4ce)
//
// The fetch-and-scan return crosses the Inngest step boundary (4 MB limit).
// Dangling-reference candidates and static JSON-LD candidates are the only
// unbounded-by-content arrays in it; both are capped, and a byte budget drops
// dangling candidates as a last resort rather than failing the scan.
// ---------------------------------------------------------------------------

describe("scanTheme — fetch-and-scan step-output budget (gc-4ce)", () => {
  const ONE_MB = 1_000_000;

  /** Run the scan and return the value the fetch-and-scan step handed Inngest. */
  async function runAndCaptureCoreStep() {
    const step = createMockInngestStep();
    await runScanTheme(undefined, { run: step.run });
    const idx = step.run.mock.calls.findIndex(([name]) => name === "fetch-and-scan");
    return (await step.run.mock.results[idx].value) as Record<string, unknown>;
  }

  function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  function danglingPersistCall() {
    return mockCreateFindings.mock.calls.find(
      ([, findings]) => findings[0]?.findingType === FindingType.DANGLING_REFERENCE,
    );
  }

  /** ~1 MB of one handle, 40 refs per line. */
  function denseSameHandleFile() {
    const line = "{{ pages['a'] }}".repeat(40);
    const lines = Array.from({ length: Math.ceil(ONE_MB / line.length) }, () => line);
    return { filename: "sections/dense.liquid", content: lines.join("\n") };
  }

  /** ~1 MB of distinct product handles, 20 per line. */
  function denseDistinctHandlesFile() {
    const lines: string[] = [];
    let n = 0;
    let size = 0;
    while (size < ONE_MB) {
      const refs = Array.from({ length: 20 }, () => `<a href="/products/h${n++}">x</a>`).join(" ");
      lines.push(refs);
      size += refs.length + 1;
    }
    return { filename: "sections/distinct.liquid", content: lines.join("\n") };
  }

  function allMissing() {
    mockResolveDanglingReferences.mockImplementation(
      async (_admin: unknown, handles: Array<{ entityType: string; handle: string }>) => ({
        missing: handles.map(({ entityType, handle }) => ({ entityType, handle })),
        scopeStatus: { products: "checked", content: "checked" },
        truncated: false,
      }),
    );
  }

  beforeEach(async () => {
    // Real extractor (its scan-engine imports resolve to this file's stubs,
    // whose buildSnippet returns 300 chars: the real cap).
    const actual = await vi.importActual<
      typeof import("../../app/services/dangling-reference-extractor.server")
    >("../../app/services/dangling-reference-extractor.server");
    mockExtractDanglingReferences.mockImplementation(actual.extractDanglingReferences);
  });

  it("keeps the worst-case output under budget and still emits findings with true counts", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    mockFetchThemeFiles.mockResolvedValue([denseSameHandleFile(), denseDistinctHandlesFile()]);
    allMissing();

    const out = await runAndCaptureCoreStep();

    expect(JSON.stringify(out).length).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    expect(jsonBytes(out)).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    expect(out.danglingTruncated).toBe(false);

    const handles = out.danglingDistinctHandles as Array<{
      handle: string;
      occurrenceCount: number;
    }>;
    // 50 product handles (the per-scope-group cap) + the dense page handle.
    expect(handles).toHaveLength(DANGLING_LOOKUP_CAP + 1);
    const pageA = handles.find((h) => h.handle === "a");
    expect(pageA?.occurrenceCount).toBeGreaterThan(60_000);

    // A finding for EVERY missing handle within the cap.
    const persisted = danglingPersistCall()?.[1] as Array<{
      description: string;
      codeSnippet: string;
      filename: string;
    }>;
    expect(persisted).toBeDefined();
    const findingHandles = new Set(
      persisted.map((f) => /\/(?:pages|products)\/([a-z0-9-]+)\./.exec(f.description)?.[1]),
    );
    for (const h of handles) expect(findingHandles.has(h.handle)).toBe(true);

    // The capped handle: N findings, each describing the TRUE total.
    const pageAFindings = persisted.filter((f) => f.description.includes("/pages/a."));
    expect(pageAFindings).toHaveLength(DANGLING_MAX_OCCURRENCES_PER_HANDLE);
    for (const f of pageAFindings) {
      expect(f.description).toContain(`referenced ${pageA?.occurrenceCount} times`);
    }
    // An uncapped handle keeps the original description verbatim.
    const h0 = persisted.find((f) => f.description.includes("/products/h0."));
    expect(h0?.description).toBe(
      "Broken product link: /products/h0. This product no longer exists (verified via Admin API).",
    );

    // Capping means some occurrences were not emitted: the category is not
    // fully audited, so the differ must not false-resolve dropped ones.
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [FindingType.DANGLING_REFERENCE] }),
    );
    const signal = mockRecordOpsEvent.mock.calls.at(-1)?.[0];
    expect(signal.metadata).toMatchObject({ danglingCapped: true, danglingTruncated: false });
  });

  it("drops dangling candidates (not the scan) when the output still exceeds the budget", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    // Simulate a payload the caps did not bound (defensive path): ~5 MB.
    const big = "x".repeat(1000);
    const occurrences = Array.from({ length: 5000 }, (_, i) => ({
      entityType: "page",
      handle: `p${i}`,
      filename: "sections/huge.liquid",
      lineNumber: i + 1,
      snippet: big,
    }));
    mockExtractDanglingReferences.mockReturnValue({
      occurrences,
      distinctHandles: occurrences.map((o) => ({
        entityType: "page",
        handle: o.handle,
        occurrenceCount: 1,
      })),
      capped: false,
    });

    const warnSpy = vi.spyOn(logger, "warn");

    const out = await runAndCaptureCoreStep();

    expect(jsonBytes(out)).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    expect(out.danglingOccurrences).toEqual([]);
    expect(out.danglingDistinctHandles).toEqual([]);
    expect(out.danglingTruncated).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("step-output budget"),
      expect.objectContaining({ event: "dangling_output_truncated", shopId: SHOP_ID }),
    );
    // Nothing resolved or persisted; category recorded so prior findings are kept.
    expect(mockResolveDanglingReferences).not.toHaveBeenCalled();
    expect(danglingPersistCall()).toBeUndefined();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({
        status: "COMPLETED",
        skippedCategories: [FindingType.DANGLING_REFERENCE],
      }),
    );
    const signal = mockRecordOpsEvent.mock.calls.at(-1)?.[0];
    expect(signal.metadata).toMatchObject({ danglingTruncated: true });
  });

  it("stays inert when over budget but the dangling flag is OFF", async () => {
    const occurrences = Array.from({ length: 5000 }, (_, i) => ({
      entityType: "page",
      handle: `p${i}`,
      filename: "sections/huge.liquid",
      lineNumber: i + 1,
      snippet: "x".repeat(1000),
    }));
    mockExtractDanglingReferences.mockReturnValue({
      occurrences,
      distinctHandles: [{ entityType: "page", handle: "p0", occurrenceCount: 1 }],
      capped: false,
    });

    const out = await runAndCaptureCoreStep();

    expect(out.danglingTruncated).toBe(true);
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ status: "COMPLETED", skippedCategories: [] }),
    );
  });

  it("stays inert when over budget on a Free plan with the flag ON", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    mockDb.shop.findUnique.mockResolvedValue({ ...MOCK_SHOP, plan: "free" });
    mockExtractDanglingReferences.mockReturnValue({
      occurrences: Array.from({ length: 5000 }, (_, i) => ({
        entityType: "page",
        handle: `p${i}`,
        filename: "sections/huge.liquid",
        lineNumber: i + 1,
        snippet: "x".repeat(1000),
      })),
      distinctHandles: [{ entityType: "page", handle: "p0", occurrenceCount: 1 }],
      capped: false,
    });

    await runAndCaptureCoreStep();

    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
  });

  it("caps static JSON-LD candidates deterministically and marks the price audit skipped", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    const count = JSONLD_PRICE_CANDIDATE_CAP + 100;
    // Supplied in reverse order so the cap must sort before truncating.
    const candidates = Array.from({ length: count }, (_, i) => ({
      filename: `sections/p${String(count - i).padStart(4, "0")}.liquid`,
      lineNumber: 1,
      codeSnippet: "y".repeat(300),
      handle: `h${i}`,
      staticPrice: "1.00",
    }));
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      staticProductCandidates: candidates,
    });
    mockAuditStaticJsonLdPrices.mockResolvedValue({ findings: [], skipped: false });

    const out = await runAndCaptureCoreStep();

    const kept = out.staticProductCandidates as Array<{ filename: string }>;
    expect(kept).toHaveLength(JSONLD_PRICE_CANDIDATE_CAP);
    expect(kept[0].filename).toBe("sections/p0001.liquid");
    expect(kept.at(-1)?.filename).toBe(
      `sections/p${String(JSONLD_PRICE_CANDIDATE_CAP).padStart(4, "0")}.liquid`,
    );
    expect(jsonBytes(out)).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    expect(mockAuditStaticJsonLdPrices).toHaveBeenCalledWith(MOCK_ADMIN, kept, SHOP_ID);
    // The audit covered everything it was given, but candidates were dropped.
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [FindingType.JSON_LD_PRICE_CONFLICT] }),
    );
    const signal = mockRecordOpsEvent.mock.calls.at(-1)?.[0];
    expect(signal.metadata).toMatchObject({ staticCandidatesCapped: true });
  });

  /** Resolver stub: only the given `"type handle"` keys are missing. */
  function onlyMissing(...keys: string[]) {
    mockResolveDanglingReferences.mockImplementation(
      async (_admin: unknown, handles: Array<{ entityType: string; handle: string }>) => ({
        missing: handles
          .filter(({ entityType, handle }) => keys.includes(`${entityType} ${handle}`))
          .map(({ entityType, handle }) => ({ entityType, handle })),
        scopeStatus: { products: "checked", content: "checked" },
        truncated: false,
      }),
    );
  }

  /** Run one scan; return the persisted dangling findings + skippedCategories. */
  async function scanDangling(content: string) {
    vi.clearAllMocks();
    mockFetchThemeFiles.mockResolvedValue([{ filename: "sections/header.liquid", content }]);
    await runAndCaptureCoreStep();
    const findings = (danglingPersistCall()?.[1] ?? []) as Array<Record<string, unknown>>;
    const { skippedCategories } = mockFinalizeScan.mock.calls.at(-1)?.[1] as {
      skippedCategories: string[];
    };
    return {
      findings: findings.map((f) => ({ ...f, id: "", scanId: "", shopId: "" })),
      skippedCategories,
    };
  }

  it("does not skip the category when an EXISTING handle exceeds the per-handle cap", async () => {
    // Audit repro (churn.ts): a mega menu links an existing page 21x, plus one
    // link to a deleted product. The existing page's extra occurrences change
    // nothing, so the category is fully audited and diffs normally.
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    onlyMissing("product deleted-thing");
    const menu = Array.from(
      { length: DANGLING_MAX_OCCURRENCES_PER_HANDLE + 1 },
      (_, i) => `<a href="/pages/contact">Contact ${i}</a>`,
    );
    const broken = [...menu, '<a href="/products/deleted-thing">Old</a>'].join("\n");

    const first = await scanDangling(broken);
    expect(first.findings).toHaveLength(1);
    expect(first.skippedCategories).toEqual([]);
    const signal = mockRecordOpsEvent.mock.calls.at(-1)?.[0];
    expect(signal.metadata).toMatchObject({ danglingCapped: false });

    // Identical rescan: the finding is unchanged, not new.
    const rescan = await scanDangling(broken);
    const same = diffScans(rescan.findings as never, first.findings as never, {
      skippedCategories: rescan.skippedCategories,
    });
    expect(same.newFindings).toHaveLength(0);
    expect(same.unchangedCount).toBe(1);

    // Merchant fixes the link: the finding resolves.
    const fixed = await scanDangling(menu.join("\n"));
    expect(fixed.skippedCategories).toEqual([]);
    const diff = diffScans(fixed.findings as never, first.findings as never, {
      skippedCategories: fixed.skippedCategories,
    });
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("skips the category when a MISSING handle exceeds the per-handle cap", async () => {
    // Occurrences past the cap of a missing handle get no finding, so the
    // category is not fully audited and prior findings must not false-resolve.
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    onlyMissing("page gone");
    const lines = Array.from(
      { length: DANGLING_MAX_OCCURRENCES_PER_HANDLE + 1 },
      (_, i) => `<a href="/pages/gone">x ${i}</a>`,
    );

    const { findings, skippedCategories } = await scanDangling(lines.join("\n"));

    expect(findings).toHaveLength(DANGLING_MAX_OCCURRENCES_PER_HANDLE);
    expect(skippedCategories).toEqual([FindingType.DANGLING_REFERENCE]);
  });

  it("does not skip the category for a missing handle exactly at the per-handle cap", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    onlyMissing("page gone");
    const lines = Array.from(
      { length: DANGLING_MAX_OCCURRENCES_PER_HANDLE },
      (_, i) => `<a href="/pages/gone">x ${i}</a>`,
    );

    const { findings, skippedCategories } = await scanDangling(lines.join("\n"));

    expect(findings).toHaveLength(DANGLING_MAX_OCCURRENCES_PER_HANDLE);
    expect(skippedCategories).toEqual([]);
  });

  it("drops static candidates too (not the scan) when dropping dangling is not enough", async () => {
    // Audit repro (static.ts shape): 500 candidates, each with a huge field,
    // blow past the budget with no dangling candidates to drop at all.
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    const candidates = Array.from({ length: JSONLD_PRICE_CANDIDATE_CAP }, (_, i) => ({
      filename: `snippets/ld-${i}.liquid`,
      lineNumber: 1,
      codeSnippet: "y".repeat(300),
      sku: `${"S".repeat(9000)}-${i}`,
      staticPrice: "9.99",
    }));
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      staticProductCandidates: candidates,
    });
    const warnSpy = vi.spyOn(logger, "warn");

    const out = await runAndCaptureCoreStep();

    expect(jsonBytes(out)).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    expect(out.staticProductCandidates).toEqual([]);
    expect(out.staticCandidatesCapped).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("step-output budget"),
      expect.objectContaining({ event: "static_candidates_output_truncated", shopId: SHOP_ID }),
    );
    // Nothing to audit this scan, but the category is reported skipped so prior
    // price findings are kept; the scan itself completes.
    expect(mockAuditStaticJsonLdPrices).not.toHaveBeenCalled();
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({
        status: "COMPLETED",
        skippedCategories: expect.arrayContaining([FindingType.JSON_LD_PRICE_CONFLICT]),
      }),
    );
  });

  it("keeps static candidates when dropping dangling alone gets under the budget", async () => {
    process.env.JSONLD_LIVE_PRICE_ENABLED = "true";
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    mockExtractDanglingReferences.mockReturnValue({
      occurrences: Array.from({ length: 5000 }, (_, i) => ({
        entityType: "page",
        handle: `p${i}`,
        filename: "sections/huge.liquid",
        lineNumber: i + 1,
        snippet: "x".repeat(1000),
      })),
      distinctHandles: [{ entityType: "page", handle: "p0", occurrenceCount: 1 }],
      capped: false,
    });
    const candidates = [
      {
        filename: "snippets/ld.liquid",
        lineNumber: 1,
        codeSnippet: "y",
        sku: "A",
        staticPrice: "1",
      },
    ];
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      staticProductCandidates: candidates,
    });
    mockAuditStaticJsonLdPrices.mockResolvedValue({ findings: [], skipped: false });

    const out = await runAndCaptureCoreStep();

    expect(out.danglingTruncated).toBe(true);
    expect(out.staticProductCandidates).toEqual(candidates);
    expect(out.staticCandidatesCapped).toBe(false);
  });

  it("leaves an ordinary theme's output and skippedCategories untouched", async () => {
    process.env.DANGLING_REFERENCE_LIVE_ENABLED = "true";
    mockFetchThemeFiles.mockResolvedValue([
      { filename: "sections/footer.liquid", content: '<a href="/pages/gone">x</a>' },
    ]);
    allMissing();

    const out = await runAndCaptureCoreStep();

    expect(out.danglingTruncated).toBe(false);
    expect(out.danglingOccurrences).toHaveLength(1);
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
    const signal = mockRecordOpsEvent.mock.calls.at(-1)?.[0];
    expect(signal.metadata).toMatchObject({
      danglingCapped: false,
      danglingTruncated: false,
      staticCandidatesCapped: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Zero-file sanity guard (LOG-5)
//
// A theme fetch that returns ZERO files is suspicious for any real theme. If the
// most recent prior successful scan had findings, completing the scan as clean
// would wipe those findings and the diff would falsely mark them all "resolved".
// The guard fails the scan in that case; otherwise scans complete normally.
// ---------------------------------------------------------------------------

describe("scanTheme — zero-file sanity guard (LOG-5)", () => {
  beforeEach(() => {
    // Simulate a soft-failed / empty theme fetch: no files, no theme findings.
    mockFetchThemeFiles.mockResolvedValue([]);
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
  });

  it("fails the scan when 0 files are fetched but the prior successful scan had findings", async () => {
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });
    mockGetPreviousScanForTheme.mockResolvedValue({
      id: "prior-scan-1",
      findingCount: 5,
    });

    await expect(runScanTheme()).rejects.toThrow(/fetched 0 theme files/);

    // The prior scan was looked up using this scan's createdAt as the boundary.
    expect(mockGetPreviousScanForTheme).toHaveBeenCalledWith(
      SHOP_ID,
      THEME_ID,
      new Date("2026-06-15T00:00:00Z"),
    );
    // The scan must be marked FAILED, never finalized COMPLETED/PARTIAL.
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "FAILED");
    expect(mockFinalizeScan).not.toHaveBeenCalled();
  });

  it("completes normally when 0 files are fetched and there is no prior scan", async () => {
    mockGetPreviousScanForTheme.mockResolvedValue(null);

    const result = await runScanTheme();

    expect(result).toEqual({ scanId: SCAN_ID, findingCount: 0, status: "COMPLETED" });
    expect(mockFinalizeScan).toHaveBeenCalledWith(SCAN_ID, {
      status: "COMPLETED",
      findingCount: 0,
      skippedCategories: [],
      skippedFiles: [],
      // No prior scan → first-scan baseline: all zeros.
      newFindingCount: 0,
      resolvedFindingCount: 0,
      persistedFindingCount: 0,
    });
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("completes normally when 0 files are fetched and the prior scan had zero findings", async () => {
    // findings:[] so the finalize-step resolution diff (Feature 3) can run.
    mockGetPreviousScanForTheme.mockResolvedValue({
      id: "prior-scan-clean",
      findingCount: 0,
      findings: [],
    });

    const result = await runScanTheme();

    expect(result).toEqual({ scanId: SCAN_ID, findingCount: 0, status: "COMPLETED" });
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("trusts a non-empty fetch and completes even when a prior scan had findings (guard bypassed)", async () => {
    mockFetchThemeFiles.mockResolvedValue(MOCK_FILES);
    mockScanThemeFiles.mockReturnValue({ findings: MOCK_FINDINGS, unknownScripts: [] });
    // A prior scan with findings exists, but a non-empty fetch is trusted so the
    // zero-file guard never fires and the scan completes. findings:[] lets the
    // finalize-step resolution diff run (the guard's own prior-scan lookup no
    // longer being the only caller — finalize also looks it up now).
    mockGetPreviousScanForTheme.mockResolvedValue({ id: "prior", findingCount: 5, findings: [] });

    const result = await runScanTheme();

    expect(result.status).toBe("COMPLETED");
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });
});

// ---------------------------------------------------------------------------
// Feature 1 — third-party domain persistence
// ---------------------------------------------------------------------------

describe("scanTheme — third-party domain capture (Feature 1)", () => {
  it("persists the scan engine's third-party domains via createScanDomains", async () => {
    const domains = [
      {
        domain: "static.klaviyo.com",
        sources: ["script"],
        refCount: 1,
        matched: true,
        appName: "Klaviyo",
        benign: false,
      },
      {
        domain: "api.unknownvendor.io",
        sources: ["ajax"],
        refCount: 2,
        matched: false,
        appName: null,
        benign: false,
      },
    ];
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      thirdPartyDomains: domains,
    });

    await runScanTheme();

    expect(mockCreateScanDomains).toHaveBeenCalledWith(SCAN_ID, domains);
  });

  it("persists an empty domain list when the engine returns none", async () => {
    mockScanThemeFiles.mockReturnValue({ findings: MOCK_FINDINGS, unknownScripts: [] });

    await runScanTheme();

    expect(mockCreateScanDomains).toHaveBeenCalledWith(SCAN_ID, []);
  });
});

// ---------------------------------------------------------------------------
// Feature 2 — per-scan scan_signal OpsEvent
// ---------------------------------------------------------------------------

describe("scanTheme — scan_signal OpsEvent (Feature 2)", () => {
  it("emits one scan_signal with the detectorHits histogram and threaded scalars", async () => {
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [{ url: "https://x" }, { url: "https://y" }],
      benignLibrarySkips: 3,
      thirdPartyDomains: [
        {
          domain: "a.io",
          sources: ["script"],
          refCount: 1,
          matched: false,
          appName: null,
          benign: false,
        },
      ],
    });
    // Authoritative per-detector histogram (DB groupBy, _count:true → number).
    mockDb.finding.groupBy.mockResolvedValue([
      { findingType: "GHOST_SCRIPT", _count: 2 },
      { findingType: "GHOST_STYLE", _count: 1 },
    ]);
    // Scan row read back for timing (durationMs = completedAt - startedAt).
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
      startedAt: new Date("2026-06-15T00:00:00Z"),
      completedAt: new Date("2026-06-15T00:00:05Z"),
    });

    await runScanTheme();

    expect(mockRecordOpsEvent).toHaveBeenCalledTimes(1);
    const [arg] = mockRecordOpsEvent.mock.calls[0];
    expect(arg.eventType).toBe("scan_signal");
    expect(arg.key).toBe(SCAN_ID);
    expect(arg.metadata).toMatchObject({
      shopId: SHOP_ID,
      scanId: SCAN_ID,
      plan: "Standard",
      themeId: THEME_ID,
      fileCount: MOCK_FILES.length,
      scannableFileCount: MOCK_FILES.length,
      totalTextBytes: 30,
      largestFileBytes: 17,
      scannableTextBytes: 30,
      skippedFileCount: 0,
      benignLibrarySkips: 3,
      unknownScriptCount: 2,
      thirdPartyDomainCount: 1,
      detectorHits: { GHOST_SCRIPT: 2, GHOST_STYLE: 1 },
      findingCount: MOCK_FINDINGS.length,
      durationMs: 5000,
    });
  });

  it("threads per-file finding cap hits into the scan_signal and warns (gc-ypk)", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    mockScanThemeFiles.mockReturnValue({
      findings: MOCK_FINDINGS,
      unknownScripts: [],
      findingCapHits: { GHOST_TITLE: 2, DUPLICATE_META: 1 },
    });

    await runScanTheme();

    const [arg] = mockRecordOpsEvent.mock.calls[0];
    expect(arg.metadata.findingCapHits).toEqual({ GHOST_TITLE: 2, DUPLICATE_META: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("capped"),
      expect.objectContaining({
        event: "findings_capped_per_file",
        shopId: SHOP_ID,
        cap: MAX_FINDINGS_PER_FILE_PER_TYPE,
        findingCapHits: { GHOST_TITLE: 2, DUPLICATE_META: 1 },
      }),
    );
    // Telemetry only: a cap hit is never a skipped category (gc-11f banner).
    expect(mockFinalizeScan).toHaveBeenCalledWith(
      SCAN_ID,
      expect.objectContaining({ skippedCategories: [] }),
    );
    warnSpy.mockRestore();
  });

  it("emits an empty findingCapHits and no cap warning for an uncapped scan (gc-ypk)", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    // Older/partial ScanResult without the field (e.g. a stale worker build).
    mockScanThemeFiles.mockReturnValue({ findings: MOCK_FINDINGS, unknownScripts: [] });

    await runScanTheme();

    const [arg] = mockRecordOpsEvent.mock.calls[0];
    expect(arg.metadata.findingCapHits).toEqual({});
    expect(
      warnSpy.mock.calls.some(
        ([, meta]) => (meta as { event?: string })?.event === "findings_capped_per_file",
      ),
    ).toBe(false);
    warnSpy.mockRestore();
  });

  it("computes totalTextBytes/largestFileBytes/scannableTextBytes over mixed file types (gc-d4e)", async () => {
    // Mixed fixture: one scannable liquid template, one non-scannable asset JS
    // file (the largest), and one non-scannable JSON file — so
    // scannableTextBytes must exclude the JS/JSON content while totalTextBytes
    // and largestFileBytes still account for it.
    const mixedFiles = [
      { filename: "templates/index.liquid", content: "A".repeat(10) },
      { filename: "assets/app.js", content: "B".repeat(500) },
      { filename: "assets/data.json", content: "C".repeat(50) },
    ];
    mockFetchThemeFiles.mockResolvedValue(mixedFiles);
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
      startedAt: new Date("2026-06-15T00:00:00Z"),
      completedAt: new Date("2026-06-15T00:00:05Z"),
    });

    await runScanTheme();

    const [arg] = mockRecordOpsEvent.mock.calls[0];
    expect(arg.metadata).toMatchObject({
      fileCount: 3,
      scannableFileCount: 1,
      totalTextBytes: 560,
      largestFileBytes: 500,
      scannableTextBytes: 10,
    });
  });

  it("emits zero-valued size fields when the theme fetch returns no files", async () => {
    mockFetchThemeFiles.mockResolvedValue([]);
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
      startedAt: new Date("2026-06-15T00:00:00Z"),
      completedAt: new Date("2026-06-15T00:00:05Z"),
    });
    // No prior scan with findings, so the zero-file sanity guard does not fire
    // (mockGetPreviousScanForTheme already defaults to null in beforeEach).

    await runScanTheme();

    const [arg] = mockRecordOpsEvent.mock.calls[0];
    expect(arg.metadata).toMatchObject({
      fileCount: 0,
      scannableFileCount: 0,
      totalTextBytes: 0,
      largestFileBytes: 0,
      scannableTextBytes: 0,
    });
  });

  it("does NOT throw and still completes the scan when the signal groupBy fails", async () => {
    mockDb.finding.groupBy.mockRejectedValue(new Error("groupBy exploded"));

    const result = await runScanTheme();

    // Telemetry failure is swallowed — the scan is unaffected.
    expect(result.status).toBe("COMPLETED");
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });
});

// ---------------------------------------------------------------------------
// Feature 3 — resolution tracking (diff → counts)
// ---------------------------------------------------------------------------

describe("scanTheme — resolution counts (Feature 3)", () => {
  const findingA = {
    filename: "sections/a.liquid",
    findingType: "GHOST_SCRIPT",
    codeSnippet: "aaa",
    lineNumber: 1,
    severity: "HIGH",
    appName: null,
    description: "A",
  };
  const findingB = {
    filename: "sections/b.liquid",
    findingType: "GHOST_STYLE",
    codeSnippet: "bbb",
    lineNumber: 1,
    severity: "MEDIUM",
    appName: null,
    description: "B",
  };
  const findingC = {
    filename: "sections/c.liquid",
    findingType: "GHOST_SNIPPET",
    codeSnippet: "ccc",
    lineNumber: 1,
    severity: "LOW",
    appName: null,
    description: "C",
  };

  it("computes new/resolved/persisted via the differ against the previous scan", async () => {
    // Current DB findings: A (persists), C (new). Prior: A (persists), B (resolved).
    mockScanThemeFiles.mockReturnValue({ findings: [findingA, findingC], unknownScripts: [] });
    mockDb.finding.findMany.mockResolvedValue([findingA, findingC]);
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });
    mockGetPreviousScanForTheme.mockResolvedValue({
      id: "prior",
      findingCount: 2,
      findings: [findingA, findingB],
    });

    await runScanTheme();

    const finalizeArg = mockFinalizeScan.mock.calls[0][1];
    expect(finalizeArg).toMatchObject({
      newFindingCount: 1, // C
      resolvedFindingCount: 1, // B
      persistedFindingCount: 1, // A
    });
  });

  it("does NOT count a scope-skipped category's prior findings as resolved (LOG-4)", async () => {
    // The product-tag audit's scope is missing → GHOST_TAG lands in
    // skippedCategories, so a prior GHOST_TAG finding absent this run must NOT be
    // reported resolved (we did not re-check it).
    mockHasProductScope.mockResolvedValue(false);

    const priorTagFinding = {
      filename: "n/a",
      findingType: "GHOST_TAG",
      codeSnippet: "tag",
      lineNumber: 0,
      severity: "LOW",
      appName: null,
      description: "prior tag",
    };
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
    mockDb.finding.findMany.mockResolvedValue([]);
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });
    mockGetPreviousScanForTheme.mockResolvedValue({
      id: "prior",
      findingCount: 1,
      findings: [priorTagFinding],
    });

    await runScanTheme();

    const finalizeArg = mockFinalizeScan.mock.calls[0][1];
    expect(finalizeArg.skippedCategories).toContain("GHOST_TAG");
    expect(finalizeArg.resolvedFindingCount).toBe(0);
    expect(finalizeArg.newFindingCount).toBe(0);
  });

  it("does NOT re-report an unchanged finding as new when its walk truncated (Option C regression, gc-1bd)", async () => {
    // REGRESSION (gc-1bd): the branch's observable-cap marked a truncated product
    // walk as a skippedCategory. The differ filters PREVIOUS findings by
    // skippedCategories but not CURRENT, so a store whose catalog truncates on
    // every scan had its prior GHOST_TAG dropped from the baseline while the
    // still-present current GHOST_TAG persisted — reported "new" forever. Under
    // Option C truncation is telemetry only, so the scanned subset diffs normally
    // and an unchanged finding is correctly "persisted", not "new".
    //
    // Fails on pre-fix code: GHOST_TAG lands in skippedCategories, so the prior
    // finding is filtered out, newFindingCount is 1, persistedFindingCount is 0.
    const tagFinding = {
      filename: "n/a",
      findingType: "GHOST_TAG",
      codeSnippet: "orphaned-tag",
      lineNumber: 0,
      severity: "MEDIUM",
      appName: null,
      description: "Orphaned GHOST_TAG",
    };
    // Scope present so the walk actually runs and truncates (telemetry path).
    mockHasProductScope.mockResolvedValue(true);
    mockFetchProductAuditData.mockResolvedValue(
      makeProductAuditData({
        tags: [{ id: "gid://shopify/Product/1" }],
        truncated: true,
        pageCount: 9,
      }),
    );
    // Current persisted findings (what the differ reads) + prior scan both hold
    // the SAME GHOST_TAG → it is unchanged, not new and not resolved.
    mockScanThemeFiles.mockReturnValue({ findings: [], unknownScripts: [] });
    mockDb.finding.findMany.mockResolvedValue([tagFinding]);
    mockDb.scan.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });
    mockGetPreviousScanForTheme.mockResolvedValue({
      id: "prior",
      findingCount: 1,
      findings: [tagFinding],
    });

    await runScanTheme();

    const finalizeArg = mockFinalizeScan.mock.calls[0][1];
    // The category is NOT skipped for truncation...
    expect(finalizeArg.skippedCategories).not.toContain("GHOST_TAG");
    // ...so the unchanged finding diffs as persisted, never "new".
    expect(finalizeArg.newFindingCount).toBe(0);
    expect(finalizeArg.resolvedFindingCount).toBe(0);
    expect(finalizeArg.persistedFindingCount).toBe(1);
    // Non-vacuous: the walk genuinely truncated (telemetry proves it).
    const [signal] = mockRecordOpsEvent.mock.calls[0];
    expect(signal.metadata.truncatedWalks).toEqual(["products"]);
  });
});
