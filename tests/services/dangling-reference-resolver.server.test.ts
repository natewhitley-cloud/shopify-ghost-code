/**
 * Unit tests for the Admin-API dangling-reference resolver (gc-m4h.4).
 *
 * The resolver takes the extractor's distinct (entityType, handle) candidates and
 * decides which handles NO LONGER EXIST in the shop's Admin. These tests exercise
 * it against a mocked `admin.graphql` (mirroring the content-fetcher and
 * jsonld-price-audit test mocks): the mock dispatches by query name and returns
 * the `{ json: () => ... }` envelope the real client produces.
 *
 * Coverage: exact-handle-match guard (fuzzy search near-match => missing), scope
 * gating (absent scope => type skipped, nothing missing, scopeStatus reflects it),
 * MAX_LOOKUPS truncation, THROTTLED retry + unexpected-error propagation,
 * mid-scan scope revocation, and page Set membership both ways.
 */

import { describe, it, expect, vi } from "vitest";

import { logger } from "../../app/lib/logger.server";
import type { DistinctDanglingHandle } from "../../app/services/dangling-reference-extractor.server";
import { resolveDanglingReferences } from "../../app/services/dangling-reference-resolver.server";
import type { AdminApiContext } from "../../app/types/shopify";

const SHOP_ID = "shop_1";

// ---------------------------------------------------------------------------
// Mock admin
// ---------------------------------------------------------------------------

/** Wrap data/errors in the `{ json: () => ... }` envelope the real client returns. */
function envelope(data: unknown, errors?: unknown[]) {
  return { json: async () => (errors ? { errors } : { data }) };
}

/** Pull the searched handle out of a `handle:"x"` search variable. */
function handleFromVars(options?: { variables?: Record<string, unknown> }): string {
  const q = (options?.variables?.query as string) ?? "";
  return /handle:"(.*)"/.exec(q)?.[1] ?? "";
}

/**
 * Build a mock admin whose graphql() dispatches by query. `product` / `collection`
 * map a queried handle to the nodes the Admin search returns (default: none, i.e.
 * the handle is missing). `pages` is the full set of existing page handles.
 */
function makeAdmin(
  opts: {
    productScope?: boolean;
    contentScope?: boolean;
    product?: (handle: string) => Array<{ handle: string }>;
    collection?: (handle: string) => Array<{ handle: string }>;
    /** Custom per-handle page node resolver (mirrors `product`/`collection`). */
    page?: (handle: string) => Array<{ handle: string }>;
    /** Convenience: the set of existing page handles (exact-match membership). */
    pages?: string[];
  } = {},
): { admin: AdminApiContext; graphql: ReturnType<typeof vi.fn> } {
  const productScope = opts.productScope ?? true;
  const contentScope = opts.contentScope ?? true;

  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      if (query.includes("ProductExistsByHandle")) {
        const nodes = opts.product ? opts.product(handleFromVars(options)) : [];
        return envelope({ products: { nodes } });
      }
      if (query.includes("CollectionExistsByHandle")) {
        const nodes = opts.collection ? opts.collection(handleFromVars(options)) : [];
        return envelope({ collections: { nodes } });
      }
      if (query.includes("PageExistsByHandle")) {
        const h = handleFromVars(options);
        const nodes = opts.page
          ? opts.page(h)
          : (opts.pages ?? []).includes(h)
            ? [{ handle: h }]
            : [];
        return envelope({ pages: { nodes } });
      }
      // Scope probes ({ products(first: 1) ... } / { pages(first: 1) ... }).
      if (query.includes("products(first: 1)")) {
        return productScope
          ? envelope({ products: { nodes: [{ id: "1" }] } })
          : envelope(null, [{ message: "Access denied" }]);
      }
      if (query.includes("pages(first: 1)")) {
        return contentScope
          ? envelope({ pages: { nodes: [{ id: "1" }] } })
          : envelope(null, [{ message: "Access denied" }]);
      }
      throw new Error(`unexpected query: ${query}`);
    },
  );

  return { admin: { graphql } as unknown as AdminApiContext, graphql };
}

/** A product handler that treats `existing` as the only products that exist. */
function existingProducts(...existing: string[]) {
  return (handle: string) => (existing.includes(handle) ? [{ handle }] : []);
}

function distinct(
  entityType: DistinctDanglingHandle["entityType"],
  handle: string,
): DistinctDanglingHandle {
  return { entityType, handle };
}

// ---------------------------------------------------------------------------
// Empty / no-op
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — empty input", () => {
  it("returns nothing missing, both scopes checked, and never queries", async () => {
    const { admin, graphql } = makeAdmin();
    const result = await resolveDanglingReferences(admin, [], SHOP_ID);
    expect(result).toEqual({
      missing: [],
      scopeStatus: { products: "checked", content: "checked" },
      truncated: false,
    });
    expect(graphql).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Product / collection existence
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — product & collection existence", () => {
  it("does not report a product whose exact handle exists", async () => {
    const { admin } = makeAdmin({ product: existingProducts("widget") });
    const result = await resolveDanglingReferences(admin, [distinct("product", "widget")], SHOP_ID);
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.products).toBe("checked");
    expect(result.truncated).toBe(false);
  });

  it("reports a product whose handle is absent", async () => {
    const { admin } = makeAdmin({ product: existingProducts() });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("product", "old-widget")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([{ entityType: "product", handle: "old-widget" }]);
  });

  it("does not report a collection whose exact handle exists", async () => {
    const { admin } = makeAdmin({
      collection: (h) => (h === "summer-sale" ? [{ handle: h }] : []),
    });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("collection", "summer-sale")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([]);
  });

  it("reports a collection whose handle is absent", async () => {
    const { admin } = makeAdmin({ collection: () => [] });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("collection", "winter-sale")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([{ entityType: "collection", handle: "winter-sale" }]);
  });

  // Exact-handle-match guard: the search can be fuzzy, so a near-match that does
  // not equal the queried handle must be treated as MISSING.
  it("treats a fuzzy near-match (different handle) as missing", async () => {
    const { admin } = makeAdmin({ product: () => [{ handle: "widget-deluxe" }] });
    const result = await resolveDanglingReferences(admin, [distinct("product", "widget")], SHOP_ID);
    expect(result.missing).toEqual([{ entityType: "product", handle: "widget" }]);
  });

  it("resolves products and collections under the single read_products probe", async () => {
    const { admin, graphql } = makeAdmin({
      product: existingProducts("live-product"),
      collection: () => [],
    });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("product", "live-product"), distinct("collection", "dead-collection")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([{ entityType: "collection", handle: "dead-collection" }]);
    expect(result.scopeStatus.products).toBe("checked");
    // Exactly one scope probe fired (products), not one per candidate.
    const probeCalls = graphql.mock.calls.filter((c) =>
      (c[0] as string).includes("products(first: 1)"),
    );
    expect(probeCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Page existence (Set membership both ways)
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — page existence", () => {
  it("does not report a page whose exact handle exists", async () => {
    const { admin } = makeAdmin({ pages: ["about-us"] });
    const result = await resolveDanglingReferences(admin, [distinct("page", "about-us")], SHOP_ID);
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.content).toBe("checked");
    expect(result.truncated).toBe(false);
  });

  it("reports only the page handles that do not exist", async () => {
    const { admin, graphql } = makeAdmin({ pages: ["about-us", "contact"] });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("page", "about-us"), distinct("page", "old-landing")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([{ entityType: "page", handle: "old-landing" }]);
    expect(result.scopeStatus.content).toBe("checked");
    // One per-handle existence lookup per candidate (not a single paginated pass).
    const pageQueries = graphql.mock.calls.filter((c) =>
      (c[0] as string).includes("PageExistsByHandle"),
    );
    expect(pageQueries).toHaveLength(2);
  });

  // Exact-handle-match guard: a fuzzy near-match that does not equal the queried
  // handle must be treated as MISSING (mirrors the product/collection guard).
  it("treats a fuzzy near-match page (different handle) as missing", async () => {
    const { admin } = makeAdmin({ page: () => [{ handle: "about-us-2" }] });
    const result = await resolveDanglingReferences(admin, [distinct("page", "about-us")], SHOP_ID);
    expect(result.missing).toEqual([{ entityType: "page", handle: "about-us" }]);
  });

  // Case-insensitivity: Shopify may return a mixed-case handle; the exact-match
  // guard lower-cases the node handle before comparing, so a case-only difference
  // is NOT reported missing (this is the old Set-membership case bug's regression).
  it("does not report a page when the returned handle differs only in case", async () => {
    const { admin } = makeAdmin({ page: () => [{ handle: "About-Us" }] });
    const result = await resolveDanglingReferences(admin, [distinct("page", "about-us")], SHOP_ID);
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.content).toBe("checked");
  });

  // Fuzzy-crowding regression (gc-3yi): a fuzzy `handle:` search can rank several
  // near-matches at or above the exact handle. The existence queries fetch
  // `first: 5` so the exact node is not crowded out of the result window. Here the
  // exact `about-us` is present but preceded by 4 higher-ranked near-matches — it
  // would fall outside a `first: 2` window (exact node excluded => false positive)
  // but survives at `first: 5`, so the page is treated as EXISTING. The logic is
  // shared via `handleExists`, so exercising it for pages covers all entity types.
  it("does not report an existing handle crowded below fuzzy near-matches (first: 5 headroom)", async () => {
    const { admin } = makeAdmin({
      page: (h) => [
        { handle: `${h}-2` },
        { handle: `${h}-old` },
        { handle: `${h}-draft` },
        { handle: `${h}-copy` },
        { handle: h }, // exact match, ranked 5th — excluded by first: 2, kept by first: 5
      ],
    });
    const result = await resolveDanglingReferences(admin, [distinct("page", "about-us")], SHOP_ID);
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.content).toBe("checked");
  });

  // Companion to the fuzzy-crowding case: a full window of near-matches that does
  // NOT include the exact handle must still be reported missing — the exact-match
  // guard rejects every near-match, so a near-match cannot rescue a truly-dangling
  // handle (the wider window is headroom, not a looser match).
  it("reports missing when the window is all near-matches and lacks the exact handle", async () => {
    const { admin } = makeAdmin({
      page: (h) => [
        { handle: `${h}-2` },
        { handle: `${h}-old` },
        { handle: `${h}-draft` },
        { handle: `${h}-copy` },
        { handle: `${h}-archive` },
      ],
    });
    const result = await resolveDanglingReferences(admin, [distinct("page", "about-us")], SHOP_ID);
    expect(result.missing).toEqual([{ entityType: "page", handle: "about-us" }]);
    expect(result.scopeStatus.content).toBe("checked");
  });

  // Primary regression (gc-3yi): with more page candidates than MAX_LOOKUPS, an
  // existing page beyond the budget is NOT falsely reported missing, and the
  // result is marked truncated so the differ suppresses the unchecked candidates.
  it("does not falsely report existing pages when the lookup budget is exceeded", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Every page exists (no findings); 60 distinct page handles > MAX_LOOKUPS (50).
    const { admin } = makeAdmin({ page: (h) => [{ handle: h }] });
    const many = Array.from({ length: 60 }, (_, i) => distinct("page", `pg-${i}`));

    const result = await resolveDanglingReferences(admin, many, SHOP_ID);

    expect(result.missing).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.scopeStatus.content).toBe("checked");
    warnSpy.mockRestore();
  });

  // The lookup budget is SHARED across products/collections and pages: products
  // consumed first, pages draw from the remainder, and the cap still trips.
  it("shares the lookup budget across product/collection and page candidates", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // 40 existing products + 40 existing pages = 80 lookups > MAX_LOOKUPS (50).
    const { admin } = makeAdmin({
      product: (h) => [{ handle: h }],
      page: (h) => [{ handle: h }],
    });
    const candidates = [
      ...Array.from({ length: 40 }, (_, i) => distinct("product", `p-${i}`)),
      ...Array.from({ length: 40 }, (_, i) => distinct("page", `pg-${i}`)),
    ];

    const result = await resolveDanglingReferences(admin, candidates, SHOP_ID);

    expect(result.missing).toEqual([]);
    expect(result.truncated).toBe(true);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Scope gating (graceful degradation)
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — scope gating", () => {
  it("skips product/collection candidates when read_products is absent", async () => {
    const { admin, graphql } = makeAdmin({ productScope: false });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("product", "old-widget"), distinct("collection", "dead")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.products).toBe("absent");
    // No existence query fired — a missing scope reports nothing missing.
    const existenceCalls = graphql.mock.calls.filter((c) =>
      (c[0] as string).includes("ExistsByHandle"),
    );
    expect(existenceCalls).toHaveLength(0);
  });

  it("skips page candidates when read_content is absent", async () => {
    const { admin, graphql } = makeAdmin({ contentScope: false });
    const result = await resolveDanglingReferences(admin, [distinct("page", "old-page")], SHOP_ID);
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.content).toBe("absent");
    const pageQueries = graphql.mock.calls.filter((c) =>
      (c[0] as string).includes("PageExistsByHandle"),
    );
    expect(pageQueries).toHaveLength(0);
  });

  it("resolves the granted scope while marking the missing one absent (mixed store)", async () => {
    const { admin } = makeAdmin({ product: () => [], contentScope: false });
    const result = await resolveDanglingReferences(
      admin,
      [distinct("product", "dead-widget"), distinct("page", "dead-page")],
      SHOP_ID,
    );
    // Product resolved (missing reported); page skipped (never reported missing).
    expect(result.missing).toEqual([{ entityType: "product", handle: "dead-widget" }]);
    expect(result.scopeStatus).toEqual({ products: "checked", content: "absent" });
    // Precise-skip rule the caller applies: a scope was absent => skip the type.
    const skipped =
      result.scopeStatus.products === "absent" || result.scopeStatus.content === "absent";
    expect(skipped).toBe(true);
  });

  it("does not probe a scope when there are no candidates of its types", async () => {
    const { admin, graphql } = makeAdmin({ product: existingProducts("widget") });
    await resolveDanglingReferences(admin, [distinct("product", "widget")], SHOP_ID);
    // Only the products probe should fire; no pages probe with zero page candidates.
    const pageProbes = graphql.mock.calls.filter((c) =>
      (c[0] as string).includes("pages(first: 1)"),
    );
    expect(pageProbes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lookup budget (MAX_LOOKUPS truncation)
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — lookup budget", () => {
  it("sets truncated and warns when the distinct-lookup cap is exceeded", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Every handle exists (no findings); the only observable effect is the cap:
    // 60 distinct product handles > MAX_LOOKUPS (50).
    const { admin } = makeAdmin({ product: (h) => [{ handle: h }] });
    const many = Array.from({ length: 60 }, (_, i) => distinct("product", `p-${i}`));

    const result = await resolveDanglingReferences(admin, many, SHOP_ID);

    expect(result.truncated).toBe(true);
    expect(result.missing).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("lookup cap"),
      expect.objectContaining({ shopId: SHOP_ID, maxLookups: 50 }),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Error resilience (THROTTLED retry, unexpected error, mid-scan revocation)
// ---------------------------------------------------------------------------

describe("resolveDanglingReferences — error resilience", () => {
  it("retries a single lookup that returns THROTTLED then succeeds", async () => {
    let calls = 0;
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("products(first: 1)")) {
        return envelope({ products: { nodes: [{ id: "1" }] } });
      }
      if (query.includes("ProductExistsByHandle")) {
        calls += 1;
        if (calls === 1) return envelope(null, [{ extensions: { code: "THROTTLED" } }]);
        return envelope({ products: { nodes: [{ handle: "widget" }] } });
      }
      throw new Error(`unexpected: ${query}`);
    });
    const admin = { graphql } as unknown as AdminApiContext;

    const result = await resolveDanglingReferences(admin, [distinct("product", "widget")], SHOP_ID);

    expect(calls).toBe(2); // throttled once, retried once
    expect(result.missing).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("propagates an unexpected GraphQL error so the Inngest step retries", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("products(first: 1)")) {
        return envelope({ products: { nodes: [{ id: "1" }] } });
      }
      return envelope(null, [{ message: "Internal error" }]);
    });
    const admin = { graphql } as unknown as AdminApiContext;

    await expect(
      resolveDanglingReferences(admin, [distinct("product", "widget")], SHOP_ID),
    ).rejects.toThrow(/Internal error/);
  });

  it("marks the scope absent (no missing) when access is revoked mid-scan", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("products(first: 1)")) {
        return envelope({ products: { nodes: [{ id: "1" }] } });
      }
      // Probe passed, then the lookup itself hits ACCESS_DENIED.
      return envelope(null, [{ extensions: { code: "ACCESS_DENIED" } }]);
    });
    const admin = { graphql } as unknown as AdminApiContext;

    const result = await resolveDanglingReferences(
      admin,
      [distinct("product", "widget"), distinct("collection", "sale")],
      SHOP_ID,
    );
    expect(result.missing).toEqual([]);
    expect(result.scopeStatus.products).toBe("absent");
  });
});
