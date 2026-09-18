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

  it("renders without throwing when given more than the render cap (250) of findings", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      severity: (i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW") as
        | "HIGH"
        | "MEDIUM"
        | "LOW",
      findingType: "GHOST_SCRIPT",
      filename: `snippets/app-${i}.liquid`,
      lineNumber: i + 1,
      appName: i % 2 === 0 ? `App ${i}` : null,
      description: `Finding number ${i}`,
      codeSnippet: `<script src="https://cdn.example.com/app-${i}.js"></script>`,
    }));

    const buffer = await renderScanReportPdf({
      scan: { id: "scan-many", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
      findings: many,
      healthScore: { score: 10, label: "Critical" },
      exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });
});
