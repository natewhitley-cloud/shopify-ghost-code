/**
 * Content data fetcher service.
 *
 * Queries Shopify Admin API for pages and other content.
 * Requires `read_content` scope.
 */

import { checkRateLimit } from "./theme-fetcher.server";
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
  const pages: PageData[] = [];
  let cursor: string | null = null;
  const PAGE_SIZE = 50;

  while (pages.length < maxPages) {
    const first = Math.min(PAGE_SIZE, maxPages - pages.length);
    const response = await admin.graphql(PAGES_QUERY, {
      variables: {
        first,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        pages?: {
          nodes?: Array<{
            id: string;
            title: string;
            handle: string;
            body: string;
            createdAt: string;
            updatedAt: string;
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[content-fetcher] Failed to fetch pages: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.pages?.nodes ?? [];
    const pageInfo = json.data?.pages?.pageInfo ?? {};

    for (const node of nodes) {
      pages.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        body: node.body ? node.body.slice(0, MAX_BODY_LENGTH) : "",
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      });
    }

    if (!pageInfo.hasNextPage || nodes.length === 0) break;
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

  return pages;
}
