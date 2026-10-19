import { GraphqlQueryError } from "@shopify/shopify-api";

/**
 * A REAL `GraphqlQueryError`, shaped exactly as @shopify/shopify-api 13.x
 * `throwFailedRequest` (lib/clients/common.mjs) builds it for an HTTP 200
 * response carrying GraphQL errors: `.body` is the graphql-client response,
 * `{ data?, extensions?, errors: { networkStatusCode, message, graphQLErrors } }`.
 *
 * This is what `admin.graphql` THROWS on a cost-throttled request; the body
 * never reaches `response.json()` (gc-psew, ported from ClearSignal ba-kiw5).
 */
export function graphqlQueryError(
  graphQLErrors: Array<{ message: string; extensions?: { code?: string } }>,
  extensions?: Record<string, unknown>,
): GraphqlQueryError {
  return new GraphqlQueryError({
    message: graphQLErrors[0]?.message ?? "GraphQL operation failed",
    response: { status: 200 },
    headers: {},
    body: {
      ...(extensions ? { extensions } : {}),
      errors: {
        networkStatusCode: 200,
        message:
          "GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details.",
        graphQLErrors,
      },
    },
  });
}

/** A THROTTLED `GraphqlQueryError` carrying `extensions.cost.throttleStatus`. */
export function throttledGraphqlError(
  throttleStatus: {
    currentlyAvailable: number;
    maximumAvailable?: number;
    restoreRate: number;
  } | null = { currentlyAvailable: 0, maximumAvailable: 2000, restoreRate: 100 },
): GraphqlQueryError {
  return graphqlQueryError(
    [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    throttleStatus
      ? { cost: { requestedQueryCost: 10, actualQueryCost: null, throttleStatus } }
      : undefined,
  );
}
