/**
 * Centralized scan-walk caps (gc-1bd).
 *
 * These bound how many Admin-API records a single scan will paginate through,
 * to keep worst-case GraphQL cost and scan duration manageable on very large
 * stores. They used to be scattered as inline default parameters across the
 * product and redirect fetchers; consolidating them here keeps the "how much do
 * we scan" policy in one place and lets the worker reference the SAME number it
 * uses to detect + report truncation (see the `truncatedWalks` scan_signal
 * field and the differ coverage-gap wiring — a truncated walk must never let the
 * differ mark un-scanned records as "resolved").
 *
 * Client-safe (no `.server` suffix, pure constants): may be imported anywhere.
 */

/**
 * Max products fetched in the consolidated product-audit walk (tags + prices +
 * metafields in one pass). Chosen as the MAX of the three legacy per-detector
 * caps (tags 500, prices 500, metafields 250) so nothing checked before the
 * consolidation is now checked LESS — the metafield audit's coverage widened
 * from 250 to 500.
 */
export const PRODUCT_AUDIT_CAP = 500;

/**
 * Max URL redirects fetched in the redirect-audit walk. Large stores can carry
 * thousands of redirects; this bounds the walk and, when hit, is reported as a
 * coverage gap so prior redirect findings beyond the cap are not false-resolved.
 */
export const REDIRECT_CAP = 1000;
