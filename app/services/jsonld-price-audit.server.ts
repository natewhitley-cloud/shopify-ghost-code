/**
 * Live-price audit for stale static JSON-LD (gc-47c.10).
 *
 * Correlates the UNSIGNED static Product JSON-LD blocks extracted during the
 * worker theme scan (see `extractStaticProductCandidates` in
 * scan-engine.server.ts) against the merchant's LIVE product data via the
 * `read_products` Admin API. When a theme still advertises a stale price or
 * availability that no longer matches the live product, an AI shopping agent
 * could quote the wrong number — so we surface it as a JSON_LD_CONFLICT finding.
 *
 * Defensive by design (gc-47c.8/.9 hardening must not regress). A finding is
 * emitted ONLY when the identity resolves to exactly one live product/variant
 * AND the price differs MATERIALLY, with several explicit suppressions:
 *   - currency mismatch                    → not a conflict (different currency)
 *   - static == a live variant price       → not stale (matches a real variant)
 *   - static == a live compareAtPrice      → intentional sale/original price
 *   - number-vs-string / rounding          → normalized to cents before compare
 *   - ambiguous/unresolvable identity      → skipped (no finding)
 *   - product with >100 variants           → skipped (can't be sure it matches none)
 *
 * The comparison helpers are pure and exported for unit testing; only
 * `auditStaticJsonLdPrices` touches the network.
 */

import { FindingType } from "@prisma/client";

import type { StaticProductCandidate } from "./scan-engine.server";
import { classifySeverity } from "./severity-classifier.server";
import { checkRateLimit } from "../lib/rate-limit-monitor.server";
import type { CreateFindingInput } from "../models/finding.server";
import type { AdminApiContext } from "../types/shopify";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Shared prefix for every finding this audit emits. Used by the persistence
 * layer to delete ONLY this audit's JSON_LD_CONFLICT rows on an Inngest retry —
 * the worker's same-file JSON_LD_CONFLICT findings (from detectJsonLdConflicts)
 * share the enum but start with "Conflicting JSON-LD", so they are never
 * clobbered.
 */
export const STATIC_JSONLD_PRICE_DESC_PREFIX = "Static JSON-LD advertises ";

/**
 * Cap on distinct product/variant lookups per scan. Static Product JSON-LD is a
 * handful per theme; this bounds worst-case API cost on a pathological theme
 * that injects hundreds of unique static blocks.
 */
const MAX_LOOKUPS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveVariant = {
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
};

/**
 * A confidently-resolved live product for one candidate.
 *
 * `variants` holds every variant under consideration: a single element when the
 * candidate resolved to a SPECIFIC variant (via sku), or all of the product's
 * variants when it resolved to a product (via handle). The suppression rules
 * ("matches ANY variant", "matches ANY compareAtPrice") operate uniformly over
 * this array in both cases.
 */
export type ResolvedLiveProduct = {
  currencyCode: string;
  variants: LiveVariant[];
};

// ---------------------------------------------------------------------------
// Pure comparison helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Normalize a price to integer cents so `19.99` (number), `"19.99"` (string),
 * and `"19.990"` all compare equal, and sub-cent formatting never causes a
 * spurious mismatch. Returns null for anything non-numeric (e.g. `"$19.99"`).
 */
export function parsePriceToCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Canonicalize an ISO currency code for comparison. */
export function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Map a schema.org availability value to a clear in-stock (true) / out-of-stock
 * (false) signal, or null when the value is ambiguous (LimitedAvailability,
 * InStoreOnly, PreOrder, etc.). Only the unambiguous values participate in an
 * availability contradiction, keeping the confidence bar high.
 */
export function mapStaticAvailability(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/schema\.org\//, "");
  if (v === "instock") return true;
  if (v === "outofstock" || v === "soldout" || v === "discontinued") return false;
  return null;
}

/**
 * Compare a static Product JSON-LD candidate against its resolved live product
 * and return a JSON_LD_CONFLICT finding when there is a MATERIAL, high-confidence
 * mismatch — otherwise null. Price is checked before availability; at most one
 * finding is emitted per candidate.
 */
export function compareStaticToLive(
  candidate: StaticProductCandidate,
  live: ResolvedLiveProduct,
): CreateFindingInput | null {
  return comparePrice(candidate, live) ?? compareAvailability(candidate, live);
}

function comparePrice(
  candidate: StaticProductCandidate,
  live: ResolvedLiveProduct,
): CreateFindingInput | null {
  const staticCents = parsePriceToCents(candidate.staticPrice);
  if (staticCents === null) return null;
  if (live.variants.length === 0) return null;

  // Currency mismatch is not a conflict — a different currency legitimately
  // carries a different number.
  if (
    candidate.staticPriceCurrency !== undefined &&
    normalizeCurrency(candidate.staticPriceCurrency) !== normalizeCurrency(live.currencyCode)
  ) {
    return null;
  }

  // Suppress: static price equals a live compareAtPrice → intentional
  // sale/original price, not a ghost.
  for (const v of live.variants) {
    if (parsePriceToCents(v.compareAtPrice) === staticCents) return null;
  }

  // Suppress: static price matches ANY live variant price → not stale (and, for
  // a multi-variant product, avoids a false positive on an ambiguous match).
  for (const v of live.variants) {
    if (parsePriceToCents(v.price) === staticCents) return null;
  }

  const livePrice = live.variants[0].price;
  return buildFinding(
    candidate,
    `${STATIC_JSONLD_PRICE_DESC_PREFIX}price ${candidate.staticPrice} but the live product price is ${livePrice}. An AI shopping agent could quote the stale price.`,
  );
}

function compareAvailability(
  candidate: StaticProductCandidate,
  live: ResolvedLiveProduct,
): CreateFindingInput | null {
  const expectedInStock = mapStaticAvailability(candidate.staticAvailability);
  if (expectedInStock === null) return null;
  if (live.variants.length === 0) return null;

  const liveInStock = live.variants.some((v) => v.availableForSale);
  // Only a clear in-stock-vs-out-of-stock contradiction is a finding.
  if (expectedInStock === liveInStock) return null;

  return buildFinding(
    candidate,
    `${STATIC_JSONLD_PRICE_DESC_PREFIX}availability ${candidate.staticAvailability} but the live product is ${
      liveInStock ? "in stock" : "out of stock"
    }. An AI shopping agent could quote stale stock status.`,
  );
}

function buildFinding(candidate: StaticProductCandidate, description: string): CreateFindingInput {
  return {
    filename: candidate.filename,
    lineNumber: candidate.lineNumber,
    codeSnippet: candidate.codeSnippet,
    findingType: FindingType.JSON_LD_CONFLICT,
    severity: classifySeverity(FindingType.JSON_LD_CONFLICT, candidate.codeSnippet),
    appName: undefined,
    description,
  };
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const SHOP_CURRENCY_QUERY = `{ shop { currencyCode } }`;

const PRODUCT_BY_HANDLE_QUERY = `
  query ProductByHandle($query: String!) {
    products(first: 2, query: $query) {
      nodes {
        handle
        variants(first: 100) {
          nodes {
            price
            compareAtPrice
            availableForSale
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    }
  }
`;

const VARIANT_BY_SKU_QUERY = `
  query VariantBySku($query: String!) {
    productVariants(first: 2, query: $query) {
      nodes {
        price
        compareAtPrice
        availableForSale
      }
    }
  }
`;

/** Quote and escape a value for the Shopify search-syntax `field:"value"` form. */
function escapeSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type GraphQLJson<T> = {
  errors?: Array<{ message?: string }>;
  data?: T;
  extensions?: unknown;
};

async function runQuery<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown> | undefined,
  context: string,
): Promise<T | undefined> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as GraphQLJson<T>;
  if (json.errors?.length) {
    throw new Error(
      `[jsonld-price-audit] ${context}: ${json.errors[0]?.message ?? "unknown error"}`,
    );
  }
  await checkRateLimit(json.extensions);
  return json.data;
}

async function fetchShopCurrency(admin: AdminApiContext): Promise<string> {
  const data = await runQuery<{ shop?: { currencyCode?: string } }>(
    admin,
    SHOP_CURRENCY_QUERY,
    undefined,
    "failed to fetch shop currency",
  );
  const code = data?.shop?.currencyCode;
  if (!code) throw new Error("[jsonld-price-audit] shop currencyCode missing");
  return code;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/** Mutable lookup budget shared across a single audit run. */
type LookupCounter = { n: number };

/**
 * Resolve a single variant by SKU. Returns null when the sku is unresolvable OR
 * ambiguous (0 or >1 matching variants) so an uncertain identity can never
 * produce a finding.
 */
async function resolveSku(
  admin: AdminApiContext,
  sku: string,
  cache: Map<string, LiveVariant | null>,
  counter: LookupCounter,
): Promise<LiveVariant | null> {
  const cached = cache.get(sku);
  if (cached !== undefined) return cached;
  if (counter.n >= MAX_LOOKUPS) {
    cache.set(sku, null);
    return null;
  }
  counter.n++;

  const data = await runQuery<{ productVariants?: { nodes?: LiveVariant[] } }>(
    admin,
    VARIANT_BY_SKU_QUERY,
    { query: `sku:${escapeSearchValue(sku)}` },
    "failed to resolve sku",
  );
  const nodes = data?.productVariants?.nodes ?? [];
  const result = nodes.length === 1 ? nodes[0] : null; // exactly-one → confident
  cache.set(sku, result);
  return result;
}

/**
 * Resolve a product's variants by handle. Returns null when the handle is
 * unresolvable, ambiguous (>1 match, which Shopify's unique-handle rule makes
 * unexpected), or has more than 100 variants (a full first page — we can't be
 * sure the static price doesn't match an un-fetched variant, so we skip to avoid
 * a false positive).
 */
async function resolveHandle(
  admin: AdminApiContext,
  handle: string,
  cache: Map<string, LiveVariant[] | null>,
  counter: LookupCounter,
): Promise<LiveVariant[] | null> {
  const cached = cache.get(handle);
  if (cached !== undefined) return cached;
  if (counter.n >= MAX_LOOKUPS) {
    cache.set(handle, null);
    return null;
  }
  counter.n++;

  const data = await runQuery<{
    products?: {
      nodes?: Array<{
        variants?: { nodes?: LiveVariant[]; pageInfo?: { hasNextPage?: boolean } };
      }>;
    };
  }>(
    admin,
    PRODUCT_BY_HANDLE_QUERY,
    { query: `handle:${escapeSearchValue(handle)}` },
    "failed to resolve handle",
  );

  const products = data?.products?.nodes ?? [];
  let result: LiveVariant[] | null = null;
  if (products.length === 1) {
    const variants = products[0].variants;
    if (!variants?.pageInfo?.hasNextPage) {
      result = variants?.nodes ?? [];
    }
  }
  cache.set(handle, result);
  return result;
}

/**
 * Resolve one candidate to a live product. SKU (a specific variant) wins over
 * handle when both are present. When a sku is present but does not resolve
 * confidently we do NOT fall back to the handle: the block named a specific
 * variant, so a product-level comparison could misattribute the price.
 */
async function resolveCandidate(
  admin: AdminApiContext,
  candidate: StaticProductCandidate,
  currencyCode: string,
  skuCache: Map<string, LiveVariant | null>,
  handleCache: Map<string, LiveVariant[] | null>,
  counter: LookupCounter,
): Promise<ResolvedLiveProduct | null> {
  if (candidate.sku !== undefined) {
    const variant = await resolveSku(admin, candidate.sku, skuCache, counter);
    return variant ? { currencyCode, variants: [variant] } : null;
  }
  if (candidate.handle !== undefined) {
    const variants = await resolveHandle(admin, candidate.handle, handleCache, counter);
    return variants ? { currencyCode, variants } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit static Product JSON-LD candidates against live product prices.
 *
 * Assumes the caller has already confirmed `read_products` is granted (via
 * `hasProductScope`). Returns the JSON_LD_CONFLICT findings for material,
 * high-confidence mismatches; unresolvable or matching candidates contribute
 * nothing.
 */
export async function auditStaticJsonLdPrices(
  admin: AdminApiContext,
  candidates: StaticProductCandidate[],
): Promise<CreateFindingInput[]> {
  if (candidates.length === 0) return [];

  const currencyCode = await fetchShopCurrency(admin);

  const skuCache = new Map<string, LiveVariant | null>();
  const handleCache = new Map<string, LiveVariant[] | null>();
  const counter: LookupCounter = { n: 0 };

  const findings: CreateFindingInput[] = [];
  for (const candidate of candidates) {
    const live = await resolveCandidate(
      admin,
      candidate,
      currencyCode,
      skuCache,
      handleCache,
      counter,
    );
    if (!live) continue;
    const finding = compareStaticToLive(candidate, live);
    if (finding) findings.push(finding);
  }

  return findings;
}
