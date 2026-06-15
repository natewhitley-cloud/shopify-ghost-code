import { describe, it, expect, vi } from "vitest";

import { hasContentScope, fetchPages } from "../../app/services/content-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof hasContentScope>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

function makePagesResponse(
  nodes: Array<{
    id: string;
    title: string;
    handle: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        pages: { nodes, pageInfo },
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

function makePageNode(
  overrides: Partial<{
    id: string;
    title: string;
    handle: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }> = {},
) {
  return {
    id: "gid://shopify/Page/1",
    title: "Test Page",
    handle: "test-page",
    body: "<p>Some content</p>",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasContentScope
// ---------------------------------------------------------------------------

describe("hasContentScope", () => {
  it("returns true when query succeeds", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { pages: { nodes: [{ id: "gid://shopify/Page/1" }] } },
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasContentScope(admin)).toBe(true);
  });

  it("returns false when ACCESS_DENIED error", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "Access denied" }],
        data: null,
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasContentScope(admin)).toBe(false);
  });

  // LOG-9: a transient transport failure must NOT be swallowed as "scope
  // missing" — it must throw so the Inngest step retries.
  it("throws on network error (transient, not scope-missing)", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Network error"));
    const admin = makeAdmin(graphql);

    await expect(hasContentScope(admin)).rejects.toThrow(/transient/i);
  });

  // LOG-9: a THROTTLED GraphQL error must throw, not be treated as scope-missing.
  it("throws on THROTTLED (transient, not scope-missing)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        data: null,
      }),
    });
    const admin = makeAdmin(graphql);

    await expect(hasContentScope(admin)).rejects.toThrow(/transient/i);
  });
});

// ---------------------------------------------------------------------------
// fetchPages
// ---------------------------------------------------------------------------

describe("fetchPages", () => {
  it("paginates correctly across multiple pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makePagesResponse(
          [
            makePageNode({ id: "gid://shopify/Page/1", handle: "page-1" }),
            makePageNode({ id: "gid://shopify/Page/2", handle: "page-2" }),
          ],
          { hasNextPage: true, endCursor: "cursor1" },
        ),
      )
      .mockResolvedValueOnce(
        makePagesResponse([makePageNode({ id: "gid://shopify/Page/3", handle: "page-3" })], {
          hasNextPage: false,
          endCursor: null,
        }),
      );
    const admin = makeAdmin(graphql);

    const pages = await fetchPages(admin);

    expect(pages).toHaveLength(3);
    expect(pages[0].id).toBe("gid://shopify/Page/1");
    expect(pages[2].id).toBe("gid://shopify/Page/3");
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("handles empty result", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makePagesResponse([], { hasNextPage: false, endCursor: null }));
    const admin = makeAdmin(graphql);

    const pages = await fetchPages(admin);

    expect(pages).toEqual([]);
  });

  it("caps body at 500 characters", async () => {
    const longBody = "x".repeat(1000);
    const graphql = vi
      .fn()
      .mockResolvedValue(makePagesResponse([makePageNode({ body: longBody })]));
    const admin = makeAdmin(graphql);

    const pages = await fetchPages(admin);

    expect(pages[0].body.length).toBe(500);
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    const admin = makeAdmin(graphql);

    await expect(fetchPages(admin)).rejects.toThrow("Failed to fetch pages");
  });

  it("passes cursor to subsequent pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makePagesResponse([makePageNode({ id: "gid://shopify/Page/1" })], {
          hasNextPage: true,
          endCursor: "abc123",
        }),
      )
      .mockResolvedValueOnce(
        makePagesResponse([makePageNode({ id: "gid://shopify/Page/2" })], {
          hasNextPage: false,
          endCursor: null,
        }),
      );
    const admin = makeAdmin(graphql);

    await fetchPages(admin);

    const secondCallArgs = graphql.mock.calls[1];
    expect(secondCallArgs[1]).toEqual(
      expect.objectContaining({
        variables: expect.objectContaining({ after: "abc123" }),
      }),
    );
  });

  it("caps at maxPages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makePagesResponse(
          [
            makePageNode({ id: "gid://shopify/Page/1" }),
            makePageNode({ id: "gid://shopify/Page/2" }),
          ],
          { hasNextPage: true, endCursor: "cursor1" },
        ),
      );
    const admin = makeAdmin(graphql);

    const pages = await fetchPages(admin, 2);

    expect(pages).toHaveLength(2);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("handles empty body gracefully", async () => {
    const graphql = vi.fn().mockResolvedValue(makePagesResponse([makePageNode({ body: "" })]));
    const admin = makeAdmin(graphql);

    const pages = await fetchPages(admin);

    expect(pages[0].body).toBe("");
  });
});
