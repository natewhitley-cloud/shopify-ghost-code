/**
 * URL redirect fetcher service.
 *
 * Queries Shopify Admin API for URL redirects.
 * Requires `read_online_store_navigation` scope.
 */

import { type GraphQLConnection, paginateConnection } from "../lib/graphql-pagination.server";
import { probeScope } from "../lib/scope-check.server";
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
 * Returns false ONLY on a genuine ACCESS_DENIED (scope not granted). Transient
 * failures (THROTTLED, network, 5xx, timeout) throw a TransientScopeCheckError
 * so the caller retries instead of silently treating the scope as missing.
 * See app/lib/scope-check.server.ts (LOG-9).
 */
export async function hasNavigationScope(admin: AdminApiContext): Promise<boolean> {
  return probeScope(
    admin,
    `{ urlRedirects(first: 1) { nodes { id } } }`,
    "read_online_store_navigation",
  );
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
  const PAGE_SIZE = 50;

  type RedirectNode = { id: string; path: string; target: string };

  return paginateConnection<RedirectNode, RedirectData>({
    admin,
    query: REDIRECTS_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxRedirects,
    errorContext: "[redirect-fetcher] Failed to fetch redirects",
    getConnection: (data) =>
      (data as { urlRedirects?: GraphQLConnection<RedirectNode> } | null | undefined)?.urlRedirects,
    mapNode: (node) => [{ id: node.id, path: node.path, target: node.target }],
  });
}
