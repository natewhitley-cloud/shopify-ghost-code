/**
 * Tests for app/lib/scan-report-pdf.server.tsx
 *
 * Confidence test for the REAL renderer: exercise @react-pdf/renderer end to
 * end and assert we get back a valid PDF Buffer (magic bytes %PDF-). Kept
 * minimal — the route test mocks this module for speed; this is where the real
 * render path is proven.
 */

import { describe, it, expect } from "vitest";

import { renderScanReportPdf } from "../../app/lib/scan-report-pdf.server";

describe("renderScanReportPdf", () => {
  it("resolves to a Buffer whose first bytes are the %PDF- magic header", async () => {
    const buffer = await renderScanReportPdf({
      scan: {
        id: "scan-xyz",
        themeName: "Dawn",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      },
      findings: [
        {
          severity: "HIGH",
          findingType: "GHOST_SCRIPT",
          filename: "layout/theme.liquid",
          lineNumber: 42,
          appName: "Klaviyo",
          description: "Orphaned Klaviyo script tag",
          codeSnippet: '<script src="https://klaviyo.com/track.js"></script>',
        },
        {
          severity: "MEDIUM",
          findingType: "GHOST_STYLE",
          filename: "assets/theme.css",
          lineNumber: 101,
          appName: null,
          description: "Orphaned stylesheet rule",
          codeSnippet: ".old-app-banner { display: none; }",
        },
      ],
      healthScore: { score: 85, label: "Good" },
      exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
