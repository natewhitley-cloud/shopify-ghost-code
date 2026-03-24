import { describe, it, expect, vi } from "vitest";

import {
  hasProductScope,
  fetchProductTags,
  fetchProductPrices,
  fetchProductMetafields,
} from "../../app/services/product-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof hasProductScope>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

function makeProductsResponse(
  nodes: Array<{ id: string; title: string; tags: string[] }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        products: { nodes, pageInfo },
      },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1800,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

function makeErrorResponse(message: string) {
  return {
    json: vi.fn().mockResolvedValue({
      errors: [{ message }],
      data: null,
    }),
  };
}

// ---------------------------------------------------------------------------
// hasProductScope
// ---------------------------------------------------------------------------

describe("hasProductScope", () => {
  it("returns true when query succeeds", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { products: { nodes: [{ id: "gid://shopify/Product/1" }] } },
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasProductScope(admin)).toBe(true);
  });

  it("returns false when ACCESS_DENIED error", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "Access denied" }],
        data: null,
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasProductScope(admin)).toBe(false);
  });

  it("returns false on network error", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Network error"));
    const admin = makeAdmin(graphql);

    expect(await hasProductScope(admin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchProductTags
// ---------------------------------------------------------------------------

describe("fetchProductTags", () => {
  it("paginates correctly across multiple pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeProductsResponse(
          [
            { id: "gid://shopify/Product/1", title: "Product 1", tags: ["tag1"] },
            { id: "gid://shopify/Product/2", title: "Product 2", tags: ["tag2"] },
          ],
          { hasNextPage: true, endCursor: "cursor1" },
        ),
      )
      .mockResolvedValueOnce(
        makeProductsResponse(
          [{ id: "gid://shopify/Product/3", title: "Product 3", tags: ["tag3"] }],
          { hasNextPage: false, endCursor: null },
        ),
      );
    const admin = makeAdmin(graphql);

    const products = await fetchProductTags(admin);

    expect(products).toHaveLength(3);
    expect(products[0].id).toBe("gid://shopify/Product/1");
    expect(products[2].id).toBe("gid://shopify/Product/3");
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("caps at maxProducts", async () => {
    // Return 3 products per page with more available
    const graphql = vi.fn().mockResolvedValueOnce(
      makeProductsResponse(
        [
          { id: "gid://shopify/Product/1", title: "P1", tags: [] },
          { id: "gid://shopify/Product/2", title: "P2", tags: [] },
          { id: "gid://shopify/Product/3", title: "P3", tags: [] },
        ],
        { hasNextPage: true, endCursor: "cursor1" },
      ),
    );
    const admin = makeAdmin(graphql);

    const products = await fetchProductTags(admin, 3);

    expect(products).toHaveLength(3);
    // Should not fetch a second page since we hit maxProducts
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("handles empty result", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeProductsResponse([], { hasNextPage: false, endCursor: null }));
    const admin = makeAdmin(graphql);

    const products = await fetchProductTags(admin);

    expect(products).toEqual([]);
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    const admin = makeAdmin(graphql);

    await expect(fetchProductTags(admin)).rejects.toThrow("Failed to fetch products");
  });

  it("passes cursor to subsequent pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeProductsResponse([{ id: "gid://shopify/Product/1", title: "P1", tags: [] }], {
          hasNextPage: true,
          endCursor: "abc123",
        }),
      )
      .mockResolvedValueOnce(
        makeProductsResponse([{ id: "gid://shopify/Product/2", title: "P2", tags: [] }], {
          hasNextPage: false,
          endCursor: null,
        }),
      );
    const admin = makeAdmin(graphql);

    await fetchProductTags(admin);

    // Second call should include the cursor
    const secondCallArgs = graphql.mock.calls[1];
    expect(secondCallArgs[1]).toEqual(
      expect.objectContaining({
        variables: expect.objectContaining({ after: "abc123" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchProductPrices
// ---------------------------------------------------------------------------

function makeProductPricesResponse(
  nodes: Array<{
    id: string;
    title: string;
    variants: {
      nodes: Array<{
        id: string;
        title: string;
        price: string;
        compareAtPrice: string | null;
      }>;
    };
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        products: { nodes, pageInfo },
      },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1800,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

describe("fetchProductPrices", () => {
  it("paginates across multiple pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeProductPricesResponse(
          [
            {
              id: "gid://shopify/Product/1",
              title: "P1",
              variants: {
                nodes: [{ id: "v1", title: "Default", price: "10.00", compareAtPrice: "20.00" }],
              },
            },
          ],
          { hasNextPage: true, endCursor: "cursor1" },
        ),
      )
      .mockResolvedValueOnce(
        makeProductPricesResponse(
          [
            {
              id: "gid://shopify/Product/2",
              title: "P2",
              variants: {
                nodes: [{ id: "v2", title: "Default", price: "15.00", compareAtPrice: "25.00" }],
              },
            },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );
    const admin = makeAdmin(graphql);

    const products = await fetchProductPrices(admin);

    expect(products).toHaveLength(2);
    expect(products[0].id).toBe("gid://shopify/Product/1");
    expect(products[1].id).toBe("gid://shopify/Product/2");
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("returns products with variant pricing data", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeProductPricesResponse([
        {
          id: "gid://shopify/Product/1",
          title: "Test Product",
          variants: {
            nodes: [
              { id: "v1", title: "Small", price: "10.00", compareAtPrice: "20.00" },
              { id: "v2", title: "Large", price: "15.00", compareAtPrice: null },
            ],
          },
        },
      ]),
    );
    const admin = makeAdmin(graphql);

    const products = await fetchProductPrices(admin);

    expect(products).toHaveLength(1);
    expect(products[0].variants).toHaveLength(2);
    expect(products[0].variants[0].price).toBe("10.00");
    expect(products[0].variants[0].compareAtPrice).toBe("20.00");
  });

  it("filters out products with no compareAtPrice set", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeProductPricesResponse([
        {
          id: "gid://shopify/Product/1",
          title: "No Compare At",
          variants: {
            nodes: [{ id: "v1", title: "Default", price: "29.99", compareAtPrice: null }],
          },
        },
        {
          id: "gid://shopify/Product/2",
          title: "Has Compare At",
          variants: {
            nodes: [{ id: "v2", title: "Default", price: "19.99", compareAtPrice: "29.99" }],
          },
        },
      ]),
    );
    const admin = makeAdmin(graphql);

    const products = await fetchProductPrices(admin);

    expect(products).toHaveLength(1);
    expect(products[0].id).toBe("gid://shopify/Product/2");
  });

  it("handles empty result", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeProductPricesResponse([], { hasNextPage: false, endCursor: null }));
    const admin = makeAdmin(graphql);

    const products = await fetchProductPrices(admin);

    expect(products).toEqual([]);
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    const admin = makeAdmin(graphql);

    await expect(fetchProductPrices(admin)).rejects.toThrow("Failed to fetch product prices");
  });
});

// ---------------------------------------------------------------------------
// fetchProductMetafields
// ---------------------------------------------------------------------------

function makeProductMetafieldsResponse(
  nodes: Array<{
    id: string;
    title: string;
    metafields: {
      nodes: Array<{
        namespace: string;
        key: string;
        value: string;
        type: string;
      }>;
    };
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        products: { nodes, pageInfo },
      },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1800,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

describe("fetchProductMetafields", () => {
  it("paginates across multiple pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeProductMetafieldsResponse(
          [
            {
              id: "gid://shopify/Product/1",
              title: "P1",
              metafields: {
                nodes: [
                  {
                    namespace: "judgeme",
                    key: "review_count",
                    value: "42",
                    type: "number_integer",
                  },
                ],
              },
            },
          ],
          { hasNextPage: true, endCursor: "cursor1" },
        ),
      )
      .mockResolvedValueOnce(
        makeProductMetafieldsResponse(
          [
            {
              id: "gid://shopify/Product/2",
              title: "P2",
              metafields: {
                nodes: [
                  { namespace: "yotpo", key: "rating", value: "4.5", type: "number_decimal" },
                ],
              },
            },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );
    const admin = makeAdmin(graphql);

    const products = await fetchProductMetafields(admin);

    expect(products).toHaveLength(2);
    expect(products[0].id).toBe("gid://shopify/Product/1");
    expect(products[1].id).toBe("gid://shopify/Product/2");
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("handles empty result", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeProductMetafieldsResponse([], { hasNextPage: false, endCursor: null }),
      );
    const admin = makeAdmin(graphql);

    const products = await fetchProductMetafields(admin);

    expect(products).toEqual([]);
  });

  it("filters out products with no metafields", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeProductMetafieldsResponse([
        {
          id: "gid://shopify/Product/1",
          title: "Has Metafields",
          metafields: {
            nodes: [
              { namespace: "judgeme", key: "review_count", value: "42", type: "number_integer" },
            ],
          },
        },
        {
          id: "gid://shopify/Product/2",
          title: "No Metafields",
          metafields: { nodes: [] },
        },
      ]),
    );
    const admin = makeAdmin(graphql);

    const products = await fetchProductMetafields(admin);

    expect(products).toHaveLength(1);
    expect(products[0].id).toBe("gid://shopify/Product/1");
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    const admin = makeAdmin(graphql);

    await expect(fetchProductMetafields(admin)).rejects.toThrow(
      "Failed to fetch product metafields",
    );
  });
});
