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
  fetchExactCount,
  paginateConnection,
  type GraphQLConnection,
  type PaginateStats,
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
// stats out-param (gc-1bd): pageCount / nodeCount / truncated
// ---------------------------------------------------------------------------

describe("paginateConnection stats out-param", () => {
  it("counts pages and nodes across a natural (untruncated) walk", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: "a" }, { id: "b" }], { hasNextPage: true, endCursor: "c1" }),
      )
      .mockResolvedValueOnce(page([{ id: "c" }], { hasNextPage: false, endCursor: null }));

    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    await paginateConnection({ ...baseOptions(graphql), stats });

    expect(stats.pageCount).toBe(2);
    expect(stats.nodeCount).toBe(3);
    expect(stats.truncated).toBe(false);
  });

  it("sets truncated when the cap stops the walk while hasNextPage is still true", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: "a" }, { id: "b" }], { hasNextPage: true, endCursor: "c1" }),
      );

    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    await paginateConnection({ ...baseOptions(graphql), pageSize: 2, maxNodes: 2, stats });

    expect(stats.truncated).toBe(true);
    expect(stats.nodeCount).toBe(2);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("does NOT set truncated when the cap coincides with the last page (no next page)", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: "a" }, { id: "b" }], { hasNextPage: false, endCursor: null }),
      );

    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };
    await paginateConnection({ ...baseOptions(graphql), pageSize: 2, maxNodes: 2, stats });

    expect(stats.truncated).toBe(false);
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

// ---------------------------------------------------------------------------
// gc-747u: resumable walks (after cursor + step time budget) and exact counts
// ---------------------------------------------------------------------------

describe("paginateConnection resumable walk (gc-747u)", () => {
  const freshStats = (): PaginateStats => ({
    pageCount: 0,
    nodeCount: 0,
    truncated: false,
    throttleSleepMs: 0,
  });

  it("starts from the given after cursor", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([{ id: "x" }], { hasNextPage: false, endCursor: null }));

    await paginateConnection({ ...baseOptions(graphql), after: "resume-here" });

    expect(graphql.mock.calls[0][1].variables.after).toBe("resume-here");
  });

  it("records the end cursor and hasMore when the chunk cap stops the walk", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: "a" }, { id: "b" }], { hasNextPage: true, endCursor: "c2" }),
      );
    const stats = freshStats();

    await paginateConnection({ ...baseOptions(graphql), pageSize: 2, maxNodes: 2, stats });

    expect(stats).toMatchObject({ truncated: true, hasMore: true, endCursor: "c2" });
  });

  it("stops at the deadline with hasMore set but NOT truncated, and never sleeps past it", async () => {
    // The page reports low headroom: without the deadline the walk would sleep
    // before requesting page 2. Past the deadline it must stop first.
    const graphql = vi.fn().mockResolvedValueOnce(
      page(
        [{ id: "a" }],
        { hasNextPage: true, endCursor: "c1" },
        {
          currentlyAvailable: 0,
          restoreRate: 1,
        },
      ),
    );
    const stats = freshStats();
    const started = Date.now();

    const result = await paginateConnection({
      ...baseOptions(graphql),
      stats,
      deadline: Date.now() - 1,
    });

    expect(result).toEqual([{ id: "a" }]);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ truncated: false, hasMore: true, endCursor: "c1" });
    expect(stats.throttleSleepMs).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps paging while the deadline has not passed", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(page([{ id: "b" }], { hasNextPage: false, endCursor: null }));
    const stats = freshStats();

    const result = await paginateConnection({
      ...baseOptions(graphql),
      stats,
      deadline: Date.now() + 60_000,
    });

    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(stats.hasMore).toBe(false);
  });

  it("an empty page with hasNextPage still true reports hasMore false (no endless resume)", async () => {
    const graphql = vi.fn().mockResolvedValue(page([], { hasNextPage: true, endCursor: "c1" }));
    const stats = freshStats();

    await paginateConnection({ ...baseOptions(graphql), stats });

    expect(stats.hasMore).toBe(false);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

describe("paginateConnection cost-aware backoff (gc-747u)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a whole page's requested cost, not the flat 100 points", async () => {
    // 150 available, page requests 650, restore 50/s: needs (650-150)/50 = 10 s.
    // The flat threshold (100) alone would not sleep at all and the next request
    // would come back THROTTLED.
    const costlyPage = (hasNextPage: boolean) => ({
      json: vi.fn().mockResolvedValue({
        data: { items: { nodes: [{ id: "a" }], pageInfo: { hasNextPage, endCursor: "c1" } } },
        extensions: {
          cost: {
            requestedQueryCost: 650,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 150, restoreRate: 50 },
          },
        },
      }),
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(costlyPage(true))
      .mockResolvedValueOnce(costlyPage(false));
    const stats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 };

    const promise = paginateConnection({ ...baseOptions(graphql), stats });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(graphql).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(stats.throttleSleepMs).toBe(10_000);
  });
});

describe("fetchExactCount (gc-747u)", () => {
  const countResponse = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) });

  it("returns an EXACT count and asks for no limit", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        countResponse({ data: { productsCount: { count: 7213, precision: "EXACT" } } }),
      );

    await expect(fetchExactCount(makeAdmin(graphql), "productsCount")).resolves.toBe(7213);
    expect(graphql.mock.calls[0][0]).toContain("productsCount(limit: null)");
  });

  it.each([
    ["a non-exact count", { data: { urlRedirectsCount: { count: 10000, precision: "AT_LEAST" } } }],
    ["a GraphQL error", { errors: [{ message: "Access denied" }] }],
    ["a null count", { data: { urlRedirectsCount: null } }],
  ])("returns null on %s", async (_label, body) => {
    const graphql = vi.fn().mockResolvedValue(countResponse(body));
    await expect(fetchExactCount(makeAdmin(graphql), "urlRedirectsCount")).resolves.toBeNull();
  });

  it("returns null (never throws) when the request itself fails", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("network"));
    await expect(fetchExactCount(makeAdmin(graphql), "productsCount")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gc-747u audit #2: a THROTTLED retry never sleeps past the step deadline
// ---------------------------------------------------------------------------

describe("paginateConnection THROTTLED retry vs the step deadline (gc-747u #2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const throttled = () =>
    errorPage([{ message: "Throttled", extensions: { code: "THROTTLED" } }], {
      currentlyAvailable: 0,
      restoreRate: 50,
    });

  it("stops with hasMore and the SAME cursor when the backoff sleep would cross the deadline", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValue(throttled());
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    // 0 of 100 points at 50/s = a 2 s backoff; only 1 s of budget is left.
    const promise = paginateConnection({
      ...baseOptions(graphql),
      stats,
      deadline: Date.now() + 1_000,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([{ id: "a" }]);
    // Page 1 + ONE throttled attempt: no sleep, no retry past the deadline.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({
      hasMore: true,
      endCursor: "c1",
      truncated: false,
      throttleStopped: true,
      throttleSleepMs: 0,
    });
  });

  it("a throttle stop on the walk's FIRST request is resumable from the start (null cursor)", async () => {
    const graphql = vi.fn().mockResolvedValue(throttled());
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    const promise = paginateConnection({
      ...baseOptions(graphql),
      stats,
      deadline: Date.now() + 1_000,
    });
    await vi.runAllTimersAsync();
    expect(await promise).toEqual([]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ hasMore: true, endCursor: null, throttleStopped: true });
  });

  it("still sleeps and retries when the backoff fits inside the deadline", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(page([{ id: "a" }], { hasNextPage: false, endCursor: null }));
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    const promise = paginateConnection({
      ...baseOptions(graphql),
      stats,
      deadline: Date.now() + 15_000,
    });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual([{ id: "a" }]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(stats.throttleSleepMs).toBe(2_000);
    expect(stats.throttleStopped).toBeUndefined();
  });

  it("without a deadline, keeps the old retry-then-throw behaviour", async () => {
    const graphql = vi.fn().mockResolvedValue(throttled());

    const promise = paginateConnection({ ...baseOptions(graphql), maxThrottleRetries: 2 });
    const assertion = expect(promise).rejects.toThrow("still THROTTLED after 2 retries");
    await vi.runAllTimersAsync();
    await assertion;
    expect(graphql).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// gc-747u audit #3: the rate-limit wait survives the step boundary
// ---------------------------------------------------------------------------

describe("paginateConnection throttle carry-over between steps (gc-747u #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const lowHeadroomPage = () => ({
    json: vi.fn().mockResolvedValue({
      data: { items: { nodes: [{ id: "a" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
      extensions: {
        cost: {
          requestedQueryCost: 650,
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 150, restoreRate: 50 },
        },
      },
    }),
  });

  it("a deadline stop records the last throttle status for the next step", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(lowHeadroomPage());
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    await paginateConnection({ ...baseOptions(graphql), stats, deadline: Date.now() - 1 });

    expect(stats.throttleSleepMs).toBe(0);
    expect(stats.throttle).toEqual({
      currentlyAvailable: 150,
      maximumAvailable: 1000,
      restoreRate: 50,
      requestedQueryCost: 650,
      observedAt: 5_000_000,
    });
  });

  it("the next step waits for the carried status BEFORE its first request", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([{ id: "b" }], { hasNextPage: false, endCursor: null }));
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    // Observed now: 150 of the 650 needed, 50/s refill => a 10 s wait.
    const promise = paginateConnection({
      ...baseOptions(graphql),
      stats,
      after: "c1",
      initialThrottle: {
        currentlyAvailable: 150,
        maximumAvailable: 1000,
        restoreRate: 50,
        requestedQueryCost: 650,
        observedAt: Date.now(),
      },
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(graphql).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(stats.throttleSleepMs).toBe(10_000);
  });

  it("a THROTTLED stop carries the throttled response's status", async () => {
    const graphql = vi.fn().mockResolvedValue(
      errorPage([{ extensions: { code: "THROTTLED" } }], {
        currentlyAvailable: 0,
        restoreRate: 50,
      }),
    );
    const stats: PaginateStats = {
      pageCount: 0,
      nodeCount: 0,
      truncated: false,
      throttleSleepMs: 0,
    };

    await paginateConnection({ ...baseOptions(graphql), stats, deadline: Date.now() + 1_000 });

    expect(stats.throttle).toMatchObject({ currentlyAvailable: 0, restoreRate: 50 });
  });
});
