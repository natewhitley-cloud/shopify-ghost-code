/**
 * URL redirect fetcher service.
 *
 * Queries Shopify Admin API for URL redirects.
 * Requires `read_url_redirects` scope.
 */

import { checkRateLimit } from "./theme-fetcher.server";
import type { AdminApiContext } from "../types/shopify";

export type RedirectData = {
  id: string;
  path: string;
  target: string;
};

// ---------------------------------------------------------------------------
// Scope check
// ---------------------------------------------------------------------------

/**
 * Test whether the current session has the `read_online_store_navigation`
 * scope by attempting a minimal query.
 *
 * Returns true if the query succeeds; false if it returns errors (typically
 * an access-denied error when the scope is not granted).
 */
export async function hasNavigationScope(admin: AdminApiContext): Promise<boolean> {
  try {
    const response = await admin.graphql(`{ urlRedirects(first: 1) { nodes { id } } }`);
    const json = (await response.json()) as { errors?: Array<{ message: string }> };
    return !json.errors?.length;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const REDIRECTS_QUERY = `
  query UrlRedirects($first: Int!, $after: String) {
    urlRedirects(first: $first, after: $after) {
      nodes {
        id
        path
        target
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch URL redirects from the Shopify Admin API, handling cursor-based
 * pagination.
 *
 * - Uses `first: 50` per page to stay within rate limits.
 * - Caps total redirects at `maxRedirects` (default 1000) to avoid
 *   excessive API calls on stores with thousands of redirects.
 * - Backs off automatically when the rate-limit headroom falls below 100 pts.
 *
 * @param admin         Shopify admin API context.
 * @param maxRedirects  Maximum number of redirects to fetch (default 1000).
 */
export async function fetchRedirects(
  admin: AdminApiContext,
  maxRedirects = 1000,
): Promise<RedirectData[]> {
  const redirects: RedirectData[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const PAGE_SIZE = 50;

  while (hasNextPage && redirects.length < maxRedirects) {
    const response = await admin.graphql(REDIRECTS_QUERY, {
      variables: {
        first: PAGE_SIZE,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        urlRedirects?: {
          nodes?: Array<{ id: string; path: string; target: string }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[redirect-fetcher] Failed to fetch redirects: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.urlRedirects?.nodes ?? [];
    const pageInfo = json.data?.urlRedirects?.pageInfo ?? {};

    for (const node of nodes) {
      if (redirects.length >= maxRedirects) break;
      redirects.push({
        id: node.id,
        path: node.path,
        target: node.target,
      });
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor ?? null;

    // Check rate limits after each page; sleep if needed before continuing.
    await checkRateLimit(json.extensions);
  }

  return redirects;
}
