/**
 * Unit tests for the live-price JSON-LD audit (gc-47c.10).
 *
 * Two layers:
 *   1. Pure comparison helpers (compareStaticToLive + normalizers) — the
 *      false-positive suppression gate. This is where Nathan's "do not regress
 *      gc-47c.8/.9" requirement is enforced.
 *   2. auditStaticJsonLdPrices with a mocked admin.graphql — identity
 *      resolution, ambiguity handling, and the lookup budget.
 */

import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect, vi } from "vitest";

import { logger } from "../../app/lib/logger.server";
import {
  auditStaticJsonLdPrices,
  compareStaticToLive,
  mapStaticAvailability,
  parsePriceToCents,
  STATIC_JSONLD_PRICE_DESC_PREFIX,
  type ResolvedLiveProduct,
} from "../../app/services/jsonld-price-audit.server";
import type { StaticProductCandidate } from "../../app/services/scan-engine.server";
import type { AdminApiContext } from "../../app/types/shopify";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candidate(overrides?: Partial<StaticProductCandidate>): StaticProductCandidate {
  return {
    filename: "sections/product.liquid",
    lineNumber: 3,
    codeSnippet: '<script type="application/ld+json">{"@type":"Product"}</script>',
    handle: "widget",
    staticPrice: "19.99",
    staticPriceCurrency: "USD",
    ...overrides,
  };
}

function live(overrides?: Partial<ResolvedLiveProduct>): ResolvedLiveProduct {
  return {
    currencyCode: "USD",
    variants: [{ price: "29.99", compareAtPrice: null, availableForSale: true }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure normalizers
// ---------------------------------------------------------------------------

describe("parsePriceToCents", () => {
  it("normalizes number-string and formatting to cents", () => {
    expect(parsePriceToCents("19.99")).toBe(1999);
    expect(parsePriceToCents("19.990")).toBe(1999);
    expect(parsePriceToCents("20")).toBe(2000);
  });

  it("returns null for non-numeric or empty", () => {
    expect(parsePriceToCents("$19.99")).toBeNull();
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents(undefined)).toBeNull();
    expect(parsePriceToCents(null)).toBeNull();
  });
});

describe("mapStaticAvailability", () => {
  it("maps clear in/out values", () => {
    expect(mapStaticAvailability("InStock")).toBe(true);
    expect(mapStaticAvailability("https://schema.org/OutOfStock")).toBe(false);
    expect(mapStaticAvailability("SoldOut")).toBe(false);
  });

  it("returns null for ambiguous or missing values", () => {
    expect(mapStaticAvailability("LimitedAvailability")).toBeNull();
    expect(mapStaticAvailability("PreOrder")).toBeNull();
    expect(mapStaticAvailability(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareStaticToLive — the FP suppression gate
// ---------------------------------------------------------------------------

describe("compareStaticToLive — price mismatch", () => {
  it("flags a material price mismatch (happy path)", () => {
    const finding = compareStaticToLive(candidate({ staticPrice: "19.99" }), live());
    expect(finding).not.toBeNull();
    expect(finding!.findingType).toBe(FindingType.JSON_LD_PRICE_CONFLICT);
    expect(finding!.severity).toBe(Severity.HIGH);
    expect(finding!.appName).toBeUndefined();
    expect(finding!.description).toContain("19.99");
    expect(finding!.description).toContain("29.99");
    expect(finding!.description.startsWith(STATIC_JSONLD_PRICE_DESC_PREFIX)).toBe(true);
  });

  it("suppresses number-vs-string / rounding equality", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "29.990" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: true }] }),
    );
    expect(finding).toBeNull();
  });

  it("suppresses when static price equals a live variant price", () => {
    expect(compareStaticToLive(candidate({ staticPrice: "29.99" }), live())).toBeNull();
  });

  it("suppresses when static price equals the live compareAtPrice (intentional sale)", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "39.99" }),
      live({ variants: [{ price: "29.99", compareAtPrice: "39.99", availableForSale: true }] }),
    );
    expect(finding).toBeNull();
  });

  it("suppresses on currency mismatch", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "19.99", staticPriceCurrency: "EUR" }),
      live({ currencyCode: "USD" }),
    );
    expect(finding).toBeNull();
  });

  it("still compares when the static block omits a currency", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "19.99", staticPriceCurrency: undefined }),
      live(),
    );
    expect(finding).not.toBeNull();
  });

  it("does not flag a multi-variant product when static matches ANY variant", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "24.99" }),
      live({
        variants: [
          { price: "29.99", compareAtPrice: null, availableForSale: true },
          { price: "24.99", compareAtPrice: null, availableForSale: true },
        ],
      }),
    );
    expect(finding).toBeNull();
  });

  it("flags a multi-variant product when static matches NO variant", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "9.99" }),
      live({
        variants: [
          { price: "29.99", compareAtPrice: null, availableForSale: true },
          { price: "24.99", compareAtPrice: null, availableForSale: true },
        ],
      }),
    );
    expect(finding).not.toBeNull();
  });

  it("does not flag when the static price is non-numeric", () => {
    expect(compareStaticToLive(candidate({ staticPrice: "call for price" }), live())).toBeNull();
  });
});

describe("compareStaticToLive — availability contradiction", () => {
  it("flags in-stock static vs out-of-stock live", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "InStock" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: false }] }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.description).toContain("out of stock");
  });

  it("flags out-of-stock static vs in-stock live", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "OutOfStock" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: true }] }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.description).toContain("in stock");
  });

  it("does not flag when availability agrees", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "InStock" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: true }] }),
    );
    expect(finding).toBeNull();
  });

  it("does not flag ambiguous availability values", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "LimitedAvailability" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: false }] }),
    );
    expect(finding).toBeNull();
  });

  it("prefers a price finding over an availability finding", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: "19.99", staticAvailability: "OutOfStock" }),
      live({ variants: [{ price: "29.99", compareAtPrice: null, availableForSale: true }] }),
    );
    expect(finding!.description).toContain("price");
  });

  it("treats a multi-variant product as in stock when ANY variant is available", () => {
    // static OutOfStock vs a product where one of several variants is in stock:
    // availableForSale.some() -> live is in stock -> contradiction -> finding.
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "OutOfStock" }),
      live({
        variants: [
          { price: "29.99", compareAtPrice: null, availableForSale: false },
          { price: "24.99", compareAtPrice: null, availableForSale: true },
        ],
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.description).toContain("in stock");
  });

  it("does not flag when static is in stock and any variant is available", () => {
    const finding = compareStaticToLive(
      candidate({ staticPrice: undefined, staticAvailability: "InStock" }),
      live({
        variants: [
          { price: "29.99", compareAtPrice: null, availableForSale: false },
          { price: "24.99", compareAtPrice: null, availableForSale: true },
        ],
      }),
    );
    expect(finding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// auditStaticJsonLdPrices — resolution against a mocked admin
// ---------------------------------------------------------------------------

/**
 * Build a mock admin whose graphql() dispatches by query name. Each handler
 * returns the `{ json: () => ... }` envelope the real client produces.
 */
function mockAdmin(handlers: {
  currency?: string;
  byHandle?: (query: string) => unknown;
  bySku?: (query: string) => unknown;
}): { admin: AdminApiContext; graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    let data: unknown;
    if (query.includes("shop {")) {
      data = { shop: { currencyCode: handlers.currency ?? "USD" } };
    } else if (query.includes("ProductByHandle")) {
      data = handlers.byHandle?.((opts?.variables?.query as string) ?? "") ?? {
        products: { nodes: [] },
      };
    } else if (query.includes("VariantBySku")) {
      data = handlers.bySku?.((opts?.variables?.query as string) ?? "") ?? {
        productVariants: { nodes: [] },
      };
    }
    return { json: async () => ({ data }) };
  });
  return { admin: { graphql } as unknown as AdminApiContext, graphql };
}

function productByHandleResponse(
  variants: Array<{ price: string; compareAtPrice: string | null; availableForSale: boolean }>,
  hasNextPage = false,
) {
  return { products: { nodes: [{ variants: { nodes: variants, pageInfo: { hasNextPage } } }] } };
}

const SHOP_ID = "shop_1";

describe("auditStaticJsonLdPrices", () => {
  it("returns no findings and not-skipped for no candidates without querying", async () => {
    const { admin, graphql } = mockAdmin({});
    expect(await auditStaticJsonLdPrices(admin, [], SHOP_ID)).toEqual({
      findings: [],
      skipped: false,
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it("flags a handle-resolved product with a stale price", async () => {
    const { admin } = mockAdmin({
      byHandle: () =>
        productByHandleResponse([{ price: "29.99", compareAtPrice: null, availableForSale: true }]),
    });
    const { findings, skipped } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "widget", sku: undefined, staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("29.99");
    expect(skipped).toBe(false);
  });

  it("resolves by sku (preferred over handle) and compares that variant", async () => {
    const bySku = vi.fn(() => ({
      productVariants: {
        nodes: [{ price: "29.99", compareAtPrice: null, availableForSale: true }],
      },
    }));
    const { admin } = mockAdmin({ bySku });
    const { findings } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "widget", sku: "SKU-1", staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(1);
    expect(bySku).toHaveBeenCalledTimes(1);
  });

  it("skips an ambiguous sku (more than one matching variant)", async () => {
    const { admin } = mockAdmin({
      bySku: () => ({
        productVariants: {
          nodes: [
            { price: "29.99", compareAtPrice: null, availableForSale: true },
            { price: "24.99", compareAtPrice: null, availableForSale: true },
          ],
        },
      }),
    });
    const { findings } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ sku: "DUP", handle: "widget", staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(0);
  });

  it("skips an unresolvable handle", async () => {
    const { admin } = mockAdmin({ byHandle: () => ({ products: { nodes: [] } }) });
    const { findings } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "missing", sku: undefined, staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(0);
  });

  it("skips a product whose variants overflow the first page (>100 variants)", async () => {
    const { admin } = mockAdmin({
      byHandle: () =>
        productByHandleResponse(
          [{ price: "29.99", compareAtPrice: null, availableForSale: true }],
          /* hasNextPage */ true,
        ),
    });
    const { findings } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "huge", sku: undefined, staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(0);
  });

  it("caches identical handles so a repeated identity is queried once", async () => {
    const byHandle = vi.fn(() =>
      productByHandleResponse([{ price: "29.99", compareAtPrice: null, availableForSale: true }]),
    );
    const { admin } = mockAdmin({ byHandle });
    const { findings } = await auditStaticJsonLdPrices(
      admin,
      [
        candidate({ handle: "widget", sku: undefined, staticPrice: "19.99", lineNumber: 1 }),
        candidate({ handle: "widget", sku: undefined, staticPrice: "19.99", lineNumber: 2 }),
      ],
      SHOP_ID,
    );
    expect(findings).toHaveLength(2);
    expect(byHandle).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // FIX 2 — THROTTLED resilience: a single lookup that throttles once then
  // succeeds must retry the SAME lookup, not fail the whole audit.
  // -------------------------------------------------------------------------
  it("backs off and retries a single lookup that returns THROTTLED then succeeds", async () => {
    let handleCalls = 0;
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("shop {")) {
        return { json: async () => ({ data: { shop: { currencyCode: "USD" } } }) };
      }
      // ProductByHandle: throttle the first attempt, succeed on the retry.
      handleCalls += 1;
      if (handleCalls === 1) {
        return { json: async () => ({ errors: [{ extensions: { code: "THROTTLED" } }] }) };
      }
      return {
        json: async () => ({
          data: productByHandleResponse([
            { price: "29.99", compareAtPrice: null, availableForSale: true },
          ]),
        }),
      };
    });
    const admin = { graphql } as unknown as AdminApiContext;

    const { findings, skipped } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "widget", sku: undefined, staticPrice: "19.99" })],
      SHOP_ID,
    );

    expect(handleCalls).toBe(2); // throttled once, retried once
    expect(findings).toHaveLength(1);
    expect(skipped).toBe(false);
  });

  // -------------------------------------------------------------------------
  // FIX 2 (error path) — a non-throttle, non-access-denied GraphQL error
  // propagates so the Inngest step retries the whole step.
  // -------------------------------------------------------------------------
  it("throws on an unexpected GraphQL error (surfaced to the step for retry)", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("shop {")) {
        return { json: async () => ({ data: { shop: { currencyCode: "USD" } } }) };
      }
      return { json: async () => ({ errors: [{ message: "Internal error" }] }) };
    });
    const admin = { graphql } as unknown as AdminApiContext;

    await expect(
      auditStaticJsonLdPrices(
        admin,
        [candidate({ handle: "widget", sku: undefined, staticPrice: "19.99" })],
        SHOP_ID,
      ),
    ).rejects.toThrow(/Internal error/);
  });

  // -------------------------------------------------------------------------
  // Nice-to-have — read_products revoked mid-scan returns a clean skip rather
  // than throwing, so the category lands in skippedCategories.
  // -------------------------------------------------------------------------
  it("returns skipped when read_products is revoked mid-scan (ACCESS_DENIED)", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("shop {")) {
        return { json: async () => ({ data: { shop: { currencyCode: "USD" } } }) };
      }
      return { json: async () => ({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }) };
    });
    const admin = { graphql } as unknown as AdminApiContext;

    const { findings, skipped } = await auditStaticJsonLdPrices(
      admin,
      [candidate({ handle: "widget", sku: undefined, staticPrice: "19.99" })],
      SHOP_ID,
    );
    expect(findings).toHaveLength(0);
    expect(skipped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // FIX 3 — the MAX_LOOKUPS cap: past the budget, extra candidates go
  // unresolved (never false-resolved), the audit warns, and reports skipped.
  // -------------------------------------------------------------------------
  it("warns and reports skipped when the lookup cap truncates the candidate list", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Each distinct handle resolves to a matching price (no finding), so the
    // only observable effect is the cap: 60 distinct handles > MAX_LOOKUPS (50).
    const { admin } = mockAdmin({
      byHandle: () =>
        productByHandleResponse([{ price: "19.99", compareAtPrice: null, availableForSale: true }]),
    });
    const many = Array.from({ length: 60 }, (_, i) =>
      candidate({ handle: `h-${i}`, sku: undefined, staticPrice: "19.99", lineNumber: i }),
    );

    const { skipped } = await auditStaticJsonLdPrices(admin, many, SHOP_ID);

    expect(skipped).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("lookup cap"),
      expect.objectContaining({ shopId: SHOP_ID, dropped: 10 }),
    );
    warnSpy.mockRestore();
  });
});
