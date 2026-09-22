/**
 * Shared store-exclusion predicate + parsers (gc-4cv).
 *
 * Dev/operator, throwaway-test, internal, and Shopify App Review stores must be
 * dropped from EVERY operator business metric. This is the single, client-safe
 * source of truth for that logic: pure, with NO Prisma / Inngest / route imports
 * so both the operator digest (`inngest/functions/operator-digest.ts`) and the
 * models it reads (e.g. `app/models/billing-event.server.ts`) can share it
 * without creating a bad dependency direction (`app/lib/*` must never import from
 * `inngest/` or a route). Behavior is byte-identical to the copies that
 * previously lived inside operator-digest.ts.
 */

// Dev/operator + throwaway-test + internal store(s) excluded from every BUSINESS
// count. Comma-separated shop domains in OPERATOR_EXCLUDE_SHOPS; the prod env var
// OVERRIDES this default. This default is a safe superset of the KNOWN internal
// exact domains so they are never counted before the env var is configured
// (referenced in billing.server.ts). dahi5e-1d.myshopify.com is an INTERNAL store
// (Professional *test* charge, not a real merchant subscription) confirmed by the
// operator 2026-09-22 (0 real Professional subscribers), so it is excluded from
// all business metrics here.
export const DEFAULT_EXCLUDE_SHOPS =
  "nw-dev-store-2.myshopify.com,teststore22022.myshopify.com,dahi5e-1d.myshopify.com";

// Domain PREFIXES excluded from every BUSINESS count. Shopify's App Review team
// installs on EPHEMERAL `app-review-*` stores (a fresh domain each review
// cycle), so a static exact list leaks again next review — they must be matched
// by prefix. Comma-separated in OPERATOR_EXCLUDE_PREFIXES; the prod env var
// overrides this default.
export const DEFAULT_EXCLUDE_PREFIXES = "app-review-";

/**
 * Parse OPERATOR_EXCLUDE_SHOPS into a lowercased Set of shop domains. Unset or
 * all-blank falls back to DEFAULT_EXCLUDE_SHOPS so the operator's own store is
 * never accidentally counted before the env var is configured.
 */
export function parseExcludeShops(raw: string | undefined): Set<string> {
  const source = raw && raw.trim().length > 0 ? raw : DEFAULT_EXCLUDE_SHOPS;
  const domains = source
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return new Set(domains);
}

/**
 * Parse OPERATOR_EXCLUDE_PREFIXES into a lowercased Set of domain prefixes.
 * Unset or all-blank falls back to DEFAULT_EXCLUDE_PREFIXES so the ephemeral
 * `app-review-*` stores are excluded before the env var is configured. A shop is
 * excluded when its lowercased domain `startsWith` any prefix in this set.
 */
export function parseExcludePrefixes(raw: string | undefined): Set<string> {
  const source = raw && raw.trim().length > 0 ? raw : DEFAULT_EXCLUDE_PREFIXES;
  const prefixes = source
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  return new Set(prefixes);
}

/**
 * Shared exclusion predicate: a shop is excluded when its lowercased domain is an
 * EXACT match in `excludeSet` OR `startsWith` any prefix in `excludePrefixes`.
 * The prefix path catches Shopify's EPHEMERAL `app-review-*` review stores (a new
 * domain each review cycle) that a static exact list would leak. Reused by
 * `partitionShops` (install/plan/MRR buckets), `aggregateActivity` (last-seen
 * + page-visit section), and `getBillingEventStats` (billing-events line) so every
 * section excludes the SAME dev/test/review stores.
 */
export function isExcluded(
  domain: string,
  excludeSet: Set<string>,
  excludePrefixes: Set<string>,
): boolean {
  const d = domain.toLowerCase();
  if (excludeSet.has(d)) return true;
  for (const prefix of excludePrefixes) {
    if (d.startsWith(prefix)) return true;
  }
  return false;
}
