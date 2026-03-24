import { describe, it, expect, vi } from "vitest";

import { hasNavigationScope, fetchRedirects } from "../../app/services/redirect-fetcher.server";

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
    const result = await hasNavigationScope(admin);
    expect(result).toBe(true);
  });

  it("returns false when query returns errors", async () => {
    const admin = mockAdmin([{ errors: [{ message: "Access denied" }] }]);
    const result = await hasNavigationScope(admin);
    expect(result).toBe(false);
  });

  it("returns false when query throws", async () => {
    const admin = {
      graphql: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };
    const result = await hasNavigationScope(admin);
    expect(result).toBe(false);
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

  it("throws on API errors", async () => {
    const admin = mockAdmin([
      {
        errors: [{ message: "Internal Server Error" }],
      },
    ]);

    await expect(fetchRedirects(admin)).rejects.toThrow("Failed to fetch redirects");
  });
});
