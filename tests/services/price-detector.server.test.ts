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

// Bold Discounts' canonical orphan marker: activating a sale writes
// `inventory.ShappifySale` and is left behind when the app is uninstalled.
const BOLD_EVIDENCE: ProductPriceData["metafields"] = [
  { namespace: "inventory", key: "ShappifySale" },
];

function makeProduct(overrides: Partial<ProductPriceData> = {}): ProductPriceData {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Product",
    variants: [makeVariant()],
    // Default to orphan evidence present so pricing-shape tests stay focused on
    // the variant logic; tests covering the "no evidence" path override this.
    metafields: BOLD_EVIDENCE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectPersistentDiscounts
// ---------------------------------------------------------------------------

describe("detectPersistentDiscounts", () => {
  // -------------------------------------------------------------------------
  // Orphan-evidence gating (LOG-2): the core behavior change.
  // -------------------------------------------------------------------------

  it("does NOT flag a normal active sale with no orphan evidence", () => {
    // Compare-at set and greater than price — a legitimate, running sale — but
    // no leftover discount-app metafield. This must not be flagged.
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "19.99", compareAtPrice: "29.99" })],
        metafields: [],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("does NOT flag when only unrelated (non-pricing) app metafields exist", () => {
    // A reviews-app metafield says nothing about pricing, so it is not orphan
    // corroboration for a compare-at price.
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "19.99", compareAtPrice: "29.99" })],
        metafields: [{ namespace: "judgeme", key: "review_count" }],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("flags a persistent discount corroborated by a Bold Discounts metafield", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "19.99", compareAtPrice: "29.99" })],
        metafields: BOLD_EVIDENCE,
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PRICE);
    expect(findings[0].appName).toBe("Bold Discounts");
    expect(findings[0].description).toContain("Bold Discounts");
    expect(findings[0].description).toContain("inventory.ShappifySale");
  });

  it("flags via Bold's branded namespace even without a key match", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
        metafields: [{ namespace: "shappify", key: "anything" }],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Bold Discounts");
  });

  it("does NOT flag when the inventory namespace key is not the Bold marker", () => {
    // `inventory` is a generic namespace — only the Bold-specific key corroborates.
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "19.99", compareAtPrice: "29.99" })],
        metafields: [{ namespace: "inventory", key: "warehouse_location" }],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Pricing-shape logic (evidence present in all of the following).
  // -------------------------------------------------------------------------

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

  it("skips products where compareAtPrice is null (even with orphan evidence)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "29.99", compareAtPrice: null })],
        metafields: BOLD_EVIDENCE,
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("skips products where compareAtPrice <= price (price was raised)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "39.99", compareAtPrice: "29.99" })],
        metafields: BOLD_EVIDENCE,
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toEqual([]);
  });

  it("does not flag when compareAtPrice equals price (no discount shown)", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "29.99", compareAtPrice: "29.99" })],
        metafields: BOLD_EVIDENCE,
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

  it("flags only the corroborated products in a mixed batch", () => {
    // A real store: one product is an orphaned Bold discount, the other is a
    // legitimate merchant sale. Only the first should be flagged.
    const products = [
      makeProduct({
        id: "gid://shopify/Product/1",
        title: "Orphaned",
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
        metafields: BOLD_EVIDENCE,
      }),
      makeProduct({
        id: "gid://shopify/Product/2",
        title: "Legit Sale",
        variants: [makeVariant({ price: "15.00", compareAtPrice: "25.00" })],
        metafields: [],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Orphaned");
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

  it("attributes the finding to the corroborating app", () => {
    const products = [
      makeProduct({
        variants: [makeVariant({ price: "10.00", compareAtPrice: "20.00" })],
      }),
    ];
    const findings = detectPersistentDiscounts(products);

    expect(findings[0].appName).toBe("Bold Discounts");
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
