import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { detectPersistentDiscounts } from "../../app/services/price-detector.server";
import type { ProductPriceData } from "../../app/services/product-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVariant(
  overrides: Partial<ProductPriceData["variants"][0]> = {},
): ProductPriceData["variants"][0] {
  return {
    id: "gid://shopify/ProductVariant/1",
    title: "Default Title",
    price: "29.99",
    compareAtPrice: null,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ProductPriceData> = {}): ProductPriceData {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Product",
    variants: [makeVariant()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectPersistentDiscounts
// ---------------------------------------------------------------------------

describe("detectPersistentDiscounts", () => {
  it("detects product with compare-at pricing on 1 variant", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "19.99", compareAtPrice: "29.99" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PRICE);
  });

  it("shows up to 3 affected variants in snippet", () => {
    const products = [
      makeProduct({
        variants: [
          makeVariant({ id: "v1", title: "Small", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v2", title: "Medium", price: "15.00", compareAtPrice: "25.00" }),
          makeVariant({ id: "v3", title: "Large", price: "20.00", compareAtPrice: "30.00" }),
        ],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].codeSnippet).toContain("Small: $10.00 (was $20.00)");
    expect(findings[0].codeSnippet).toContain("Medium: $15.00 (was $25.00)");
    expect(findings[0].codeSnippet).toContain("Large: $20.00 (was $30.00)");
  });

  it("adds variant count note when more than 3 affected", () => {
    const products = [
      makeProduct({
        variants: [
          makeVariant({ id: "v1", title: "V1", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v2", title: "V2", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v3", title: "V3", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v4", title: "V4", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v5", title: "V5", price: "10.00", compareAtPrice: "20.00" }),
        ],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("showing 3 of 5");
    // Snippet should only have 3 lines
    expect(findings[0].codeSnippet.split("\n")).toHaveLength(3);
  });

  it("skips products where compareAtPrice is null", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "29.99", compareAtPrice: null })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("skips products where compareAtPrice <= price (price was raised)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "39.99", compareAtPrice: "29.99" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("emits one finding per product across multiple products", () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/1",
        title: "Product A",
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
      makeProduct({
        id: "gid://shopify/Product/2",
        title: "Product B",
        variants: [makeVariant({ price: "15.00", compareAtPrice: "25.00" })],
      }),
      makeProduct({
        id: "gid://shopify/Product/3",
        title: "Product C",
        variants: [makeVariant({ price: "20.00", compareAtPrice: "30.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(3);
    expect(findings[0].description).toContain("Product A");
    expect(findings[1].description).toContain("Product B");
    expect(findings[2].description).toContain("Product C");
  });

  it("returns empty array for empty products input", () => {
    const findings = detectPersistentDiscounts([]);

    expect(findings).toEqual([]);
  });

  it("assigns HIGH severity", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("sets appName to undefined (cannot attribute from price data)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings[0].appName).toBeUndefined();
  });

  it("uses products/{id} format for filename", () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/42",
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings[0].filename).toBe("products/gid://shopify/Product/42");
  });

  it("only counts affected variants, not all variants", () => {
    const products = [
      makeProduct({
        variants: [
          makeVariant({ id: "v1", title: "Affected", price: "10.00", compareAtPrice: "20.00" }),
          makeVariant({ id: "v2", title: "Normal", price: "15.00", compareAtPrice: null }),
          makeVariant({
            id: "v3",
            title: "Also Affected",
            price: "12.00",
            compareAtPrice: "18.00",
          }),
        ],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("2 variant(s)");
    // Snippet should show only affected variants
    expect(findings[0].codeSnippet).toContain("Affected");
    expect(findings[0].codeSnippet).toContain("Also Affected");
    expect(findings[0].codeSnippet).not.toContain("Normal");
  });

  it("does not flag when compareAtPrice equals price (no discount shown)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "29.99", compareAtPrice: "29.99" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("sets lineNumber to 0", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings[0].lineNumber).toBe(0);
  });
});
