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

import { logger } from "./logger.server";
import { OPTIONAL_SCOPES, type OptionalScope } from "./optional-scopes";
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

// ---------------------------------------------------------------------------
// Granted-scope pre-check (gc-5l9)
// ---------------------------------------------------------------------------
//
// Probing a scope the shop never granted is an ACCESS_DENIED by construction,
// and every one of those lands in the Partner Dashboard's API error log (4 per
// scan on a shop without optional scopes). So the scan fetches the granted
// scopes ONCE and only probes the ones that are granted. A granted scope is
// still probed: the grant alone is not proof of access. A check whose probe
// needs more than one grant (translations: read_translations + read_locales,
// since shopLocales is gated on read_locales, gc-l1cm) skips without a query
// when any of them is missing.

/**
 * The optional scopes this installation has granted, or `null` when unknown
 * (the accessScopes lookup failed). `null` means "probe every scope", which is
 * exactly the pre-gc-5l9 behavior, so a failed lookup can never skip an audit
 * that would otherwise have run.
 */
export type GrantedOptionalScopes = readonly OptionalScope[] | null;

const ACCESS_SCOPES_QUERY = `{ currentAppInstallation { accessScopes { handle } } }`;

type AccessScopesResponse = {
  data?: { currentAppInstallation?: { accessScopes?: Array<{ handle?: unknown }> } | null };
  errors?: GraphQLResponseError[];
};

/**
 * Reduce a list of granted scope handles (required + optional, as returned by
 * `accessScopes`) to the optional scopes it covers, in declared order. A
 * `write_X` grant implies `read_X` in Shopify's scope model, so it counts.
 */
export function grantedOptionalScopesFrom(handles: readonly string[]): OptionalScope[] {
  const set = new Set(handles);
  return OPTIONAL_SCOPES.filter(
    (scope) => set.has(scope) || set.has(scope.replace(/^read_/, "write_")),
  );
}

/**
 * Fetch the installation's granted optional scopes with ONE
 * `currentAppInstallation.accessScopes` query.
 *
 * Never throws: any failure (thrown client error, GraphQL errors, malformed
 * response) is logged and returns `null`, which makes every scope check fall
 * back to its probe.
 */
export async function fetchGrantedOptionalScopes(
  admin: AdminApiContext,
  shopId: string,
): Promise<GrantedOptionalScopes> {
  try {
    const response = await admin.graphql(ACCESS_SCOPES_QUERY);
    const json = (await response.json()) as AccessScopesResponse;
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors[0]?.message ?? "unknown GraphQL error");
    }
    const accessScopes = json.data?.currentAppInstallation?.accessScopes;
    if (!Array.isArray(accessScopes)) {
      throw new Error("response has no currentAppInstallation.accessScopes list");
    }
    const handles = accessScopes
      .map((scope) => scope.handle)
      .filter((handle): handle is string => typeof handle === "string");
    return grantedOptionalScopesFrom(handles);
  } catch (err) {
    logger.warn("accessScopes lookup failed; falling back to per-scope probes", {
      function: "scope-check",
      event: "access_scopes_lookup_failed",
      shopId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check one optional scope: skip the probe entirely when the granted list
 * proves the scope is not granted, otherwise run {@link probeScope} to verify
 * real access. Same return/throw contract as `probeScope`.
 *
 * @param granted  From {@link fetchGrantedOptionalScopes}; `null` = unknown,
 *                 so the probe always runs (pre-gc-5l9 behavior).
 */
export async function checkOptionalScope(
  admin: AdminApiContext,
  scope: OptionalScope,
  probeQuery: string,
  granted: GrantedOptionalScopes,
): Promise<boolean> {
  if (granted !== null && !granted.includes(scope)) return false;
  return probeScope(admin, probeQuery, scope);
}
