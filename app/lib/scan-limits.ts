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

/**
 * Max distinct `(entityType, handle)` pairs one scan resolves against the Admin
 * API in the dangling-reference audit (one GraphQL lookup each). Shared by the
 * resolver (its lookup budget) and the extractor (gc-4ce), which drops handles
 * beyond this cap BEFORE they cross the Inngest step boundary: a handle past the
 * budget could never be checked, so carrying it only inflates the step output.
 */
export const DANGLING_LOOKUP_CAP = 50;

/**
 * Max occurrences (file + line + snippet) kept per distinct dangling handle
 * (gc-4ce). Findings are one per occurrence, so this also caps the findings one
 * missing handle can produce. Real themes link a handle from a handful of places
 * (header, footer, a few sections); 20 leaves room for that while bounding a
 * pathological file (1 MB of `pages['a']` used to yield ~100k occurrences and
 * ~39 MB of step output). The true total is carried as `occurrenceCount`.
 */
export const DANGLING_MAX_OCCURRENCES_PER_HANDLE = 20;

/**
 * Max static Product JSON-LD candidates carried to the live-price audit
 * (gc-4ce). Each carries a ~300-char snippet; a file packed with tiny JSON-LD
 * blocks could otherwise produce thousands. The audit's own lookup budget (50
 * Admin API lookups, cached by handle/SKU) is far below this, so the cap only
 * bites on pathological themes, and when it does the category is reported as
 * skipped so the differ never false-resolves candidates that were dropped.
 */
export const JSONLD_PRICE_CANDIDATE_CAP = 500;

/**
 * Byte budget for the scan-theme `fetch-and-scan` step's return value (gc-4ce).
 * Inngest rejects step output over 4 MB; 3 MB leaves headroom for Inngest's own
 * envelope. The caps above keep the worst case well under this; the budget is a
 * defensive backstop that drops dangling candidates rather than failing a scan.
 */
export const CORE_STEP_OUTPUT_BUDGET_BYTES = 3_000_000;
