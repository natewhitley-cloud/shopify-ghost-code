/**
 * Product data fetcher service.
 *
 * Queries Shopify Admin API for product data used by ghost code detectors.
 * Requires `read_products` scope.
 */

import {
  type GraphQLConnection,
  type PaginateStats,
  paginateConnection,
} from "../lib/graphql-pagination.server";
import { PRODUCT_AUDIT_CAP } from "../lib/scan-limits";
import { probeScope } from "../lib/scope-check.server";
import type { AdminApiContext } from "../types/shopify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProductTagData = {
  id: string;
  title: string;
  tags: string[];
};

export type ProductPriceData = {
  id: string;
  title: string;
  variants: Array<{
    id: string;
    title: string;
    price: string;
    compareAtPrice: string | null;
  }>;
  // Merchant-visible product metafields, used by the price detector to
  // corroborate that a persistent compare-at price was left by an uninstalled
  // discount/sale app (rather than being an intentional merchant sale).
  // App-owned (app--{id}--*) metafields are invisible to third-party apps and
  // are therefore never present here.
  metafields: Array<{ namespace: string; key: string }>;
};

export type ProductMetafieldData = {
  id: string;
  title: string;
  metafields: Array<{
    namespace: string;
    key: string;
    value: string;
    type: string;
  }>;
};

/**
 * Result of the consolidated product-audit walk (gc-1bd). ONE paginated pass
 * over the `products` connection yields the inputs for all three product-backed
 * detectors, replacing the three redundant walks (tags, prices, metafields) that
 * each independently exchanged a token, probed `read_products`, and paginated
 * the same connection.
 *
 * The three arrays preserve the EXACT shape + filtering the legacy per-detector
 * fetchers produced, so detector output is unchanged:
 *   - `tags`:       every product (no filter), used by the tag detector.
 *   - `prices`:     only products with at least one `compareAtPrice` variant.
 *   - `metafields`: only products with at least one metafield.
 *
 * `truncated`/`pageCount`/`throttleSleepMs` are walk observability (Option 1/4):
 * `truncated` is true when the {@link PRODUCT_AUDIT_CAP} cut the walk short while
 * more products existed, so the caller records a coverage gap for all three
 * product categories (the differ must not false-resolve un-scanned products).
 */
export type ProductAuditData = {
  tags: ProductTagData[];
  prices: ProductPriceData[];
  metafields: ProductMetafieldData[];
  truncated: boolean;
  pageCount: number;
  throttleSleepMs: number;
};

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

/**
 * Consolidated product-audit query (gc-1bd): the UNION of the fields the three
 * product-backed detectors need — `tags` (tag detector), `variants` (price
 * detector), and `metafields` with value+type (metafield detector; the price
 * detector reads only namespace+key from the same block). One walk over this
 * connection replaces three separate paginations. `variants(first: 100)` and
 * `metafields(first: 50)` mirror the legacy per-detector caps exactly.
 */
const PRODUCT_AUDIT_QUERY = `
  query ProductAudit($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        tags
        variants(first: 100) {
          nodes {
            id
            title
            price
            compareAtPrice
          }
        }
        metafields(first: 50) {
          nodes {
            namespace
            key
            value
            type
          }
        }
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
 * Check if the read_products scope is available by attempting a lightweight query.
 *
 * Returns false ONLY on a genuine ACCESS_DENIED (scope not granted). Transient
 * failures (THROTTLED, network, 5xx, timeout) throw a TransientScopeCheckError
 * so the caller retries instead of silently treating the scope as missing.
 * See app/lib/scope-check.server.ts (LOG-9).
 */
export async function hasProductScope(admin: AdminApiContext): Promise<boolean> {
  return probeScope(admin, `{ products(first: 1) { nodes { id } } }`, "read_products");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Raw shape of one node returned by {@link PRODUCT_AUDIT_QUERY}. */
type ProductAuditNode = {
  id: string;
  title: string;
  tags: string[];
  variants: {
    nodes: Array<{ id: string; title: string; price: string; compareAtPrice: string | null }>;
  };
  metafields: {
    nodes: Array<{ namespace: string; key: string; value: string; type: string }>;
  };
};

/**
 * Fetch the product catalog ONCE and fan the single result out to the three
 * product-backed detectors (gc-1bd).
 *
 * Replaces `fetchProductTags` + `fetchProductPrices` + `fetchProductMetafields`,
 * each of which independently paginated the SAME `products` connection. One
 * token exchange + one `read_products` probe (by the caller) + one walk.
 *
 * The derived arrays reproduce the legacy per-detector filtering byte-for-byte,
 * so detector findings are identical:
 *   - `tags`:       every product mapped to `{ id, title, tags }` (no filter).
 *   - `prices`:     only products with a `compareAtPrice` variant; carries the
 *                   full variant list + merchant-visible metafields as
 *                   `{ namespace, key }` (the price detector's corroboration).
 *   - `metafields`: only products with ≥1 metafield; carries value+type.
 *
 * Caps at {@link PRODUCT_AUDIT_CAP} (the max of the legacy caps) and reports
 * `truncated` when the cap cut the walk short so the caller can record a
 * coverage gap. Uses cursor-based pagination with 50 products per page.
 */
export async function fetchProductAuditData(
  admin: AdminApiContext,
  maxProducts: number = PRODUCT_AUDIT_CAP,
): Promise<ProductAuditData> {
  const PAGE_SIZE = 50;

  const stats: PaginateStats = {
    pageCount: 0,
    nodeCount: 0,
    truncated: false,
    throttleSleepMs: 0,
  };

  // mapNode is identity: keep the raw merged node so a SINGLE pass can be split
  // into the three detector-shaped arrays below. This full payload stays in the
  // worker's memory INSIDE one Inngest step and never crosses a step boundary —
  // only scalar counts do — so the 4MB step-output limit is respected.
  const nodes = await paginateConnection<ProductAuditNode, ProductAuditNode>({
    admin,
    query: PRODUCT_AUDIT_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxProducts,
    errorContext: "[product-fetcher] Failed to fetch product audit data",
    getConnection: (data) =>
      (data as { products?: GraphQLConnection<ProductAuditNode> } | null | undefined)?.products,
    mapNode: (node) => [node],
    stats,
  });

  const tags: ProductTagData[] = nodes.map((n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
  }));

  const prices: ProductPriceData[] = [];
  const metafields: ProductMetafieldData[] = [];
  for (const n of nodes) {
    const variants = n.variants.nodes;
    // Price detector input: only products with at least one compare-at variant.
    if (variants.some((v) => v.compareAtPrice !== null)) {
      prices.push({
        id: n.id,
        title: n.title,
        variants,
        metafields: n.metafields.nodes.map((m) => ({ namespace: m.namespace, key: m.key })),
      });
    }
    // Metafield detector input: only products with at least one metafield.
    if (n.metafields.nodes.length > 0) {
      metafields.push({ id: n.id, title: n.title, metafields: n.metafields.nodes });
    }
  }

  return {
    tags,
    prices,
    metafields,
    truncated: stats.truncated,
    pageCount: stats.pageCount,
    throttleSleepMs: stats.throttleSleepMs,
  };
}
