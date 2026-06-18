/**
 * Shared cursor-based GraphQL pagination helper (QLT-3 / PRF-3).
 *
 * Every fetcher service (themes, theme files, products, pages, redirects,
 * translations) used to hand-roll the same ~40-line loop: request a page,
 * check `errors`, read `nodes` + `pageInfo`, accumulate, advance the cursor,
 * and back off on rate limits. This consolidates that loop into one place.
 *
 * It also fixes PRF-3: a `THROTTLED` error mid-pagination previously threw and
 * failed the whole Inngest step, which then re-fetched every page from
 * scratch. Here a THROTTLED error backs off and *retries the current cursor*,
 * so earlier pages are never re-fetched.
 *
 * Layering: this lives in `app/lib` (a leaf utility). It depends only on the
 * rate-limit module and the shared Shopify type — services import it, never the
 * other way around.
 */

import {
  checkRateLimit,
  checkThrottleStatusFromExtensions,
  isThrottledError,
} from "./rate-limit-monitor.server";
import type { AdminApiContext } from "../types/shopify";

/** A Relay-style connection slice as returned inside a GraphQL response. */
export type GraphQLConnection<TNode> = {
  nodes?: TNode[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

/** Minimal shape of the JSON envelope returned by `admin.graphql`. */
type GraphQLResponseJson = {
  errors?: Array<{ message?: string; extensions?: { code?: unknown } | null }>;
  data?: unknown;
  extensions?: unknown;
};

export type PaginateOptions<TNode, TResult> = {
  /** Shopify admin API context (from authenticate.admin or an offline token). */
  admin: AdminApiContext;
  /** The GraphQL query. MUST accept `$first: Int!` and `$after: String`. */
  query: string;
  /**
   * Static variables merged into every page request (e.g. `{ themeId }` or
   * `{ resourceType, locale }`). `first` and `after` are managed by the helper
   * and must not be supplied here.
   */
  variables?: Record<string, unknown>;
  /** Items requested per page (the `$first` argument). */
  pageSize: number;
  /**
   * Optional cap on the number of raw nodes fetched across all pages. When set,
   * the final page requests only the remaining count so the API is never
   * over-queried. When omitted, pagination continues until `hasNextPage` is
   * false.
   */
  maxNodes?: number;
  /**
   * Prefix + action used to build fetch-failure messages, e.g.
   * `"[theme-fetcher] Failed to fetch themes"`. The first GraphQL error message
   * is appended as `": <message>"`.
   */
  errorContext: string;
  /**
   * When provided, throttle proximity is logged (warn/error) after each page.
   * Pass the shop's myshopify domain.
   */
  shopDomain?: string;
  /**
   * Maximum number of times a single page is retried after a THROTTLED error
   * before giving up and throwing. Defaults to 5.
   */
  maxThrottleRetries?: number;
  /**
   * Navigate the GraphQL `data` object to the relevant connection. May throw
   * for domain-specific "parent missing" cases (e.g. theme files where the
   * theme node is null — see theme-fetcher). Returning `null`/`undefined` is
   * treated as an empty page that ends pagination.
   */
  getConnection: (data: unknown) => GraphQLConnection<TNode> | null | undefined;
  /**
   * Map a single node to zero or more result items. Return `[]` to filter a
   * node out, `[x]` for the common 1:1 case, or several items to flatten
   * (e.g. one entry per translation on a node).
   */
  mapNode: (node: TNode) => TResult[];
};

/**
 * Drive cursor-based pagination over a Shopify GraphQL connection, handling
 * error checking, THROTTLED-resume, rate-limit backoff, and result mapping.
 *
 * @throws if the response contains a non-THROTTLED GraphQL error, or if a page
 *         stays THROTTLED past `maxThrottleRetries`.
 */
export async function paginateConnection<TNode, TResult>(
  options: PaginateOptions<TNode, TResult>,
): Promise<TResult[]> {
  const {
    admin,
    query,
    variables = {},
    pageSize,
    maxNodes,
    errorContext,
    shopDomain,
    maxThrottleRetries = 5,
    getConnection,
    mapNode,
  } = options;

  const results: TResult[] = [];
  let cursor: string | null = null;
  let totalNodes = 0;
  let throttleRetries = 0;

  for (;;) {
    // When capped, request only the remaining count on the final page so the
    // API is never over-queried.
    const first = maxNodes !== undefined ? Math.min(pageSize, maxNodes - totalNodes) : pageSize;
    if (maxNodes !== undefined && first <= 0) break;

    const response = await admin.graphql(query, {
      variables: {
        ...variables,
        first,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as GraphQLResponseJson;

    if (json.errors?.length) {
      // PRF-3: a THROTTLED error is transient — back off and retry the SAME
      // cursor so earlier pages are not re-fetched. Any other error is fatal.
      if (json.errors.some(isThrottledError)) {
        throttleRetries += 1;
        if (throttleRetries > maxThrottleRetries) {
          throw new Error(`${errorContext}: still THROTTLED after ${maxThrottleRetries} retries`);
        }
        // Back off using whatever throttle headroom the response reported; if it
        // carried none, checkRateLimit is a no-op and we retry promptly.
        await checkRateLimit(json.extensions);
        continue; // retry the same page — cursor unchanged
      }

      throw new Error(`${errorContext}: ${json.errors[0]?.message ?? "unknown error"}`);
    }

    // A successful page resets the per-page throttle retry budget.
    throttleRetries = 0;

    const connection = getConnection(json.data);
    const allNodes = connection?.nodes ?? [];
    const pageInfo = connection?.pageInfo ?? {};

    // Enforce maxNodes as a hard cap on nodes consumed. We request only the
    // remaining count via `first`, but trim defensively in case the API
    // over-returns so the cap is never exceeded.
    const nodes =
      maxNodes !== undefined && allNodes.length > maxNodes - totalNodes
        ? allNodes.slice(0, maxNodes - totalNodes)
        : allNodes;

    for (const node of nodes) {
      for (const item of mapNode(node)) {
        results.push(item);
      }
    }
    totalNodes += nodes.length;

    // Defensive: an empty page with hasNextPage still true would otherwise spin
    // forever (the cap is by node count, which is not advancing).
    if (allNodes.length === 0) break;
    if (maxNodes !== undefined && totalNodes >= maxNodes) break;
    if (!pageInfo.hasNextPage) break;

    cursor = pageInfo.endCursor ?? null;

    // Proactively back off before the next request, then log throttle proximity.
    await checkRateLimit(json.extensions);
    if (shopDomain) {
      checkThrottleStatusFromExtensions(shopDomain, json.extensions);
    }
  }

  return results;
}
