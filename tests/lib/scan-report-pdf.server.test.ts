/**
 * Tests for app/lib/scan-report-pdf.server.tsx
 *
 * Confidence test for the REAL renderer: exercise @react-pdf/renderer end to
 * end and assert we get back a valid PDF Buffer (magic bytes %PDF-). Kept
 * minimal — the route test mocks this module for speed; this is where the real
 * render path is proven.
 */

import type { ReactElement, ReactNode } from "react";
import { describe, it, expect } from "vitest";

import {
  renderScanReportPdf,
  hasUnsupportedGlyphs,
  ScanReportDocument,
} from "../../app/lib/scan-report-pdf.server";

/**
 * Every text run in the report's element tree, in render order. The react-pdf
 * primitives are plain string element types ("TEXT", "VIEW"), so calling the
 * document component gives a tree we can walk without a PDF text extractor
 * (the rendered PDF's content streams are compressed).
 */
function reportText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reportText).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") {
    return reportText((el.type as (p: unknown) => ReactNode)(el.props));
  }
  return `${reportText(el.props?.children)}\n`;
}

const FINDING = {
  severity: "HIGH" as const,
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 42,
  appName: "Klaviyo",
  description: "Orphaned Klaviyo script tag",
  codeSnippet: '<script src="https://klaviyo.com/track.js"></script>',
};

describe("ScanReportDocument header (gc-k2ub)", () => {
  const base = {
    scan: { id: "scan-xyz", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
    exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
  };

  it("summarizes with the findings count, never a 0-100 health score", () => {
    const text = reportText(
      ScanReportDocument({
        ...base,
        findings: [
          FINDING,
          { ...FINDING, severity: "MEDIUM" },
          { ...FINDING, severity: "LOW" },
          { ...FINDING, severity: "LOW" },
        ],
      }),
    );

    expect(text).toContain("4 findings\n");
    expect(text).toContain("1 High · 1 Medium · 2 Low");
    expect(text).not.toMatch(/health score/i);
    expect(text).not.toContain("/100");
    expect(text).not.toMatch(/out of 100/i);
  });

  it("uses the singular for one finding", () => {
    const text = reportText(ScanReportDocument({ ...base, findings: [FINDING] }));
    expect(text).toContain("1 finding\n");
  });

  it("states 0 findings for a clean theme", () => {
    const text = reportText(ScanReportDocument({ ...base, findings: [] }));
    expect(text).toContain("0 findings\n");
    expect(text).toContain("No findings. This theme is clean.");
  });
});

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
      exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("renders Cyrillic content (covered by Noto Sans) to a valid PDF", async () => {
    const buffer = await renderScanReportPdf({
      scan: { id: "scan-cyr", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
      findings: [
        {
          severity: "HIGH",
          findingType: "GHOST_SCRIPT",
          filename: "layout/theme.liquid",
          lineNumber: 7,
          appName: "Klaviyo",
          description: "Привет мир",
          codeSnippet: '<script src="https://example.com/a.js"></script>',
        },
      ],
      exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders CJK content (degrade path) without throwing", async () => {
    const buffer = await renderScanReportPdf({
      scan: { id: "scan-cjk", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
      findings: [
        {
          severity: "MEDIUM",
          findingType: "GHOST_STYLE",
          filename: "assets/theme.css",
          lineNumber: 3,
          appName: null,
          description: "日本語テスト",
          codeSnippet: ".x { display: none; }",
        },
      ],
      exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("hasUnsupportedGlyphs", () => {
  it("returns true for glyphs outside Noto Sans coverage", () => {
    expect(hasUnsupportedGlyphs("日本語")).toBe(true);
    expect(hasUnsupportedGlyphs("مرحبا")).toBe(true);
    expect(hasUnsupportedGlyphs("😀")).toBe(true);
    expect(hasUnsupportedGlyphs("안녕")).toBe(true);
  });

  it("returns false for covered scripts (Latin-ext, Cyrillic, Greek, ASCII)", () => {
    expect(hasUnsupportedGlyphs("zażółć gęślą")).toBe(false);
    expect(hasUnsupportedGlyphs("Привет")).toBe(false);
    expect(hasUnsupportedGlyphs("Ελληνικά")).toBe(false);
    expect(hasUnsupportedGlyphs("plain ASCII")).toBe(false);
  });
});

// gc-j8xq: known malicious code is exported even when the merchant ignored it,
// and the PDF says so on that finding, so nobody wonders why it is back.
describe("ScanReportDocument: ignored malicious findings (gc-j8xq)", () => {
  const base = {
    scan: { id: "scan-xyz", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
    exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
  };
  const MALICIOUS = {
    ...FINDING,
    findingType: "MALICIOUS_SCRIPT",
    appName: null,
    description: "Loads from a known malicious source",
  };
  const MARKER = " · Ignored by you";

  it("marks an ignored malicious finding on its header line", () => {
    const text = reportText(
      ScanReportDocument({ ...base, findings: [{ ...MALICIOUS, ignoredByMerchant: true }] }),
    );
    expect(text).toContain("HIGH · MALICIOUS SCRIPT · Ignored by you\n");
    expect(text).toContain("1 finding\n");
    expect(text).toContain("1 High · 0 Medium · 0 Low");
    expect(text).not.toContain("No findings. This theme is clean.");
  });

  it("puts the marker only on the ignored malicious finding", () => {
    const text = reportText(
      ScanReportDocument({
        ...base,
        findings: [
          FINDING,
          MALICIOUS,
          { ...MALICIOUS, ignoredByMerchant: false },
          { ...MALICIOUS, ignoredByMerchant: true },
        ],
      }),
    );
    expect(text.split(MARKER)).toHaveLength(2);
    expect(text).toContain("HIGH · GHOST SCRIPT\n");
    expect(text).toContain("HIGH · MALICIOUS SCRIPT\n");
    expect(text).toContain(`HIGH · MALICIOUS SCRIPT${MARKER}\n`);
  });

  it("shows the clean line only when there is nothing at all to show", () => {
    expect(reportText(ScanReportDocument({ ...base, findings: [] }))).toContain(
      "No findings. This theme is clean.",
    );
    for (const findings of [[FINDING], [MALICIOUS], [{ ...MALICIOUS, ignoredByMerchant: true }]]) {
      const text = reportText(ScanReportDocument({ ...base, findings }));
      expect(text).not.toContain("This theme is clean");
      expect(text).not.toContain("0 findings");
    }
  });

  it("renders an ignored malicious finding to a valid PDF", async () => {
    const buffer = await renderScanReportPdf({
      ...base,
      findings: [{ ...MALICIOUS, severity: "HIGH", ignoredByMerchant: true }],
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  // gc-j8xq audit: the render cap (250) must never cut known malicious code
  // while other findings are shown, so it sorts first, before severity.
  describe("render cap", () => {
    const CAP = 250;
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...FINDING, filename: `sections/s${i}.liquid` }));
    const headers = (text: string) =>
      text.split("\n").filter((line) => /^(HIGH|MEDIUM|LOW) · /.test(line));

    it("keeps malicious findings that sort after more than the cap of other findings", () => {
      // 300 HIGH findings first in input order, then the malicious ones, one
      // of them a lower severity than everything ahead of it.
      const findings = [
        ...many(300),
        { ...MALICIOUS, filename: "snippets/bad-a.liquid" },
        { ...MALICIOUS, filename: "snippets/bad-b.liquid", severity: "MEDIUM" as const },
        { ...MALICIOUS, filename: "snippets/bad-c.liquid", ignoredByMerchant: true },
      ];
      const text = reportText(ScanReportDocument({ ...base, findings }));

      expect(text).toContain("snippets/bad-a.liquid:42");
      expect(text).toContain("snippets/bad-b.liquid:42");
      expect(text).toContain("snippets/bad-c.liquid:42");
      expect(text).toContain(`HIGH · MALICIOUS SCRIPT${MARKER}\n`);
      // The header, the severity summary and the overflow line still add up:
      // 303 found, 250 shown (3 malicious + 247 others), 53 more.
      expect(text).toContain("303 findings\n");
      expect(text).toContain("302 High · 1 Medium · 0 Low");
      expect(text).toContain(`+${303 - CAP} more findings.`);
      expect(text.split("HIGH · GHOST SCRIPT\n")).toHaveLength(CAP - 3 + 1);
    });

    it("lists malicious findings first, then everything else by severity as before", () => {
      const text = reportText(
        ScanReportDocument({
          ...base,
          findings: [
            { ...FINDING, severity: "LOW" as const },
            { ...FINDING, severity: "MEDIUM" as const },
            FINDING,
            { ...MALICIOUS, severity: "MEDIUM" as const },
            MALICIOUS,
          ],
        }),
      );
      expect(headers(text)).toEqual([
        "HIGH · MALICIOUS SCRIPT",
        "MEDIUM · MALICIOUS SCRIPT",
        "HIGH · GHOST SCRIPT",
        "MEDIUM · GHOST SCRIPT",
        "LOW · GHOST SCRIPT",
      ]);
    });
  });
});

describe("ScanReportDocument: homepage malicious hits (gc-3y89 #2)", () => {
  const base = {
    scan: { id: "scan-xyz", themeName: "Dawn", createdAt: new Date("2026-01-15T10:00:00Z") },
    exportedAt: new Date("2026-01-16T09:00:00Z").toISOString(),
  };

  it("names the place 'Your live homepage', never storefront/homepage:0", () => {
    const text = reportText(
      ScanReportDocument({
        ...base,
        findings: [
          {
            ...FINDING,
            findingType: "MALICIOUS_SCRIPT",
            filename: "storefront/homepage",
            lineNumber: 0,
            appName: null,
          },
        ],
      }),
    );
    expect(text).toContain("Your live homepage · App: —\n");
    expect(text).not.toContain("storefront/homepage");
  });

  it("keeps file:line for theme-file findings", () => {
    const text = reportText(ScanReportDocument({ ...base, findings: [FINDING] }));
    expect(text).toContain("layout/theme.liquid:42 · App: Klaviyo\n");
  });
});
