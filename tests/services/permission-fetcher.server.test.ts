import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/installed-app.server", () => ({
  upsertInstalledApp: vi.fn().mockResolvedValue({}),
  markAppsRemovedByIds: vi.fn().mockResolvedValue(undefined),
  getInstalledApps: vi.fn().mockResolvedValue([]),
}));

import {
  upsertInstalledApp,
  markAppsRemovedByIds,
  getInstalledApps,
} from "../../app/models/installed-app.server";
import {
  fetchAllInstalledApps,
  fetchCurrentAppInstallation,
  syncInstalledApps,
  type FetchedApp,
} from "../../app/services/permission-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof fetchAllInstalledApps>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

/** Build a mock GraphQL response for appInstallations. */
function makeAppInstallationsResponse(
  nodes: Array<{
    app: {
      id: string;
      title: string;
      handle: string;
      description: string | null;
      publicCategory: string | null;
    };
    accessScopes: Array<{ handle: string; description: string | null }>;
    activeSubscriptions: Array<{ id: string }>;
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  throttle?: { currentlyAvailable: number; restoreRate: number },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: { appInstallations: { nodes, pageInfo } },
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

/** Build a mock GraphQL response for currentAppInstallation. */
function makeCurrentAppResponse(node: {
  app: {
    id: string;
    title: string;
    handle: string;
    description: string | null;
    publicCategory: string | null;
  };
  accessScopes: Array<{ handle: string; description: string | null }>;
  activeSubscriptions: Array<{ id: string }>;
}) {
  return {
    json: vi.fn().mockResolvedValue({
      data: { currentAppInstallation: node },
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

/** Build a mock GraphQL error response. */
function makeErrorResponse(
  errors: Array<{ message: string }>,
  forQuery: "appInstallations" | "currentAppInstallation" = "appInstallations",
) {
  return {
    json: vi.fn().mockResolvedValue({
      data:
        forQuery === "appInstallations"
          ? { appInstallations: null }
          : { currentAppInstallation: null },
      errors,
      extensions: {},
    }),
  };
}

const SAMPLE_APP_NODE = {
  app: {
    id: "gid://shopify/App/123",
    title: "Reviews Pro",
    handle: "reviews-pro",
    description: "Product reviews app",
    publicCategory: "reviews",
  },
  accessScopes: [
    { handle: "read_products", description: "Read products" },
    { handle: "write_products", description: "Write products" },
  ],
  activeSubscriptions: [{ id: "gid://shopify/AppSubscription/456" }],
};

const SAMPLE_APP_NODE_2 = {
  app: {
    id: "gid://shopify/App/789",
    title: "Shipping Helper",
    handle: "shipping-helper",
    description: null,
    publicCategory: "shipping",
  },
  accessScopes: [{ handle: "read_shipping", description: "Read shipping" }],
  activeSubscriptions: [],
};

// ---------------------------------------------------------------------------
// fetchAllInstalledApps
// ---------------------------------------------------------------------------

describe("fetchAllInstalledApps", () => {
  it("returns apps from a single page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeAppInstallationsResponse([SAMPLE_APP_NODE], { hasNextPage: false, endCursor: null }),
      );

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toHaveLength(1);
    expect(apps[0]).toEqual({
      id: "gid://shopify/App/123",
      title: "Reviews Pro",
      handle: "reviews-pro",
      description: "Product reviews app",
      publicCategory: "reviews",
      accessScopes: [
        { handle: "read_products", description: "Read products" },
        { handle: "write_products", description: "Write products" },
      ],
      hasActiveSubscription: true,
    });
  });

  it("paginates through multiple pages", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        makeAppInstallationsResponse([SAMPLE_APP_NODE], {
          hasNextPage: true,
          endCursor: "cursor-1",
        }),
      )
      .mockResolvedValueOnce(
        makeAppInstallationsResponse([SAMPLE_APP_NODE_2], { hasNextPage: false, endCursor: null }),
      );

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toHaveLength(2);
    expect(graphql).toHaveBeenCalledTimes(2);

    // Second call should include cursor
    const secondCallVars = graphql.mock.calls[1][1]?.variables;
    expect(secondCallVars).toMatchObject({ after: "cursor-1" });

    // First call should not include cursor
    const firstCallVars = graphql.mock.calls[0][1]?.variables;
    expect(firstCallVars.after).toBeUndefined();
  });

  it("handles scope error gracefully by returning empty array", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeErrorResponse([{ message: "ACCESS_DENIED: requires read_apps scope" }]),
      );

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toEqual([]);
  });

  it("handles permission error message by returning empty array", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeErrorResponse([{ message: "App does not have the required permissions" }]),
      );

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toEqual([]);
  });

  it("throws on non-scope GraphQL errors", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(makeErrorResponse([{ message: "Internal server error" }]));

    await expect(fetchAllInstalledApps(makeAdmin(graphql))).rejects.toThrow(
      "Failed to fetch app installations",
    );
  });

  it("handles network errors gracefully", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toEqual([]);
  });

  it("correctly maps hasActiveSubscription to false when no subscriptions", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeAppInstallationsResponse(
        [SAMPLE_APP_NODE_2], // no active subscriptions
        { hasNextPage: false, endCursor: null },
      ),
    );

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps[0].hasActiveSubscription).toBe(false);
  });

  it("stops pagination when appInstallations data is missing", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { appInstallations: null },
        extensions: {},
      }),
    });

    const apps = await fetchAllInstalledApps(makeAdmin(graphql));

    expect(apps).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fetchCurrentAppInstallation
// ---------------------------------------------------------------------------

describe("fetchCurrentAppInstallation", () => {
  it("returns the current app installation", async () => {
    const graphql = vi.fn().mockResolvedValue(makeCurrentAppResponse(SAMPLE_APP_NODE));

    const app = await fetchCurrentAppInstallation(makeAdmin(graphql));

    expect(app).toEqual({
      id: "gid://shopify/App/123",
      title: "Reviews Pro",
      handle: "reviews-pro",
      description: "Product reviews app",
      publicCategory: "reviews",
      accessScopes: [
        { handle: "read_products", description: "Read products" },
        { handle: "write_products", description: "Write products" },
      ],
      hasActiveSubscription: true,
    });
  });

  it("throws when the response contains GraphQL errors", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeErrorResponse([{ message: "Something went wrong" }], "currentAppInstallation"),
      );

    await expect(fetchCurrentAppInstallation(makeAdmin(graphql))).rejects.toThrow(
      "Failed to fetch current app installation",
    );
  });

  it("throws when currentAppInstallation data is null", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { currentAppInstallation: null },
        extensions: {},
      }),
    });

    await expect(fetchCurrentAppInstallation(makeAdmin(graphql))).rejects.toThrow(
      "No currentAppInstallation data returned",
    );
  });
});

// ---------------------------------------------------------------------------
// syncInstalledApps
// ---------------------------------------------------------------------------

describe("syncInstalledApps", () => {
  const mockUpsert = upsertInstalledApp as ReturnType<typeof vi.fn>;
  const mockMarkRemoved = markAppsRemovedByIds as ReturnType<typeof vi.fn>;
  const mockGetApps = getInstalledApps as ReturnType<typeof vi.fn>;

  const fetchedApps: FetchedApp[] = [
    {
      id: "gid://shopify/App/123",
      title: "Reviews Pro",
      handle: "reviews-pro",
      description: "Product reviews app",
      publicCategory: "reviews",
      accessScopes: [{ handle: "read_products", description: "Read products" }],
      hasActiveSubscription: true,
    },
    {
      id: "gid://shopify/App/789",
      title: "Shipping Helper",
      handle: "shipping-helper",
      description: null,
      publicCategory: "shipping",
      accessScopes: [],
      hasActiveSubscription: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApps.mockResolvedValue([]);
    mockUpsert.mockResolvedValue({});
    mockMarkRemoved.mockResolvedValue(undefined);
  });

  it("upserts each fetched app via model layer", async () => {
    await syncInstalledApps("shop-1", fetchedApps);

    expect(mockUpsert).toHaveBeenCalledTimes(2);

    expect(mockUpsert).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        shopifyAppId: "gid://shopify/App/123",
        appName: "Reviews Pro",
        appHandle: "reviews-pro",
        grantedScopes: '["read_products"]',
        grantedScopeCount: 1,
        hasActiveSubscription: true,
      }),
    );

    expect(mockUpsert).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        shopifyAppId: "gid://shopify/App/789",
        appName: "Shipping Helper",
        grantedScopes: "[]",
        grantedScopeCount: 0,
        hasActiveSubscription: false,
      }),
    );
  });

  it("marks apps not in fetchedApps as REMOVED", async () => {
    mockGetApps.mockResolvedValue([
      { id: "installed-app-old", shopifyAppId: "gid://shopify/App/999" },
      { id: "installed-app-123", shopifyAppId: "gid://shopify/App/123" },
    ]);

    await syncInstalledApps("shop-1", fetchedApps);

    expect(mockMarkRemoved).toHaveBeenCalledWith(["installed-app-old"]);
  });

  it("does not mark removals when all existing apps are in fetched set", async () => {
    mockGetApps.mockResolvedValue([
      { id: "installed-app-123", shopifyAppId: "gid://shopify/App/123" },
    ]);

    await syncInstalledApps("shop-1", fetchedApps);

    expect(mockMarkRemoved).toHaveBeenCalledWith([]);
  });

  it("handles empty fetchedApps array", async () => {
    mockGetApps.mockResolvedValue([
      { id: "installed-app-1", shopifyAppId: "gid://shopify/App/111" },
    ]);

    await syncInstalledApps("shop-1", []);

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockMarkRemoved).toHaveBeenCalledWith(["installed-app-1"]);
  });
});
