import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import type { ProductTagData } from "../../app/services/product-fetcher.server";
import { detectOrphanedProductTags } from "../../app/services/product-tag-detector.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<ProductTagData> = {}): ProductTagData {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Product",
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectOrphanedProductTags
// ---------------------------------------------------------------------------

describe("detectOrphanedProductTags", () => {
  it("detects Bold tag (__bold prefix)", () => {
    const products = [makeProduct({ tags: ["__bold_variant"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Bold");
    expect(findings[0].findingType).toBe(FindingType.GHOST_TAG);
  });

  it("detects Smile.io loyalty tag", () => {
    const products = [makeProduct({ tags: ["loyalty-member"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Smile.io");
  });

  it("detects Recharge tag", () => {
    const products = [makeProduct({ tags: ["recharge-subscription"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Recharge");
  });

  it("detects Klaviyo tag", () => {
    const products = [makeProduct({ tags: ["klaviyo-subscribed"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
  });

  it("detects Judge.me tag", () => {
    const products = [makeProduct({ tags: ["judgeme-reviewed"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("ignores unrecognized tags", () => {
    const products = [makeProduct({ tags: ["sale", "new-arrival", "summer-2024"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toEqual([]);
  });

  it("detects multiple tags from different apps on same product", () => {
    const products = [makeProduct({ tags: ["__bold_x", "recharge-y"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(2);
    expect(findings[0].appName).toBe("Bold");
    expect(findings[1].appName).toBe("Recharge");
  });

  it("detects tags across multiple products", () => {
    const products = [
      makeProduct({ id: "gid://shopify/Product/1", title: "Product A", tags: ["__bold_a"] }),
      makeProduct({ id: "gid://shopify/Product/2", title: "Product B", tags: ["__bold_b"] }),
    ];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(2);
    expect(findings[0].description).toContain("Product A");
    expect(findings[1].description).toContain("Product B");
  });

  it("returns empty findings for empty tags array", () => {
    const products = [makeProduct({ tags: [] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toEqual([]);
  });

  it("returns empty findings for empty products array", () => {
    const findings = detectOrphanedProductTags([]);

    expect(findings).toEqual([]);
  });

  it("assigns LOW severity by default", () => {
    const products = [makeProduct({ tags: ["__bold_variant"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("uses products/{id} format for filename", () => {
    const products = [makeProduct({ id: "gid://shopify/Product/123", tags: ["recharge-sub"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings[0].filename).toBe("products/gid://shopify/Product/123");
  });

  it("includes product title and tag in description", () => {
    const products = [makeProduct({ title: "Cool Shirt", tags: ["recharge-subscription"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings[0].description).toContain("Cool Shirt");
    expect(findings[0].description).toContain("recharge-subscription");
    expect(findings[0].description).toContain("Recharge");
  });

  it("matches case-insensitively", () => {
    const products = [makeProduct({ tags: ["__BOLD_variant"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Bold");
  });

  it("all 20 patterns produce correct app names", () => {
    const testCases: Array<{ tag: string; expectedApp: string }> = [
      { tag: "__bold_variant", expectedApp: "Bold" },
      { tag: "bold-product", expectedApp: "Bold" },
      { tag: "loyalty-member", expectedApp: "Smile.io" },
      { tag: "smile-rewards", expectedApp: "Smile.io" },
      { tag: "recharge-sub", expectedApp: "Recharge" },
      { tag: "yotpo-review", expectedApp: "Yotpo" },
      { tag: "stamped-review", expectedApp: "Stamped.io" },
      { tag: "loox-review", expectedApp: "Loox" },
      { tag: "omnisend-segment", expectedApp: "Omnisend" },
      { tag: "privy-popup", expectedApp: "Privy" },
      { tag: "klaviyo-list", expectedApp: "Klaviyo" },
      { tag: "judgeme-badge", expectedApp: "Judge.me" },
      { tag: "shopify-flow-tag", expectedApp: "Shopify Flow" },
      { tag: "zipify-page", expectedApp: "Zipify" },
      { tag: "oberlo-import", expectedApp: "Oberlo" },
      { tag: "dsers-product", expectedApp: "DSers" },
      { tag: "spocket-sync", expectedApp: "Spocket" },
      { tag: "returnly-eligible", expectedApp: "Returnly" },
      { tag: "aftership-tracked", expectedApp: "AfterShip" },
      { tag: "back-in-stock", expectedApp: "Back in Stock" },
    ];

    for (const { tag, expectedApp } of testCases) {
      const products = [makeProduct({ tags: [tag] })];
      const findings = detectOrphanedProductTags(products);

      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe(expectedApp);
    }
  });

  it("sets lineNumber to 0", () => {
    const products = [makeProduct({ tags: ["__bold_x"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings[0].lineNumber).toBe(0);
  });

  it("includes product title and tag in codeSnippet", () => {
    const products = [makeProduct({ title: "Fancy Widget", tags: ["recharge-active"] })];
    const findings = detectOrphanedProductTags(products);

    expect(findings[0].codeSnippet).toContain("Product: Fancy Widget");
    expect(findings[0].codeSnippet).toContain("Tag: recharge-active");
  });
});
