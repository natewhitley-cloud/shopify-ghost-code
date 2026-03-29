import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchMainTheme,
  fetchThemeFiles,
  fetchAllThemes,
  checkRateLimit,
} from "../../app/services/theme-fetcher.server";
import { createMockGraphQLResponse } from "../mocks/shopify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof fetchMainTheme>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

function makeThemeFilesResponse(
  nodes: Array<{ filename: string; body?: { content?: string } }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  throttle?: { currentlyAvailable: number; restoreRate: number },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        theme: {
          files: { nodes, pageInfo },
        },
      },
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

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns Infinity when extensions is nullish", async () => {
    const result = await checkRateLimit(null);
    expect(result).toBe(Infinity);
  });

  it("returns Infinity when extensions has no cost block", async () => {
    const result = await checkRateLimit({});
    expect(result).toBe(Infinity);
  });

  it("returns currentlyAvailable without sleeping when headroom is sufficient", async () => {
    const sleepSpy = vi.spyOn(global, "setTimeout");
    const result = await checkRateLimit({
      cost: {
        throttleStatus: { currentlyAvailable: 500, restoreRate: 50 },
      },
    });
    expect(result).toBe(500);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("sleeps and returns RATE_LIMIT_THRESHOLD when headroom is below 100", async () => {
    const advanceSpy = vi.spyOn(global, "setTimeout");
    const promise = checkRateLimit({
      cost: {
        throttleStatus: { currentlyAvailable: 50, restoreRate: 100 },
      },
    });
    // Advance timers so the sleep resolves
    vi.runAllTimers();
    const result = await promise;
    // Should have scheduled at least one timer
    expect(advanceSpy).toHaveBeenCalled();
    expect(result).toBe(100); // the RATE_LIMIT_THRESHOLD sentinel
  });

  it("computes sleep duration proportional to points needed and restore rate", async () => {
    const sleepDurations: number[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      sleepDurations.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await checkRateLimit({
      cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } },
    });

    // 100 pts needed / 50 pts/sec * 1000 = 2000ms
    expect(sleepDurations[0]).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// fetchMainTheme
// ---------------------------------------------------------------------------

describe("fetchMainTheme", () => {
  it("returns id, name, and updatedAt when a MAIN theme exists", async () => {
    const updatedAt = "2026-01-15T12:00:00Z";
    const graphql = vi.fn().mockResolvedValue(
      createMockGraphQLResponse({
        themes: {
          nodes: [{ id: "gid://shopify/Theme/123", name: "Dawn", updatedAt }],
        },
      }),
    );

    const result = await fetchMainTheme(makeAdmin(graphql));

    expect(result).not.toBeNull();
    expect(result!.id).toBe("gid://shopify/Theme/123");
    expect(result!.name).toBe("Dawn");
    expect(result!.updatedAt).toEqual(new Date(updatedAt));
  });

  it("returns null when no MAIN theme is found", async () => {
    const graphql = vi.fn().mockResolvedValue(createMockGraphQLResponse({ themes: { nodes: [] } }));

    const result = await fetchMainTheme(makeAdmin(graphql));
    expect(result).toBeNull();
  });

  it("throws when the response contains GraphQL errors", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(createMockGraphQLResponse(null, [{ message: "ACCESS_DENIED" }]));

    await expect(fetchMainTheme(makeAdmin(graphql))).rejects.toThrow("Failed to fetch main theme");
  });
});

// ---------------------------------------------------------------------------
// fetchThemeFiles
// ---------------------------------------------------------------------------

describe("fetchThemeFiles", () => {
  it("returns files from a single page", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeThemeFilesResponse(
        [
          { filename: "layout/theme.liquid", body: { content: "{{ content_for_layout }}" } },
          { filename: "templates/index.liquid", body: { content: "<h1>Home</h1>" } },
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1");
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      filename: "layout/theme.liquid",
      content: "{{ content_for_layout }}",
    });
  });

  it("paginates through multiple pages and concatenates results", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeThemeFilesResponse([{ filename: "layout/theme.liquid", body: { content: "a" } }], {
          hasNextPage: true,
          endCursor: "cursor-1",
        }),
      )
      .mockResolvedValueOnce(
        makeThemeFilesResponse([{ filename: "templates/index.liquid", body: { content: "b" } }], {
          hasNextPage: false,
          endCursor: null,
        }),
      );

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1");
    expect(files).toHaveLength(2);
    expect(graphql).toHaveBeenCalledTimes(2);
    // Second call should include the cursor from the first page
    expect(graphql.mock.calls[1][1]).toMatchObject({
      variables: { after: "cursor-1" },
    });
  });

  it("skips files with no text content (binary assets)", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeThemeFilesResponse(
        [
          { filename: "assets/image.png", body: {} }, // no content field
          { filename: "layout/theme.liquid", body: { content: "html" } },
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1");
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("layout/theme.liquid");
  });

  it("returns empty array and logs when theme data is missing", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { theme: null },
        extensions: {},
      }),
    });

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/999");
    expect(files).toHaveLength(0);
  });

  it("throws when the response contains GraphQL errors", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(createMockGraphQLResponse(null, [{ message: "Theme not found" }]));

    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1")).rejects.toThrow(
      "Failed to fetch files for theme",
    );
  });

  it("passes variables without after cursor on first page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeThemeFilesResponse([], { hasNextPage: false, endCursor: null }));

    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/42");
    const call = graphql.mock.calls[0];
    expect(call[1].variables.after).toBeUndefined();
    expect(call[1].variables.first).toBe(250);
    expect(call[1].variables.themeId).toBe("gid://shopify/Theme/42");
  });
});

// ---------------------------------------------------------------------------
// fetchAllThemes helpers
// ---------------------------------------------------------------------------

type ThemeNode = { id: string; name: string; role: string; updatedAt: string };

function makeAllThemesResponse(
  nodes: ThemeNode[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        themes: { nodes, pageInfo },
      },
      extensions: {
        cost: {
          throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1800, restoreRate: 100 },
        },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// fetchAllThemes
// ---------------------------------------------------------------------------

describe("fetchAllThemes", () => {
  it("returns themes from a single page including role field", async () => {
    const nodes: ThemeNode[] = [
      {
        id: "gid://shopify/Theme/1",
        name: "Dawn",
        role: "MAIN",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/2",
        name: "Craft",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse(nodes, { hasNextPage: false, endCursor: null }));

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(result).toHaveLength(2);
    // Every returned object must carry the role field
    for (const theme of result) {
      expect(theme).toHaveProperty("role");
    }
  });

  it("sorts MAIN theme first, then remaining themes alphabetically", async () => {
    const nodes: ThemeNode[] = [
      {
        id: "gid://shopify/Theme/3",
        name: "Zephyr",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-03T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/1",
        name: "Aurora",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/2",
        name: "Midnight",
        role: "MAIN",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse(nodes, { hasNextPage: false, endCursor: null }));

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(result[0].role).toBe("MAIN");
    expect(result[0].name).toBe("Midnight");
    expect(result[1].name).toBe("Aurora");
    expect(result[2].name).toBe("Zephyr");
  });

  it("handles pagination by fetching all pages and concatenating results", async () => {
    const page1Nodes: ThemeNode[] = [
      {
        id: "gid://shopify/Theme/1",
        name: "Beta",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const page2Nodes: ThemeNode[] = [
      {
        id: "gid://shopify/Theme/2",
        name: "Alpha",
        role: "MAIN",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeAllThemesResponse(page1Nodes, { hasNextPage: true, endCursor: "cursor-page-1" }),
      )
      .mockResolvedValueOnce(
        makeAllThemesResponse(page2Nodes, { hasNextPage: false, endCursor: null }),
      );

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    // Second call must include the cursor from the first page
    expect(graphql.mock.calls[1][1]).toMatchObject({ variables: { after: "cursor-page-1" } });
  });

  it("does not include after variable on the first page request", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse([], { hasNextPage: false, endCursor: null }));

    await fetchAllThemes(makeAdmin(graphql));

    expect(graphql.mock.calls[0][1].variables.after).toBeUndefined();
  });

  it("returns empty array when the shop has no themes", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse([], { hasNextPage: false, endCursor: null }));

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(result).toEqual([]);
  });

  it("throws when the response contains GraphQL errors", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(createMockGraphQLResponse(null, [{ message: "ACCESS_DENIED" }]));

    await expect(fetchAllThemes(makeAdmin(graphql))).rejects.toThrow("Failed to fetch themes");
  });

  it("includes all required fields (id, name, role, updatedAt) on each returned theme", async () => {
    const node: ThemeNode = {
      id: "gid://shopify/Theme/99",
      name: "Sense",
      role: "MAIN",
      updatedAt: "2026-03-01T12:00:00Z",
    };
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse([node], { hasNextPage: false, endCursor: null }));

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(result[0]).toEqual({
      id: "gid://shopify/Theme/99",
      name: "Sense",
      role: "MAIN",
      updatedAt: "2026-03-01T12:00:00Z",
    });
  });

  it("sorts multiple non-MAIN themes alphabetically after MAIN", async () => {
    const nodes: ThemeNode[] = [
      {
        id: "gid://shopify/Theme/4",
        name: "Zebra",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-04T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/1",
        name: "Dawn",
        role: "MAIN",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/3",
        name: "Craft",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-03T00:00:00Z",
      },
      {
        id: "gid://shopify/Theme/2",
        name: "Aurora",
        role: "UNPUBLISHED",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const graphql = vi
      .fn()
      .mockResolvedValue(makeAllThemesResponse(nodes, { hasNextPage: false, endCursor: null }));

    const result = await fetchAllThemes(makeAdmin(graphql));

    expect(result.map((t) => t.name)).toEqual(["Dawn", "Aurora", "Craft", "Zebra"]);
  });
});
