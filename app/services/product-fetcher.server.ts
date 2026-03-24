/**
 * Product data fetcher service.
 *
 * Queries Shopify Admin API for product data used by ghost code detectors.
 * Requires `read_products` scope.
 */

import { checkRateLimit } from "./theme-fetcher.server";
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
 * Check if read_products scope is available by attempting a lightweight query.
 * Returns false on ACCESS_DENIED or any error.
 */
export async function hasProductScope(admin: AdminApiContext): Promise<boolean> {
  try {
    const response = await admin.graphql(`{ products(first: 1) { nodes { id } } }`);
    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: unknown;
    };
    return !json.errors?.length;
  } catch {
    return false;
  }
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
  const products: ProductTagData[] = [];
  let cursor: string | null = null;
  const PAGE_SIZE = 50;

  while (products.length < maxProducts) {
    const first = Math.min(PAGE_SIZE, maxProducts - products.length);
    const response = await admin.graphql(PRODUCT_TAGS_QUERY, {
      variables: {
        first,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        products?: {
          nodes?: Array<{ id: string; title: string; tags: string[] }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[product-fetcher] Failed to fetch products: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.products?.nodes ?? [];
    const pageInfo = json.data?.products?.pageInfo ?? {};

    for (const node of nodes) {
      products.push({
        id: node.id,
        title: node.title,
        tags: node.tags,
      });
    }

    if (!pageInfo.hasNextPage || nodes.length === 0) break;
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

  return products;
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
  const products: ProductPriceData[] = [];
  let totalFetched = 0;
  let cursor: string | null = null;
  const PAGE_SIZE = 50;

  while (totalFetched < maxProducts) {
    const first = Math.min(PAGE_SIZE, maxProducts - totalFetched);
    const response = await admin.graphql(PRODUCT_PRICES_QUERY, {
      variables: {
        first,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        products?: {
          nodes?: Array<{
            id: string;
            title: string;
            variants: {
              nodes: Array<{
                id: string;
                title: string;
                price: string;
                compareAtPrice: string | null;
              }>;
            };
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[product-fetcher] Failed to fetch product prices: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.products?.nodes ?? [];
    const pageInfo = json.data?.products?.pageInfo ?? {};

    for (const node of nodes) {
      const variants = node.variants.nodes;
      const hasCompareAtPrice = variants.some((v) => v.compareAtPrice !== null);

      if (hasCompareAtPrice) {
        products.push({
          id: node.id,
          title: node.title,
          variants,
        });
      }
    }

    totalFetched += nodes.length;

    if (!pageInfo.hasNextPage || nodes.length === 0) break;
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

  return products;
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
  const products: ProductMetafieldData[] = [];
  let totalFetched = 0;
  let cursor: string | null = null;
  const PAGE_SIZE = 50;

  while (totalFetched < maxProducts) {
    const first = Math.min(PAGE_SIZE, maxProducts - totalFetched);
    const response = await admin.graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: {
        first,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        products?: {
          nodes?: Array<{
            id: string;
            title: string;
            metafields: {
              nodes: Array<{
                namespace: string;
                key: string;
                value: string;
                type: string;
              }>;
            };
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[product-fetcher] Failed to fetch product metafields: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.products?.nodes ?? [];
    const pageInfo = json.data?.products?.pageInfo ?? {};

    for (const node of nodes) {
      const metafields = node.metafields.nodes;
      if (metafields.length > 0) {
        products.push({
          id: node.id,
          title: node.title,
          metafields,
        });
      }
    }

    totalFetched += nodes.length;

    if (!pageInfo.hasNextPage || nodes.length === 0) break;
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

  return products;
}
