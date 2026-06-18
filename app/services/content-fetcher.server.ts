/**
 * Content data fetcher service.
 *
 * Queries Shopify Admin API for pages and other content.
 * Requires `read_content` scope.
 */

import { type GraphQLConnection, paginateConnection } from "../lib/graphql-pagination.server";
import { probeScope } from "../lib/scope-check.server";
import type { AdminApiContext } from "../types/shopify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageData = {
  id: string;
  title: string;
  handle: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const PAGES_QUERY = `
  query Pages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      nodes {
        id
        title
        handle
        body
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------

/**
 * Check if the read_content scope is available by attempting a lightweight query.
 *
 * Returns false ONLY on a genuine ACCESS_DENIED (scope not granted). Transient
 * failures (THROTTLED, network, 5xx, timeout) throw a TransientScopeCheckError
 * so the caller retries instead of silently treating the scope as missing.
 * See app/lib/scope-check.server.ts (LOG-9).
 */
export async function hasContentScope(admin: AdminApiContext): Promise<boolean> {
  return probeScope(admin, `{ pages(first: 1) { nodes { id } } }`, "read_content");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Max characters to keep from page body to avoid memory bloat. */
const MAX_BODY_LENGTH = 500;

/**
 * Fetch pages from the store. Paginates through all pages.
 * Caps at `maxPages` (default 250) to keep API cost manageable.
 *
 * Body content is truncated to 500 characters to avoid memory bloat —
 * the detector only needs a short preview for the code snippet.
 *
 * Uses cursor-based pagination with 50 pages per request.
 */
export async function fetchPages(
  admin: AdminApiContext,
  maxPages: number = 250,
): Promise<PageData[]> {
  const PAGE_SIZE = 50;

  type PageNode = {
    id: string;
    title: string;
    handle: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  };

  return paginateConnection<PageNode, PageData>({
    admin,
    query: PAGES_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxPages,
    errorContext: "[content-fetcher] Failed to fetch pages",
    getConnection: (data) =>
      (data as { pages?: GraphQLConnection<PageNode> } | null | undefined)?.pages,
    // Body is truncated to avoid memory bloat — the detector only needs a preview.
    mapNode: (node) => [
      {
        id: node.id,
        title: node.title,
        handle: node.handle,
        body: node.body ? node.body.slice(0, MAX_BODY_LENGTH) : "",
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      },
    ],
  });
}
