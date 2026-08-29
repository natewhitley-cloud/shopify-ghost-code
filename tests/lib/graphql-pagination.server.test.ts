/**
 * Tests for app/lib/graphql-pagination.server.ts
 *
 * Focus areas:
 *   - single page, multi-page, empty results
 *   - cursor advancement (no `after` on the first request)
 *   - maxNodes cap with dynamic `first` on the final page
 *   - mapNode filtering (0 items) and flattening (>1 item per node)
 *   - PRF-3: THROTTLED mid-pagination resumes from the SAME cursor without
 *     re-fetching prior pages, and gives up after the retry budget
 *   - non-THROTTLED GraphQL errors throw
 *   - getConnection may throw for a missing parent (theme-files style)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted). paginateConnection records a durable API_ERROR
// OpsEvent before each fatal throw; mock the model so those writes never hit a
// real db and can be asserted.
// ---------------------------------------------------------------------------

const mockRecordApiError = vi.hoisted(() => vi.fn());
vi.mock("../../app/models/ops-event.server", () => ({
  recordApiError: mockRecordApiError,
}));

import {
  paginateConnection,
  type GraphQLConnection,
} from "../../app/lib/graphql-pagination.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Item = { id: string };

type AdminApiContext = Parameters<typeof paginateConnection>[0]["admin"];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

/** A successful page response under data.items, with ample throttle headroom. */
function page(
  nodes: Item[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  throttle?: { currentlyAvailable: number; restoreRate: number },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: { items: { nodes, pageInfo } },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: throttle?.currentlyAvailable ?? 1900,
            restoreRate: throttle?.restoreRate ?? 100,
          },
        },
      },
    }),
  };
}

/** A response carrying GraphQL errors and (optionally) throttle extensions. */
function errorPage(
  errors: Array<{ message?: string; extensions?: { code?: string } }>,
  throttle?: { currentlyAvailable: number; restoreRate: number },
) {
  return {
    json: vi.fn().mockResolvedValue({
      errors,
      extensions: throttle
        ? { cost: { throttleStatus: { maximumAvailable: 2000, ...throttle } } }
        : {},
    }),
  };
}

const getItems = (data: unknown) =>
  (data as { items?: GraphQLConnection<Item> } | null | undefined)?.items;

const identity = (node: Item) => [node];

function baseOptions(graphql: ReturnType<typeof vi.fn>) {
  return {
    admin: makeAdmin(graphql),
    query: "query($first: Int!, $after: String) { items }",
    pageSize: 50,
    errorContext: "[test] Failed to fetch items",
    getConnection: getItems,
    mapNode: identity,
  };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("paginateConnection", () => {
  it("returns items from a single page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([{ id: "a" }, { id: "b" }], { hasNextPage: false, endCursor: null }));

    const result = await paginateConnection(baseOptions(graphql));

    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when the connection has no nodes", async () => {
    const graphql = vi.fn().mockResolvedValue(page([], { hasNextPage: false, endCursor: null }));

    const result = await paginateConnection(baseOptions(graphql));
    expect(result).toEqual([]);
  });

  it("does not send an after cursor on the first request", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([{ id: "a" }], { hasNextPage: false, endCursor: null }));

    await paginateConnection(baseOptions(graphql));

    expect(graphql.mock.calls[0][1].variables.after).toBeUndefined();
    expect(graphql.mock.calls[0][1].variables.first).toBe(50);
  });

  it("paginates multiple pages and advances the cursor", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(page([{ id: "b" }], { hasNextPage: true, endCursor: "c2" }))
      .mockResolvedValueOnce(page([{ id: "c" }], { hasNextPage: false, endCursor: null }));

    const result = await paginateConnection(baseOptions(graphql));

    expect(result).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[1][1].variables.after).toBe("c1");
    expect(graphql.mock.calls[2][1].variables.after).toBe("c2");
  });

  it("stops at an empty page even when hasNextPage is true (no infinite loop)", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(page([], { hasNextPage: true, endCursor: "c2" }));

    const result = await paginateConnection(baseOptions(graphql));

    expect(result).toEqual([{ id: "a" }]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("passes through static variables on every request", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(page([{ id: "b" }], { hasNextPage: false, endCursor: null }));

    await paginateConnection({ ...baseOptions(graphql), variables: { themeId: "gid://x" } });

    expect(graphql.mock.calls[0][1].variables.themeId).toBe("gid://x");
    expect(graphql.mock.calls[1][1].variables.themeId).toBe("gid://x");
  });

  // -------------------------------------------------------------------------
  // mapNode behaviors
  // -------------------------------------------------------------------------

  it("filters nodes when mapNode returns an empty array", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        page([{ id: "keep" }, { id: "drop" }], { hasNextPage: false, endCursor: null }),
      );

    const result = await paginateConnection({
      ...baseOptions(graphql),
      mapNode: (node: Item) => (node.id === "keep" ? [node] : []),
    });

    expect(result).toEqual([{ id: "keep" }]);
  });

  it("flattens when mapNode returns multiple items per node", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([{ id: "a" }, { id: "b" }], { hasNextPage: false, endCursor: null }));

    const result = await paginateConnection({
      ...baseOptions(graphql),
      mapNode: (node: Item) => [{ id: `${node.id}-1` }, { id: `${node.id}-2` }],
    });

    expect(result).toEqual([{ id: "a-1" }, { id: "a-2" }, { id: "b-1" }, { id: "b-2" }]);
  });

  // -------------------------------------------------------------------------
  // maxNodes cap
  // -------------------------------------------------------------------------

  it("requests only the remaining count on the final page when maxNodes is set", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: "a" }, { id: "b" }], { hasNextPage: true, endCursor: "c1" }),
      )
      .mockResolvedValueOnce(page([{ id: "c" }], { hasNextPage: true, endCursor: "c2" }));

    const result = await paginateConnection({ ...baseOptions(graphql), pageSize: 2, maxNodes: 3 });

    // First page: first=2; second page: first = min(2, 3-2) = 1.
    expect(graphql.mock.calls[0][1].variables.first).toBe(2);
    expect(graphql.mock.calls[1][1].variables.first).toBe(1);
    expect(result).toHaveLength(3);
    // Cap reached -> no third request even though hasNextPage was true.
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("does not request a page when maxNodes is already satisfied", async () => {
    const graphql = vi.fn();
    const result = await paginateConnection({ ...baseOptions(graphql), maxNodes: 0 });
    expect(result).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // getConnection that throws for a missing parent (theme-files style)
  // -------------------------------------------------------------------------

  it("propagates an error thrown by getConnection", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: { items: null }, extensions: {} }),
    });

    await expect(
      paginateConnection({
        ...baseOptions(graphql),
        getConnection: () => {
          throw new Error("[test] parent missing");
        },
      }),
    ).rejects.toThrow("[test] parent missing");
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws on a non-THROTTLED GraphQL error, prefixed with errorContext", async () => {
    const graphql = vi.fn().mockResolvedValue(errorPage([{ message: "Access denied" }]));

    await expect(paginateConnection(baseOptions(graphql))).rejects.toThrow(
      "[test] Failed to fetch items: Access denied",
    );
  });

  it("records an API_ERROR OpsEvent before throwing on a non-THROTTLED error", async () => {
    mockRecordApiError.mockClear();
    mockRecordApiError.mockResolvedValue(undefined);
    const graphql = vi.fn().mockResolvedValue(errorPage([{ message: "Access denied" }]));

    await expect(paginateConnection(baseOptions(graphql))).rejects.toThrow();

    expect(mockRecordApiError).toHaveBeenCalledWith({
      level: "error",
      code: "graphql_error",
      message: "Access denied",
      metadata: { context: "[test] Failed to fetch items" },
    });
  });
});

// ---------------------------------------------------------------------------
// PRF-3: THROTTLED mid-pagination resume
// ---------------------------------------------------------------------------

describe("paginateConnection THROTTLED resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the SAME cursor after a THROTTLED error without re-fetching prior pages", async () => {
    const graphql = vi
      .fn()
      // Page 1 succeeds.
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      // Page 2 (after c1) is THROTTLED -> should back off and retry SAME cursor.
      .mockResolvedValueOnce(
        errorPage([{ message: "Throttled", extensions: { code: "THROTTLED" } }], {
          currentlyAvailable: 0,
          restoreRate: 100,
        }),
      )
      // Retry of page 2 (still after c1) succeeds and ends pagination.
      .mockResolvedValueOnce(page([{ id: "b" }], { hasNextPage: false, endCursor: null }));

    const promise = paginateConnection(baseOptions(graphql));
    await vi.runAllTimersAsync();
    const result = await promise;

    // No prior page re-fetched: page 1 fetched exactly once.
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(graphql).toHaveBeenCalledTimes(3);
    // The retry used the SAME cursor as the throttled request (c1), not the start.
    expect(graphql.mock.calls[1][1].variables.after).toBe("c1");
    expect(graphql.mock.calls[2][1].variables.after).toBe("c1");
  });

  it("gives up and throws after exceeding the throttle retry budget", async () => {
    const graphql = vi.fn().mockResolvedValue(
      errorPage([{ message: "Throttled", extensions: { code: "THROTTLED" } }], {
        currentlyAvailable: 0,
        restoreRate: 100,
      }),
    );

    const promise = paginateConnection({ ...baseOptions(graphql), maxThrottleRetries: 2 });
    const assertion = expect(promise).rejects.toThrow("still THROTTLED after 2 retries");
    await vi.runAllTimersAsync();
    await assertion;

    // First attempt + 2 retries = 3 requests before giving up.
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("resets the throttle retry budget after a successful page", async () => {
    const throttled = () =>
      errorPage([{ extensions: { code: "THROTTLED" } }], {
        currentlyAvailable: 0,
        restoreRate: 100,
      });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(page([{ id: "b" }], { hasNextPage: false, endCursor: null }));

    const promise = paginateConnection({ ...baseOptions(graphql), maxThrottleRetries: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    // Each page burned 1 of its 1-retry budget but the counter reset between
    // pages, so neither throttle exhausted the budget.
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(graphql).toHaveBeenCalledTimes(4);
  });
});
