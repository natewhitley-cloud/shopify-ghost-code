/**
 * Shared Shopify API types used across fetcher services.
 */

/** Minimal slice of the Shopify admin context used by fetcher services. */
export type AdminApiContext = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};
