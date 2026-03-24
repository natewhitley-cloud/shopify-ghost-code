import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import type { PageData } from "../../app/services/content-fetcher.server";
import { detectOrphanedPages } from "../../app/services/page-detector.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    id: "gid://shopify/Page/1",
    title: "Test Page",
    handle: "test-page",
    body: "<p>Some content here</p>",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectOrphanedPages
// ---------------------------------------------------------------------------

describe("detectOrphanedPages", () => {
  it("detects PageFly page", () => {
    const pages = [makePage({ handle: "pagefly-landing", title: "Landing Page" })];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[0].findingType).toBe(FindingType.GHOST_PAGE);
  });

  it("detects GemPages page", () => {
    const pages = [makePage({ handle: "gempages-home", title: "Home" })];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("GemPages");
  });

  it("detects Shogun page", () => {
    const pages = [makePage({ handle: "shogun-landing", title: "Shogun Landing" })];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Shogun");
  });

  it("detects Privy page", () => {
    const pages = [makePage({ handle: "privy-popup", title: "Privy Page" })];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Privy");
  });

  it("ignores regular pages", () => {
    const pages = [
      makePage({ handle: "about-us", title: "About Us" }),
      makePage({ handle: "contact", title: "Contact" }),
      makePage({ handle: "faq", title: "FAQ" }),
    ];
    const findings = detectOrphanedPages(pages);

    expect(findings).toEqual([]);
  });

  it("detects multiple app pages", () => {
    const pages = [
      makePage({ handle: "pagefly-landing", title: "PF Landing" }),
      makePage({ handle: "klaviyo-signup", title: "Klaviyo Signup" }),
    ];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(2);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[1].appName).toBe("Klaviyo");
  });

  it("returns empty findings for empty pages array", () => {
    const findings = detectOrphanedPages([]);

    expect(findings).toEqual([]);
  });

  it("assigns MEDIUM severity", () => {
    const pages = [makePage({ handle: "pagefly-test" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("sets appName correctly", () => {
    const pages = [makePage({ handle: "bold-page" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].appName).toBe("Bold");
  });

  it("uses pages/{handle} format for filename", () => {
    const pages = [makePage({ handle: "pagefly-landing" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].filename).toBe("pages/pagefly-landing");
  });

  it("strips HTML from body preview in snippet", () => {
    const pages = [
      makePage({
        handle: "pagefly-test",
        body: "<h1>Hello</h1><p>World</p>",
      }),
    ];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].codeSnippet).toContain("Content: HelloWorld");
    expect(findings[0].codeSnippet).not.toContain("<h1>");
    expect(findings[0].codeSnippet).not.toContain("<p>");
  });

  it("shows (empty page) for pages with no body", () => {
    const pages = [makePage({ handle: "pagefly-test", body: "" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].codeSnippet).toContain("(empty page)");
  });

  it("truncates codeSnippet to 300 characters", () => {
    const longBody = "x".repeat(400);
    const pages = [makePage({ handle: "pagefly-test", body: longBody })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].codeSnippet.length).toBeLessThanOrEqual(300);
  });

  it("matches handles case-insensitively", () => {
    const pages = [makePage({ handle: "PageFly-landing" })];
    const findings = detectOrphanedPages(pages);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
  });

  it("sets lineNumber to 0", () => {
    const pages = [makePage({ handle: "pagefly-test" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].lineNumber).toBe(0);
  });

  it("includes page title and handle in description", () => {
    const pages = [makePage({ handle: "pagefly-landing", title: "My Landing Page" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].description).toContain("My Landing Page");
    expect(findings[0].description).toContain("/pagefly-landing");
    expect(findings[0].description).toContain("PageFly");
  });

  it("all 20 patterns produce correct app names", () => {
    const testCases: Array<{ handle: string; expectedApp: string }> = [
      { handle: "pagefly-landing", expectedApp: "PageFly" },
      { handle: "gempages-home", expectedApp: "GemPages" },
      { handle: "shogun-page", expectedApp: "Shogun" },
      { handle: "zipify-funnel", expectedApp: "Zipify Pages" },
      { handle: "privy-popup", expectedApp: "Privy" },
      { handle: "klaviyo-signup", expectedApp: "Klaviyo" },
      { handle: "omnisend-form", expectedApp: "Omnisend" },
      { handle: "stamped-reviews", expectedApp: "Stamped.io" },
      { handle: "yotpo-reviews", expectedApp: "Yotpo" },
      { handle: "judgeme-reviews", expectedApp: "Judge.me" },
      { handle: "loox-gallery", expectedApp: "Loox" },
      { handle: "trustoo-reviews", expectedApp: "Trustoo" },
      { handle: "vitals-page", expectedApp: "Vitals" },
      { handle: "recharge-portal", expectedApp: "Recharge" },
      { handle: "bold-page", expectedApp: "Bold" },
      { handle: "ecomsolid-home", expectedApp: "EComSolid" },
      { handle: "reconvert-thanks", expectedApp: "ReConvert" },
      { handle: "aftership-tracking", expectedApp: "AfterShip" },
      { handle: "trackingmore-page", expectedApp: "TrackingMore" },
      { handle: "returnly-returns", expectedApp: "Returnly" },
    ];

    for (const { handle, expectedApp } of testCases) {
      const pages = [makePage({ handle })];
      const findings = detectOrphanedPages(pages);

      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe(expectedApp);
    }
  });

  it("includes page title in codeSnippet", () => {
    const pages = [makePage({ handle: "pagefly-test", title: "Fancy Landing" })];
    const findings = detectOrphanedPages(pages);

    expect(findings[0].codeSnippet).toContain("Page: Fancy Landing");
    expect(findings[0].codeSnippet).toContain("Handle: /pagefly-test");
  });
});
