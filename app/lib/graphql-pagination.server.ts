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
  parseActualQueryCost,
  parseRequestedQueryCost,
  rateLimitSleepMs,
  throttleSnapshot,
  type ThrottleSnapshot,
  waitForThrottleSnapshot,
} from "./rate-limit-monitor.server";
import { recordApiError } from "../models/ops-event.server";
import type { AdminApiContext } from "../types/shopify";

/** A Relay-style connection slice as returned inside a GraphQL response. */
export type GraphQLConnection<TNode> = {
  nodes?: TNode[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

/**
 * Optional out-parameter the helper populates as it paginates (gc-1bd). Pass a
 * fresh object; the helper MUTATES it in place so the caller can read walk
 * observability without changing the return type (existing callers ignore it):
 *
 *   - `pageCount`:       number of GraphQL page requests that returned data
 *                        (THROTTLED retries of the same cursor are not counted).
 *   - `nodeCount`:       raw nodes consumed across all pages (after the cap trim).
 *   - `truncated`:       true iff the `maxNodes` cap stopped the walk while the
 *                        connection still reported `hasNextPage` — i.e. records
 *                        beyond the cap were NOT scanned. Used to mark a coverage
 *                        gap so the differ never false-resolves un-scanned records.
 *   - `throttleSleepMs`: accumulated wall-clock spent in proactive rate-limit
 *                        backoff (checkRateLimit sleeps only when headroom is low;
 *                        otherwise it adds ~0), summed across all pages.
 *   - `hasMore`:         true iff the walk stopped (cap OR `deadline`) while the
 *                        connection still had more nodes (gc-747u). A superset of
 *                        `truncated`: a deadline stop is NOT truncation, the
 *                        caller resumes from `endCursor` in a later step.
 *   - `endCursor`:       the cursor after the last consumed page (gc-747u), to
 *                        resume a chunked walk with `after`.
 *   - `throttleStopped`: true iff a THROTTLED backoff would have crossed
 *                        `deadline`, so the walk stopped instead of sleeping
 *                        (gc-747u audit #2). `hasMore` is true and `endCursor`
 *                        is the cursor to RETRY, which is null when the walk's
 *                        very first request was throttled (resume from the start).
 *   - `throttle`:        the last throttle status a response reported (gc-747u
 *                        audit #3). A deadline stop skips the rate-limit wait, so
 *                        a chunked caller passes this to the next step's
 *                        `initialThrottle` and the wait happens there instead.
 *   - `cost`:            query cost over the pages counted in `pageCount`
 *                        (gc-747u audit #7): max + sum of `requestedQueryCost`
 *                        (avg = sum / pageCount) and the sum of `actualQueryCost`.
 */
export type PaginateStats = {
  pageCount: number;
  nodeCount: number;
  truncated: boolean;
  throttleSleepMs: number;
  hasMore?: boolean;
  endCursor?: string | null;
  throttleStopped?: boolean;
  throttle?: ThrottleSnapshot | null;
  cost?: QueryCostStats;
};

/** Query cost over a walk's successful pages (gc-747u audit #7). */
export type QueryCostStats = {
  requestedMax: number;
  requestedSum: number;
  actualSum: number;
};

/** Combine per-step cost stats into one walk's (absent = no pages). */
export function sumQueryCost(parts: Array<QueryCostStats | null | undefined>): QueryCostStats {
  return parts.reduce<QueryCostStats>(
    (total, c) => ({
      requestedMax: Math.max(total.requestedMax, c?.requestedMax ?? 0),
      requestedSum: total.requestedSum + (c?.requestedSum ?? 0),
      actualSum: total.actualSum + (c?.actualSum ?? 0),
    }),
    { requestedMax: 0, requestedSum: 0, actualSum: 0 },
  );
}

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
  /**
   * Cursor to start from (gc-747u): resumes a walk a previous step stopped.
   * Omit (or null) to start at the beginning of the connection.
   */
  after?: string | null;
  /**
   * Epoch ms after which no NEW page is requested (gc-747u). Checked after each
   * page (before any backoff sleep), so the walk overruns it by at most the page
   * in flight. Stopping here sets `stats.hasMore`, never `stats.truncated`. A
   * THROTTLED backoff that would end past it also stops the walk (audit #2):
   * `stats.throttleStopped` then marks the cursor as one to retry.
   */
  deadline?: number;
  /**
   * Throttle status the previous step of this walk last saw (gc-747u audit #3,
   * from its `stats.throttle`). The helper waits on it, crediting the refill
   * since, BEFORE the first request, so the step boundary never skips the wait
   * the deadline stop deferred. This wait does not check `deadline`: skipping
   * it would make the step fire into an empty bucket and make no progress.
   */
  initialThrottle?: ThrottleSnapshot | null;
  /**
   * Optional walk-observability out-parameter (gc-1bd). When provided, the
   * helper mutates it with page/node counts, cap truncation, and accumulated
   * throttle-backoff sleep. See {@link PaginateStats}. Omit it and pagination
   * behaves exactly as before.
   */
  stats?: PaginateStats;
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
    stats,
    after = null,
    deadline,
    initialThrottle,
  } = options;

  const results: TResult[] = [];
  let cursor: string | null = after;
  let totalNodes = 0;
  let throttleRetries = 0;

  if (initialThrottle) {
    const sleepStart = Date.now();
    await waitForThrottleSnapshot(initialThrottle);
    if (stats) stats.throttleSleepMs += Date.now() - sleepStart;
  }

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
    if (stats) stats.throttle = throttleSnapshot(json.extensions) ?? stats.throttle ?? null;

    if (json.errors?.length) {
      // PRF-3: a THROTTLED error is transient — back off and retry the SAME
      // cursor so earlier pages are not re-fetched. Any other error is fatal.
      if (json.errors.some(isThrottledError)) {
        throttleRetries += 1;
        if (throttleRetries > maxThrottleRetries) {
          await recordApiError({
            level: "error",
            code: "graphql_throttled_exhausted",
            message: `still THROTTLED after ${maxThrottleRetries} retries`,
            metadata: { context: errorContext },
          });
          throw new Error(`${errorContext}: still THROTTLED after ${maxThrottleRetries} retries`);
        }
        const requestedCost = parseRequestedQueryCost(json.extensions);
        // gc-747u audit #2: never back off past the step deadline (up to 5
        // retries x ~20 s would outlast the step and Railway's ~60 s idle cut).
        // Stop instead; the next step retries this same cursor.
        if (
          deadline !== undefined &&
          Date.now() + rateLimitSleepMs(json.extensions, requestedCost) >= deadline
        ) {
          if (stats) {
            stats.hasMore = true;
            stats.endCursor = cursor;
            stats.throttleStopped = true;
          }
          break;
        }
        // Back off using whatever throttle headroom the response reported; if it
        // carried none, checkRateLimit is a no-op and we retry promptly.
        const sleepStart = Date.now();
        await checkRateLimit(json.extensions, requestedCost);
        if (stats) stats.throttleSleepMs += Date.now() - sleepStart;
        continue; // retry the same page — cursor unchanged
      }

      await recordApiError({
        level: "error",
        code: "graphql_error",
        message: json.errors[0]?.message ?? "unknown error",
        metadata: { context: errorContext },
      });
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
    if (stats) {
      stats.pageCount += 1;
      stats.nodeCount += nodes.length;
      const requested = parseRequestedQueryCost(json.extensions);
      stats.cost = sumQueryCost([
        stats.cost,
        {
          requestedMax: requested,
          requestedSum: requested,
          actualSum: parseActualQueryCost(json.extensions),
        },
      ]);
      stats.endCursor = pageInfo.endCursor ?? null;
      stats.hasMore = pageInfo.hasNextPage === true;
    }

    // Defensive: an empty page with hasNextPage still true would otherwise spin
    // forever (the cap is by node count, which is not advancing).
    if (allNodes.length === 0) {
      // ...and a chunked caller must not resume it either (gc-747u).
      if (stats) stats.hasMore = false;
      break;
    }
    if (maxNodes !== undefined && totalNodes >= maxNodes) {
      // Cap reached. If the connection still had more, records beyond the cap
      // were NOT scanned — flag the walk truncated so callers can record a
      // coverage gap (the differ must not false-resolve un-scanned records).
      if (stats && pageInfo.hasNextPage) stats.truncated = true;
      break;
    }
    if (!pageInfo.hasNextPage) break;

    cursor = pageInfo.endCursor ?? null;

    // Step time budget spent (gc-747u): stop BEFORE any backoff sleep; the next
    // step resumes from `stats.endCursor` (`stats.hasMore` is already true).
    if (deadline !== undefined && Date.now() >= deadline) break;

    // Proactively back off before the next request (waiting for the points one
    // more page of this shape requests, gc-747u), then log throttle proximity.
    const sleepStart = Date.now();
    await checkRateLimit(json.extensions, parseRequestedQueryCost(json.extensions));
    if (stats) stats.throttleSleepMs += Date.now() - sleepStart;
    if (shopDomain) {
      checkThrottleStatusFromExtensions(shopDomain, json.extensions);
    }
  }

  return results;
}

/**
 * Exact total for a capped walk's disclosure (gc-747u), shared by the product
 * and redirect fetchers. `field` is a QueryRoot `*Count` field returning
 * `Count { count precision }`.
 * `limit: null` lifts the default 10,000 ceiling so the count is EXACT; any
 * error or a non-exact count returns null (the caller falls back to copy
 * without a total), so a count problem never fails a scan.
 */
export async function fetchExactCount(
  admin: AdminApiContext,
  field: "productsCount" | "urlRedirectsCount",
): Promise<number | null> {
  try {
    const response = await admin.graphql(`{ ${field}(limit: null) { count precision } }`);
    const json = (await response.json()) as {
      errors?: unknown[];
      data?: Record<string, { count?: unknown; precision?: unknown } | null> | null;
    };
    if (json.errors?.length) return null;
    const result = json.data?.[field];
    if (!result || result.precision !== "EXACT" || typeof result.count !== "number") return null;
    return result.count;
  } catch {
    return null;
  }
}
