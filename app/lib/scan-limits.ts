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
 * Plan-aware walk caps (gc-747u). {@link PRODUCT_AUDIT_CAP} and
 * {@link REDIRECT_CAP} are the FREE caps (unchanged); paid plans walk further.
 * `getPlanFeatures` (billing.server.ts) is the one place a plan picks its caps:
 * the scan reads them ONCE (first walk chunk) and reuses that number for the
 * fetch, the truncation check and the coverage it records.
 */
export const STANDARD_PRODUCT_AUDIT_CAP = 2_000;
export const PROFESSIONAL_PRODUCT_AUDIT_CAP = 5_000;

/**
 * Max URL redirects fetched in the redirect-audit walk. Large stores can carry
 * thousands of redirects; this bounds the walk and, when hit, is reported as a
 * coverage gap so prior redirect findings beyond the cap are not false-resolved.
 */
export const REDIRECT_CAP = 1000;

/** Paid-plan redirect caps (gc-747u); see STANDARD_PRODUCT_AUDIT_CAP. */
export const STANDARD_REDIRECT_CAP = 4_000;
export const PROFESSIONAL_REDIRECT_CAP = 10_000;

/**
 * Wall-clock budget for ONE product or redirect walk step (gc-747u). A paid
 * plan's walk can be 10x the Free walk (100 product pages, 200 redirect pages),
 * and with Shopify's rate limit that is minutes, not seconds. A single Inngest
 * step is one HTTP request to /api/inngest that sends no bytes until it ends,
 * and Railway's edge has been seen to drop such requests at ~60 s. So a walk
 * stops paging once this budget is spent and the next step resumes from the
 * saved cursor. Worst case per step: this budget, plus one in-flight page, plus
 * one rate-limit sleep (at most ~20 s for a 1,000-point page at 50 pts/s).
 */
export const WALK_STEP_TIME_BUDGET_MS = 15_000;

/**
 * Max records fetched in ONE walk step (gc-747u), independent of the time
 * budget: bounds the in-memory product payload (variants + metafield values) to
 * what a single Free walk held before paid caps existed.
 */
export const PRODUCT_WALK_CHUNK = 500;
export const REDIRECT_WALK_CHUNK = 1000;

/**
 * Byte budget for the bulk-redirect groups a redirect walk step hands to the
 * next one (gc-747u). Bulk detection needs every unmatched redirect's path
 * prefix, so a chunked walk carries a per-prefix count plus up to 3 sample
 * lines across the step boundary. Realistic stores have a few dozen prefixes
 * (a few KB); this is the backstop for a store whose redirects mostly have
 * distinct first path segments. Over budget, samples are dropped first; still
 * over, bulk detection stops for the scan and GHOST_REDIRECT is recorded as
 * capped so the differ never false-resolves a bulk finding.
 *
 * Sized against Inngest's 32 MiB per-run state (every step output is kept for
 * the run): a 10,000-redirect walk is ~200 pages at >= ~10 pages per 15 s step,
 * so ~20 steps x 500 KB = ~10 MB worst case, beside the 3 MB core step.
 */
export const REDIRECT_GROUPS_BUDGET_BYTES = 500_000;

/**
 * Max distinct `(entityType, handle)` pairs one scan resolves against the Admin
 * API in the dangling-reference audit (one GraphQL lookup each). Shared by the
 * resolver (its lookup budget) and the extractor (gc-4ce), which drops handles
 * beyond this cap PER SCOPE GROUP (product + collection = read_products, page =
 * read_content) BEFORE they cross the Inngest step boundary. Per group because
 * the resolver skips a group whose scope is absent without spending lookups, so
 * that group's handles must not crowd the other group out of the cap.
 */
export const DANGLING_LOOKUP_CAP = 50;

/**
 * Max occurrences (file + line + snippet) kept per distinct dangling handle
 * (gc-4ce). Findings are one per occurrence, so this also caps the findings one
 * missing handle can produce. Real themes link a handle from a handful of places
 * (header, footer, a few sections); 20 leaves room for that while bounding a
 * pathological file (1 MB of `pages['a']` used to yield ~100k occurrences and
 * ~39 MB of step output). The true total is carried as `occurrenceCount`. Only
 * a MISSING handle over the cap marks the category skipped (its extra
 * occurrences get no finding); an existing handle over it loses nothing.
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
 * defensive backstop that drops dangling candidates, re-measures, and then drops
 * static JSON-LD candidates too if still over, rather than failing a scan.
 */
export const CORE_STEP_OUTPUT_BUDGET_BYTES = 3_000_000;

/**
 * Max findings kept per (theme file, finding type) by scanThemeFiles (gc-ypk).
 *
 * The per-file detectors cost tens of µs per emitted finding (mostly app
 * attribution on the snippet), and a tag-dense 1 MB file can emit tens of
 * thousands of findings of one type (~3 s for a `<title>` flood), so a theme
 * with 10+ such files could run into the 30 s scan worker timeout and FAIL the
 * scan. Real themes emit a handful per file (prod max per SCAN is ~26), so 200
 * never bites on a real theme; it only bounds pathological files.
 *
 * The kept findings are the FIRST 200 by line, so rescans of an unchanged theme
 * keep the same set (fingerprint stability). A cap hit is telemetry only
 * (`findingCapHits` in the scan_signal + a logger.warn), NOT a skipped category.
 * MALICIOUS_SCRIPT is exempt: the security alert is shown in full on all plans.
 */
export const MAX_FINDINGS_PER_FILE_PER_TYPE = 200;
