/**
 * Product data fetcher service.
 *
 * Queries Shopify Admin API for product data used by ghost code detectors.
 * Requires `read_products` scope.
 */

import { type GraphQLConnection, paginateConnection } from "../lib/graphql-pagination.server";
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

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const PRODUCT_PRICES_QUERY = `
  query ProductPrices($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
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

const PRODUCT_METAFIELDS_QUERY = `
  query ProductMetafields($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
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

const PRODUCT_TAGS_QUERY = `
  query ProductTags($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        tags
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

/**
 * Fetch products with their tags. Paginates through all products.
 * Caps at `maxProducts` (default 500) to keep API cost manageable.
 *
 * Uses cursor-based pagination with 50 products per page.
 */
export async function fetchProductTags(
  admin: AdminApiContext,
  maxProducts: number = 500,
): Promise<ProductTagData[]> {
  const PAGE_SIZE = 50;

  type ProductTagNode = { id: string; title: string; tags: string[] };

  return paginateConnection<ProductTagNode, ProductTagData>({
    admin,
    query: PRODUCT_TAGS_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxProducts,
    errorContext: "[product-fetcher] Failed to fetch products",
    getConnection: (data) =>
      (data as { products?: GraphQLConnection<ProductTagNode> } | null | undefined)?.products,
    mapNode: (node) => [{ id: node.id, title: node.title, tags: node.tags }],
  });
}

/**
 * Fetch products with variant pricing data. Paginates through all products.
 * Only returns products where at least one variant has compareAtPrice set.
 * Caps at `maxProducts` (default 500) to keep API cost manageable.
 *
 * Uses cursor-based pagination with 50 products per page.
 */
export async function fetchProductPrices(
  admin: AdminApiContext,
  maxProducts: number = 500,
): Promise<ProductPriceData[]> {
  const PAGE_SIZE = 50;

  type ProductPriceNode = {
    id: string;
    title: string;
    variants: {
      nodes: Array<{ id: string; title: string; price: string; compareAtPrice: string | null }>;
    };
    metafields?: { nodes?: Array<{ namespace: string; key: string }> };
  };

  return paginateConnection<ProductPriceNode, ProductPriceData>({
    admin,
    query: PRODUCT_PRICES_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxProducts,
    errorContext: "[product-fetcher] Failed to fetch product prices",
    getConnection: (data) =>
      (data as { products?: GraphQLConnection<ProductPriceNode> } | null | undefined)?.products,
    // Only return products where at least one variant has compareAtPrice set.
    mapNode: (node) => {
      const variants = node.variants.nodes;
      if (!variants.some((v) => v.compareAtPrice !== null)) return [];
      return [
        {
          id: node.id,
          title: node.title,
          variants,
          metafields: (node.metafields?.nodes ?? []).map((m) => ({
            namespace: m.namespace,
            key: m.key,
          })),
        },
      ];
    },
  });
}

/**
 * Fetch products with their metafields. Paginates through all products.
 * Caps at `maxProducts` (default 250) to keep API cost manageable.
 *
 * Only returns products that have at least one metafield. Products with
 * no metafields are filtered out.
 *
 * Note: app-owned metafields (app--{id}--* namespaces) are invisible to
 * third-party apps. Only merchant-visible metafields are returned.
 */
export async function fetchProductMetafields(
  admin: AdminApiContext,
  maxProducts: number = 250,
): Promise<ProductMetafieldData[]> {
  const PAGE_SIZE = 50;

  type ProductMetafieldNode = {
    id: string;
    title: string;
    metafields: { nodes: Array<{ namespace: string; key: string; value: string; type: string }> };
  };

  return paginateConnection<ProductMetafieldNode, ProductMetafieldData>({
    admin,
    query: PRODUCT_METAFIELDS_QUERY,
    pageSize: PAGE_SIZE,
    maxNodes: maxProducts,
    errorContext: "[product-fetcher] Failed to fetch product metafields",
    getConnection: (data) =>
      (data as { products?: GraphQLConnection<ProductMetafieldNode> } | null | undefined)?.products,
    // Only return products that have at least one metafield.
    mapNode: (node) => {
      const metafields = node.metafields.nodes;
      if (metafields.length === 0) return [];
      return [{ id: node.id, title: node.title, metafields }];
    },
  });
}
