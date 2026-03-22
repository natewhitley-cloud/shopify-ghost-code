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
}));

vi.mock("../../app/models/scan.server", () => ({
  updateScanStatus: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  completeScanWithFindings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { completeScanWithFindings } from "../../app/models/finding.server";
import { updateScanStatus } from "../../app/models/scan.server";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
import { fetchThemeFiles } from "../../app/services/theme-fetcher.server";
import { unauthenticated } from "../../app/shopify.server";
import { scanTheme } from "../../inngest/functions/scan-theme";
import { createMockInngestStep, createMockInngestEvent } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDb = db as { shop: { findUnique: ReturnType<typeof vi.fn> } };
const mockUnauthenticated = unauthenticated as { admin: ReturnType<typeof vi.fn> };
const mockFetchThemeFiles = fetchThemeFiles as ReturnType<typeof vi.fn>;
const mockScanThemeFiles = scanThemeFiles as ReturnType<typeof vi.fn>;
const mockUpdateScanStatus = updateScanStatus as ReturnType<typeof vi.fn>;
const mockCompleteScanWithFindings = completeScanWithFindings as ReturnType<typeof vi.fn>;

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
  return scanTheme.fn({ event, step });
}

// ---------------------------------------------------------------------------
// Setup: reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring for db + shopify
  mockDb.shop.findUnique.mockResolvedValue(MOCK_SHOP);
  mockUnauthenticated.admin.mockResolvedValue({ admin: MOCK_ADMIN });

  // Default happy-path wiring for services
  mockFetchThemeFiles.mockResolvedValue(MOCK_FILES);
  mockScanThemeFiles.mockReturnValue(MOCK_FINDINGS);

  // Default happy-path wiring for models
  mockUpdateScanStatus.mockResolvedValue(undefined);
  mockCompleteScanWithFindings.mockResolvedValue(undefined);
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
    expect(mockFetchThemeFiles).toHaveBeenCalledWith(MOCK_ADMIN, THEME_ID);
  });

  it("passes fetched files to the scan engine", async () => {
    await runScanTheme();

    expect(mockScanThemeFiles).toHaveBeenCalledWith(MOCK_FILES);
  });

  it("persists findings and marks scan COMPLETED atomically", async () => {
    await runScanTheme();

    expect(mockCompleteScanWithFindings).toHaveBeenCalledWith(SCAN_ID, MOCK_FINDINGS);
  });

  it("executes all 4 steps in the correct order", async () => {
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
      return MOCK_FINDINGS;
    });
    mockCompleteScanWithFindings.mockImplementation(async () => {
      callOrder.push("completeScanWithFindings");
    });

    await runScanTheme();

    expect(callOrder).toEqual([
      "updateScanStatus:IN_PROGRESS",
      "fetchThemeFiles",
      "scanThemeFiles",
      "completeScanWithFindings",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Happy path — zero findings
// ---------------------------------------------------------------------------

describe("scanTheme — zero findings", () => {
  beforeEach(() => {
    mockScanThemeFiles.mockReturnValue([]);
  });

  it("returns findingCount of 0 and COMPLETED status", async () => {
    const result = await runScanTheme();

    expect(result).toEqual({
      scanId: SCAN_ID,
      findingCount: 0,
      status: "COMPLETED",
    });
  });

  it("calls completeScanWithFindings with empty array", async () => {
    await runScanTheme();

    expect(mockCompleteScanWithFindings).toHaveBeenCalledWith(SCAN_ID, []);
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

  it("marks scan FAILED and re-throws when completeScanWithFindings throws", async () => {
    const dbError = new Error("DB write failed");
    mockCompleteScanWithFindings.mockRejectedValue(dbError);

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

  it("does not call completeScanWithFindings on error paths", async () => {
    mockFetchThemeFiles.mockRejectedValue(new Error("network failure"));

    await expect(runScanTheme()).rejects.toThrow();

    expect(mockCompleteScanWithFindings).not.toHaveBeenCalled();
  });

  it("marks scan IN_PROGRESS before any failure in step 2", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await expect(runScanTheme()).rejects.toThrow();

    // Step 1 (IN_PROGRESS) should still have been called
    expect(mockUpdateScanStatus).toHaveBeenCalledWith(SCAN_ID, "IN_PROGRESS");
  });
});
