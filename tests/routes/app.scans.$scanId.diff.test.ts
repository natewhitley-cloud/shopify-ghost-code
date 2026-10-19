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
  getPreviousScanForTheme: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingsForScan: vi.fn(),
}));

// E2.2: the loader now filters ignored findings out of both scan sets before
// diffing. Mock the ignore read to return "no suppressions" so filterIgnoredFindings
// (real, pure) short-circuits and the existing diff assertions are unchanged.
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canUseScanDiffing: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  isSuccessfulScan: (status: string) => status === "COMPLETED" || status === "PARTIAL",
}));

// Keep the REAL unauditedCategories (gc-11f) so the loader's skipped+capped
// union is exercised; only the differ itself is stubbed.
vi.mock("../../app/services/scan-differ.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/scan-differ.server")>()),
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
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
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
const mockGetIgnoredFindings = getIgnoredFindingsForShop as ReturnType<typeof vi.fn>;
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
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
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
  mockGetIgnoredFindings.mockResolvedValue({ fingerprints: new Set(), appNames: new Set() });
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
      notNewCategories: [],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
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
      notNewCategories: [],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
    });
  });

  it("excludes capped categories from resolved too, via the skipped+capped union (gc-11f)", async () => {
    // A capped category was only partly re-checked, so its prior findings must
    // be excluded exactly like a scope skip. GHOST_TAG in both lists is deduped.
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      skippedCategories: ["GHOST_TAG"],
      cappedCategories: ["DANGLING_REFERENCE", "GHOST_TAG"],
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), {
      skippedCategories: ["GHOST_TAG", "DANGLING_REFERENCE"],
      skippedFiles: [],
      notNewCategories: [],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
    });
  });

  it("excludes a capped-only category from resolved (gc-11f)", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      cappedCategories: ["JSON_LD_PRICE_CONFLICT"],
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), {
      skippedCategories: ["JSON_LD_PRICE_CONFLICT"],
      skippedFiles: [],
      notNewCategories: [],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
    });
  });

  it("excludes an unreachable-storefront category from resolved", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      unreachableCategories: ["SCRIPT_TAG_SUNSET"],
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), {
      skippedCategories: ["SCRIPT_TAG_SUNSET"],
      skippedFiles: [],
      notNewCategories: [],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
    });
  });

  it("never reports as new a finding whose category the PREVIOUS scan did not audit (H3)", async () => {
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      unreachableCategories: ["SCRIPT_TAG_SUNSET"],
      skippedCategories: ["GHOST_PAGE"],
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), {
      skippedCategories: [],
      skippedFiles: [],
      notNewCategories: ["GHOST_PAGE", "SCRIPT_TAG_SUNSET"],
      // Legacy fixtures: no walk coverage recorded (gc-747u).
      currentWalks: null,
      baselineWalks: null,
    });
  });

  it("treats types missing from the current scan's live set as un-audited (M4)", async () => {
    const { FindingType } = await import("@prisma/client");
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      liveFindingTypes: Object.values(FindingType).filter((t) => t !== "SCRIPT_TAG_SUNSET"),
    });

    await loader(makeLoaderArgs("scan-1"));

    expect(mockDiffScans.mock.calls[0][2].skippedCategories).toEqual(["SCRIPT_TAG_SUNSET"]);
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

// gc-14x5: an affected-app advisory in the in-app diff, with the REAL differ.
describe("app.scans.$scanId.diff loader: an affected-app advisory (gc-14x5)", () => {
  // Stored advisories are shown only while their flag is on (gc-5nok kill switch).
  beforeEach(() => {
    process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
  });

  const ALL_TYPES = ["GHOST_SCRIPT", "GHOST_STYLE", "MALICIOUS_SCRIPT", "APP_INCIDENT_ADVISORY"];
  const ADVISORY = {
    id: "adv",
    severity: "HIGH",
    findingType: "APP_INCIDENT_ADVISORY",
    filename: "layout/theme.liquid",
    lineNumber: 42,
    appName: null,
    codeSnippet: '<script src="https://productoption.hulkapps.com/hulkcode.js"></script>',
    description: "Loads code from Hulk Product Options",
  };
  const live = (types: string[]) => ({ liveFindingTypes: types });

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("../../app/services/scan-differ.server")>(
      "../../app/services/scan-differ.server",
    );
    mockDiffScans.mockImplementation(real.diffScans as never);
    mockGetScanById.mockResolvedValue({ ...SCAN, ...live(ALL_TYPES) });
  });

  const load = async () =>
    (await loader(makeLoaderArgs("scan-1"))) as {
      scanDiff: {
        newFindings: Array<{ findingType: string }>;
        resolvedFindings: Array<{ findingType: string }>;
        unchangedCount: number;
      };
    };

  it("new: it is a new finding like any other", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      ...live(ALL_TYPES),
      findings: [],
    });

    const { scanDiff } = await load();

    expect(scanDiff.newFindings.map((f) => f.findingType)).toEqual(["APP_INCIDENT_ADVISORY"]);
    expect(scanDiff.resolvedFindings).toEqual([]);
  });

  it("the script removed: resolved", async () => {
    mockGetFindingsForScan.mockResolvedValue([]);
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      ...live(ALL_TYPES),
      findings: [ADVISORY],
    });

    expect((await load()).scanDiff.resolvedFindings.map((f) => f.findingType)).toEqual([
      "APP_INCIDENT_ADVISORY",
    ]);
  });

  it("the entry EXPIRED (the current scan did not record the type as live): no 'Fixed' row", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      ...live(ALL_TYPES.filter((t) => t !== "APP_INCIDENT_ADVISORY")),
    });
    mockGetFindingsForScan.mockResolvedValue([]);
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      ...live(ALL_TYPES),
      findings: [ADVISORY, PREV_FINDING],
    });

    const { scanDiff } = await load();

    // The real fix beside it is still reported.
    expect(scanDiff.resolvedFindings.map((f) => f.findingType)).toEqual(["GHOST_STYLE"]);
  });

  it("a draft-theme baseline (type not live there): the published scan's advisory is not 'new'", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      ...live(ALL_TYPES.filter((t) => t !== "APP_INCIDENT_ADVISORY")),
      findings: [],
    });

    expect((await load()).scanDiff.newFindings).toEqual([]);
  });

  it("an IGNORED advisory is in neither side of the diff", async () => {
    const { fingerprintFinding } = await vi.importActual<
      typeof import("../../app/services/scan-differ.server")
    >("../../app/services/scan-differ.server");
    mockGetIgnoredFindings.mockResolvedValue({
      fingerprints: new Set([
        fingerprintFinding(
          ADVISORY.filename,
          ADVISORY.findingType,
          ADVISORY.codeSnippet,
          ADVISORY.lineNumber,
        ),
      ]),
      appNames: new Set(),
    });
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);
    mockGetPreviousScanForTheme.mockResolvedValue({
      ...PREVIOUS_SCAN,
      ...live(ALL_TYPES),
      findings: [],
    });

    const { scanDiff } = await load();

    expect(scanDiff).toMatchObject({ newFindings: [], resolvedFindings: [], unchangedCount: 0 });
  });

  it("flag off (gc-5nok kill switch): the hidden advisory is neither new nor fixed", async () => {
    const types = (rows: Array<{ findingType: string }>) => rows.map((f) => f.findingType);
    const asNew = async () => {
      mockGetFindingsForScan.mockResolvedValue([ADVISORY]);
      mockGetPreviousScanForTheme.mockResolvedValue({
        ...PREVIOUS_SCAN,
        ...live(ALL_TYPES),
        findings: [],
      });
      return (await load()).scanDiff;
    };
    const asFixed = async () => {
      mockGetFindingsForScan.mockResolvedValue([]);
      mockGetPreviousScanForTheme.mockResolvedValue({
        ...PREVIOUS_SCAN,
        ...live(ALL_TYPES),
        findings: [ADVISORY],
      });
      return (await load()).scanDiff;
    };

    // Non-vacuous: the same scans with the flag on report it new, then fixed.
    expect(types((await asNew()).newFindings)).toEqual(["APP_INCIDENT_ADVISORY"]);
    expect(types((await asFixed()).resolvedFindings)).toEqual(["APP_INCIDENT_ADVISORY"]);

    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
    expect(await asNew()).toMatchObject({ newFindings: [], resolvedFindings: [] });
    expect(await asFixed()).toMatchObject({ newFindings: [], resolvedFindings: [] });
  });
});
