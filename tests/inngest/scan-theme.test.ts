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
    },
  },
}));

vi.mock("../../app/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchThemeFiles: vi.fn(),
}));

vi.mock("../../app/services/scan-engine.server", () => ({
  scanThemeFiles: vi.fn(),
  MAX_SCANNABLE_FILE_BYTES: 1_000_000,
}));

vi.mock("../../app/services/scan-pool.server", () => ({
  scanThemeFilesInPool: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  createUnknownScripts: vi.fn(),
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
  fetchProductTags: vi.fn(),
  fetchProductPrices: vi.fn(),
  fetchProductMetafields: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { TransientScopeCheckError } from "../../app/lib/scope-check.server";
import { saveThemeFindings, createFindings } from "../../app/models/finding.server";
import {
  finalizeScan,
  updateScanStatus,
  getPreviousScanForTheme,
} from "../../app/models/scan.server";
import { createUnknownScripts } from "../../app/models/unknown-script.server";
import { hasContentScope, fetchPages } from "../../app/services/content-fetcher.server";
import { auditStaticJsonLdPrices } from "../../app/services/jsonld-price-audit.server";
import { detectOrphanedMetafields } from "../../app/services/metafield-detector.server";
import { detectOrphanedPages } from "../../app/services/page-detector.server";
import { detectPersistentDiscounts } from "../../app/services/price-detector.server";
import {
  hasProductScope,
  fetchProductTags,
  fetchProductPrices,
  fetchProductMetafields,
} from "../../app/services/product-fetcher.server";
import { detectOrphanedProductTags } from "../../app/services/product-tag-detector.server";
import { detectOrphanedRedirects } from "../../app/services/redirect-detector.server";
import { hasNavigationScope, fetchRedirects } from "../../app/services/redirect-fetcher.server";
import { scanThemeFilesInPool } from "../../app/services/scan-pool.server";
import { fetchThemeFiles } from "../../app/services/theme-fetcher.server";
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
  finding: { deleteMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
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

// Audit scope checks
const mockHasTranslationScope = hasTranslationScope as ReturnType<typeof vi.fn>;
const mockHasProductScope = hasProductScope as ReturnType<typeof vi.fn>;
const mockHasContentScope = hasContentScope as ReturnType<typeof vi.fn>;
const mockHasNavigationScope = hasNavigationScope as ReturnType<typeof vi.fn>;

// Audit fetchers
const mockAuditTranslations = auditTranslations as ReturnType<typeof vi.fn>;
const mockFetchProductTags = fetchProductTags as ReturnType<typeof vi.fn>;
const mockFetchProductPrices = fetchProductPrices as ReturnType<typeof vi.fn>;
const mockFetchProductMetafields = fetchProductMetafields as ReturnType<typeof vi.fn>;
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

  mockFetchProductTags.mockResolvedValue([]);
  mockFetchProductPrices.mockResolvedValue([]);
  mockFetchProductMetafields.mockResolvedValue([]);
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
    });
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
      mockFetchProductTags.mockResolvedValue([{ id: "gid://shopify/Product/1" }]);
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
      mockFetchProductTags.mockResolvedValue([{ id: "gid://shopify/Product/1" }]);
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
      // product-backed audits (tag, price, metafield) all gate on it.
      mockHasProductScope.mockResolvedValue(false);
      // Even though data + detector would yield findings, the audit must skip.
      mockFetchProductTags.mockResolvedValue([{ id: "gid://shopify/Product/1" }]);
      mockDetectOrphanedProductTags.mockReturnValue([makeAuditFinding(FindingType.GHOST_TAG)]);

      const result = await runScanTheme();

      // Skipped before fetching / persisting anything for those audits.
      expect(mockFetchProductTags).not.toHaveBeenCalled();
      expect(mockFetchProductPrices).not.toHaveBeenCalled();
      expect(mockFetchProductMetafields).not.toHaveBeenCalled();
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
    });
    expect(result.status).toBe("COMPLETED");
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
    });
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("completes normally when 0 files are fetched and the prior scan had zero findings", async () => {
    mockGetPreviousScanForTheme.mockResolvedValue({ id: "prior-scan-clean", findingCount: 0 });

    const result = await runScanTheme();

    expect(result).toEqual({ scanId: SCAN_ID, findingCount: 0, status: "COMPLETED" });
    expect(mockUpdateScanStatus).not.toHaveBeenCalledWith(SCAN_ID, "FAILED");
  });

  it("does NOT run the guard (or look up a prior scan) when files were fetched", async () => {
    mockFetchThemeFiles.mockResolvedValue(MOCK_FILES);
    mockScanThemeFiles.mockReturnValue({ findings: MOCK_FINDINGS, unknownScripts: [] });
    // Even if a prior scan with findings exists, a non-empty fetch is trusted.
    mockGetPreviousScanForTheme.mockResolvedValue({ id: "prior", findingCount: 5 });

    const result = await runScanTheme();

    expect(mockGetPreviousScanForTheme).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
  });
});
