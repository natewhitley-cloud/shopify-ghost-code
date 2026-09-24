/**
 * Tests for app/routes/app.scans.$scanId.tsx (scan detail)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock scan/finding models, plan-gating, health-score, and app-lookup.
 *   - Verify loader returns correct data: paginated findings, no inline diff
 *     (diff is now in the .diff resource route — see app.scans.$scanId.diff.test.ts),
 *     canUseDiffing flag, appAttributionData, and findingsPagination.
 *
 * PRF-2: loader no longer loads full findings or previous-scan data.
 *   - getScanById is always called with { includeFindings: false }
 *   - getFindingsPageForScan provides the paginated findings
 *   - getAppAttributionForScan provides the lean attribution data
 *   - getPreviousScanForTheme / diffScans are not called from this loader
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingSummary: vi.fn(),
  getFindingsForScan: vi.fn(),
  getHighestSeverityFinding: vi.fn(),
  getFindingsPageForScan: vi.fn(),
  getAppAttributionForScan: vi.fn(),
  getFindingFilterOptionsForScan: vi.fn(),
  getFindingByIdForShop: vi.fn(),
  // Zero-map helpers used by the REAL getFilteredFindingSummary (finding-aggregation
  // is left unmocked). Needed once a test supplies non-empty ignores, which routes
  // aggregation through the materialize-and-filter path instead of the groupBy.
  createZeroSeverityCounts: () => ({ HIGH: 0, MEDIUM: 0, LOW: 0 }),
  createZeroTypeCounts: () => ({}),
}));

// E2.2: the loader now aggregates via getFilteredFindingSummary, which fast-paths
// to getFindingSummary when the shop has no suppressions. Left unmocked (real,
// pure) so the fast-path assertions on getFindingSummary below still hold; only
// the ignore read is mocked to return "no suppressions".
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
  ignoreFindingInstance: vi.fn(),
  ignoreFindingApp: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canViewFindingDetails: vi.fn(),
  canUseScanDiffing: vi.fn(),
  canExportPdf: vi.fn(),
}));

vi.mock("../../app/lib/health-score", () => ({
  computeHealthScore: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  getUnknownScriptsForScan: vi.fn(),
  submitSignatureSuggestion: vi.fn(),
  findUnknownScriptForShop: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
  statusTone: vi.fn().mockReturnValue("info"),
  statusLabel: vi.fn().mockReturnValue("Completed"),
  // Mirror the real implementation so loader gating on successful scans works.
  isSuccessfulScan: (status: string) => status === "COMPLETED" || status === "PARTIAL",
}));

vi.mock("../../app/services/app-lookup.server", () => ({
  isTrackerApp: vi.fn().mockReturnValue(false),
}));

// gc-97k.4: the once-per-merchant nudge recorder (its claim/dedupe logic is
// covered in tests/services/upgrade-preview-nudge.server.test.ts).
vi.mock("../../app/services/upgrade-preview-nudge.server", () => ({
  recordUpgradePreviewStageOnce: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { laneLabelForLane, soWhatForLane, typesForLane } from "../../app/lib/finding-consequence";
import { computeHealthScore } from "../../app/lib/health-score";
import { canUseScanDiffing, canViewFindingDetails } from "../../app/lib/plan-gating.server";
import {
  getAppAttributionForScan,
  getFindingByIdForShop,
  getFindingFilterOptionsForScan,
  getFindingsForScan,
  getFindingsPageForScan,
  getFindingSummary,
  getHighestSeverityFinding,
} from "../../app/models/finding.server";
import {
  getIgnoredFindingsForShop,
  ignoreFindingApp,
  ignoreFindingInstance,
} from "../../app/models/ignored-finding.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  findUnknownScriptForShop,
  getUnknownScriptsForScan,
  submitSignatureSuggestion,
} from "../../app/models/unknown-script.server";
import {
  action,
  cappedCategoriesNotice,
  CopyButton,
  FindingRow,
  loader,
  nextFindingsFilterParams,
  ScanCoverageNotices,
  scanProgressLabel,
  skippedFilesNotice,
  recordUpgradeClick,
  UpgradePreviewBanner,
} from "../../app/routes/app.scans.$scanId";
import { isTrackerApp } from "../../app/services/app-lookup.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import { recordUpgradePreviewStageOnce } from "../../app/services/upgrade-preview-nudge.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScanById = getScanById as ReturnType<typeof vi.fn>;
const mockGetFindingSummary = getFindingSummary as ReturnType<typeof vi.fn>;
const mockGetFindingsPageForScan = getFindingsPageForScan as ReturnType<typeof vi.fn>;
const mockGetAppAttributionForScan = getAppAttributionForScan as ReturnType<typeof vi.fn>;
const mockGetFindingFilterOptionsForScan = getFindingFilterOptionsForScan as ReturnType<
  typeof vi.fn
>;
const mockGetHighestSeverityFinding = getHighestSeverityFinding as ReturnType<typeof vi.fn>;
const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockGetIgnoredFindings = getIgnoredFindingsForShop as ReturnType<typeof vi.fn>;
const mockGetFindingByIdForShop = getFindingByIdForShop as ReturnType<typeof vi.fn>;
const mockIgnoreFindingInstance = ignoreFindingInstance as ReturnType<typeof vi.fn>;
const mockIgnoreFindingApp = ignoreFindingApp as ReturnType<typeof vi.fn>;
const mockCanViewFindingDetails = canViewFindingDetails as ReturnType<typeof vi.fn>;
const mockCanUseScanDiffing = canUseScanDiffing as ReturnType<typeof vi.fn>;
const mockComputeHealthScore = computeHealthScore as ReturnType<typeof vi.fn>;
const mockFindUnknownScriptForShop = findUnknownScriptForShop as ReturnType<typeof vi.fn>;
const mockIsTrackerApp = isTrackerApp as ReturnType<typeof vi.fn>;
const mockSubmitSignatureSuggestion = submitSignatureSuggestion as ReturnType<typeof vi.fn>;
const mockRecordUpgradePreviewStage = recordUpgradePreviewStageOnce as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Standard",
};

/** Scan fixture — no findings included; loader always uses includeFindings: false. */
const SCAN = {
  id: "scan-1",
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/123456",
  themeName: "Dawn",
  status: "COMPLETED",
  findingCount: 5,
  startedAt: new Date("2026-03-20T10:00:00Z"),
  completedAt: new Date("2026-03-20T10:05:00Z"),
  createdAt: new Date("2026-03-20T10:00:00Z"),
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  skippedFiles: [] as string[],
};

const FINDING_ONE = {
  id: "f-1",
  severity: "HIGH",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 42,
  appName: "SomeApp",
  codeSnippet: '<script src="https://cdn.someapp.com/tracker.js"></script>',
  description: "Orphaned script tag",
  createdAt: new Date("2026-03-20T10:05:00Z"),
};

const FINDING_SUMMARY = {
  total: 5,
  bySeverity: { HIGH: 2, MEDIUM: 2, LOW: 1 },
  byType: { GHOST_SCRIPT: 3, GHOST_STYLE: 2, GHOST_SNIPPET: 0 },
};

const HEALTH_SCORE = {
  score: 69,
  label: "Fair",
  tone: "warning" as const,
};

const EMPTY_FINDINGS_PAGE = { items: [], hasNextPage: false, nextCursor: null };
const SINGLE_FINDING_PAGE = {
  items: [FINDING_ONE],
  hasNextPage: false,
  nextCursor: null,
};

function makeLoaderArgs(
  scanId: string,
  url?: string,
  overrides?: Partial<LoaderFunctionArgs>,
): LoaderFunctionArgs {
  const requestUrl = url ?? `https://test-shop.myshopify.com/app/scans/${scanId}`;
  return {
    request: new Request(requestUrl),
    params: { scanId },
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

function makeActionArgs(fields: Record<string, string>): ActionFunctionArgs {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value);
  }

  return {
    request: new Request("https://test-shop.myshopify.com/app/scans/scan-1", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    params: { scanId: "scan-1" },
    context: {},
  } as unknown as ActionFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP.domain },
  });

  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockGetScanById.mockResolvedValue(SCAN);
  mockGetFindingSummary.mockResolvedValue(FINDING_SUMMARY);
  mockGetFindingsPageForScan.mockResolvedValue(SINGLE_FINDING_PAGE);
  mockGetAppAttributionForScan.mockResolvedValue([]);
  mockGetFindingFilterOptionsForScan.mockResolvedValue({ types: [], apps: [] });
  // vi.resetAllMocks clears mockReturnValue set in the vi.mock factory; restore here.
  mockIsTrackerApp.mockReturnValue(false);
  mockCanViewFindingDetails.mockReturnValue(true);
  mockCanUseScanDiffing.mockReturnValue(false);
  mockComputeHealthScore.mockReturnValue(HEALTH_SCORE);
  mockGetHighestSeverityFinding.mockResolvedValue(null);
  mockGetFindingsForScan.mockResolvedValue([]);
  mockGetIgnoredFindings.mockResolvedValue({ fingerprints: new Set(), appNames: new Set() });
  (getUnknownScriptsForScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.scans.$scanId loader", () => {
  // -------------------------------------------------------------------------
  // Baseline shape
  // -------------------------------------------------------------------------

  it("returns the expected loader shape for a paid plan", async () => {
    const result = (await loader(makeLoaderArgs("scan-1"))) as {
      scan: { id: string };
      findings: unknown[];
      findingsPagination: { hasNextPage: boolean; nextCursor: string | null };
      canViewDetails: boolean;
      canUseDiffing: boolean;
      previewFinding: null;
      healthScore: typeof HEALTH_SCORE;
      findingSummary: typeof FINDING_SUMMARY;
      appAttributionData: unknown[];
    };

    expect(result.scan.id).toBe("scan-1");
    expect(result.findings).toHaveLength(1);
    expect(result.findingsPagination).toEqual({ hasNextPage: false, nextCursor: null });
    expect(result.canViewDetails).toBe(true);
    expect(result.canUseDiffing).toBe(false);
    expect(result.previewFinding).toBeNull();
    expect(result.healthScore).toEqual(HEALTH_SCORE);
    expect(result.findingSummary).toEqual(FINDING_SUMMARY);
    expect(result.appAttributionData).toEqual([]);
  });

  it("exposes scan.skippedCategories for the missing-scope banner (gc-1wf)", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      skippedCategories: ["GHOST_PAGE", "GHOST_REDIRECT"],
    });

    const result = (await loader(makeLoaderArgs("scan-1"))) as {
      scan: { skippedCategories: string[] };
    };

    expect(result.scan.skippedCategories).toEqual(["GHOST_PAGE", "GHOST_REDIRECT"]);
  });

  it("exposes scan.cappedCategories separately for the size-cap notice (gc-11f)", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      skippedCategories: ["GHOST_PAGE"],
      cappedCategories: ["DANGLING_REFERENCE"],
    });

    const result = (await loader(makeLoaderArgs("scan-1"))) as {
      scan: { skippedCategories: string[]; cappedCategories: string[] };
    };

    expect(result.scan.skippedCategories).toEqual(["GHOST_PAGE"]);
    expect(result.scan.cappedCategories).toEqual(["DANGLING_REFERENCE"]);
  });

  // gc-rzq: the in-progress "Found N so far…" line reads scan.findingCount on
  // each 3s poll, so the loader must surface the live partial count even while
  // the scan is still running (findingCount updates incrementally in the DB).
  it("surfaces scan.findingCount for an in-progress scan (live poll count)", async () => {
    mockGetScanById.mockResolvedValue({ ...SCAN, status: "IN_PROGRESS", findingCount: 12 });

    const result = (await loader(makeLoaderArgs("scan-1"))) as {
      scan: { status: string; findingCount: number };
    };

    expect(result.scan.status).toBe("IN_PROGRESS");
    expect(result.scan.findingCount).toBe(12);
  });

  it("always calls getScanById with includeFindings: false (findings loaded separately)", async () => {
    await loader(makeLoaderArgs("scan-1"));

    expect(mockGetScanById).toHaveBeenCalledWith("scan-1", { includeFindings: false });
  });

  it("does not return scanDiff — diffing is handled by the .diff resource route", async () => {
    mockCanUseScanDiffing.mockReturnValue(true);

    const result = (await loader(makeLoaderArgs("scan-1"))) as Record<string, unknown>;

    expect(result).not.toHaveProperty("scanDiff");
  });

  // -------------------------------------------------------------------------
  // Plan gating: paid vs. free
  // -------------------------------------------------------------------------

  describe("paid plan — paginated findings", () => {
    it("calls getFindingsPageForScan with PAGE_SIZE and no cursor for the first page", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith("scan-1", {
        limit: 50,
        cursor: undefined,
        severity: undefined,
        findingType: undefined,
        appName: undefined,
      });
    });

    it("passes cursor from URL search params to getFindingsPageForScan", async () => {
      await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?cursor=f-99"),
      );

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith("scan-1", {
        limit: 50,
        cursor: "f-99",
        severity: undefined,
        findingType: undefined,
        appName: undefined,
      });
    });

    it("returns findings enriched with isTracker flag", async () => {
      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findings: Array<{ id: string; isTracker: boolean }>;
      };

      expect(result.findings[0].id).toBe("f-1");
      expect(result.findings[0].isTracker).toBe(false);
    });

    it("calls getAppAttributionForScan to populate the app impact map data", async () => {
      mockGetAppAttributionForScan.mockResolvedValue([
        { appName: "SomeApp", filename: "layout/theme.liquid", findingType: "GHOST_SCRIPT" },
      ]);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        appAttributionData: Array<{ appName: string }>;
      };

      expect(mockGetAppAttributionForScan).toHaveBeenCalledWith("scan-1");
      expect(result.appAttributionData).toHaveLength(1);
      expect(result.appAttributionData[0].appName).toBe("SomeApp");
    });
  });

  describe("free plan — limited/preview finding", () => {
    beforeEach(() => {
      mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Free" });
      mockCanViewFindingDetails.mockReturnValue(false);
    });

    it("returns empty findings page and previewFinding for free plan", async () => {
      mockGetHighestSeverityFinding.mockResolvedValue(FINDING_ONE);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findings: unknown[];
        findingsPagination: { hasNextPage: boolean; nextCursor: string | null };
        previewFinding: { id: string; isTracker: boolean };
        canViewDetails: boolean;
      };

      expect(result.findings).toHaveLength(0);
      expect(result.findingsPagination).toEqual({ hasNextPage: false, nextCursor: null });
      expect(result.canViewDetails).toBe(false);
      expect(result.previewFinding).toMatchObject({ id: "f-1", isTracker: false });
    });

    it("does not call getFindingsPageForScan for free-plan shops", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetFindingsPageForScan).not.toHaveBeenCalled();
    });

    // FIX 3 (E2.2): the free-tier preview finding must respect suppressions. If
    // the highest-severity finding is itself ignored, surfacing it as "your top
    // issue" while the health score excludes it is dishonest.
    it("falls back to the highest NON-ignored finding when the top finding is ignored", async () => {
      // Top finding is attributed to an app the merchant has APP-ignored.
      const ignoredTop = { ...FINDING_ONE, id: "f-ignored", appName: "BadApp", severity: "HIGH" };
      const keptNext = {
        ...FINDING_ONE,
        id: "f-kept",
        appName: "GoodApp",
        severity: "MEDIUM",
      };
      mockGetHighestSeverityFinding.mockResolvedValue(ignoredTop);
      // getFindingsForScan returns HIGH→MEDIUM ordered; the ignored one is first.
      mockGetFindingsForScan.mockResolvedValue([ignoredTop, keptNext]);
      mockGetIgnoredFindings.mockResolvedValue({
        fingerprints: new Set<string>(),
        appNames: new Set(["BadApp"]),
      });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        previewFinding: { id: string } | null;
      };

      expect(mockGetFindingsForScan).toHaveBeenCalledWith("scan-1");
      expect(result.previewFinding?.id).toBe("f-kept");
    });

    it("returns previewFinding null when every finding is ignored", async () => {
      const ignoredTop = { ...FINDING_ONE, id: "f-ignored", appName: "BadApp", severity: "HIGH" };
      mockGetHighestSeverityFinding.mockResolvedValue(ignoredTop);
      mockGetFindingsForScan.mockResolvedValue([ignoredTop]);
      mockGetIgnoredFindings.mockResolvedValue({
        fingerprints: new Set<string>(),
        appNames: new Set(["BadApp"]),
      });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        previewFinding: { id: string } | null;
      };

      expect(result.previewFinding).toBeNull();
    });

    it("does not load full findings for the preview when the shop has no ignores", async () => {
      mockGetHighestSeverityFinding.mockResolvedValue(FINDING_ONE);
      // Default ignores are empty (set in beforeEach).

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        previewFinding: { id: string } | null;
      };

      // Only the always-on malicious-script query may run; no unfiltered load.
      expect(mockGetFindingsForScan).not.toHaveBeenCalledWith("scan-1");
      expect(result.previewFinding?.id).toBe("f-1");
    });

    // Known-malicious scripts are NEVER paywalled: a free merchant sees every one,
    // in full (file, line, snippet), for shopper safety and merchant trust.
    it("returns ALL malicious-script findings in full for free-plan shops", async () => {
      const MAL_1 = { ...FINDING_ONE, id: "mal-1", findingType: "MALICIOUS_SCRIPT", lineNumber: 6 };
      const MAL_2 = {
        ...FINDING_ONE,
        id: "mal-2",
        findingType: "MALICIOUS_SCRIPT",
        lineNumber: 365,
      };
      mockGetFindingsForScan.mockImplementation(
        async (_id: string, filters?: { findingType?: string }) =>
          filters?.findingType === "MALICIOUS_SCRIPT" ? [MAL_1, MAL_2] : [],
      );

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        maliciousFindings: Array<{
          id: string;
          filename: string;
          codeSnippet: string;
          lineNumber: number;
        }>;
      };

      expect(mockGetFindingsForScan).toHaveBeenCalledWith("scan-1", {
        findingType: "MALICIOUS_SCRIPT",
      });
      expect(result.maliciousFindings.map((f) => f.id)).toEqual(["mal-1", "mal-2"]);
      expect(result.maliciousFindings[1]).toMatchObject({
        filename: FINDING_ONE.filename,
        codeSnippet: FINDING_ONE.codeSnippet,
        lineNumber: 365,
      });
    });

    it("flags ignored malicious findings (still returned, shown regardless)", async () => {
      const mal = {
        ...FINDING_ONE,
        id: "mal-1",
        findingType: "MALICIOUS_SCRIPT",
        appName: "BadApp",
      };
      mockGetIgnoredFindings.mockResolvedValue({
        fingerprints: new Set<string>(),
        appNames: new Set(["BadApp"]),
      });
      mockGetFindingsForScan.mockImplementation(
        async (_id: string, filters?: { findingType?: string }) =>
          filters?.findingType === "MALICIOUS_SCRIPT" ? [mal] : [],
      );

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        maliciousFindings: Array<{ id: string; isIgnored: boolean }>;
      };

      expect(result.maliciousFindings).toEqual([
        expect.objectContaining({ id: "mal-1", isIgnored: true }),
      ]);
    });

    it("never uses a malicious finding as the ignore-fallback preview (it is shown in the alert)", async () => {
      const ignoredTop = { ...FINDING_ONE, id: "ignored-top", appName: "BadApp" };
      const mal = { ...FINDING_ONE, id: "mal-1", findingType: "MALICIOUS_SCRIPT", appName: null };
      const keptNext = { ...FINDING_ONE, id: "kept-next", appName: "GoodApp" };
      mockGetHighestSeverityFinding.mockResolvedValue(ignoredTop);
      mockGetIgnoredFindings.mockResolvedValue({
        fingerprints: new Set<string>(),
        appNames: new Set(["BadApp"]),
      });
      mockGetFindingsForScan.mockImplementation(
        async (_id: string, filters?: { findingType?: string }) =>
          filters?.findingType === "MALICIOUS_SCRIPT" ? [mal] : [ignoredTop, mal, keptNext],
      );

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        previewFinding: { id: string } | null;
      };

      expect(result.previewFinding?.id).toBe("kept-next");
    });

    it("does not query malicious findings for a non-successful (FAILED) scan", async () => {
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "FAILED" });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { maliciousFindings: unknown[] };

      expect(mockGetFindingsForScan).not.toHaveBeenCalledWith("scan-1", {
        findingType: "MALICIOUS_SCRIPT",
      });
      expect(result.maliciousFindings).toEqual([]);
    });

    it("does not call getAppAttributionForScan for free-plan shops", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetAppAttributionForScan).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Free-tier upgrade preview teaser + `shown` telemetry (gc-97k.4)
  // -------------------------------------------------------------------------

  describe("free-tier upgrade preview (gc-97k.4)", () => {
    type PreviewResult = {
      upgradePreview: { hiddenCount: number; groups: Array<{ label: string; count: number }> };
    };

    function freeShop(overrides: Record<string, unknown> = {}) {
      mockGetShopMetadata.mockResolvedValue({
        ...SHOP,
        plan: "free",
        upgradePreviewShownAt: null,
        ...overrides,
      });
      mockCanViewFindingDetails.mockReturnValue(false);
    }

    function summary(byType: Record<string, number>) {
      const total = Object.values(byType).reduce((a, b) => a + b, 0);
      mockGetFindingSummary.mockResolvedValue({
        total,
        bySeverity: { HIGH: total, MEDIUM: 0, LOW: 0 },
        byType,
      });
    }

    beforeEach(() => {
      freeShop();
      mockGetHighestSeverityFinding.mockResolvedValue(FINDING_ONE); // a GHOST_SCRIPT
      mockRecordUpgradePreviewStage.mockResolvedValue(true);
    });

    it("returns the per-lane breakdown of hidden findings (excluding the preview row)", async () => {
      summary({ GHOST_SCRIPT: 3, GHOST_STYLE: 2, GHOST_HREFLANG: 4, DUPLICATE_META: 1 });

      const result = (await loader(makeLoaderArgs("scan-1"))) as PreviewResult;

      expect(result.upgradePreview).toEqual({
        hiddenCount: 9,
        groups: [
          { label: "Found by Google & AI", count: 5 },
          { label: "Speed", count: 4 },
        ],
      });
    });

    it("excludes malicious findings from the hidden count and breakdown", async () => {
      summary({ MALICIOUS_SCRIPT: 4, GHOST_SCRIPT: 2, GHOST_PIXEL: 1 });
      const mal = { ...FINDING_ONE, id: "mal-1", findingType: "MALICIOUS_SCRIPT" };
      mockGetFindingsForScan.mockImplementation(
        async (_id: string, filters?: { findingType?: string }) =>
          filters?.findingType === "MALICIOUS_SCRIPT" ? [mal, mal, mal, mal] : [],
      );

      const result = (await loader(makeLoaderArgs("scan-1"))) as PreviewResult & {
        maliciousFindings: unknown[];
      };

      // Malicious are still returned in full for the security alert...
      expect(result.maliciousFindings).toHaveLength(4);
      // ...but never counted as paywalled.
      expect(result.upgradePreview).toEqual({
        hiddenCount: 2,
        groups: [
          { label: "Speed", count: 1 },
          { label: "Still tracking you", count: 1 },
        ],
      });
    });

    it("stamps and emits `shown` on the first render of the teaser", async () => {
      summary({ GHOST_SCRIPT: 3 });

      await loader(makeLoaderArgs("scan-1"));

      expect(mockRecordUpgradePreviewStage).toHaveBeenCalledTimes(1);
      expect(mockRecordUpgradePreviewStage).toHaveBeenCalledWith("shown", SHOP.domain);
    });

    it("returns the Managed Pricing plan URL for the session shop (teaser CTA target)", async () => {
      summary({ GHOST_SCRIPT: 3 });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { pricingPlansUrl: string };

      expect(result.pricingPlansUrl).toBe(
        "https://admin.shopify.com/store/test-shop/charges/ghost-code/pricing_plans",
      );
    });

    it("does not attempt `shown` again once the shop's stamp is set", async () => {
      summary({ GHOST_SCRIPT: 3 });
      freeShop({ upgradePreviewShownAt: new Date("2026-09-24T00:00:00Z") });

      const result = (await loader(makeLoaderArgs("scan-1"))) as PreviewResult;

      expect(result.upgradePreview.hiddenCount).toBe(2); // teaser still renders
      expect(mockRecordUpgradePreviewStage).not.toHaveBeenCalled();
    });

    it("still renders the teaser when a concurrent load already won the `shown` claim", async () => {
      summary({ GHOST_SCRIPT: 3 });
      mockRecordUpgradePreviewStage.mockResolvedValue(false); // claim count 0

      const result = (await loader(makeLoaderArgs("scan-1"))) as PreviewResult;

      expect(result.upgradePreview.hiddenCount).toBe(2);
    });

    it("returns no teaser and emits nothing when zero findings are hidden", async () => {
      summary({ GHOST_SCRIPT: 1, MALICIOUS_SCRIPT: 2 });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { upgradePreview: unknown };

      expect(result.upgradePreview).toBeNull();
      expect(mockRecordUpgradePreviewStage).not.toHaveBeenCalled();
    });

    it("returns no teaser and emits nothing when there is no preview finding", async () => {
      summary({ GHOST_SCRIPT: 3 });
      mockGetHighestSeverityFinding.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs("scan-1"))) as { upgradePreview: unknown };

      expect(result.upgradePreview).toBeNull();
      expect(mockRecordUpgradePreviewStage).not.toHaveBeenCalled();
    });

    it("returns no teaser and emits nothing for an unsuccessful (FAILED) scan", async () => {
      summary({ GHOST_SCRIPT: 3 });
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "FAILED" });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { upgradePreview: unknown };

      expect(result.upgradePreview).toBeNull();
      expect(mockRecordUpgradePreviewStage).not.toHaveBeenCalled();
    });

    it.each(["Standard", "Professional"])(
      "never returns a teaser or emits for a paid %s shop",
      async (plan) => {
        summary({ GHOST_SCRIPT: 5, GHOST_HREFLANG: 3 });
        mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan, upgradePreviewShownAt: null });
        mockCanViewFindingDetails.mockReturnValue(true);

        const result = (await loader(makeLoaderArgs("scan-1"))) as { upgradePreview: unknown };

        expect(result.upgradePreview).toBeNull();
        expect(mockRecordUpgradePreviewStage).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // canUseDiffing flag
  // -------------------------------------------------------------------------

  describe("canUseDiffing flag", () => {
    it("is true when scan is completed and plan supports diffing", async () => {
      mockCanUseScanDiffing.mockReturnValue(true);

      const result = (await loader(makeLoaderArgs("scan-1"))) as { canUseDiffing: boolean };

      expect(result.canUseDiffing).toBe(true);
    });

    it("is false when plan does not support diffing", async () => {
      mockCanUseScanDiffing.mockReturnValue(false);

      const result = (await loader(makeLoaderArgs("scan-1"))) as { canUseDiffing: boolean };

      expect(result.canUseDiffing).toBe(false);
    });

    it("is false when scan is not completed (IN_PROGRESS)", async () => {
      mockCanUseScanDiffing.mockReturnValue(true);
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "IN_PROGRESS" });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { canUseDiffing: boolean };

      expect(result.canUseDiffing).toBe(false);
    });

    it("is true for PARTIAL scans on eligible plans (PARTIAL is a successful scan)", async () => {
      mockCanUseScanDiffing.mockReturnValue(true);
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "PARTIAL" });

      const result = (await loader(makeLoaderArgs("scan-1"))) as { canUseDiffing: boolean };

      expect(result.canUseDiffing).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Findings pagination
  // -------------------------------------------------------------------------

  describe("findings pagination", () => {
    it("returns hasNextPage true and nextCursor when model signals more pages", async () => {
      mockGetFindingsPageForScan.mockResolvedValue({
        items: [FINDING_ONE],
        hasNextPage: true,
        nextCursor: "f-50",
      });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findings: unknown[];
        findingsPagination: { hasNextPage: boolean; nextCursor: string | null };
      };

      expect(result.findings).toHaveLength(1);
      expect(result.findingsPagination).toEqual({ hasNextPage: true, nextCursor: "f-50" });
    });

    it("returns hasNextPage false and null nextCursor on the last page", async () => {
      mockGetFindingsPageForScan.mockResolvedValue(SINGLE_FINDING_PAGE);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findingsPagination: { hasNextPage: boolean; nextCursor: string | null };
      };

      expect(result.findingsPagination).toEqual({ hasNextPage: false, nextCursor: null });
    });

    it("returns empty findings and no next cursor when the scan has no findings", async () => {
      mockGetFindingsPageForScan.mockResolvedValue(EMPTY_FINDINGS_PAGE);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findings: unknown[];
        findingsPagination: { hasNextPage: boolean; nextCursor: string | null };
      };

      expect(result.findings).toHaveLength(0);
      expect(result.findingsPagination).toEqual({ hasNextPage: false, nextCursor: null });
    });

    it("does not call getFindingsPageForScan for non-completed scans (IN_PROGRESS)", async () => {
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "IN_PROGRESS" });

      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetFindingsPageForScan).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Findings filters (server-side severity / type / app)
  // -------------------------------------------------------------------------

  describe("findings filters", () => {
    it("threads valid severity/type/app params into getFindingsPageForScan", async () => {
      await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?severity=HIGH&type=GHOST_SCRIPT&app=Klaviyo",
        ),
      );

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith("scan-1", {
        limit: 50,
        cursor: undefined,
        severity: "HIGH",
        findingType: "GHOST_SCRIPT",
        appName: "Klaviyo",
      });
    });

    it("returns the active filter values so the selects are controlled", async () => {
      const result = (await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?severity=MEDIUM&type=GHOST_STYLE&app=OldApp",
        ),
      )) as { filters: { severity: string; type: string; app: string; lane: string } };

      expect(result.filters).toEqual({
        severity: "MEDIUM",
        type: "GHOST_STYLE",
        app: "OldApp",
        lane: "",
      });
    });

    it("ignores an unknown severity param (treats it as no filter)", async () => {
      const result = (await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?severity=BOGUS"),
      )) as { filters: { severity: string } };

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({ severity: undefined }),
      );
      expect(result.filters.severity).toBe("");
    });

    it("ignores an unknown type param (treats it as no filter)", async () => {
      const result = (await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?type=NOT_A_REAL_TYPE",
        ),
      )) as { filters: { type: string } };

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({ findingType: undefined }),
      );
      expect(result.filters.type).toBe("");
    });

    it("returns the distinct filter options for the dropdowns", async () => {
      mockGetFindingFilterOptionsForScan.mockResolvedValue({
        types: ["GHOST_SCRIPT", "GHOST_STYLE"],
        apps: ["AppA", "AppB"],
      });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        filterOptions: { types: string[]; apps: string[] };
      };

      expect(mockGetFindingFilterOptionsForScan).toHaveBeenCalledWith("scan-1");
      expect(result.filterOptions).toEqual({
        types: ["GHOST_SCRIPT", "GHOST_STYLE"],
        apps: ["AppA", "AppB"],
      });
    });

    it("does not query filtered findings or options for a free-tier shop (even with filter params)", async () => {
      mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Free" });
      mockCanViewFindingDetails.mockReturnValue(false);

      const result = (await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?severity=HIGH&type=GHOST_SCRIPT&app=Klaviyo",
        ),
      )) as { findings: unknown[]; filterOptions: { types: string[]; apps: string[] } };

      expect(mockGetFindingsPageForScan).not.toHaveBeenCalled();
      expect(mockGetFindingFilterOptionsForScan).not.toHaveBeenCalled();
      expect(result.findings).toHaveLength(0);
      expect(result.filterOptions).toEqual({ types: [], apps: [] });
    });

    it("does not query filtered findings or options for a non-successful scan (FAILED) even with filter params", async () => {
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "FAILED" });

      const result = (await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?severity=HIGH"),
      )) as { filterOptions: { types: string[]; apps: string[] } };

      expect(mockGetFindingsPageForScan).not.toHaveBeenCalled();
      expect(mockGetFindingFilterOptionsForScan).not.toHaveBeenCalled();
      expect(result.filterOptions).toEqual({ types: [], apps: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Lane deep-link filter (`?lane=`) — Slice 3 consequence-axis reframe
  // -------------------------------------------------------------------------

  describe("lane deep-link filter", () => {
    it("resolves ?lane=speed to typesForLane('speed') and passes them as findingTypes", async () => {
      await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?lane=speed"),
      );

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({
          findingTypes: typesForLane("speed"),
          // No single-type filter came from the URL.
          findingType: undefined,
        }),
      );
    });

    it("populates filters.lane, laneLabel, and laneSoWhat for a valid lane", async () => {
      const result = (await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?lane=customers-see-it",
        ),
      )) as { filters: { lane: string }; laneLabel: string; laneSoWhat: string };

      expect(result.filters.lane).toBe("customers-see-it");
      expect(result.laneLabel).toBe(laneLabelForLane("customers-see-it"));
      expect(result.laneSoWhat).toBe(soWhatForLane("customers-see-it"));
    });

    it("ignores an invalid ?lane=bogus (no findingTypes, empty banner copy)", async () => {
      const result = (await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?lane=bogus"),
      )) as { filters: { lane: string }; laneLabel: string; laneSoWhat: string };

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({ findingTypes: undefined }),
      );
      expect(result.filters.lane).toBe("");
      expect(result.laneLabel).toBe("");
      expect(result.laneSoWhat).toBe("");
    });

    it("passes the single type AND the lane types when both ?type= and ?lane= are present (model applies precedence)", async () => {
      await loader(
        makeLoaderArgs(
          "scan-1",
          "https://test-shop.myshopify.com/app/scans/scan-1?type=GHOST_SCRIPT&lane=discoverability",
        ),
      );

      // The loader forwards both; type precedence is enforced in the model layer.
      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({
          findingType: "GHOST_SCRIPT",
          findingTypes: typesForLane("discoverability"),
        }),
      );
    });

    it("leaves lane fields empty when no ?lane= param is present", async () => {
      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        filters: { lane: string };
        laneLabel: string;
        laneSoWhat: string;
      };

      expect(result.filters.lane).toBe("");
      expect(result.laneLabel).toBe("");
      expect(result.laneSoWhat).toBe("");
      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith(
        "scan-1",
        expect.objectContaining({ findingTypes: undefined }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Health score
  // -------------------------------------------------------------------------

  describe("health score", () => {
    it("computes health score for completed scans", async () => {
      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        healthScore: typeof HEALTH_SCORE;
      };

      expect(result.healthScore).toEqual(HEALTH_SCORE);
      expect(mockComputeHealthScore).toHaveBeenCalledWith(FINDING_SUMMARY.bySeverity);
    });

    it("returns null healthScore for non-completed scans", async () => {
      mockGetScanById.mockResolvedValue({ ...SCAN, status: "IN_PROGRESS" });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        healthScore: null;
      };

      expect(result.healthScore).toBeNull();
      expect(mockComputeHealthScore).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws 404 when scan not found", async () => {
      mockGetScanById.mockResolvedValue(null);

      await expect(loader(makeLoaderArgs("nonexistent"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("nonexistent"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });

    it("throws 404 when scan belongs to different shop (ownership check)", async () => {
      mockGetScanById.mockResolvedValue({
        ...SCAN,
        shopId: "different-shop-id",
      });

      await expect(loader(makeLoaderArgs("scan-1"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("scan-1"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });

    it("throws 404 when shop not found", async () => {
      mockGetShopMetadata.mockResolvedValue(null);

      await expect(loader(makeLoaderArgs("scan-1"))).rejects.toThrow();
      try {
        await loader(makeLoaderArgs("scan-1"));
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(404);
      }
    });

    it("throws 400 when scanId param is missing", async () => {
      const args = makeLoaderArgs("", undefined, { params: {} });

      await expect(loader(args)).rejects.toThrow();
      try {
        await loader(args);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(400);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Action — merchant feedback on unknown scripts (untrusted input + tenant
// isolation). The action RETURNS validation errors as `{ error }` (HTTP 200)
// but THROWS a 404 Response when the shop cannot be resolved.
// ---------------------------------------------------------------------------

describe("app.scans.$scanId action", () => {
  const UNKNOWN_SCRIPT = {
    id: "us-1",
    scanId: "scan-1",
    url: "https://cdn.example.com/widget.js",
  };

  it("submits a valid suggestion with the trimmed name and returns success", async () => {
    mockFindUnknownScriptForShop.mockResolvedValue(UNKNOWN_SCRIPT);
    mockSubmitSignatureSuggestion.mockResolvedValue({ id: "sub-1" });

    const result = await action(
      makeActionArgs({
        unknownScriptId: "us-1",
        // Leading/trailing whitespace must be stripped before persisting.
        suggestedAppName: "  Klaviyo  ",
      }),
    );

    expect(mockFindUnknownScriptForShop).toHaveBeenCalledWith("us-1", SHOP.id);
    // The TRIMMED name is what gets persisted, scoped to the resolved shop id.
    expect(mockSubmitSignatureSuggestion).toHaveBeenCalledWith("us-1", SHOP.id, "Klaviyo");
    expect(result).toEqual({ success: true, unknownScriptId: "us-1" });
  });

  it("returns an error and does not write when unknownScriptId is missing", async () => {
    const result = await action(makeActionArgs({ suggestedAppName: "Klaviyo" }));

    expect(result).toEqual({ error: "App name is required" });
    expect(mockSubmitSignatureSuggestion).not.toHaveBeenCalled();
    expect(mockFindUnknownScriptForShop).not.toHaveBeenCalled();
  });

  it("returns an error and does not write when suggestedAppName is whitespace-only", async () => {
    const result = await action(
      makeActionArgs({ unknownScriptId: "us-1", suggestedAppName: "   " }),
    );

    expect(result).toEqual({ error: "App name is required" });
    expect(mockSubmitSignatureSuggestion).not.toHaveBeenCalled();
    expect(mockFindUnknownScriptForShop).not.toHaveBeenCalled();
  });

  it("returns an error and does not write when the name exceeds 200 chars", async () => {
    // Pad with whitespace to also prove the length check runs on the TRIMMED
    // value (201 non-space chars + surrounding spaces).
    const longName = "a".repeat(201);
    const result = await action(
      makeActionArgs({ unknownScriptId: "us-1", suggestedAppName: `  ${longName}  ` }),
    );

    expect(result).toEqual({ error: "App name is too long" });
    expect(mockSubmitSignatureSuggestion).not.toHaveBeenCalled();
    expect(mockFindUnknownScriptForShop).not.toHaveBeenCalled();
  });

  it("accepts a name that is exactly 200 chars after trimming", async () => {
    const exactName = "a".repeat(200);
    mockFindUnknownScriptForShop.mockResolvedValue(UNKNOWN_SCRIPT);
    mockSubmitSignatureSuggestion.mockResolvedValue({ id: "sub-1" });

    const result = await action(
      makeActionArgs({ unknownScriptId: "us-1", suggestedAppName: `  ${exactName}  ` }),
    );

    expect(mockSubmitSignatureSuggestion).toHaveBeenCalledWith("us-1", SHOP.id, exactName);
    expect(result).toEqual({ success: true, unknownScriptId: "us-1" });
  });

  it("does NOT write when the script belongs to another shop (tenant isolation)", async () => {
    // findUnknownScriptForShop enforces ownership via its scoped where clause;
    // a cross-shop script id resolves to null, so no submission may be written.
    mockFindUnknownScriptForShop.mockResolvedValue(null);

    const result = await action(
      makeActionArgs({ unknownScriptId: "other-shops-script", suggestedAppName: "Klaviyo" }),
    );

    expect(mockFindUnknownScriptForShop).toHaveBeenCalledWith("other-shops-script", SHOP.id);
    expect(result).toEqual({ error: "Unknown script not found" });
    expect(mockSubmitSignatureSuggestion).not.toHaveBeenCalled();
  });

  it("throws a 404 Response when the shop cannot be resolved", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(
      action(makeActionArgs({ unknownScriptId: "us-1", suggestedAppName: "Klaviyo" })),
    ).rejects.toBeInstanceOf(Response);

    try {
      await action(makeActionArgs({ unknownScriptId: "us-1", suggestedAppName: "Klaviyo" }));
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }

    expect(mockSubmitSignatureSuggestion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action — ignore/mark-intentional (E2.3). The fingerprint is computed
// SERVER-SIDE from the stored finding (looked up by id, scoped to the shop),
// so the client only sends a finding id — never a forgeable fingerprint.
// ---------------------------------------------------------------------------

describe("app.scans.$scanId action — ignore intents", () => {
  it("ignore-instance: computes the server-side fingerprint and suppresses with the reason", async () => {
    mockGetFindingByIdForShop.mockResolvedValue(FINDING_ONE);
    mockIgnoreFindingInstance.mockResolvedValue({ id: "ign-1" });

    const result = await action(
      makeActionArgs({
        intent: "ignore-instance",
        findingId: "f-1",
        reason: "  false positive  ",
      }),
    );

    // Ownership is enforced by the scoped lookup.
    expect(mockGetFindingByIdForShop).toHaveBeenCalledWith("f-1", SHOP.id);

    // The fingerprint must match E2.2's filter key exactly (same pure function).
    const expectedFingerprint = fingerprintFinding(
      FINDING_ONE.filename,
      FINDING_ONE.findingType,
      FINDING_ONE.codeSnippet,
      FINDING_ONE.lineNumber,
    );
    expect(mockIgnoreFindingInstance).toHaveBeenCalledWith({
      shopId: SHOP.id,
      fingerprint: expectedFingerprint,
      reason: "false positive",
    });
    expect(result).toEqual({ success: true, ignored: "instance" });
  });

  it("ignore-instance: omits reason (undefined) when blank", async () => {
    mockGetFindingByIdForShop.mockResolvedValue(FINDING_ONE);
    mockIgnoreFindingInstance.mockResolvedValue({ id: "ign-1" });

    await action(makeActionArgs({ intent: "ignore-instance", findingId: "f-1", reason: "   " }));

    expect(mockIgnoreFindingInstance.mock.calls[0][0].reason).toBeUndefined();
  });

  it("ignore-instance: returns an error and does not suppress when the finding is not the shop's", async () => {
    mockGetFindingByIdForShop.mockResolvedValue(null);

    const result = await action(
      makeActionArgs({ intent: "ignore-instance", findingId: "f-other" }),
    );

    expect(result).toEqual({ error: "Finding not found" });
    expect(mockIgnoreFindingInstance).not.toHaveBeenCalled();
  });

  it("ignore-instance: returns an error when findingId is missing (no lookup, no write)", async () => {
    const result = await action(makeActionArgs({ intent: "ignore-instance" }));

    expect(result).toEqual({ error: "Finding is required" });
    expect(mockGetFindingByIdForShop).not.toHaveBeenCalled();
    expect(mockIgnoreFindingInstance).not.toHaveBeenCalled();
  });

  it("ignore-app: suppresses every finding for the app with the trimmed reason", async () => {
    mockIgnoreFindingApp.mockResolvedValue({ id: "ign-2" });

    const result = await action(
      makeActionArgs({ intent: "ignore-app", appName: "  Judge.me  ", reason: "known good" }),
    );

    expect(mockIgnoreFindingApp).toHaveBeenCalledWith({
      shopId: SHOP.id,
      appName: "Judge.me",
      reason: "known good",
    });
    expect(result).toEqual({ success: true, ignored: "app" });
  });

  it("ignore-app: returns an error when appName is missing (no write)", async () => {
    const result = await action(makeActionArgs({ intent: "ignore-app", appName: "   " }));

    expect(result).toEqual({ error: "App is required" });
    expect(mockIgnoreFindingApp).not.toHaveBeenCalled();
  });

  it("throws a 404 Response when the shop cannot be resolved (ignore-instance)", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(
      action(makeActionArgs({ intent: "ignore-instance", findingId: "f-1" })),
    ).rejects.toBeInstanceOf(Response);
    expect(mockIgnoreFindingInstance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// nextFindingsFilterParams — lane/type mutual exclusion + cursor reset
// ---------------------------------------------------------------------------

describe("nextFindingsFilterParams", () => {
  it("selecting a type clears an active lane (they are the same query dimension)", () => {
    const prev = new URLSearchParams("lane=privacy&severity=HIGH&cursor=abc");
    const next = nextFindingsFilterParams(prev, "type", "GHOST_SCRIPT");
    expect(next.get("type")).toBe("GHOST_SCRIPT");
    expect(next.has("lane")).toBe(false); // lane dropped
    expect(next.get("severity")).toBe("HIGH"); // orthogonal filter preserved
    expect(next.has("cursor")).toBe(false); // pagination reset
  });

  it("selecting a lane clears an active type", () => {
    const prev = new URLSearchParams("type=GHOST_SCRIPT&cursor=abc");
    const next = nextFindingsFilterParams(prev, "lane", "speed");
    expect(next.get("lane")).toBe("speed");
    expect(next.has("type")).toBe(false);
    expect(next.has("cursor")).toBe(false);
  });

  it("selecting severity or app leaves lane intact (orthogonal to the type axis)", () => {
    const prev = new URLSearchParams("lane=speed");
    expect(nextFindingsFilterParams(prev, "severity", "HIGH").get("lane")).toBe("speed");
    expect(nextFindingsFilterParams(prev, "app", "OldApp").get("lane")).toBe("speed");
  });

  it("clearing a filter (empty value) deletes the key and does not trigger lane/type coupling", () => {
    const prev = new URLSearchParams("lane=privacy&type=GHOST_SCRIPT&cursor=abc");
    // Clearing severity must not delete lane or type via the coupling guards.
    const next = nextFindingsFilterParams(prev, "type", "");
    expect(next.has("type")).toBe(false);
    expect(next.get("lane")).toBe("privacy"); // coupling only fires when a value is set
    expect(next.has("cursor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FindingRow rendering — removal guidance + copy-to-clipboard (gc-06e.11)
//
// Rendered to static markup so we can assert the remediation blurb and the
// copy control both appear. The row is wrapped in a table to keep the markup
// valid (a bare <tr> would warn about DOM nesting).
// ---------------------------------------------------------------------------

describe("FindingRow — removal guidance + copy button", () => {
  function renderRow(finding: Record<string, unknown>) {
    return renderToStaticMarkup(
      createElement(
        "table",
        null,
        createElement("tbody", null, createElement(FindingRow, { finding } as never)),
      ),
    );
  }

  it("renders the per-type remediation guidance for the finding", () => {
    const html = renderRow(FINDING_ONE);
    // GHOST_SCRIPT guidance mentions removing the script tag from the theme.
    expect(html).toContain("How to remove:");
    expect(html.toLowerCase()).toContain("script tag");
    expect(html.toLowerCase()).toContain("theme");
  });

  it("renders a Copy button labelled for accessibility", () => {
    const html = renderRow(FINDING_ONE);
    expect(html).toContain('aria-label="Copy code snippet"');
    expect(html).toContain(">Copy<");
  });

  it("shows guidance appropriate to the finding type (SETTINGS_DRIFT is not a script tag)", () => {
    const html = renderRow({ ...FINDING_ONE, findingType: "SETTINGS_DRIFT" });
    expect(html).toContain("settings_data.json");
    expect(html.toLowerCase()).not.toContain("script tag");
  });

  it("still renders the truncated snippet alongside the guidance", () => {
    const html = renderRow(FINDING_ONE);
    // The snippet is present (first chunk of the code snippet appears).
    expect(html).toContain("&lt;script");
  });

  it('renders a "High confidence" badge for a signature-matched finding (GHOST_SCRIPT)', () => {
    const html = renderRow(FINDING_ONE);
    expect(html).toContain("High confidence");
    expect(html).not.toContain(">Heuristic<");
  });

  it('renders a "Heuristic" badge for a structurally-inferred finding (SETTINGS_DRIFT)', () => {
    const html = renderRow({ ...FINDING_ONE, findingType: "SETTINGS_DRIFT" });
    expect(html).toContain(">Heuristic<");
    expect(html).not.toContain("High confidence");
  });
});

// ---------------------------------------------------------------------------
// CopyButton — initial render state
// ---------------------------------------------------------------------------

describe("CopyButton", () => {
  it("renders with the idle 'Copy' label and an accessible name", () => {
    const html = renderToStaticMarkup(createElement(CopyButton, { text: "some code" }));
    expect(html).toContain('aria-label="Copy code snippet"');
    expect(html).toContain(">Copy<");
    // Not yet copied — the confirmation label must not be present initially.
    expect(html).not.toContain(">Copied<");
  });
});

// ---------------------------------------------------------------------------
// scanProgressLabel — live "Scan In Progress" count copy (gc-rzq)
//
// Rules the wording must honor:
//   - N=0: never "Found 0" (reads like a completed empty scan) — reassure instead.
//   - N=1 vs N>1: singular "finding" vs plural "findings".
//   - Always in-progress: "so far…", never a final-sounding count.
// ---------------------------------------------------------------------------

describe("scanProgressLabel", () => {
  it("does not say 'Found 0' when no findings yet (N=0)", () => {
    const label = scanProgressLabel(0);
    expect(label).toBe("Scanning… no findings yet.");
    expect(label).not.toContain("Found 0");
  });

  it("treats a negative/absent count as the no-findings-yet state", () => {
    // Defensive: findingCount should never be negative, but the copy must not
    // regress to "Found -1 so far…" if it ever is.
    expect(scanProgressLabel(-1)).toBe("Scanning… no findings yet.");
  });

  it("uses the singular 'finding' for exactly one (N=1)", () => {
    const label = scanProgressLabel(1);
    expect(label).toBe("Found 1 finding so far…");
    expect(label).not.toContain("findings");
  });

  it("uses the plural 'findings' for more than one (N>1)", () => {
    expect(scanProgressLabel(2)).toBe("Found 2 findings so far…");
    expect(scanProgressLabel(45)).toBe("Found 45 findings so far…");
  });

  it("always reads as in-progress, never final (ends with 'so far…')", () => {
    for (const n of [1, 2, 45, 200]) {
      expect(scanProgressLabel(n)).toMatch(/so far…$/);
    }
  });
});

// ---------------------------------------------------------------------------
// UpgradePreviewBanner (gc-97k.4): the free-tier teaser's copy + CTA
// ---------------------------------------------------------------------------

describe("UpgradePreviewBanner", () => {
  const PRICING_URL = "https://admin.shopify.com/store/test-shop/charges/ghost-code/pricing_plans";

  function render(preview: {
    hiddenCount: number;
    groups: Array<{ label: string; count: number }>;
  }) {
    return renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(UpgradePreviewBanner, { preview, pricingPlansUrl: PRICING_URL }),
      ),
    );
  }

  it("shows the breakdown headline and the upgrade copy", () => {
    const html = render({
      hiddenCount: 12,
      groups: [
        { label: "Found by Google & AI", count: 5 },
        { label: "Speed", count: 4 },
        { label: "Housekeeping", count: 3 },
      ],
    });

    expect(html).toContain(
      "12 more findings on Standard: Found by Google &amp; AI (5), Speed (4), Housekeeping (3).",
    );
    expect(html).toContain("Upgrade to see full details");
  });

  it("CTA is a plain top-level link to the Managed Pricing plan page (proven Settings pattern)", () => {
    const html = render({ hiddenCount: 1, groups: [{ label: "Speed", count: 1 }] });

    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain(`href="${PRICING_URL}"`);
    expect(anchors[0]).toContain('target="_top"');
    expect(html).not.toContain("/app/upgrade");
    expect(html).not.toContain('href="/app/settings"');
    expect(html).toContain("1 more finding on Standard: Speed (1).");
  });

  it("wires the anchor's onClick to the best-effort click ping (no preventDefault)", () => {
    const tree = UpgradePreviewBanner({
      preview: { hiddenCount: 1, groups: [{ label: "Speed", count: 1 }] },
      pricingPlansUrl: PRICING_URL,
    });
    type El = { type: unknown; props: { children?: unknown; [k: string]: unknown } };
    function findAnchor(node: unknown): El | null {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = findAnchor(child);
          if (hit) return hit;
        }
        return null;
      }
      const el = node as El;
      if (el.type === "a") return el;
      return findAnchor(el.props?.children);
    }

    const anchor = findAnchor(tree);
    expect(anchor?.props.href).toBe(PRICING_URL);
    expect(anchor?.props.target).toBe("_top");
    expect(anchor?.props.onClick).toBe(recordUpgradeClick);
  });

  it("never implies security or malicious alerts need an upgrade, and has no em dash", () => {
    const html = render({
      hiddenCount: 5,
      groups: [
        { label: "Still tracking you", count: 3 },
        { label: "Speed", count: 2 },
      ],
    });

    expect(html).not.toMatch(/malicious|security|attack|threat/i);
    expect(html).not.toContain("\u2014");
  });
});

// ---------------------------------------------------------------------------
// Oversized-file skip banner copy
// ---------------------------------------------------------------------------

describe("skippedFilesNotice", () => {
  it("lists the files and says most checks were skipped (accurate for old and new scans)", () => {
    const text = skippedFilesNotice(["sections/a.liquid", "layout/theme.liquid"]);
    expect(text).toContain("2 files skipped (over 1 MB): sections/a.liquid, layout/theme.liquid.");
    expect(text).toContain("too large for the full scan");
    expect(text).toContain("most checks were skipped");
  });

  it("uses singular wording for one file", () => {
    const text = skippedFilesNotice(["sections/a.liquid"]);
    expect(text).toMatch(/^1 file skipped \(over 1 MB\): sections\/a\.liquid\. It was/);
    expect(text).not.toMatch(/\bfiles\b|\bthese\b|\bthem\b/);
  });

  it("does not claim the malicious-domain check ran (false for pre-gc-qqt scans)", () => {
    const text = skippedFilesNotice(["sections/a.liquid"]).toLowerCase();
    expect(text).not.toContain("malicious");
    expect(text).not.toContain("still runs");
    expect(text).not.toContain("not scanned");
    expect(text).not.toMatch(/[\u2014\u2013]/);
  });
});

// ---------------------------------------------------------------------------
// Scan-coverage notices: missing-scope warning vs size-cap info (gc-11f)
//
// A size cap is NOT a permissions problem: the merchant already granted access.
// Capped categories get their own info notice with no CTA; only scope-skipped
// categories get the warning that links to Settings.
// ---------------------------------------------------------------------------

describe("ScanCoverageNotices", () => {
  const PERMISSIONS_TEXT = "required permissions";
  const CAP_TEXT = "limited this scan";

  function renderNotices(overrides: Partial<Parameters<typeof ScanCoverageNotices>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ScanCoverageNotices, {
          isCompleted: true,
          canViewDetails: true,
          status: "COMPLETED",
          skippedCategories: [],
          cappedCategories: [],
          ...overrides,
        }),
      ),
    );
  }

  it("scope-only: renders the permissions warning with a Settings link, and no cap notice", () => {
    const html = renderNotices({ skippedCategories: ["GHOST_PAGE"] });
    expect(html).toContain('tone="warning"');
    expect(html).toContain(PERMISSIONS_TEXT);
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain("Content pages");
    expect(html).not.toContain('tone="info"');
    expect(html).not.toContain(CAP_TEXT);
  });

  it("capped-only: renders the info notice with no Settings link and no permissions wording", () => {
    const html = renderNotices({ cappedCategories: ["DANGLING_REFERENCE"] });
    expect(html).toContain('tone="info"');
    expect(html).toContain(CAP_TEXT);
    expect(html).toContain("Broken links");
    expect(html).not.toContain('tone="warning"');
    expect(html).not.toContain(PERMISSIONS_TEXT);
    expect(html.toLowerCase()).not.toContain("permission");
    expect(html).not.toContain("/app/settings");
    expect(html).not.toContain("Settings");
  });

  it("both: renders the warning (scope categories only) AND the info notice (capped only)", () => {
    const html = renderNotices({
      skippedCategories: ["GHOST_PAGE"],
      cappedCategories: ["JSON_LD_PRICE_CONFLICT"],
    });
    expect(html).toContain('tone="warning"');
    expect(html).toContain('tone="info"');
    // Warning comes first, the cap notice right below it.
    expect(html.indexOf('tone="warning"')).toBeLessThan(html.indexOf('tone="info"'));
    const [warning, info] = html.split('tone="info"');
    expect(warning).toContain("This scan skipped 1 check because");
    expect(warning).toContain("Content pages");
    expect(warning).not.toContain("Structured-data prices");
    expect(info).toContain("Structured-data prices");
    expect(info).not.toContain("Content pages");
  });

  it("neither: renders nothing", () => {
    expect(renderNotices()).toBe("");
  });

  it("Free plan (!canViewDetails): renders nothing even when both lists are non-empty", () => {
    const html = renderNotices({
      canViewDetails: false,
      skippedCategories: ["GHOST_PAGE"],
      cappedCategories: ["DANGLING_REFERENCE"],
    });
    expect(html).toBe("");
  });

  it("renders nothing for a scan that is not completed", () => {
    const html = renderNotices({
      isCompleted: false,
      skippedCategories: ["GHOST_PAGE"],
      cappedCategories: ["DANGLING_REFERENCE"],
    });
    expect(html).toBe("");
  });

  it("still renders the permissions warning for a legacy PARTIAL scan with no categories", () => {
    const html = renderNotices({ status: "PARTIAL" });
    expect(html).toContain(PERMISSIONS_TEXT);
    expect(html).not.toContain(CAP_TEXT);
  });
});

describe("cappedCategoriesNotice", () => {
  it("uses plural wording and lists every label for several capped checks", () => {
    const text = cappedCategoriesNotice(["JSON_LD_PRICE_CONFLICT", "DANGLING_REFERENCE"]);
    expect(text).toBe(
      "Some checks were limited this scan: Structured-data prices, Broken links. Your theme has more references than Ghost Code checks in a single scan, so these results cover the ones we checked. Anything we didn't check keeps its status from your previous scan.",
    );
  });

  it("uses singular wording for one capped check", () => {
    const text = cappedCategoriesNotice(["DANGLING_REFERENCE"]);
    expect(text).toMatch(/^One check was limited this scan: Broken links\. /);
    expect(text).not.toMatch(/^Some checks/);
  });

  it("dedupes repeated categories before choosing singular/plural", () => {
    const text = cappedCategoriesNotice(["DANGLING_REFERENCE", "DANGLING_REFERENCE"]);
    expect(text).toMatch(/^One check was limited this scan: Broken links\. /);
  });

  it("has no em/en dashes, no permissions wording, and no call to action", () => {
    const text = cappedCategoriesNotice(["DANGLING_REFERENCE", "JSON_LD_PRICE_CONFLICT"]);
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text.toLowerCase()).not.toContain("permission");
    expect(text.toLowerCase()).not.toContain("grant");
    expect(text).not.toContain("Settings");
  });
});

// ---------------------------------------------------------------------------
// recordUpgradeClick (gc-97k review): best-effort keepalive click ping
// ---------------------------------------------------------------------------

describe("recordUpgradeClick", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs src=upgrade_preview to /app/upgrade with keepalive", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    recordUpgradeClick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/app/upgrade");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(String(init.body)).toBe("src=upgrade_preview");
  });

  it("swallows a rejected fetch (no unhandled rejection, no throw)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      expect(() => recordUpgradeClick()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("swallows a synchronous fetch throw", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("boom");
      }),
    );

    expect(() => recordUpgradeClick()).not.toThrow();
  });
});
