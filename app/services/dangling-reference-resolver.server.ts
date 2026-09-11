/**
 * Admin-API entity-existence resolver for DANGLING_REFERENCE (gc-m4h.4).
 *
 * Consumes the distinct `(entityType, handle)` candidates produced by the pure
 * static extractor (`dangling-reference-extractor.server.ts`) and determines
 * which handles NO LONGER EXIST in the shop's Admin. Only the missing ones are
 * worth turning into DANGLING_REFERENCE findings (that finding-building + worker
 * wiring is gc-m4h.5 — this module resolves existence and returns a contract,
 * it does NOT create findings or touch the DB).
 *
 * Existence is checked through Admin GraphQL ONLY — there is deliberately no
 * storefront HTTP fetcher (locked constraint). v1 resolves product, collection,
 * and page. Menu (`linklists`) is deferred to v2.
 *
 * Scope grouping (spike §C, verified):
 *   - `read_products` covers BOTH products AND collections (collections live
 *     under the Products scope group).
 *   - `read_content`  covers pages.
 *
 * ---------------------------------------------------------------------------
 * RETURN CONTRACT (gc-m4h.5 depends on this shape)
 * ---------------------------------------------------------------------------
 * {
 *   missing:     ResolvedMissingRef[]   // (entityType, handle) pairs confirmed
 *                                        // absent in the Admin. ONLY these
 *                                        // become findings.
 *   scopeStatus: {
 *     products: 'checked' | 'absent'     // covers product + collection candidates
 *     content:  'checked' | 'absent'     // covers page candidates
 *   }
 *   truncated:   boolean                 // the per-scan lookup cap (MAX_LOOKUPS)
 *                                        // stopped some product/collection
 *                                        // candidates from being checked
 * }
 *
 * Graceful degradation (locked decision #5 + precise-skip rule R1). Each entity
 * type is gated on its own scope. When a scope is ABSENT we resolve NOTHING for
 * the types it covers and NEVER report them missing (an unchecked type can never
 * be claimed "deleted"). A scope is reported 'absent' ONLY when it was genuinely
 * needed — i.e. at least one candidate of a type it covers was present AND the
 * probe (or a mid-scan revocation) proved the scope is not granted. When there
 * are no candidates of a scope's types, we do not probe and report 'checked'
 * (there is nothing that could be false-resolved).
 *
 * This lets the caller implement the FindingType-granular precise-skip rule with
 * a single expression:
 *     skipped = scopeStatus.products === 'absent' || scopeStatus.content === 'absent'
 * i.e. mark DANGLING_REFERENCE skipped iff the theme contained a static ref of a
 * type whose scope is absent — which prevents the differ from false-resolving
 * refs we could not re-check, without suppressing the type when scopes are fully
 * present.
 *
 * Mirrors the per-handle lookup + budget + THROTTLED/ACCESS_DENIED discipline of
 * `jsonld-price-audit.server.ts`; reuses the shared scope probes (`hasProductScope`,
 * `hasContentScope`) and `fetchPages` rather than reinventing them.
 */

import { hasContentScope, fetchPages } from "./content-fetcher.server";
import type {
  DanglingEntityType,
  DistinctDanglingHandle,
} from "./dangling-reference-extractor.server";
import { hasProductScope } from "./product-fetcher.server";
import { logger } from "../lib/logger.server";
import { checkRateLimit, isThrottledError } from "../lib/rate-limit-monitor.server";
import { type GraphQLResponseError, isAccessDeniedError } from "../lib/scope-check.server";
import type { AdminApiContext } from "../types/shopify";

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

/** A candidate confirmed to no longer exist in the shop's Admin. */
export interface ResolvedMissingRef {
  entityType: DanglingEntityType;
  handle: string;
}

/**
 * Per-scope-group resolution state.
 *   - `checked`: every candidate of this scope's types was resolved (or there
 *     were none to resolve). Missing ones are in `missing`.
 *   - `absent`:  at least one candidate of this scope's types could NOT be
 *     checked because the scope is not granted; NONE of its types were reported
 *     missing. The caller must treat DANGLING_REFERENCE as skipped for the scan.
 */
export type ScopeResolutionState = "checked" | "absent";

/** See the module-level RETURN CONTRACT doc comment. */
export interface DanglingResolutionResult {
  missing: ResolvedMissingRef[];
  scopeStatus: {
    products: ScopeResolutionState;
    content: ScopeResolutionState;
  };
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cap on distinct product/collection existence lookups per scan. Mirrors the
 * live-price audit's budget (spike §D). Pages are fetched in a single paginated
 * pass and membership-tested in memory, so they do NOT consume this budget.
 */
const MAX_LOOKUPS = 50;

/** Max times a single lookup is retried after THROTTLED before giving up. */
const MAX_THROTTLE_RETRIES = 5;

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const PRODUCT_EXISTS_QUERY = `
  query ProductExistsByHandle($query: String!) {
    products(first: 2, query: $query) {
      nodes {
        handle
      }
    }
  }
`;

const COLLECTION_EXISTS_QUERY = `
  query CollectionExistsByHandle($query: String!) {
    collections(first: 2, query: $query) {
      nodes {
        handle
      }
    }
  }
`;

/**
 * Quote and escape a value for the Shopify search-syntax `field:"value"` form.
 * Mirrors `escapeSearchValue` in jsonld-price-audit.server.ts (duplicated as a
 * trivial one-liner to avoid coupling two unrelated audit services).
 */
function escapeSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type GraphQLJson<T> = {
  errors?: GraphQLResponseError[];
  data?: T;
  extensions?: unknown;
};

/** Structured GraphQL errors carried on a thrown GraphqlQueryError. */
type ThrownWithBody = { body?: { errors?: { graphQLErrors?: GraphQLResponseError[] } } };

/**
 * Raised when a scope is revoked mid-scan (an ACCESS_DENIED arrives on a lookup
 * after the pre-resolution probe already passed). Caught by the product/collection
 * resolver, which then reports its scope as `absent` and drops any partial
 * results so an unchecked type is never reported missing.
 */
class ScopeRevokedError extends Error {}

/**
 * Run one existence lookup, resilient to THROTTLED and scope revocation. The
 * @shopify/shopify-api GraphQL client THROWS a GraphqlQueryError on an HTTP-200
 * body that carries GraphQL errors, so THROTTLED / ACCESS_DENIED can arrive via
 * throw OR via `json.errors`; both paths are handled (mirrors the price audit).
 */
async function runQuery<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  context: string,
): Promise<T | undefined> {
  let throttleRetries = 0;
  for (;;) {
    let json: GraphQLJson<T>;
    try {
      const response = await admin.graphql(query, { variables });
      json = (await response.json()) as GraphQLJson<T>;
    } catch (err) {
      const thrownErrors: GraphQLResponseError[] =
        (err as ThrownWithBody)?.body?.errors?.graphQLErrors ?? [];
      if (
        thrownErrors.some(isAccessDeniedError) ||
        (err instanceof Error && isAccessDeniedError({ message: err.message }))
      ) {
        throw new ScopeRevokedError(`[dangling-reference-resolver] ${context}: scope revoked`);
      }
      if (thrownErrors.some(isThrottledError)) {
        throttleRetries += 1;
        if (throttleRetries > MAX_THROTTLE_RETRIES) throw err;
        await checkRateLimit(undefined);
        continue;
      }
      throw err;
    }

    if (json.errors?.length) {
      if (json.errors.some(isThrottledError)) {
        throttleRetries += 1;
        if (throttleRetries > MAX_THROTTLE_RETRIES) {
          throw new Error(
            `[dangling-reference-resolver] ${context}: still THROTTLED after ${MAX_THROTTLE_RETRIES} retries`,
          );
        }
        await checkRateLimit(json.extensions);
        continue;
      }
      if (json.errors.some(isAccessDeniedError)) {
        throw new ScopeRevokedError(`[dangling-reference-resolver] ${context}: scope revoked`);
      }
      throw new Error(
        `[dangling-reference-resolver] ${context}: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    await checkRateLimit(json.extensions);
    return json.data;
  }
}

// ---------------------------------------------------------------------------
// Existence checks
// ---------------------------------------------------------------------------

/**
 * True iff a product/collection with EXACTLY this handle exists. The
 * `query: 'handle:"..."'` search can be fuzzy, so we confirm a returned node's
 * handle equals the queried handle before deciding "exists" — a fuzzy near-match
 * (or an empty result) means the exact handle is gone → dangling. Handles are
 * lower-cased by Shopify and by the extractor, so a case-insensitive compare is
 * belt-and-braces.
 */
async function handleExists(
  admin: AdminApiContext,
  entityType: "product" | "collection",
  handle: string,
): Promise<boolean> {
  const query = entityType === "product" ? PRODUCT_EXISTS_QUERY : COLLECTION_EXISTS_QUERY;
  const data = await runQuery<{ [key: string]: { nodes?: Array<{ handle?: string }> } }>(
    admin,
    query,
    { query: `handle:${escapeSearchValue(handle)}` },
    `failed to resolve ${entityType} handle`,
  );
  const root = entityType === "product" ? data?.products : data?.collections;
  const nodes = root?.nodes ?? [];
  return nodes.some((n) => (n.handle ?? "").toLowerCase() === handle);
}

/**
 * Resolve product + collection candidates. Probes `read_products` only when
 * there is at least one such candidate. Returns the missing ones and the
 * resolution state; increments `counter.n` per lookup and marks `counter.capHit`
 * when the budget truncates the list.
 */
async function resolveProductsAndCollections(
  admin: AdminApiContext,
  candidates: DistinctDanglingHandle[],
  counter: { n: number; capHit: boolean },
): Promise<{ missing: ResolvedMissingRef[]; scope: ScopeResolutionState }> {
  if (candidates.length === 0) return { missing: [], scope: "checked" };

  if (!(await hasProductScope(admin))) return { missing: [], scope: "absent" };

  const missing: ResolvedMissingRef[] = [];
  try {
    for (const candidate of candidates) {
      if (counter.n >= MAX_LOOKUPS) {
        counter.capHit = true;
        continue;
      }
      counter.n += 1;
      const exists = await handleExists(
        admin,
        candidate.entityType as "product" | "collection",
        candidate.handle,
      );
      if (!exists) missing.push({ entityType: candidate.entityType, handle: candidate.handle });
    }
  } catch (err) {
    if (err instanceof ScopeRevokedError) {
      // Revoked mid-scan: drop partial results so an unchecked type is never
      // reported missing, and surface the scope as absent.
      return { missing: [], scope: "absent" };
    }
    throw err;
  }

  return { missing, scope: "checked" };
}

/**
 * Resolve page candidates via a single `fetchPages` pass + Set membership.
 * Probes `read_content` only when there is at least one page candidate. Pages do
 * not consume the lookup budget.
 */
async function resolvePages(
  admin: AdminApiContext,
  candidates: DistinctDanglingHandle[],
): Promise<{ missing: ResolvedMissingRef[]; scope: ScopeResolutionState }> {
  if (candidates.length === 0) return { missing: [], scope: "checked" };

  if (!(await hasContentScope(admin))) return { missing: [], scope: "absent" };

  const pages = await fetchPages(admin);
  const existing = new Set(pages.map((p) => p.handle.toLowerCase()));

  const missing = candidates
    .filter((c) => !existing.has(c.handle))
    .map((c) => ({ entityType: c.entityType, handle: c.handle }));

  return { missing, scope: "checked" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine which distinct candidate handles no longer exist in the shop's
 * Admin. See the module-level RETURN CONTRACT for the semantics of every field.
 *
 * Never throws for a genuine missing scope (that becomes `scopeStatus: 'absent'`).
 * Transient failures (THROTTLED exhaustion, unexpected GraphQL errors,
 * `TransientScopeCheckError` from a probe) propagate so the surrounding Inngest
 * step retries rather than recording a false-clean result.
 */
export async function resolveDanglingReferences(
  admin: AdminApiContext,
  distinctHandles: DistinctDanglingHandle[],
  shopId: string,
): Promise<DanglingResolutionResult> {
  const productCollectionCandidates = distinctHandles.filter(
    (c) => c.entityType === "product" || c.entityType === "collection",
  );
  const pageCandidates = distinctHandles.filter((c) => c.entityType === "page");

  const counter = { n: 0, capHit: false };

  const products = await resolveProductsAndCollections(admin, productCollectionCandidates, counter);
  const content = await resolvePages(admin, pageCandidates);

  if (counter.capHit) {
    logger.warn(
      "dangling-reference resolver hit the per-scan lookup cap; some candidates were not checked",
      { function: "dangling-reference-resolver", shopId, maxLookups: MAX_LOOKUPS },
    );
  }

  return {
    missing: [...products.missing, ...content.missing],
    scopeStatus: { products: products.scope, content: content.scope },
    truncated: counter.capHit,
  };
}
