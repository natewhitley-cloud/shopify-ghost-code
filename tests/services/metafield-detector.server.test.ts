import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { detectOrphanedMetafields } from "../../app/services/metafield-detector.server";
import type { ProductMetafieldData } from "../../app/services/product-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<ProductMetafieldData> = {}): ProductMetafieldData {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Product",
    metafields: [],
    ...overrides,
  };
}

function makeMetafield(overrides: Partial<ProductMetafieldData["metafields"][0]> = {}) {
  return {
    namespace: "judgeme",
    key: "review_count",
    value: "42",
    type: "number_integer",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectOrphanedMetafields
// ---------------------------------------------------------------------------

describe("detectOrphanedMetafields", () => {
  it("detects Judge.me metafield", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "judgeme", key: "review_count", value: "42" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].findingType).toBe(FindingType.GHOST_METAFIELD);
  });

  it("detects Stamped.io metafield", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "stamped", key: "rating", value: "4.5" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Stamped.io");
  });

  it("detects Yotpo metafield", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "yotpo", key: "reviews_count", value: "10" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Yotpo");
  });

  it("detects Bold metafield (bold_ prefix)", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "bold_product", key: "config", value: "{}" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Bold");
  });

  it("skips global namespace", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "global", key: "title_tag", value: "SEO Title" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toEqual([]);
  });

  it("skips custom namespace", () => {
    const products = [
      makeProduct({
        metafields: [
          makeMetafield({ namespace: "custom", key: "my_field", value: "custom value" }),
        ],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toEqual([]);
  });

  it("skips unrecognized namespace", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "random_ns", key: "something", value: "data" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toEqual([]);
  });

  it("deduplicates per app per product — 3 Judge.me metafields produce 1 finding", () => {
    const products = [
      makeProduct({
        metafields: [
          makeMetafield({ namespace: "judgeme", key: "review_count", value: "42" }),
          makeMetafield({ namespace: "judgeme", key: "average_rating", value: "4.8" }),
          makeMetafield({ namespace: "judgeme", key: "badge_text", value: "Excellent" }),
        ],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].description).toContain("3 metafield(s)");
  });

  it("multiple apps on same product produce separate findings", () => {
    const products = [
      makeProduct({
        metafields: [
          makeMetafield({ namespace: "judgeme", key: "review_count", value: "42" }),
          makeMetafield({ namespace: "yotpo", key: "rating", value: "4.5" }),
        ],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(2);
    const appNames = findings.map((f) => f.appName).sort();
    expect(appNames).toEqual(["Judge.me", "Yotpo"]);
  });

  it("detects across multiple products", () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/1",
        title: "Product A",
        metafields: [makeMetafield({ namespace: "judgeme", key: "review_count", value: "10" })],
      }),
      makeProduct({
        id: "gid://shopify/Product/2",
        title: "Product B",
        metafields: [makeMetafield({ namespace: "judgeme", key: "review_count", value: "20" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(2);
    expect(findings[0].description).toContain("Product A");
    expect(findings[1].description).toContain("Product B");
  });

  it("returns empty findings for products with empty metafields", () => {
    const products = [makeProduct({ metafields: [] })];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toEqual([]);
  });

  it("returns empty findings for empty products array", () => {
    const findings = detectOrphanedMetafields([]);

    expect(findings).toEqual([]);
  });

  it("assigns LOW severity", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "judgeme", key: "review_count", value: "42" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("shows up to 3 samples in snippet", () => {
    const products = [
      makeProduct({
        metafields: [
          makeMetafield({ namespace: "judgeme", key: "review_count", value: "42" }),
          makeMetafield({ namespace: "judgeme", key: "average_rating", value: "4.8" }),
          makeMetafield({ namespace: "judgeme", key: "badge_text", value: "Excellent" }),
          makeMetafield({ namespace: "judgeme", key: "extra_field", value: "should not appear" }),
        ],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings[0].codeSnippet).toContain("judgeme.review_count: 42");
    expect(findings[0].codeSnippet).toContain("judgeme.average_rating: 4.8");
    expect(findings[0].codeSnippet).toContain("judgeme.badge_text: Excellent");
    expect(findings[0].codeSnippet).not.toContain("extra_field");
  });

  it("uses products/{id}/metafields format for filename", () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/123",
        metafields: [makeMetafield({ namespace: "judgeme", key: "x", value: "y" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings[0].filename).toBe("products/gid://shopify/Product/123/metafields");
  });

  it("matches case-insensitively", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "JudgeMe", key: "review_count", value: "42" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("truncates long values in snippet at 50 chars", () => {
    const longValue = "a".repeat(100);
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "judgeme", key: "long_field", value: longValue })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    // The snippet should contain the first 50 chars of the value, not the full 100
    expect(findings[0].codeSnippet).toContain("judgeme.long_field: " + "a".repeat(50));
    expect(findings[0].codeSnippet).not.toContain("a".repeat(51));
  });

  it("sets lineNumber to 0", () => {
    const products = [
      makeProduct({
        metafields: [makeMetafield({ namespace: "judgeme", key: "x", value: "y" })],
      }),
    ];
    const findings = detectOrphanedMetafields(products);

    expect(findings[0].lineNumber).toBe(0);
  });

  it("all namespace patterns produce correct app names", () => {
    const testCases: Array<{ namespace: string; expectedApp: string }> = [
      { namespace: "judgeme", expectedApp: "Judge.me" },
      { namespace: "stamped", expectedApp: "Stamped.io" },
      { namespace: "yotpo", expectedApp: "Yotpo" },
      { namespace: "loox", expectedApp: "Loox" },
      { namespace: "bold_product", expectedApp: "Bold" },
      { namespace: "bold-options", expectedApp: "Bold" },
      { namespace: "recharge", expectedApp: "Recharge" },
      { namespace: "klaviyo", expectedApp: "Klaviyo" },
      { namespace: "privy", expectedApp: "Privy" },
      { namespace: "spr", expectedApp: "Shopify Product Reviews" },
      { namespace: "reviews", expectedApp: "Reviews App" },
      { namespace: "smartseo", expectedApp: "Smart SEO" },
      { namespace: "seo_data", expectedApp: "SEO App" },
      { namespace: "seo-tags", expectedApp: "SEO App" },
      { namespace: "loyalty_program", expectedApp: "Loyalty App" },
      { namespace: "smile", expectedApp: "Smile.io" },
      { namespace: "omnisend", expectedApp: "Omnisend" },
      { namespace: "pagefly", expectedApp: "PageFly" },
      { namespace: "shogun", expectedApp: "Shogun" },
      { namespace: "zipify", expectedApp: "Zipify" },
      { namespace: "aftership", expectedApp: "AfterShip" },
      { namespace: "returnly", expectedApp: "Returnly" },
    ];

    for (const { namespace, expectedApp } of testCases) {
      const products = [
        makeProduct({
          metafields: [makeMetafield({ namespace, key: "test", value: "val" })],
        }),
      ];
      const findings = detectOrphanedMetafields(products);

      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe(expectedApp);
    }
  });
});
