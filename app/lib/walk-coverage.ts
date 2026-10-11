/**
 * What a scan's capped Admin API walks covered (gc-747u).
 *
 * The product walk (GHOST_TAG / GHOST_PRICE / GHOST_METAFIELD) and the redirect
 * walk (GHOST_REDIRECT) page through records in ascending ID order up to the
 * plan's cap. `Scan.walkCoverage` records, per walk that ran:
 *   - `checked`:   records the walk consumed.
 *   - `total`:     the store's exact record count, read only when the walk was
 *                  truncated (null when not read or unavailable).
 *   - `truncated`: the cap stopped the walk while more records existed.
 *   - `lastId`:    GID of the last record checked when truncated, else null.
 *                  Because the walk is ID-ordered, the scan covered exactly the
 *                  records with an ID up to it.
 *
 * NULL column = a legacy scan (before gc-747u): it walked at most the Free caps
 * and recorded nothing. A walk that did not run (scope not granted, no shop)
 * has no key; its categories are in `skippedCategories` instead.
 *
 * Client-safe (no `.server` suffix): the scan page renders the disclosure.
 */

import { PRODUCT_AUDIT_CAP, REDIRECT_CAP } from "./scan-limits";

export type WalkName = "products" | "redirects";

export type WalkCoverage = {
  checked: number;
  total: number | null;
  truncated: boolean;
  lastId: string | null;
};

export type ScanWalkCoverage = Partial<Record<WalkName, WalkCoverage>>;

/** The FindingTypes each walk feeds (string literals: client-safe). */
export const WALK_FINDING_TYPES: Record<WalkName, readonly string[]> = {
  products: ["GHOST_TAG", "GHOST_PRICE", "GHOST_METAFIELD"],
  redirects: ["GHOST_REDIRECT"],
};

/** The caps every legacy (pre-gc-747u) scan walked with, on every plan. */
export const LEGACY_WALK_CAPS: Record<WalkName, number> = {
  products: PRODUCT_AUDIT_CAP,
  redirects: REDIRECT_CAP,
};

const WALK_NAMES: readonly WalkName[] = ["products", "redirects"];

function parseOne(raw: unknown): WalkCoverage | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.checked !== "number" || typeof r.truncated !== "boolean") return null;
  return {
    checked: r.checked,
    total: typeof r.total === "number" ? r.total : null,
    truncated: r.truncated,
    lastId: typeof r.lastId === "string" ? r.lastId : null,
  };
}

/**
 * Parse `Scan.walkCoverage` (Json?). Null for a legacy scan (NULL) or any
 * non-object value; malformed per-walk entries are dropped.
 */
export function parseWalkCoverage(raw: unknown): ScanWalkCoverage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ScanWalkCoverage = {};
  for (const walk of WALK_NAMES) {
    const parsed = parseOne((raw as Record<string, unknown>)[walk]);
    if (parsed) out[walk] = parsed;
  }
  return out;
}

const NOUNS: Record<WalkName, string> = { products: "products", redirects: "URL redirects" };

/**
 * What the store total counts beyond the obvious (audit #6): productsCount
 * includes draft and archived products, and so does the walk, so the merchant
 * is told the total is not just their live catalog.
 */
const TOTAL_QUALIFIERS: Record<WalkName, string> = {
  products: ", including drafts and archived",
  redirects: "",
};

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Merchant-facing disclosure for each truncated walk, in walk order (empty
 * when nothing was truncated). With an exact total larger than what was
 * checked: "Your store has 7,213 products, including drafts and archived. This
 * scan checked the first 5,000." (redirects: "Your store has 6,001 URL
 * redirects. This scan checked the first 4,000.")
 * Otherwise (no total, or a total that no longer exceeds it): "This scan
 * checked the first 5,000 products in your store."
 */
export function walkCoverageNotices(coverage: ScanWalkCoverage | null): string[] {
  if (!coverage) return [];
  const lines: string[] = [];
  for (const walk of WALK_NAMES) {
    const c = coverage[walk];
    if (!c?.truncated) continue;
    const noun = NOUNS[walk];
    lines.push(
      c.total !== null && c.total > c.checked
        ? `Your store has ${formatCount(c.total)} ${noun}${TOTAL_QUALIFIERS[walk]}. This scan checked the first ${formatCount(c.checked)}.`
        : `This scan checked the first ${formatCount(c.checked)} ${noun} in your store.`,
    );
  }
  return lines;
}

/**
 * The upgrade line under a truncated-walk notice for Free and Standard: what
 * Professional walks. The caps come from the caller (getPlanFeatures for
 * Professional), never from literals here: "Professional checks up to 5,000
 * products and 10,000 redirects."
 */
export function walkCoverageUpgradeLine(caps: {
  productAuditCap: number;
  redirectAuditCap: number;
}): string {
  return `Professional checks up to ${formatCount(caps.productAuditCap)} products and ${formatCount(caps.redirectAuditCap)} redirects.`;
}
