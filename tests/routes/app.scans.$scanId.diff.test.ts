/**
 * Tests for app/routes/app.scans.$scanId.diff.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin(), getShopMetadata, getScanById,
 *     getPreviousScanForTheme, getFindingsForScan, canUseScanDiffing,
 *     diffScans, and the sort helpers.
 *   - Verify the loader computes and returns a diff for eligible plans,
 *     short-circuits correctly for ineligible plans / non-completed scans /
 *     missing previous scan, and respects scan ownership.
 *
 * This covers the diff logic that was extracted from the main scan-detail
 * loader as part of PRF-2 (GC-6vv) to avoid loading full previous-scan
 * findings on every page view.
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
  getFindingsForScan: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canUseScanDiffing: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  isSuccessfulScan: (status: string) => status === "COMPLETED" || status === "PARTIAL",
}));

vi.mock("../../app/services/scan-differ.server", () => ({
  diffScans: vi.fn(),
}));

vi.mock("../../app/lib/finding-sort", () => ({
  sortDiffFindingsBySeverity: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { canUseScanDiffing } from "../../app/lib/plan-gating.server";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getScanById, getPreviousScanForTheme } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans.$scanId.diff";
import { diffScans } from "../../app/services/scan-differ.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScanById = getScanById as ReturnType<typeof vi.fn>;
const mockGetPreviousScanForTheme = getPreviousScanForTheme as ReturnType<typeof vi.fn>;
const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockCanUseScanDiffing = canUseScanDiffing as ReturnType<typeof vi.fn>;
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
  findingCount: 2,
  startedAt: new Date("2026-03-20T10:00:00Z"),
  completedAt: new Date("2026-03-20T10:05:00Z"),
  createdAt: new Date("2026-03-20T10:00:00Z"),
  skippedCategories: [] as string[],
  skippedFiles: [] as string[],
};

const CURRENT_FINDING = {
  id: "f-cur-1",
  severity: "HIGH",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 42,
  appName: "SomeApp",
  codeSnippet: '<script src="https://cdn.someapp.com/tracker.js"></script>',
  description: "Orphaned script tag",
};

const PREV_FINDING = {
  id: "f-prev-1",
  severity: "MEDIUM",
  findingType: "GHOST_STYLE",
  filename: "assets/old.css",
  lineNumber: 10,
  appName: "OldApp",
  codeSnippet: ".old-class {}",
  description: "Ghost style from OldApp",
};

const PREVIOUS_SCAN = {
  ...SCAN,
  id: "scan-0",
  createdAt: new Date("2026-03-10T10:00:00Z"),
  findings: [PREV_FINDING],
};

const DIFF_RESULT = {
  newFindings: [
    {
      filename: CURRENT_FINDING.filename,
      findingType: CURRENT_FINDING.findingType,
      severity: CURRENT_FINDING.severity,
      appName: CURRENT_FINDING.appName,
      description: CURRENT_FINDING.description,
    },
  ],
  resolvedFindings: [
    {
      filename: PREV_FINDING.filename,
      findingType: PREV_FINDING.findingType,
      severity: PREV_FINDING.severity,
      appName: PREV_FINDING.appName,
      description: PREV_FINDING.description,
    },
  ],
  unchangedCount: 0,
};

function makeLoaderArgs(scanId: string): LoaderFunctionArgs {
  return {
    request: new Request(`https://test-shop.myshopify.com/app/scans/${scanId}/diff`),
    params: { scanId },
    context: {},
  } as unknown as LoaderFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: SHOP.domain } });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockGetScanById.mockResolvedValue(SCAN);
  mockGetPreviousScanForTheme.mockResolvedValue(PREVIOUS_SCAN);
  mockGetFindingsForScan.mockResolvedValue([CURRENT_FINDING]);
  mockCanUseScanDiffing.mockReturnValue(true);
  mockDiffScans.mockReturnValue(DIFF_RESULT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.scans.$scanId.diff loader", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns the computed diff for an eligible plan with a previous scan", async () => {
    const result = (await loader(makeLoaderArgs("scan-1"))) as {
      scanDiff: typeof DIFF_RESULT;
    };

    expect(result.scanDiff).toEqual(DIFF_RESULT);
    expect(mockDiffScans).toHaveBeenCalledWith([CURRENT_FINDING], PREVIOUS_SCAN.findings, {
      skippedCategories: [],
      skippedFiles: [],
    });
  });

  it("calls getFindingsForScan to load all current findings for diffing", async () => {
    await loader(makeLoaderArgs("scan-1"));

    expect(mockGetFindingsForScan).toHaveBeenCalledWith("scan-1");
  });

  it("calls getScanById with includeFindings: false (findings loaded separately)", async () => {
    await loader(makeLoaderArgs("scan-1"));

    expect(mockGetScanById).toHaveBeenCalledWith("scan-1", { includeFindings: false });
  });

  it("passes skippedCategories to diffScans so un-audited categories are not false-resolved (LOG-4)", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      status: "PARTIAL",
      skippedCategories: ["GHOST_TAG"],
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), {
      skippedCategories: ["GHOST_TAG"],
      skippedFiles: [],
    });
  });

  // -------------------------------------------------------------------------
  // Short-circuits (scanDiff: null)
  // -------------------------------------------------------------------------

  it("returns { scanDiff: null } when plan does not support diffing", async () => {
    mockCanUseScanDiffing.mockReturnValue(false);

    const result = (await loader(makeLoaderArgs("scan-1"))) as { scanDiff: null };

    expect(result.scanDiff).toBeNull();
    expect(mockDiffScans).not.toHaveBeenCalled();
    expect(mockGetPreviousScanForTheme).not.toHaveBeenCalled();
  });

  it("returns { scanDiff: null } when no previous scan exists", async () => {
    mockGetPreviousScanForTheme.mockResolvedValue(null);

    const result = (await loader(makeLoaderArgs("scan-1"))) as { scanDiff: null };

    expect(result.scanDiff).toBeNull();
    expect(mockDiffScans).not.toHaveBeenCalled();
  });

  it("returns { scanDiff: null } for a non-completed scan (IN_PROGRESS)", async () => {
    mockGetScanById.mockResolvedValue({ ...SCAN, status: "IN_PROGRESS" });

    const result = (await loader(makeLoaderArgs("scan-1"))) as { scanDiff: null };

    expect(result.scanDiff).toBeNull();
    expect(mockDiffScans).not.toHaveBeenCalled();
    expect(mockGetPreviousScanForTheme).not.toHaveBeenCalled();
  });

  it("returns { scanDiff: null } for a FAILED scan", async () => {
    mockGetScanById.mockResolvedValue({ ...SCAN, status: "FAILED" });

    const result = (await loader(makeLoaderArgs("scan-1"))) as { scanDiff: null };

    expect(result.scanDiff).toBeNull();
    expect(mockDiffScans).not.toHaveBeenCalled();
  });

  it("treats PARTIAL as a successful scan and computes the diff", async () => {
    mockGetScanById.mockResolvedValue({ ...SCAN, status: "PARTIAL", skippedCategories: [] });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error / ownership handling
  // -------------------------------------------------------------------------

  it("returns 400 when scanId param is missing", async () => {
    const args = {
      request: new Request("https://test-shop.myshopify.com/app/scans//diff"),
      params: {},
      context: {},
    } as unknown as LoaderFunctionArgs;

    const result = await loader(args);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("returns 404 when shop is not found", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = await loader(makeLoaderArgs("scan-1"));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("returns 404 when scan is not found", async () => {
    mockGetScanById.mockResolvedValue(null);

    const result = await loader(makeLoaderArgs("scan-1"));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("returns 404 when scan belongs to a different shop (ownership check)", async () => {
    mockGetScanById.mockResolvedValue({ ...SCAN, shopId: "other-shop" });

    const result = await loader(makeLoaderArgs("scan-1"));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });
});
