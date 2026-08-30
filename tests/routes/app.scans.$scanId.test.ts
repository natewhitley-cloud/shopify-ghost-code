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
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingSummary: vi.fn(),
  getHighestSeverityFinding: vi.fn(),
  getFindingsPageForScan: vi.fn(),
  getAppAttributionForScan: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canViewFindingDetails: vi.fn(),
  canUseScanDiffing: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { computeHealthScore } from "../../app/lib/health-score";
import { canUseScanDiffing, canViewFindingDetails } from "../../app/lib/plan-gating.server";
import {
  getAppAttributionForScan,
  getFindingsPageForScan,
  getFindingSummary,
  getHighestSeverityFinding,
} from "../../app/models/finding.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  findUnknownScriptForShop,
  getUnknownScriptsForScan,
  submitSignatureSuggestion,
} from "../../app/models/unknown-script.server";
import { action, CopyButton, FindingRow, loader } from "../../app/routes/app.scans.$scanId";
import { isTrackerApp } from "../../app/services/app-lookup.server";
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
const mockGetHighestSeverityFinding = getHighestSeverityFinding as ReturnType<typeof vi.fn>;
const mockCanViewFindingDetails = canViewFindingDetails as ReturnType<typeof vi.fn>;
const mockCanUseScanDiffing = canUseScanDiffing as ReturnType<typeof vi.fn>;
const mockComputeHealthScore = computeHealthScore as ReturnType<typeof vi.fn>;
const mockFindUnknownScriptForShop = findUnknownScriptForShop as ReturnType<typeof vi.fn>;
const mockIsTrackerApp = isTrackerApp as ReturnType<typeof vi.fn>;
const mockSubmitSignatureSuggestion = submitSignatureSuggestion as ReturnType<typeof vi.fn>;

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
  // vi.resetAllMocks clears mockReturnValue set in the vi.mock factory; restore here.
  mockIsTrackerApp.mockReturnValue(false);
  mockCanViewFindingDetails.mockReturnValue(true);
  mockCanUseScanDiffing.mockReturnValue(false);
  mockComputeHealthScore.mockReturnValue(HEALTH_SCORE);
  mockGetHighestSeverityFinding.mockResolvedValue(null);
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
      });
    });

    it("passes cursor from URL search params to getFindingsPageForScan", async () => {
      await loader(
        makeLoaderArgs("scan-1", "https://test-shop.myshopify.com/app/scans/scan-1?cursor=f-99"),
      );

      expect(mockGetFindingsPageForScan).toHaveBeenCalledWith("scan-1", {
        limit: 50,
        cursor: "f-99",
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

    it("does not call getAppAttributionForScan for free-plan shops", async () => {
      await loader(makeLoaderArgs("scan-1"));

      expect(mockGetAppAttributionForScan).not.toHaveBeenCalled();
    });
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
