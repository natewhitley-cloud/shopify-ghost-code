import { describe, it, expect, vi } from "vitest";

import {
  fetchMainTheme,
  fetchThemeFiles,
  fetchAllThemes,
  ThemeTooLargeError,
  MAX_THEME_TOTAL_TEXT_BYTES,
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
  // gc-8s2: aggregate text ceiling. Bounds memory DURING the fetch (not after),
  // so a pathological theme can never be held whole in the main thread and
  // again in the worker.
  describe("total theme size ceiling", () => {
    it("throws ThemeTooLargeError and stops paginating once cumulative text exceeds the cap", async () => {
      const graphql = vi
        .fn()
        .mockResolvedValueOnce(
          makeThemeFilesResponse(
            [
              { filename: "layout/theme.liquid", body: { content: "aaaa" } }, // 4
              { filename: "templates/index.liquid", body: { content: "bbbb" } }, // 8 > 6
            ],
            { hasNextPage: true, endCursor: "cursor-1" },
          ),
        )
        .mockResolvedValueOnce(
          makeThemeFilesResponse([{ filename: "sections/x.liquid", body: { content: "c" } }], {
            hasNextPage: false,
            endCursor: null,
          }),
        );

      const err = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
        maxTotalBytes: 6,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ThemeTooLargeError);
      expect((err as ThemeTooLargeError).maxTotalBytes).toBe(6);
      // Cumulative text length at the moment of abort (4 + 4), so calibration
      // can see how far over the cap a real theme ran (gc-d4e follow-up).
      expect((err as ThemeTooLargeError).bytesAtAbort).toBe(8);
      expect((err as ThemeTooLargeError).themeId).toBe("gid://shopify/Theme/1");
      expect((err as ThemeTooLargeError).message).toContain("gid://shopify/Theme/1");
      expect(graphql).toHaveBeenCalledTimes(1); // aborted before fetching page 2
    });

    it("allows a theme exactly at the cap", async () => {
      const graphql = vi.fn().mockResolvedValue(
        makeThemeFilesResponse(
          [
            { filename: "layout/theme.liquid", body: { content: "aaa" } },
            { filename: "templates/index.liquid", body: { content: "bbb" } },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );

      const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
        maxTotalBytes: 6,
      });
      expect(files).toHaveLength(2);
    });

    it("does not count binary (no-text) files toward the cap", async () => {
      const graphql = vi.fn().mockResolvedValue(
        makeThemeFilesResponse(
          [
            { filename: "assets/logo.png", body: {} },
            { filename: "layout/theme.liquid", body: { content: "aaaaaa" } },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );

      const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
        maxTotalBytes: 6,
      });
      expect(files.map((f) => f.filename)).toEqual(["layout/theme.liquid"]);
    });

    it("defaults to a ceiling far above any real theme (normal themes unaffected)", () => {
      expect(MAX_THEME_TOTAL_TEXT_BYTES).toBeGreaterThanOrEqual(50_000_000);
    });
  });

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

  // LOG-5: previously this returned an empty array (break-and-return), which let
  // a transient soft-failure complete a scan as "clean" and wipe prior findings.
  // It must now throw so the scan is retried and ultimately marked FAILED.
  it("throws (including the themeId) when theme data is null without a GraphQL errors array", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { theme: null },
        extensions: {},
      }),
    });

    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/999")).rejects.toThrow(
      "No theme data returned for theme gid://shopify/Theme/999",
    );
  });

  it("throws when theme data is undefined (missing data block entirely)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: {}, extensions: {} }),
    });

    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1")).rejects.toThrow(
      "No theme data returned for theme gid://shopify/Theme/1",
    );
  });

  // LOG-5: theme data disappearing mid-pagination must also throw — a retry is
  // safer than persisting the partial file list accumulated from earlier pages.
  it("throws when theme data disappears mid-pagination instead of returning a partial list", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeThemeFilesResponse([{ filename: "layout/theme.liquid", body: { content: "a" } }], {
          hasNextPage: true,
          endCursor: "cursor-1",
        }),
      )
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({ data: { theme: null }, extensions: {} }),
      });

    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/7")).rejects.toThrow(
      "No theme data returned for theme gid://shopify/Theme/7",
    );
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

// ---------------------------------------------------------------------------
// gc-wr81: files returned without a text body are dropped from the result, but
// their NAMES are reported, so a caller can tell "exists" from "missing".
// ---------------------------------------------------------------------------

describe("fetchThemeFiles: onFileWithoutText (gc-wr81)", () => {
  type Node = { filename: string; body?: { content?: string | null } | null };
  const respond = (nodes: Node[], hasNextPage = false, endCursor: string | null = null) =>
    makeThemeFilesResponse(nodes as Parameters<typeof makeThemeFilesResponse>[0], {
      hasNextPage,
      endCursor,
    });

  it("reports every file whose body is not text, and returns the rest unchanged", async () => {
    const graphql = vi.fn().mockResolvedValue(
      respond([
        { filename: "layout/theme.liquid", body: { content: "html" } },
        // A base64 or URL body: the text fragment selects nothing.
        { filename: "snippets/huge.liquid", body: {} },
        { filename: "snippets/null-content.liquid", body: { content: null } },
        { filename: "snippets/null-body.liquid", body: null },
        { filename: "snippets/no-body.liquid" },
        { filename: "assets/logo.png", body: {} },
      ]),
    );
    const reported: string[] = [];

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileWithoutText: (filename) => reported.push(filename),
    });

    expect(files).toEqual([{ filename: "layout/theme.liquid", content: "html" }]);
    expect(reported).toEqual([
      "snippets/huge.liquid",
      "snippets/null-content.liquid",
      "snippets/null-body.liquid",
      "snippets/no-body.liquid",
      "assets/logo.png",
    ]);
  });

  it("a file whose text is EMPTY is a text file: returned, not reported", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(respond([{ filename: "snippets/empty.liquid", body: { content: "" } }]));
    const onFileWithoutText = vi.fn();

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileWithoutText,
    });

    expect(files).toEqual([{ filename: "snippets/empty.liquid", content: "" }]);
    expect(onFileWithoutText).not.toHaveBeenCalled();
  });

  it("reports across pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(respond([{ filename: "snippets/a.liquid", body: {} }], true, "c1"))
      .mockResolvedValueOnce(respond([{ filename: "snippets/b.liquid", body: {} }]));
    const reported: string[] = [];

    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileWithoutText: (filename) => reported.push(filename),
    });

    expect(reported).toEqual(["snippets/a.liquid", "snippets/b.liquid"]);
  });

  it("is optional: without it, text-less files are skipped as before", async () => {
    const graphql = vi.fn().mockResolvedValue(
      respond([
        { filename: "snippets/huge.liquid", body: {} },
        { filename: "layout/theme.liquid", body: { content: "html" } },
      ]),
    );
    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1")).resolves.toEqual([
      { filename: "layout/theme.liquid", content: "html" },
    ]);
  });

  it("text-less files do not count toward the total text ceiling", async () => {
    const graphql = vi.fn().mockResolvedValue(
      respond([
        { filename: "snippets/huge.liquid", body: {} },
        { filename: "layout/theme.liquid", body: { content: "aaaa" } },
      ]),
    );
    await expect(
      fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
        maxTotalBytes: 4,
        onFileWithoutText: () => {},
      }),
    ).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// gc-rrh.4: every file's metadata (checksum, size, updatedAt) is reported,
// text or binary, for the change-log manifest. The returned files are exactly
// as before.
// ---------------------------------------------------------------------------

describe("fetchThemeFiles: onFileMeta (gc-rrh.4)", () => {
  type Node = {
    filename: string;
    checksumMd5?: string | null;
    size?: string | number | null;
    updatedAt?: string | null;
    body?: { content?: string | null } | null;
  };
  const respond = (nodes: Node[], hasNextPage = false, endCursor: string | null = null) =>
    makeThemeFilesResponse(nodes as Parameters<typeof makeThemeFilesResponse>[0], {
      hasNextPage,
      endCursor,
    });
  const MD5 = "0cc175b9c0f1b6a831c399e269772661";
  const AT = "2026-10-12T08:30:00Z";

  it("asks for checksumMd5, size and updatedAt in the same files query", async () => {
    const graphql = vi.fn().mockResolvedValue(respond([]));
    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1");
    const query = graphql.mock.calls[0][0] as string;
    expect(graphql).toHaveBeenCalledTimes(1);
    for (const field of ["checksumMd5", "size", "updatedAt", "filename", "content"]) {
      expect(query).toContain(field);
    }
  });

  it("reports text AND binary files, in order, and returns only the text files as before", async () => {
    const graphql = vi.fn().mockResolvedValue(
      respond([
        {
          filename: "layout/theme.liquid",
          checksumMd5: MD5,
          size: "4",
          updatedAt: AT,
          body: { content: "html" },
        },
        { filename: "assets/logo.png", checksumMd5: MD5, size: "2048", updatedAt: AT, body: {} },
      ]),
    );
    const metas: unknown[] = [];

    const files = await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileMeta: (meta) => metas.push(meta),
    });

    expect(files).toEqual([{ filename: "layout/theme.liquid", content: "html" }]);
    expect(metas).toEqual([
      { filename: "layout/theme.liquid", checksumMd5: MD5, size: 4, updatedAt: AT },
      { filename: "assets/logo.png", checksumMd5: MD5, size: 2048, updatedAt: AT },
    ]);
  });

  it("missing or malformed values become null, never a made-up value", async () => {
    const graphql = vi.fn().mockResolvedValue(
      respond([
        { filename: "a.liquid", body: { content: "" } },
        { filename: "b.liquid", checksumMd5: "", size: "not-a-number", updatedAt: "", body: {} },
        { filename: "c.liquid", checksumMd5: null, size: -1, updatedAt: null, body: {} },
        { filename: "d.liquid", size: 12, body: {} },
      ]),
    );
    const metas: unknown[] = [];

    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileMeta: (meta) => metas.push(meta),
    });

    expect(metas).toEqual([
      { filename: "a.liquid", checksumMd5: null, size: null, updatedAt: null },
      { filename: "b.liquid", checksumMd5: null, size: null, updatedAt: null },
      { filename: "c.liquid", checksumMd5: null, size: null, updatedAt: null },
      { filename: "d.liquid", checksumMd5: null, size: 12, updatedAt: null },
    ]);
  });

  it("reports across pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(respond([{ filename: "snippets/a.liquid", body: {} }], true, "c1"))
      .mockResolvedValueOnce(respond([{ filename: "snippets/b.liquid", body: { content: "b" } }]));
    const names: string[] = [];

    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileMeta: (meta) => names.push(meta.filename),
    });

    expect(names).toEqual(["snippets/a.liquid", "snippets/b.liquid"]);
  });

  it("a file over the per-file size is still reported (metadata never reads content)", async () => {
    const big = "x".repeat(2_000_000);
    const graphql = vi
      .fn()
      .mockResolvedValue(
        respond([{ filename: "assets/big.js", size: "2000000", body: { content: big } }]),
      );
    const metas: Array<{ filename: string; size: number | null }> = [];

    await fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1", undefined, {
      onFileMeta: (meta) => metas.push(meta),
    });

    expect(metas).toEqual([
      { filename: "assets/big.js", checksumMd5: null, size: 2_000_000, updatedAt: null },
    ]);
  });

  it("is optional: without it, the result is unchanged", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        respond([{ filename: "layout/theme.liquid", checksumMd5: MD5, body: { content: "html" } }]),
      );
    await expect(fetchThemeFiles(makeAdmin(graphql), "gid://shopify/Theme/1")).resolves.toEqual([
      { filename: "layout/theme.liquid", content: "html" },
    ]);
  });
});
