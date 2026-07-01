/**
 * Shared scope-probe helper for the optional per-audit Shopify scopes.
 *
 * Background (LOG-9)
 * ------------------
 * Each optional audit (products, content, redirects, translations) probes
 * whether its required scope is granted by running a tiny GraphQL query. The
 * original implementations caught *every* error and returned `false`
 * ("scope missing"). That conflated two very different situations:
 *
 *   - ACCESS_DENIED   — the scope is genuinely not granted. Skipping the audit
 *                       is correct.
 *   - Transient error — THROTTLED, a network blip, a 5xx, or a timeout during
 *                       the probe. The scope status is *unknown*, not "missing".
 *
 * Swallowing the transient case as "scope missing" made the audit step emit 0
 * findings, which the scan-differ then interpreted as "previously-found items
 * are now resolved" — a silent false-clean result.
 *
 * This helper classifies the two cases and handles them differently:
 *
 *   - genuine ACCESS_DENIED -> return false (caller skips the audit cleanly)
 *   - anything else         -> throw TransientScopeCheckError so the caller
 *                              (an Inngest step) retries instead of recording a
 *                              false-clean audit.
 */

import type { AdminApiContext } from "../types/shopify";

/** Minimal shape of a Shopify GraphQL error entry we care about. */
export type GraphQLResponseError = {
  message?: string;
  extensions?: { code?: string } & Record<string, unknown>;
};

/**
 * Matches access-denied errors that arrive without a machine-readable
 * `extensions.code` (Shopify sometimes returns only a human message such as
 * "Access denied for products field").
 */
const ACCESS_DENIED_MESSAGE =
  /access denied|not approved to access|insufficient scope|requires? .*scope/i;

/**
 * True only when the error is *positive proof* that the scope is not granted.
 *
 * Deliberately conservative: anything we cannot confidently identify as
 * access-denied is treated as transient (see {@link probeScope}), so a future
 * unexpected error can never masquerade as "scope missing" again.
 */
export function isAccessDeniedError(error: GraphQLResponseError): boolean {
  const code = error.extensions?.code;
  if (typeof code === "string" && code.toUpperCase() === "ACCESS_DENIED") {
    return true;
  }
  return ACCESS_DENIED_MESSAGE.test(error.message ?? "");
}

/**
 * Raised when a scope probe fails for any reason other than a genuine
 * ACCESS_DENIED. Thrown so the surrounding Inngest step retries rather than
 * silently skipping the audit.
 */
export class TransientScopeCheckError extends Error {
  readonly scopeLabel: string;

  constructor(scopeLabel: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`[scope-check] transient error while probing "${scopeLabel}" scope: ${detail}`);
    this.name = "TransientScopeCheckError";
    this.scopeLabel = scopeLabel;
    // Preserve the original error for logs / debugging.
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Probe whether a scope is granted by running a lightweight query.
 *
 * @param admin       Shopify admin API context.
 * @param probeQuery  A minimal query that requires the scope under test.
 * @param scopeLabel  Human-readable scope name, used in error/log messages.
 *
 * @returns `true`  if the probe succeeds (scope granted).
 *          `false` if the probe fails with a genuine ACCESS_DENIED (scope not
 *                  granted) — the caller should skip its audit cleanly.
 *
 * @throws {TransientScopeCheckError} on any non-access-denied failure
 *         (THROTTLED, network error, 5xx, timeout, unexpected GraphQL error).
 *         The caller MUST let this propagate so the Inngest step retries
 *         instead of recording a false-clean audit.
 */
export async function probeScope(
  admin: AdminApiContext,
  probeQuery: string,
  scopeLabel: string,
): Promise<boolean> {
  let json: { errors?: GraphQLResponseError[] };
  try {
    const response = await admin.graphql(probeQuery);
    json = (await response.json()) as { errors?: GraphQLResponseError[] };
  } catch (err) {
    // The @shopify/shopify-api GraphQL client THROWS a GraphqlQueryError when
    // the HTTP response contains GraphQL errors (status 200 + body.errors).
    // This means an access-denied from the API arrives here via throw, not via
    // json.errors, so we must classify it before defaulting to transient.

    // Check structured GraphQL errors carried on the thrown error.
    // GraphqlQueryError exposes them at err.body.errors.graphQLErrors (an array
    // of raw GraphQL error objects with {message, extensions}).
    type ThrownWithBody = { body?: { errors?: { graphQLErrors?: GraphQLResponseError[] } } };
    const graphqlErrors: GraphQLResponseError[] =
      (err as ThrownWithBody)?.body?.errors?.graphQLErrors ?? [];
    if (graphqlErrors.some(isAccessDeniedError)) return false;

    // Also check the thrown error's top-level message — the client sets it to
    // the first GraphQL error's message, which may match the access-denied regex
    // even without a structured extensions.code (e.g. "Access denied for
    // shopLocales field. Required access: read_locales or read_markets_home").
    if (err instanceof Error && isAccessDeniedError({ message: err.message })) {
      return false;
    }

    // Anything else (network, timeout, 5xx, unexpected): scope status unknown.
    throw new TransientScopeCheckError(scopeLabel, err);
  }

  const errors = json.errors ?? [];
  if (errors.length === 0) return true;

  // A genuine access-denied is proof the scope is not granted -> skip cleanly.
  if (errors.some(isAccessDeniedError)) return false;

  // Any other GraphQL error (THROTTLED, internal error, unexpected) is NOT
  // proof the scope is missing. Throw so the step retries.
  throw new TransientScopeCheckError(
    scopeLabel,
    new Error(errors[0]?.message ?? "unknown GraphQL error"),
  );
}
