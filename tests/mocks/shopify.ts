import { vi } from "vitest";

export function createMockAdmin() {
  return {
    admin: {
      graphql: vi.fn(),
      rest: undefined, // REST is blocked in Shopify GraphQL-only apps
    },
    session: {
      shop: "test-shop.myshopify.com",
      accessToken: "test-token",
    },
    billing: {
      require: vi.fn(),
      request: vi.fn(),
      check: vi.fn(),
    },
  };
}

export function createMockWebhook(
  overrides?: Partial<{ shop: string; topic: string }>
) {
  return {
    shop: overrides?.shop ?? "test-shop.myshopify.com",
    topic: overrides?.topic ?? "APP_UNINSTALLED",
    session: { shop: overrides?.shop ?? "test-shop.myshopify.com" },
    payload: {},
    admin: null,
  };
}

// Mock GraphQL response factory — includes the extensions.cost block Shopify always returns.
export function createMockGraphQLResponse(data: any, errors?: any[]) {
  return {
    json: vi.fn().mockResolvedValue({
      data,
      errors: errors ?? undefined,
      extensions: {
        cost: {
          requestedQueryCost: 10,
          actualQueryCost: 8,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1992,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

// Mock THROTTLED error response — used when the API rate limit is hit.
export function createThrottledResponse() {
  return createMockGraphQLResponse(null, [
    { message: "Throttled", extensions: { code: "THROTTLED" } },
  ]);
}
