import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { hasProductScope, fetchProductAuditData } from "../../app/services/product-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof hasProductScope>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

type AuditNode = {
  id: string;
  title: string;
  tags: string[];
  variants: {
    nodes: Array<{ id: string; title: string; price: string; compareAtPrice: string | null }>;
  };
  metafields: {
    nodes: Array<{ namespace: string; key: string; value: string; type: string }>;
  };
};

/**
 * A successful products page for the consolidated audit query. `throttle`
 * defaults to ample headroom so the walk never sleeps unless a test asks it to.
 */
function makeAuditResponse(
  nodes: AuditNode[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
  throttle?: { currentlyAvailable: number; restoreRate: number },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: { products: { nodes, pageInfo } },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: throttle?.currentlyAvailable ?? 1800,
            restoreRate: throttle?.restoreRate ?? 100,
          },
        },
      },
    }),
  };
}

function makeErrorResponse(message: string) {
  return {
    json: vi.fn().mockResolvedValue({ errors: [{ message }], data: null }),
  };
}

/** A product node with all three detectors' data present. */
function fullNode(id: string, overrides?: Partial<AuditNode>): AuditNode {
  return {
    id,
    title: `Product ${id}`,
    tags: ["bold-sale"],
    variants: {
      nodes: [{ id: `${id}-v1`, title: "Default", price: "10.00", compareAtPrice: "20.00" }],
    },
    metafields: {
      nodes: [{ namespace: "judgeme", key: "rating", value: "4.5", type: "number_decimal" }],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasProductScope (unchanged)
// ---------------------------------------------------------------------------

describe("hasProductScope", () => {
  it("returns true when query succeeds", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { products: { nodes: [{ id: "gid://shopify/Product/1" }] } },
      }),
    });
    expect(await hasProductScope(makeAdmin(graphql))).toBe(true);
  });

  it("returns false when ACCESS_DENIED error", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ errors: [{ message: "Access denied" }], data: null }),
    });
    expect(await hasProductScope(makeAdmin(graphql))).toBe(false);
  });

  it("returns false when ACCESS_DENIED is carried in extensions.code", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "not authorized", extensions: { code: "ACCESS_DENIED" } }],
        data: null,
      }),
    });
    expect(await hasProductScope(makeAdmin(graphql))).toBe(false);
  });

  // LOG-9: transient transport failure must throw (not be treated scope-missing).
  it("throws on network error (transient, not scope-missing)", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(hasProductScope(makeAdmin(graphql))).rejects.toThrow(/transient/i);
  });

  it("throws on THROTTLED (transient, not scope-missing)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        data: null,
      }),
    });
    await expect(hasProductScope(makeAdmin(graphql))).rejects.toThrow(/transient/i);
  });
});

// ---------------------------------------------------------------------------
// fetchProductAuditData — the consolidated single-walk fetcher (gc-1bd)
// ---------------------------------------------------------------------------

describe("fetchProductAuditData", () => {
  it("yields data for all THREE detectors from ONE walk (one graphql query per page)", async () => {
    const graphql = vi.fn().mockResolvedValue(makeAuditResponse([fullNode("1")]));

    const result = await fetchProductAuditData(makeAdmin(graphql));

    // One product with tags + a compare-at variant + a metafield appears in all
    // three detector-shaped arrays, produced by a SINGLE catalog walk.
    expect(result.tags).toEqual([{ id: "1", title: "Product 1", tags: ["bold-sale"] }]);
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0].id).toBe("1");
    expect(result.metafields).toHaveLength(1);
    expect(result.metafields[0].id).toBe("1");
    // Critically: only ONE graphql call — not three separate walks.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("keeps every product in `tags` (no filter), matching the legacy tag fetcher", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeAuditResponse([fullNode("1", { tags: [] }), fullNode("2", { tags: ["recharge-x"] })]),
      );

    const result = await fetchProductAuditData(makeAdmin(graphql));

    expect(result.tags.map((t) => t.id)).toEqual(["1", "2"]);
    expect(result.tags[0].tags).toEqual([]);
  });

  it("includes in `prices` only products with a compareAtPrice variant", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeAuditResponse([
        // No compare-at → excluded from prices (but still in tags).
        fullNode("1", {
          variants: {
            nodes: [{ id: "1-v1", title: "Default", price: "10.00", compareAtPrice: null }],
          },
        }),
        // Has compare-at → included.
        fullNode("2"),
      ]),
    );

    const result = await fetchProductAuditData(makeAdmin(graphql));

    expect(result.prices.map((p) => p.id)).toEqual(["2"]);
    // Full variant list carried through, plus merchant-visible metafields as {namespace,key}.
    expect(result.prices[0].variants).toHaveLength(1);
    expect(result.prices[0].metafields).toEqual([{ namespace: "judgeme", key: "rating" }]);
    // The compare-at-less product is still present for the tag detector.
    expect(result.tags.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("includes in `metafields` only products with at least one metafield, carrying value+type", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeAuditResponse([fullNode("1", { metafields: { nodes: [] } }), fullNode("2")]),
      );

    const result = await fetchProductAuditData(makeAdmin(graphql));

    expect(result.metafields.map((m) => m.id)).toEqual(["2"]);
    expect(result.metafields[0].metafields).toEqual([
      { namespace: "judgeme", key: "rating", value: "4.5", type: "number_decimal" },
    ]);
  });

  it("paginates across pages and advances the cursor", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeAuditResponse([fullNode("1")], { hasNextPage: true, endCursor: "c1" }),
      )
      .mockResolvedValueOnce(
        makeAuditResponse([fullNode("2")], { hasNextPage: false, endCursor: null }),
      );

    const result = await fetchProductAuditData(makeAdmin(graphql));

    expect(result.tags.map((t) => t.id)).toEqual(["1", "2"]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1].variables.after).toBe("c1");
    expect(result.pageCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("reports truncated=true and does not over-fetch when the cap is hit mid-catalog", async () => {
    // One page of 2 products, cap 2, and MORE available (hasNextPage true).
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeAuditResponse([fullNode("1"), fullNode("2")], { hasNextPage: true, endCursor: "c1" }),
      );

    const result = await fetchProductAuditData(makeAdmin(graphql), 2);

    expect(result.tags).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.pageCount).toBe(1);
    // Cap reached → no second page fetched despite hasNextPage.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark truncated when the catalog exactly fills the cap with no next page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeAuditResponse([fullNode("1"), fullNode("2")], { hasNextPage: false, endCursor: null }),
      );

    const result = await fetchProductAuditData(makeAdmin(graphql), 2);

    expect(result.tags).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("returns empty arrays (not truncated) for an empty catalog", async () => {
    const graphql = vi.fn().mockResolvedValue(makeAuditResponse([]));

    const result = await fetchProductAuditData(makeAdmin(graphql));

    expect(result).toMatchObject({ tags: [], prices: [], metafields: [], truncated: false });
  });

  it("throws (does not swallow) on a non-throttled API error so the step retries/fails", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    await expect(fetchProductAuditData(makeAdmin(graphql))).rejects.toThrow(
      "Failed to fetch product audit data",
    );
  });

  describe("throttle-sleep accounting", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("accumulates throttleSleepMs when a page reports low rate-limit headroom", async () => {
      // Page 1 reports low headroom (< 100 pts) → proactive backoff sleeps before
      // page 2. Page 2 has ample headroom and ends the walk.
      const graphql = vi
        .fn()
        .mockResolvedValueOnce(
          makeAuditResponse(
            [fullNode("1")],
            { hasNextPage: true, endCursor: "c1" },
            {
              currentlyAvailable: 0,
              restoreRate: 100,
            },
          ),
        )
        .mockResolvedValueOnce(
          makeAuditResponse([fullNode("2")], { hasNextPage: false, endCursor: null }),
        );

      const promise = fetchProductAuditData(makeAdmin(graphql));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.tags).toHaveLength(2);
      // 100 pts needed / 100 per sec ≈ 1000ms of backoff was measured.
      expect(result.throttleSleepMs).toBeGreaterThan(0);
    });

    it("records zero throttle sleep on a single page with ample headroom", async () => {
      const graphql = vi.fn().mockResolvedValue(makeAuditResponse([fullNode("1")]));
      const promise = fetchProductAuditData(makeAdmin(graphql));
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.throttleSleepMs).toBe(0);
    });
  });
});
