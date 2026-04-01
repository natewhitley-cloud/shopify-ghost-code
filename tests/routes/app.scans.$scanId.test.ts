/**
 * Tests for app/routes/app.scans.$scanId.tsx (scan detail)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock scan/finding models, plan-gating, health-score, and scan-differ.
 *   - Verify loader returns correct data for paid vs free plans, ownership
 *     checks, 404s, and scan diffing.
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getPreviousScanForTheme: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingSummary: vi.fn(),
  getHighestSeverityFinding: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canViewFindingDetails: vi.fn(),
  canUseScanDiffing: vi.fn(),
}));

vi.mock("../../app/lib/health-score", () => ({
  computeHealthScore: vi.fn(),
}));

vi.mock("../../app/services/scan-differ.server", () => ({
  diffScans: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  getUnknownScriptsForScan: vi.fn(),
  submitSignatureSuggestion: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
  statusTone: vi.fn().mockReturnValue("info"),
  statusLabel: vi.fn().mockReturnValue("Completed"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { computeHealthScore } from "../../app/lib/health-score";
import { canViewFindingDetails, canUseScanDiffing } from "../../app/lib/plan-gating.server";
import { getFindingSummary, getHighestSeverityFinding } from "../../app/models/finding.server";
import { getScanById, getPreviousScanForTheme } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { getUnknownScriptsForScan } from "../../app/models/unknown-script.server";
import { loader } from "../../app/routes/app.scans.$scanId";
import { diffScans } from "../../app/services/scan-differ.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScanById = getScanById as ReturnType<typeof vi.fn>;
const mockGetPreviousScanForTheme = getPreviousScanForTheme as ReturnType<typeof vi.fn>;
const mockGetFindingSummary = getFindingSummary as ReturnType<typeof vi.fn>;
const mockGetHighestSeverityFinding = getHighestSeverityFinding as ReturnType<typeof vi.fn>;
const mockCanViewFindingDetails = canViewFindingDetails as ReturnType<typeof vi.fn>;
const mockCanUseScanDiffing = canUseScanDiffing as ReturnType<typeof vi.fn>;
const mockComputeHealthScore = computeHealthScore as ReturnType<typeof vi.fn>;
const mockDiffScans = diffScans as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Standard",
};

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
  findings: [
    {
      id: "f-1",
      severity: "HIGH",
      findingType: "GHOST_SCRIPT",
      filename: "layout/theme.liquid",
      lineNumber: 42,
      appName: "SomeApp",
      codeSnippet: '<script src="https://cdn.someapp.com/tracker.js"></script>',
      description: "Orphaned script tag",
    },
  ],
};

const FINDING_SUMMARY = {
  total: 5,
  bySeverity: { HIGH: 2, MEDIUM: 2, LOW: 1 },
  byType: { GHOST_SCRIPT: 3, GHOST_STYLE: 2 },
};

const HEALTH_SCORE = {
  score: 69,
  label: "Fair",
  tone: "warning" as const,
};

function makeLoaderArgs(
  scanId: string,
  overrides?: Partial<LoaderFunctionArgs>,
): LoaderFunctionArgs {
  return {
    request: new Request(`https://test-shop.myshopify.com/app/scans/${scanId}`),
    params: { scanId },
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
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
  mockCanViewFindingDetails.mockReturnValue(true);
  mockCanUseScanDiffing.mockReturnValue(false);
  mockComputeHealthScore.mockReturnValue(HEALTH_SCORE);
  mockGetHighestSeverityFinding.mockResolvedValue(null);
  mockGetPreviousScanForTheme.mockResolvedValue(null);
  (getUnknownScriptsForScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.scans.$scanId loader", () => {
  describe("paid plan — full findings", () => {
    it("returns full findings for paid plan", async () => {
      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        scan: { id: string };
        findings: unknown[];
        canViewDetails: boolean;
        previewFinding: null;
        healthScore: typeof HEALTH_SCORE;
        findingSummary: typeof FINDING_SUMMARY;
      };

      expect(result.scan.id).toBe("scan-1");
      expect(result.findings).toHaveLength(1);
      expect(result.canViewDetails).toBe(true);
      expect(result.previewFinding).toBeNull();
      expect(result.healthScore).toEqual(HEALTH_SCORE);
      expect(result.findingSummary).toEqual(FINDING_SUMMARY);
    });

    it("calls getScanById with includeFindings: true for paid plans", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetScanById).toHaveBeenCalledWith("scan-1", { includeFindings: true });
    });
  });

  describe("free plan — limited/preview finding", () => {
    beforeEach(() => {
      mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan: "Free" });
      mockCanViewFindingDetails.mockReturnValue(false);
      // When includeFindings is false, scan.findings is not present
      mockGetScanById.mockResolvedValue({
        ...SCAN,
        findings: undefined,
      });
    });

    it("returns empty findings array and previewFinding for free plan", async () => {
      const previewFinding = {
        id: "f-1",
        severity: "HIGH",
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 42,
        appName: "SomeApp",
        codeSnippet: '<script src="https://cdn.someapp.com/tracker.js"></script>',
      };
      mockGetHighestSeverityFinding.mockResolvedValue(previewFinding);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        findings: unknown[];
        previewFinding: typeof previewFinding;
        canViewDetails: boolean;
      };

      expect(result.findings).toHaveLength(0);
      expect(result.canViewDetails).toBe(false);
      expect(result.previewFinding).toEqual({ ...previewFinding, isTracker: false });
    });

    it("calls getScanById with includeFindings: false for free plans", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetScanById).toHaveBeenCalledWith("scan-1", {
        includeFindings: false,
      });
    });
  });

  describe("health score", () => {
    it("computes health score for completed scans", async () => {
      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        healthScore: typeof HEALTH_SCORE;
      };

      expect(result.healthScore).toEqual(HEALTH_SCORE);
      expect(mockComputeHealthScore).toHaveBeenCalledWith(FINDING_SUMMARY.bySeverity);
    });

    it("returns null healthScore for non-completed scans", async () => {
      mockGetScanById.mockResolvedValue({
        ...SCAN,
        status: "IN_PROGRESS",
        findings: undefined,
      });

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        healthScore: null;
      };

      expect(result.healthScore).toBeNull();
      expect(mockComputeHealthScore).not.toHaveBeenCalled();
    });
  });

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
      const args = makeLoaderArgs("", { params: {} });

      await expect(loader(args)).rejects.toThrow();
      try {
        await loader(args);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(400);
      }
    });
  });

  describe("scan diffing", () => {
    it("computes diff for eligible plans with a previous scan", async () => {
      mockCanUseScanDiffing.mockReturnValue(true);
      const previousScan = {
        ...SCAN,
        id: "scan-0",
        findings: [
          {
            id: "f-old",
            severity: "MEDIUM",
            findingType: "GHOST_STYLE",
            filename: "assets/old.css",
            lineNumber: 10,
            appName: "OldApp",
            codeSnippet: ".old-class {}",
          },
        ],
      };
      mockGetPreviousScanForTheme.mockResolvedValue(previousScan);

      const scanDiffResult = {
        newFindings: [SCAN.findings[0]],
        resolvedFindings: [previousScan.findings[0]],
        unchangedCount: 0,
      };
      mockDiffScans.mockReturnValue(scanDiffResult);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await loader(makeLoaderArgs("scan-1"))) as any;

      expect(result.scanDiff).toEqual(scanDiffResult);
      expect(mockDiffScans).toHaveBeenCalled();
    });

    it("returns null scanDiff when plan does not support diffing", async () => {
      mockCanUseScanDiffing.mockReturnValue(false);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        scanDiff: null;
      };

      expect(result.scanDiff).toBeNull();
      expect(mockGetPreviousScanForTheme).not.toHaveBeenCalled();
    });

    it("returns null scanDiff when no previous scan exists", async () => {
      mockCanUseScanDiffing.mockReturnValue(true);
      mockGetPreviousScanForTheme.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs("scan-1"))) as {
        scanDiff: null;
      };

      expect(result.scanDiff).toBeNull();
      expect(mockDiffScans).not.toHaveBeenCalled();
    });
  });
});
