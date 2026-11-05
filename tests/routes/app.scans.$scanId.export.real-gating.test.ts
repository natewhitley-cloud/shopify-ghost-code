/**
 * Export route with the REAL plan gating (gc-0uht).
 *
 * app.scans.$scanId.export.test.ts mocks plan-gating, so a change to the
 * billing matrix (e.g. dropping exportPdf from Standard) would not fail any
 * route test. Here only the I/O boundaries are mocked (auth, db, models, the
 * PDF renderer); canViewFindingDetails / canExportPdf and getPlanFeatures run
 * for real.
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

// plan-gating.server imports db.server; the export path never queries it.
vi.mock("../../app/db.server", () => ({ default: {} }));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
  // Imported by plan-gating.server (scan quota); unused by the export path.
  countScansForShopSince: vi.fn(),
  hasCompletedScans: vi.fn(),
}));

vi.mock("../../app/models/finding.server", () => ({
  getFindingsForScan: vi.fn(),
}));

vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));

vi.mock("../../app/lib/scan-report-pdf.server", () => ({
  renderScanReportPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7 fake")),
}));

import { PLANS } from "../../app/lib/plans";
import { renderScanReportPdf } from "../../app/lib/scan-report-pdf.server";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans.$scanId.export";
import { authenticate } from "../../app/shopify.server";

const SCAN = {
  id: "scan-abc",
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/123",
  themeName: "Dawn",
  status: "COMPLETED",
  createdAt: new Date("2026-01-15T10:00:00Z"),
  completedAt: new Date("2026-01-15T10:05:00Z"),
  findingCount: 1,
};

const FINDING = {
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
};

function callLoader(format: string) {
  return loader({
    request: new Request(
      `https://test-shop.myshopify.com/app/scans/${SCAN.id}/export?format=${format}`,
    ),
    params: { scanId: SCAN.id },
    context: {},
  } as unknown as LoaderFunctionArgs);
}

function asPlan(plan: string) {
  vi.mocked(getShopMetadata).mockResolvedValue({
    id: "shop-1",
    domain: "test-shop.myshopify.com",
    plan,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticate.admin).mockResolvedValue({
    session: { shop: "test-shop.myshopify.com" },
  } as never);
  vi.mocked(getScanById).mockResolvedValue(SCAN as never);
  vi.mocked(getFindingsForScan).mockResolvedValue([FINDING] as never);
  vi.mocked(getIgnoredFindingsForShop).mockResolvedValue({
    fingerprints: new Set<string>(),
    appNames: new Set<string>(),
  } as never);
});

describe("PDF export through the real plan gating (gc-0uht)", () => {
  it("Standard: 200 application/pdf (gc-pqg0)", async () => {
    asPlan(PLANS.STANDARD);
    const res = await callLoader("pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/pdf");
    expect(renderScanReportPdf).toHaveBeenCalledTimes(1);
  });

  it("Professional: 200 application/pdf", async () => {
    asPlan(PLANS.PROFESSIONAL);
    const res = await callLoader("pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/pdf");
  });

  it("Free: 403 and the renderer never runs", async () => {
    asPlan(PLANS.FREE);
    const res = await callLoader("pdf");
    expect(res.status).toBe(403);
    expect(renderScanReportPdf).not.toHaveBeenCalled();
  });

  it("an unknown plan name is treated as Free: 403", async () => {
    asPlan("legacy-plan");
    const res = await callLoader("pdf");
    expect(res.status).toBe(403);
    expect(renderScanReportPdf).not.toHaveBeenCalled();
  });
});
