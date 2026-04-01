/**
 * Tests for app/routes/app.scans.$scanId.export.tsx
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session shop domain.
 *   - Mock getShopMetadata, getScanById, getFindingsForScan, and canViewFindingDetails
 *     to avoid any real DB or Shopify API calls.
 *   - Verify response status, Content-Type, Content-Disposition, and body shape
 *     for CSV, JSON, free-plan 403, and missing-scan 404 cases.
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

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingsForScan: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canViewFindingDetails: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { canViewFindingDetails } from "../../app/lib/plan-gating.server";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans.$scanId.export";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScanById = getScanById as ReturnType<typeof vi.fn>;
const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockCanViewFindingDetails = canViewFindingDetails as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Standard",
};

const SCAN = {
  id: "scan-abc",
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/123",
  themeName: "Dawn",
  status: "COMPLETED",
  createdAt: new Date("2026-01-15T10:00:00Z"),
  completedAt: new Date("2026-01-15T10:05:00Z"),
  findingCount: 2,
};

const FINDINGS = [
  {
    id: "finding-1",
    scanId: "scan-abc",
    severity: "HIGH",
    findingType: "GHOST_SCRIPT",
    filename: "layout/theme.liquid",
    lineNumber: 42,
    appName: "Klaviyo",
    codeSnippet: '<script src="https://klaviyo.com/track.js"></script>',
    description: "Orphaned Klaviyo script tag",
    createdAt: new Date("2026-01-15T10:05:00Z"),
  },
  {
    id: "finding-2",
    scanId: "scan-abc",
    severity: "MEDIUM",
    findingType: "GHOST_STYLE",
    filename: "assets/theme.css",
    lineNumber: 101,
    appName: null,
    codeSnippet: ".old-app-banner { display: none; }",
    description: "Orphaned stylesheet rule",
    createdAt: new Date("2026-01-15T10:05:00Z"),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(scanId: string, format?: string) {
  const url = format
    ? `https://test-shop.myshopify.com/app/scans/${scanId}/export?format=${format}`
    : `https://test-shop.myshopify.com/app/scans/${scanId}/export`;
  return new Request(url, { method: "GET" });
}

function callLoader(scanId: string, format?: string) {
  return loader({
    request: makeRequest(scanId, format),
    params: { scanId },
    context: {},
  } as unknown as LoaderFunctionArgs);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy path: paid shop, known scan, findings present.
  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: "test-shop.myshopify.com" },
  });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockCanViewFindingDetails.mockReturnValue(true);
  mockGetScanById.mockResolvedValue(SCAN);
  mockGetFindingsForScan.mockResolvedValue(FINDINGS);
});

// ---------------------------------------------------------------------------
// Happy path: CSV export
// ---------------------------------------------------------------------------

describe("CSV export", () => {
  it("returns 200 with text/csv content-type", async () => {
    const response = await callLoader("scan-abc", "csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
  });

  it("returns Content-Disposition attachment with .csv filename", async () => {
    const response = await callLoader("scan-abc", "csv");

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".csv");
  });

  it("includes CSV header row as first line", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();
    const firstLine = body.split("\r\n")[0];

    expect(firstLine).toContain("Severity");
    expect(firstLine).toContain("Type");
    expect(firstLine).toContain("File");
    expect(firstLine).toContain("Line");
    expect(firstLine).toContain("App");
    expect(firstLine).toContain("Code Snippet");
  });

  it("includes one data row per finding", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();
    const lines = body.split("\r\n");

    // 1 header + 2 data rows
    expect(lines).toHaveLength(3);
  });

  it("includes finding severity, type, and filename in the data rows", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    expect(body).toContain("HIGH");
    expect(body).toContain("GHOST_SCRIPT");
    expect(body).toContain("layout/theme.liquid");
  });

  it("defaults to CSV when no format query param is provided", async () => {
    const response = await callLoader("scan-abc"); // no format param

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
  });

  it("defaults to CSV for unrecognised format values", async () => {
    const response = await callLoader("scan-abc", "xml");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
  });

  it("wraps fields with double-quotes in the output", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();
    // All fields are wrapped in quotes per escapeCsvField
    expect(body).toContain('"HIGH"');
  });

  it("escapes internal double-quotes by doubling them", async () => {
    // A finding with a code snippet containing a double-quote character
    mockGetFindingsForScan.mockResolvedValue([
      {
        ...FINDINGS[0],
        codeSnippet: 'data-attr="value"',
      },
    ]);

    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    // The double-quote in the snippet should be escaped as ""
    expect(body).toContain('""value""');
  });

  it("handles fields containing commas without breaking columns", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      {
        ...FINDINGS[0],
        codeSnippet: "color: red, green, blue;",
      },
    ]);

    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    // The comma-containing value should be inside double-quotes, keeping it as one field
    expect(body).toContain('"color: red, green, blue;"');
    // Data row should still have the correct number of comma-separated fields
    const dataRow = body.split("\r\n")[1];
    // Split on commas that are NOT inside quotes to count fields
    // Since all fields are quoted, we can count by splitting on ","
    const fields = dataRow.match(/"[^"]*(?:""[^"]*)*"/g);
    expect(fields).toHaveLength(6); // Severity, Type, File, Line, App, Code Snippet
  });

  it("handles fields containing newlines within quoted values", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      {
        ...FINDINGS[0],
        codeSnippet: "line1\nline2\nline3",
      },
    ]);

    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    // Newlines inside quoted fields are valid CSV — the field should contain them
    expect(body).toContain('"line1\nline2\nline3"');
  });

  it("handles fields with both commas and double-quotes", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      {
        ...FINDINGS[0],
        codeSnippet: 'attr="val1,val2"',
      },
    ]);

    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    // Quotes should be doubled, commas preserved inside the quoted field
    expect(body).toContain('"attr=""val1,val2"""');
  });

  it("uses empty string for null appName fields", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    // FINDINGS[1] has appName: null — should appear as empty quoted field
    const lines = body.split("\r\n");
    // data row index 2 = second finding (index 1 in FINDINGS)
    expect(lines[2]).toContain('""');
  });
});

// ---------------------------------------------------------------------------
// Happy path: JSON export
// ---------------------------------------------------------------------------

describe("JSON export", () => {
  it("returns 200 with application/json content-type", async () => {
    const response = await callLoader("scan-abc", "json");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns Content-Disposition attachment with .json filename", async () => {
    const response = await callLoader("scan-abc", "json");

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".json");
  });

  it("includes scanId, themeName, and exportedAt at the top level", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    expect(body.scanId).toBe("scan-abc");
    expect(body.themeName).toBe("Dawn");
    expect(typeof body.exportedAt).toBe("string");
  });

  it("includes one entry per finding in the findings array", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.findings).toHaveLength(2);
  });

  it("maps finding fields to the documented JSON shape", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();
    const first = body.findings[0];

    expect(first.severity).toBe("HIGH");
    expect(first.type).toBe("GHOST_SCRIPT");
    expect(first.file).toBe("layout/theme.liquid");
    expect(first.line).toBe(42);
    expect(first.app).toBe("Klaviyo");
    expect(typeof first.codeSnippet).toBe("string");
  });

  it("serialises null appName as null in JSON (not as a string)", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();
    const second = body.findings[1];

    expect(second.app).toBeNull();
  });

  it("returns an empty findings array when the scan has no findings", async () => {
    mockGetFindingsForScan.mockResolvedValue([]);

    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    expect(body.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plan gating: free plan → 403
// ---------------------------------------------------------------------------

describe("free plan", () => {
  beforeEach(() => {
    mockCanViewFindingDetails.mockReturnValue(false);
  });

  it("returns 403 when the shop is on the free plan", async () => {
    const response = await callLoader("scan-abc", "csv");

    expect(response.status).toBe(403);
  });

  it("does not call getFindingsForScan when plan check fails", async () => {
    await callLoader("scan-abc", "csv");

    expect(mockGetFindingsForScan).not.toHaveBeenCalled();
  });

  it("returns 403 for JSON format too (plan check fires before format check)", async () => {
    const response = await callLoader("scan-abc", "json");

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Missing or unauthorised scan → 404
// ---------------------------------------------------------------------------

describe("missing scan", () => {
  it("returns 404 when getScanById returns null", async () => {
    mockGetScanById.mockResolvedValue(null);

    const response = await callLoader("nonexistent-scan", "csv");

    expect(response.status).toBe(404);
  });

  it("returns 404 when scan belongs to a different shop", async () => {
    mockGetScanById.mockResolvedValue({
      ...SCAN,
      shopId: "other-shop-99", // does not match SHOP.id = "shop-1"
    });

    const response = await callLoader("scan-abc", "csv");

    expect(response.status).toBe(404);
  });

  it("does not call getFindingsForScan when scan is not found", async () => {
    mockGetScanById.mockResolvedValue(null);

    await callLoader("nonexistent-scan", "csv");

    expect(mockGetFindingsForScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Missing shop → 404
// ---------------------------------------------------------------------------

describe("missing shop", () => {
  it("returns 404 when getShopMetadata returns null", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const response = await callLoader("scan-abc", "csv");

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Missing scanId param → 400
// ---------------------------------------------------------------------------

describe("missing scanId param", () => {
  it("returns 400 when scanId param is missing", async () => {
    const response = await loader({
      request: new Request("https://test-shop.myshopify.com/app/scans//export"),
      params: {}, // no scanId
      context: {},
    } as unknown as LoaderFunctionArgs);

    expect(response.status).toBe(400);
  });
});
