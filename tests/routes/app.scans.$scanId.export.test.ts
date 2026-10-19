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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));

// gc-j8xq: the export decides what to show through the REAL
// filterIgnoredExceptMalicious (pure, no DB), so these tests exercise the
// actual ignore rules. filterIgnoredFindings stays a mock for the older tests
// below that still set it up; the route no longer calls it.
vi.mock("../../app/services/finding-aggregation.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/services/finding-aggregation.server")>();
  return {
    filterIgnoredFindings: vi.fn(),
    filterIgnoredExceptMalicious: actual.filterIgnoredExceptMalicious,
  };
});

vi.mock("../../app/lib/plan-gating.server", () => ({
  canViewFindingDetails: vi.fn(),
  canExportPdf: vi.fn(),
}));

// Mock the PDF renderer for speed and hermeticity — the real renderer is
// exercised separately in tests/lib/scan-report-pdf.server.test.ts.
vi.mock("../../app/lib/scan-report-pdf.server", () => ({
  renderScanReportPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7 fake")),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { canExportPdf, canViewFindingDetails } from "../../app/lib/plan-gating.server";
import { renderScanReportPdf } from "../../app/lib/scan-report-pdf.server";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans.$scanId.export";
import { filterIgnoredFindings } from "../../app/services/finding-aggregation.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScanById = getScanById as ReturnType<typeof vi.fn>;
const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockCanViewFindingDetails = canViewFindingDetails as ReturnType<typeof vi.fn>;
const mockCanExportPdf = canExportPdf as ReturnType<typeof vi.fn>;
const mockGetIgnoredFindingsForShop = getIgnoredFindingsForShop as ReturnType<typeof vi.fn>;
const mockFilterIgnoredFindings = filterIgnoredFindings as ReturnType<typeof vi.fn>;

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
  mockCanExportPdf.mockReturnValue(true); // Professional happy path for PDF export
  mockGetScanById.mockResolvedValue(SCAN);
  mockGetFindingsForScan.mockResolvedValue(FINDINGS);

  // Default: no suppressions — pass every finding through untouched.
  mockGetIgnoredFindingsForShop.mockResolvedValue({
    fingerprints: new Set<string>(),
    appNames: new Set<string>(),
  });
  mockFilterIgnoredFindings.mockImplementation((findings: unknown[]) => ({
    kept: findings,
    ignored: [],
  }));
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
    expect(firstLine).toContain("Description");
  });

  it("includes each finding's description in the data rows", async () => {
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();

    expect(body).toContain("Orphaned Klaviyo script tag");
    expect(body).toContain("Orphaned stylesheet rule");
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
    expect(fields).toHaveLength(7); // Severity, Type, File, Line, App, Code Snippet, Description
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
// Security: CSV formula injection neutralization (GC-fjg / SEC-2)
// ---------------------------------------------------------------------------

describe("CSV formula injection", () => {
  /**
   * Returns the second line of the CSV body (the single data row) for a scan
   * whose only finding has the given codeSnippet. The codeSnippet column is the
   * second-to-last field in the row (Description is now the final column), so
   * these tests assert on the neutralized, uniquely-quoted snippet field via
   * containment rather than a row-end match.
   */
  async function dataRowForSnippet(codeSnippet: string): Promise<string> {
    mockGetFindingsForScan.mockResolvedValue([{ ...FINDINGS[0], codeSnippet }]);
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();
    return body.split("\r\n")[1];
  }

  it("prefixes a value starting with = with a single quote", async () => {
    const row = await dataRowForSnippet("=SUM(A1:A2)");
    expect(row).toContain(`"'=SUM(A1:A2)"`);
  });

  it("prefixes a value starting with + with a single quote", async () => {
    const row = await dataRowForSnippet("+1+1");
    expect(row).toContain(`"'+1+1"`);
  });

  it("prefixes a value starting with - with a single quote", async () => {
    const row = await dataRowForSnippet("-2+3");
    expect(row).toContain(`"'-2+3"`);
  });

  it("prefixes a value starting with @ with a single quote", async () => {
    const row = await dataRowForSnippet("@SUM(1)");
    expect(row).toContain(`"'@SUM(1)"`);
  });

  it("prefixes a value starting with a tab with a single quote", async () => {
    const row = await dataRowForSnippet("\t=cmd");
    expect(row).toContain(`"'\t=cmd"`);
  });

  it("prefixes a value starting with a carriage return with a single quote", async () => {
    const row = await dataRowForSnippet("\r=cmd");
    expect(row).toContain(`"'\r=cmd"`);
  });

  it("does NOT prefix a value with = that is not at the start", async () => {
    const row = await dataRowForSnippet("color =red");
    expect(row).toContain(`"color =red"`);
    expect(row).not.toContain(`"'color`);
  });

  it("does NOT prefix a benign value", async () => {
    const row = await dataRowForSnippet("display: none;");
    expect(row).toContain(`"display: none;"`);
  });

  it("composes with comma/quote escaping when a dangerous value also contains them", async () => {
    // Leading '=' must be neutralized AND internal quotes doubled AND the comma
    // kept inside the wrapping quotes (so it stays one field).
    const row = await dataRowForSnippet('=HYPERLINK("a,b")');
    expect(row).toContain(`"'=HYPERLINK(""a,b"")"`);
  });

  it("composes with newline escaping for a dangerous value containing a newline", async () => {
    mockGetFindingsForScan.mockResolvedValue([{ ...FINDINGS[0], codeSnippet: "=A1\nsecond line" }]);
    const response = await callLoader("scan-abc", "csv");
    const body = await response.text();
    // The neutralized field with embedded newline lives inside the wrapping quotes.
    expect(body).toContain(`"'=A1\nsecond line"`);
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

  it("includes each finding's description", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    expect(body.findings[0].description).toBe("Orphaned Klaviyo script tag");
    expect(body.findings[1].description).toBe("Orphaned stylesheet rule");
  });

  it("carries no 0-100 health score (gc-k2ub: the score is gone from every surface)", async () => {
    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    expect(body).not.toHaveProperty("healthScore");
    expect(Object.keys(body).sort()).toEqual(["exportedAt", "findings", "scanId", "themeName"]);
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

  it("excludes ignored findings from the export", async () => {
    // The shop has suppressed FINDINGS[0] (the HIGH Klaviyo finding); only the
    // MEDIUM finding survives filtering.
    mockGetIgnoredFindingsForShop.mockResolvedValue({
      fingerprints: new Set<string>(),
      appNames: new Set<string>(["Klaviyo"]),
    });
    mockFilterIgnoredFindings.mockReturnValue({
      kept: [FINDINGS[1]],
      ignored: [FINDINGS[0]],
    });

    const response = await callLoader("scan-abc", "json");
    const body = await response.json();

    // The suppressed HIGH finding is absent; only the MEDIUM one remains.
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].type).toBe("GHOST_STYLE");
    expect(body.findings.some((f: { app: string | null }) => f.app === "Klaviyo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PDF export (Professional-only, gc-rrh.1)
// ---------------------------------------------------------------------------

describe("PDF export", () => {
  it("returns 200 with application/pdf content-type when the plan can export PDF", async () => {
    const response = await callLoader("scan-abc", "pdf");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/pdf");
  });

  it("returns Content-Disposition attachment with .pdf filename", async () => {
    const response = await callLoader("scan-abc", "pdf");

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".pdf");
  });

  it("returns a body starting with the %PDF magic bytes", async () => {
    const response = await callLoader("scan-abc", "pdf");
    const body = await response.text();

    expect(body.startsWith("%PDF")).toBe(true);
  });

  it("passes the renderer the scan and kept findings, no health score (gc-k2ub)", async () => {
    await callLoader("scan-abc", "pdf");

    const input = vi.mocked(renderScanReportPdf).mock.calls[0][0];
    expect(input).not.toHaveProperty("healthScore");
    expect(Object.keys(input).sort()).toEqual(["exportedAt", "findings", "scan"]);
  });

  it("returns 403 when the plan cannot export PDF (Standard/Free)", async () => {
    mockCanExportPdf.mockReturnValue(false);

    const response = await callLoader("scan-abc", "pdf");

    expect(response.status).toBe(403);
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

// ---------------------------------------------------------------------------
// gc-j8xq: known malicious code is exported regardless of ignores
// ---------------------------------------------------------------------------

describe("ignored malicious findings are still exported (gc-j8xq)", () => {
  const MALICIOUS_IGNORED = {
    id: "finding-m1",
    scanId: "scan-abc",
    severity: "HIGH",
    findingType: "MALICIOUS_SCRIPT",
    filename: "layout/theme.liquid",
    lineNumber: 7,
    appName: "Klaviyo", // APP-ignored below
    codeSnippet: '<script src="https://evil.example/x.js"></script>',
    description: "Loads from a known malicious source",
    createdAt: new Date("2026-01-15T10:05:00Z"),
  };
  const MALICIOUS_NOT_IGNORED = {
    ...MALICIOUS_IGNORED,
    id: "finding-m2",
    appName: null,
    lineNumber: 99,
    codeSnippet: '<script src="https://evil.example/y.js"></script>',
  };
  // FINDINGS[0] is Klaviyo's (ignored); FINDINGS[1] has no app (kept).
  const ALL = [FINDINGS[0], MALICIOUS_IGNORED, FINDINGS[1], MALICIOUS_NOT_IGNORED];

  function ignoreKlaviyo() {
    mockGetIgnoredFindingsForShop.mockResolvedValue({
      fingerprints: new Set<string>(),
      appNames: new Set<string>(["Klaviyo"]),
    });
  }

  describe("a scan whose only finding is an ignored malicious one", () => {
    beforeEach(() => {
      ignoreKlaviyo();
      mockGetFindingsForScan.mockResolvedValue([MALICIOUS_IGNORED]);
    });

    it("CSV: the finding is a data row, not just the header", async () => {
      const lines = (await (await callLoader("scan-abc", "csv")).text()).split("\r\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('"Severity","Type","File","Line","App","Code Snippet","Description"');
      expect(lines[1]).toContain('"MALICIOUS_SCRIPT"');
    });

    it("JSON: the finding is in the findings array, in the unchanged shape", async () => {
      const body = await (await callLoader("scan-abc", "json")).json();
      expect(body.findings).toHaveLength(1);
      expect(Object.keys(body.findings[0])).toEqual([
        "severity",
        "type",
        "file",
        "line",
        "app",
        "description",
        "codeSnippet",
      ]);
      expect(body.findings[0].type).toBe("MALICIOUS_SCRIPT");
    });

    it("PDF: the renderer gets the finding, marked as ignored (never an empty list)", async () => {
      await callLoader("scan-abc", "pdf");
      const input = vi.mocked(renderScanReportPdf).mock.calls[0][0];
      expect(input.findings).toHaveLength(1);
      expect(input.findings[0]).toMatchObject({
        findingType: "MALICIOUS_SCRIPT",
        ignoredByMerchant: true,
      });
    });
  });

  describe("a mixed scan", () => {
    beforeEach(() => {
      ignoreKlaviyo();
      mockGetFindingsForScan.mockResolvedValue(ALL);
    });

    it("CSV: drops the ignored non-malicious finding, keeps both malicious ones, in order", async () => {
      const lines = (await (await callLoader("scan-abc", "csv")).text()).split("\r\n");
      expect(lines).toHaveLength(4);
      expect(lines.slice(1).map((l) => l.split(",")[1])).toEqual([
        '"MALICIOUS_SCRIPT"',
        '"GHOST_STYLE"',
        '"MALICIOUS_SCRIPT"',
      ]);
      expect(lines.join("\n")).not.toContain("GHOST_SCRIPT");
      // No new column, in the header or in any row.
      expect(lines[0].split(",")).toHaveLength(7);
      expect(lines.join("\n")).not.toMatch(/ignored/i);
    });

    it("JSON: drops the ignored non-malicious finding, keeps both malicious ones, in order", async () => {
      const body = await (await callLoader("scan-abc", "json")).json();
      expect(body.findings.map((f: { type: string }) => f.type)).toEqual([
        "MALICIOUS_SCRIPT",
        "GHOST_STYLE",
        "MALICIOUS_SCRIPT",
      ]);
      expect(JSON.stringify(body)).not.toMatch(/ignored/i);
    });

    it("PDF: same three findings, and only the ignored malicious one is marked", async () => {
      await callLoader("scan-abc", "pdf");
      const { findings } = vi.mocked(renderScanReportPdf).mock.calls[0][0];
      expect(findings.map((f) => [f.findingType, Boolean(f.ignoredByMerchant)])).toEqual([
        ["MALICIOUS_SCRIPT", true],
        ["GHOST_STYLE", false],
        ["MALICIOUS_SCRIPT", false],
      ]);
    });
  });

  it.each(["csv", "json", "pdf"])(
    "%s: with everything ignored and nothing malicious, the export is empty",
    async (format) => {
      ignoreKlaviyo();
      mockGetFindingsForScan.mockResolvedValue([FINDINGS[0]]);
      const response = await callLoader("scan-abc", format);
      if (format === "csv") {
        expect((await response.text()).split("\r\n")).toHaveLength(1);
      } else if (format === "json") {
        expect((await response.json()).findings).toEqual([]);
      } else {
        expect(vi.mocked(renderScanReportPdf).mock.calls[0][0].findings).toEqual([]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// gc-14x5: an affected-app advisory is exported like any other finding, and
// (unlike malicious code) an ignored one is dropped
// ---------------------------------------------------------------------------

describe("affected-app advisory in the export (gc-14x5)", () => {
  // Stored advisories are shown only while their flag is on (gc-5nok kill switch).
  beforeEach(() => {
    process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
  });

  const ADVISORY = {
    id: "finding-adv",
    scanId: "scan-abc",
    severity: "HIGH",
    findingType: "APP_INCIDENT_ADVISORY",
    filename: "layout/theme.liquid",
    lineNumber: 42,
    appName: null,
    codeSnippet: '<script src="https://productoption.hulkapps.com/hulkcode.js"></script>',
    description:
      "Loads code from Hulk Product Options (productoption.hulkapps.com), an app named in a public report of shoppers being sent to a fake checkout page (10 October 2026)",
    createdAt: new Date("2026-10-12T10:05:00Z"),
  };

  function ignoreAdvisory() {
    mockGetIgnoredFindingsForShop.mockResolvedValue({
      fingerprints: new Set<string>([
        fingerprintFinding(
          ADVISORY.filename,
          ADVISORY.findingType,
          ADVISORY.codeSnippet,
          ADVISORY.lineNumber,
        ),
      ]),
      appNames: new Set<string>(),
    });
  }

  it("CSV: one row with its type, file, line, an empty app, the snippet and the description", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);

    const lines = (await (await callLoader("scan-abc", "csv")).text()).split("\r\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      [
        '"HIGH"',
        '"APP_INCIDENT_ADVISORY"',
        '"layout/theme.liquid"',
        '"42"',
        '""',
        '"<script src=""https://productoption.hulkapps.com/hulkcode.js""></script>"',
        `"${ADVISORY.description}"`,
      ].join(","),
    );
  });

  it("JSON: in the findings array, with a null app and the description", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);

    const body = await (await callLoader("scan-abc", "json")).json();

    expect(body.findings).toEqual([
      {
        severity: "HIGH",
        type: "APP_INCIDENT_ADVISORY",
        file: "layout/theme.liquid",
        line: 42,
        app: null,
        description: ADVISORY.description,
        codeSnippet: ADVISORY.codeSnippet,
      },
    ]);
  });

  it("PDF: handed to the renderer, never marked 'ignored by you'", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);

    await callLoader("scan-abc", "pdf");

    const { findings } = vi.mocked(renderScanReportPdf).mock.calls[0][0];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ findingType: "APP_INCIDENT_ADVISORY" });
    expect(findings[0].ignoredByMerchant).toBeUndefined();
  });

  it.each(["csv", "json", "pdf"])(
    "%s: HONOURS IGNORES, an ignored advisory is dropped (it is not malicious code)",
    async (format) => {
      ignoreAdvisory();
      mockGetFindingsForScan.mockResolvedValue([ADVISORY, FINDINGS[1]]);

      const response = await callLoader("scan-abc", format);

      if (format === "csv") {
        const text = await response.text();
        expect(text.split("\r\n")).toHaveLength(2);
        expect(text).not.toContain("APP_INCIDENT_ADVISORY");
      } else if (format === "json") {
        const types = (await response.json()).findings.map((f: { type: string }) => f.type);
        expect(types).toEqual([FINDINGS[1].findingType]);
      } else {
        const { findings } = vi.mocked(renderScanReportPdf).mock.calls[0][0];
        expect(findings.map((f) => f.findingType)).toEqual([FINDINGS[1].findingType]);
      }
    },
  );

  it("flag off (gc-5nok kill switch): a stored advisory is left out of the export", async () => {
    mockGetFindingsForScan.mockResolvedValue([ADVISORY, FINDINGS[1]]);
    const types = async () =>
      (await (await callLoader("scan-abc", "json")).json()).findings.map(
        (f: { type: string }) => f.type,
      );

    // Non-vacuous: the same stored rows with the flag on export the advisory.
    expect(await types()).toEqual(["APP_INCIDENT_ADVISORY", FINDINGS[1].findingType]);

    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
    expect(await types()).toEqual([FINDINGS[1].findingType]);
  });

  it("Free: export stays a paid feature for every type (403), exactly as for malicious code", async () => {
    mockCanViewFindingDetails.mockReturnValue(false);
    mockGetFindingsForScan.mockResolvedValue([ADVISORY]);

    for (const format of ["csv", "json", "pdf"]) {
      expect((await callLoader("scan-abc", format)).status).toBe(403);
    }
    expect(mockGetFindingsForScan).not.toHaveBeenCalled();
  });
});
