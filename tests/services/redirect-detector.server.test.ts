import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { detectOrphanedRedirects } from "../../app/services/redirect-detector.server";
import type { RedirectData } from "../../app/services/redirect-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedirect(overrides: Partial<RedirectData> = {}): RedirectData {
  return {
    id: "gid://shopify/UrlRedirect/1",
    path: "/old-page",
    target: "/new-page",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectOrphanedRedirects
// ---------------------------------------------------------------------------

describe("detectOrphanedRedirects", () => {
  it("detects Smart SEO redirect", () => {
    const redirects = [
      makeRedirect({ path: "/a/seo-redirect/old-product", target: "/products/new" }),
    ];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Smart SEO");
    expect(findings[0].findingType).toBe(FindingType.GHOST_REDIRECT);
  });

  it("detects Plug in SEO redirect", () => {
    const redirects = [makeRedirect({ path: "/a/pluginseo/old-url", target: "/new-url" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Plug in SEO");
  });

  it("detects Searchanise redirect", () => {
    const redirects = [makeRedirect({ path: "/a/searchanise/search", target: "/search" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Searchanise");
  });

  it("detects Boost Commerce redirect", () => {
    const redirects = [makeRedirect({ path: "/a/boost/filter", target: "/collections" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Boost Commerce");
  });

  it("ignores regular redirects", () => {
    const redirects = [makeRedirect({ path: "/old-product", target: "/new-product" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(0);
  });

  it("detects bulk redirect pattern (50+ under same prefix)", () => {
    const redirects: RedirectData[] = [];
    for (let i = 0; i < 55; i++) {
      redirects.push(
        makeRedirect({
          id: `gid://shopify/UrlRedirect/${i}`,
          path: `/collections/old-collection-${i}`,
          target: `/collections/new-collection-${i}`,
        }),
      );
    }
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("55 bulk redirects");
    expect(findings[0].appName).toBeUndefined();
  });

  it("skips small groups (below bulk threshold)", () => {
    const redirects: RedirectData[] = [];
    for (let i = 0; i < 10; i++) {
      redirects.push(
        makeRedirect({
          id: `gid://shopify/UrlRedirect/${i}`,
          path: `/collections/old-${i}`,
          target: `/collections/new-${i}`,
        }),
      );
    }
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(0);
  });

  it("detects multiple app patterns", () => {
    const redirects = [
      makeRedirect({ id: "1", path: "/a/seo-redirect/old", target: "/new" }),
      makeRedirect({ id: "2", path: "/a/pluginseo/old", target: "/new" }),
    ];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.appName).sort()).toEqual(["Plug in SEO", "Smart SEO"]);
  });

  it("returns no findings for empty redirects", () => {
    const findings = detectOrphanedRedirects([]);
    expect(findings).toHaveLength(0);
  });

  it("severity is MEDIUM", () => {
    const redirects = [makeRedirect({ path: "/a/seo-redirect/old", target: "/new" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("bulk finding has sample paths in snippet", () => {
    const redirects: RedirectData[] = [];
    for (let i = 0; i < 55; i++) {
      redirects.push(
        makeRedirect({
          id: `gid://shopify/UrlRedirect/${i}`,
          path: `/pages/old-page-${i}`,
          target: `/pages/new-page-${i}`,
        }),
      );
    }
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    // Should contain sample paths (first 3)
    expect(findings[0].codeSnippet).toContain("/pages/old-page-0");
    expect(findings[0].codeSnippet).toContain("/pages/old-page-1");
    expect(findings[0].codeSnippet).toContain("/pages/old-page-2");
  });

  it("bulk finding description includes count", () => {
    const redirects: RedirectData[] = [];
    for (let i = 0; i < 60; i++) {
      redirects.push(
        makeRedirect({
          id: `gid://shopify/UrlRedirect/${i}`,
          path: `/blogs/old-${i}`,
          target: `/blogs/new-${i}`,
        }),
      );
    }
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("60");
    expect(findings[0].description).toContain("bulk redirects");
  });

  it("does not double-count bulk groups that match app patterns", () => {
    const redirects: RedirectData[] = [];
    for (let i = 0; i < 55; i++) {
      redirects.push(
        makeRedirect({
          id: `gid://shopify/UrlRedirect/${i}`,
          path: `/a/seo-redirect/item-${i}`,
          target: `/products/item-${i}`,
        }),
      );
    }
    const findings = detectOrphanedRedirects(redirects);

    // Should have 55 individual app-matched findings but NO bulk finding
    const appFindings = findings.filter((f) => f.appName === "Smart SEO");
    const bulkFindings = findings.filter((f) => f.description.includes("bulk redirects"));
    expect(appFindings).toHaveLength(55);
    expect(bulkFindings).toHaveLength(0);
  });

  it("matches app pattern in target URL too", () => {
    const redirects = [makeRedirect({ path: "/old-page", target: "/a/seo-redirect/new" })];
    const findings = detectOrphanedRedirects(redirects);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Smart SEO");
  });
});
