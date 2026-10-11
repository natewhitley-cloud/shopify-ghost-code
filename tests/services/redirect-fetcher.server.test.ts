import { describe, it, expect, vi } from "vitest";

import {
  hasNavigationScope,
  fetchRedirects,
  fetchRedirectsTotal,
} from "../../app/services/redirect-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockResponse = {
  json: () => Promise<unknown>;
};

function mockAdmin(responses: unknown[]) {
  let callIndex = 0;
  return {
    graphql: vi.fn(async (): Promise<MockResponse> => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return { json: async () => response };
    }),
  };
}

// ---------------------------------------------------------------------------
// hasNavigationScope
// ---------------------------------------------------------------------------

describe("hasNavigationScope", () => {
  it("returns true when query succeeds", async () => {
    const admin = mockAdmin([{ data: { urlRedirects: { nodes: [] } } }]);
    const result = await hasNavigationScope(admin, null);
    expect(result).toBe(true);
  });

  it("returns false when query returns an access-denied error", async () => {
    const admin = mockAdmin([{ errors: [{ message: "Access denied" }] }]);
    const result = await hasNavigationScope(admin, null);
    expect(result).toBe(false);
  });

  // LOG-9: a transient transport failure must NOT be swallowed as "scope
  // missing" — it must throw so the Inngest step retries.
  it("throws when the query throws (transient, not scope-missing)", async () => {
    const admin = {
      graphql: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };
    await expect(hasNavigationScope(admin, null)).rejects.toThrow(/transient/i);
  });

  // LOG-9: a THROTTLED GraphQL error must throw, not be treated as scope-missing.
  it("throws on THROTTLED (transient, not scope-missing)", async () => {
    const admin = mockAdmin([
      { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
    ]);
    await expect(hasNavigationScope(admin, null)).rejects.toThrow(/transient/i);
  });
});

// ---------------------------------------------------------------------------
// fetchRedirects
// ---------------------------------------------------------------------------

describe("fetchRedirects", () => {
  it("fetches redirects with pagination", async () => {
    const admin = mockAdmin([
      {
        data: {
          urlRedirects: {
            nodes: [
              { id: "gid://shopify/UrlRedirect/1", path: "/old-1", target: "/new-1" },
              { id: "gid://shopify/UrlRedirect/2", path: "/old-2", target: "/new-2" },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor1" },
          },
        },
        extensions: {},
      },
      {
        data: {
          urlRedirects: {
            nodes: [{ id: "gid://shopify/UrlRedirect/3", path: "/old-3", target: "/new-3" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        extensions: {},
      },
    ]);

    const redirects = await fetchRedirects(admin);
    expect(redirects).toHaveLength(3);
    expect(redirects[0].path).toBe("/old-1");
    expect(redirects[2].path).toBe("/old-3");
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it("handles empty results", async () => {
    const admin = mockAdmin([
      {
        data: {
          urlRedirects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        extensions: {},
      },
    ]);

    const redirects = await fetchRedirects(admin);
    expect(redirects).toHaveLength(0);
  });

  it("respects maxRedirects limit", async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `gid://shopify/UrlRedirect/${i}`,
      path: `/old-${i}`,
      target: `/new-${i}`,
    }));

    const admin = mockAdmin([
      {
        data: {
          urlRedirects: {
            nodes,
            pageInfo: { hasNextPage: true, endCursor: "cursor1" },
          },
        },
        extensions: {},
      },
    ]);

    const redirects = await fetchRedirects(admin, 30);
    expect(redirects).toHaveLength(30);
  });

  // gc-1bd: when the cap cuts the walk short and more redirects existed, the
  // optional stats out-param must report truncated so the caller records a
  // coverage gap (the differ must not false-resolve redirects beyond the cap).
  it("flags stats.truncated when the cap is hit while more redirects remain", async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `gid://shopify/UrlRedirect/${i}`,
      path: `/old-${i}`,
      target: `/new-${i}`,
    }));
    const admin = mockAdmin([
      {
        data: { urlRedirects: { nodes, pageInfo: { hasNextPage: true, endCursor: "cursor1" } } },
        extensions: {},
      },
    ]);

    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    const redirects = await fetchRedirects(admin, 30, stats);

    expect(redirects).toHaveLength(30);
    expect(stats.truncated).toBe(true);
    expect(stats.pageCount).toBe(1);
  });

  it("leaves stats.truncated false when the walk ends naturally under the cap", async () => {
    const admin = mockAdmin([
      {
        data: {
          urlRedirects: {
            nodes: [{ id: "gid://shopify/UrlRedirect/1", path: "/o", target: "/n" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        extensions: {},
      },
    ]);

    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    await fetchRedirects(admin, 1000, stats);

    expect(stats.truncated).toBe(false);
    expect(stats.pageCount).toBe(1);
  });

  it("throws on API errors", async () => {
    const admin = mockAdmin([
      {
        errors: [{ message: "Internal Server Error" }],
      },
    ]);

    await expect(fetchRedirects(admin)).rejects.toThrow("Failed to fetch redirects");
  });
});

// ---------------------------------------------------------------------------
// gc-747u: resumable chunks, ID order, total count
// ---------------------------------------------------------------------------

describe("fetchRedirects chunked walk (gc-747u)", () => {
  const pageOf = (ids: number[], hasNextPage: boolean, endCursor: string | null) => ({
    data: {
      urlRedirects: {
        nodes: ids.map((n) => ({
          id: `gid://shopify/UrlRedirect/${n}`,
          path: `/p${n}`,
          target: "/",
        })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  });

  it("walks in explicit ID order and resumes from the given cursor", async () => {
    const admin = mockAdmin([pageOf([5, 6], false, null)]);
    await fetchRedirects(admin, 1000, undefined, { after: "c4" });
    const [query, opts] = admin.graphql.mock.calls[0] as unknown as [
      string,
      { variables: { after?: string } },
    ];
    expect(query).toContain("sortKey: ID");
    expect(opts.variables.after).toBe("c4");
  });

  it("stops at the deadline and reports where to resume", async () => {
    const admin = mockAdmin([pageOf([1, 2], true, "c2")]);
    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    const redirects = await fetchRedirects(admin, 1000, stats, { deadline: Date.now() - 1 });
    expect(redirects).toHaveLength(2);
    expect(stats).toMatchObject({ hasMore: true, endCursor: "c2", truncated: false });
  });
});

describe("fetchRedirectsTotal (gc-747u)", () => {
  it("reads urlRedirectsCount with no limit", async () => {
    const admin = mockAdmin([
      { data: { urlRedirectsCount: { count: 12400, precision: "EXACT" } } },
    ]);
    await expect(fetchRedirectsTotal(admin)).resolves.toBe(12400);
    expect(admin.graphql.mock.calls[0]).toEqual([
      expect.stringContaining("urlRedirectsCount(limit: null)"),
    ]);
  });

  it("returns null on an error response", async () => {
    const admin = mockAdmin([{ errors: [{ message: "Access denied" }] }]);
    await expect(fetchRedirectsTotal(admin)).resolves.toBeNull();
  });
});
