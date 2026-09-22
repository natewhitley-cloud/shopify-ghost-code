/**
 * Tests for app/lib/store-exclusion.ts
 *
 * The shared, client-safe store-exclusion primitives (parsers + predicate +
 * defaults). Extracted from operator-digest.ts (gc-4cv) so client-safe models can
 * share them; these assertions were moved here from operator-digest.test.ts and
 * must stay byte-behavior-identical.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_EXCLUDE_PREFIXES,
  DEFAULT_EXCLUDE_SHOPS,
  isExcluded,
  isExcludedShop,
  parseExcludePrefixes,
  parseExcludeShops,
} from "../../app/lib/store-exclusion";

// ---------------------------------------------------------------------------
// parseExcludeShops
// ---------------------------------------------------------------------------

describe("parseExcludeShops", () => {
  // DEFAULT_EXCLUDE_SHOPS is a comma-separated superset of the KNOWN internal
  // exact domains (dev store + throwaway test store + dahi5e-1d, the internal
  // Professional-test store the operator confirmed 2026-09-22 has 0 real subs).
  const defaultSet = new Set([
    "nw-dev-store-2.myshopify.com",
    "teststore22022.myshopify.com",
    "dahi5e-1d.myshopify.com",
  ]);

  it("falls back to the default when unset", () => {
    expect(parseExcludeShops(undefined)).toEqual(defaultSet);
    expect(defaultSet.has("nw-dev-store-2.myshopify.com")).toBe(true);
    expect(defaultSet.has("teststore22022.myshopify.com")).toBe(true);
    expect(defaultSet.has("dahi5e-1d.myshopify.com")).toBe(true);
  });

  it("falls back to the default when blank/whitespace-only", () => {
    expect(parseExcludeShops("   ")).toEqual(defaultSet);
    expect(parseExcludeShops("")).toEqual(defaultSet);
  });

  it("splits a comma-separated list", () => {
    expect(parseExcludeShops("a.myshopify.com,b.myshopify.com")).toEqual(
      new Set(["a.myshopify.com", "b.myshopify.com"]),
    );
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseExcludeShops(" a.myshopify.com , , b.myshopify.com ")).toEqual(
      new Set(["a.myshopify.com", "b.myshopify.com"]),
    );
  });

  it("lowercases every domain", () => {
    expect(parseExcludeShops("A.MyShopify.com")).toEqual(new Set(["a.myshopify.com"]));
  });

  it("parses the DEFAULT_EXCLUDE_SHOPS constant into its three known domains", () => {
    expect(parseExcludeShops(DEFAULT_EXCLUDE_SHOPS)).toEqual(defaultSet);
  });
});

// ---------------------------------------------------------------------------
// parseExcludePrefixes
// ---------------------------------------------------------------------------

describe("parseExcludePrefixes", () => {
  it("falls back to the default (app-review-) when unset/blank", () => {
    expect(parseExcludePrefixes(undefined)).toEqual(new Set([DEFAULT_EXCLUDE_PREFIXES]));
    expect(parseExcludePrefixes("   ")).toEqual(new Set([DEFAULT_EXCLUDE_PREFIXES]));
    expect(parseExcludePrefixes("")).toEqual(new Set([DEFAULT_EXCLUDE_PREFIXES]));
    expect(DEFAULT_EXCLUDE_PREFIXES).toBe("app-review-");
  });

  it("splits, trims, and lowercases a comma-separated list", () => {
    expect(parseExcludePrefixes(" App-Review- , qa- , ")).toEqual(new Set(["app-review-", "qa-"]));
  });
});

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe("isExcluded", () => {
  const excludeSet = new Set(["dev-store.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);

  it("matches an exact domain (case-insensitive)", () => {
    expect(isExcluded("dev-store.myshopify.com", excludeSet, excludePrefixes)).toBe(true);
    expect(isExcluded("DEV-STORE.myshopify.com", excludeSet, excludePrefixes)).toBe(true);
  });

  it("matches a domain that starts with an excluded prefix", () => {
    expect(isExcluded("app-review-abc123.myshopify.com", excludeSet, excludePrefixes)).toBe(true);
    expect(isExcluded("App-Review-XYZ.myshopify.com", excludeSet, excludePrefixes)).toBe(true);
  });

  it("does NOT over-match: a domain that CONTAINS but does not START WITH the prefix is kept", () => {
    expect(isExcluded("my-app-review-tool.myshopify.com", excludeSet, excludePrefixes)).toBe(false);
  });

  it("keeps a real merchant store (no exact match, no prefix match)", () => {
    expect(isExcluded("real-merchant.myshopify.com", excludeSet, excludePrefixes)).toBe(false);
  });

  it("returns false when both exclusion sets are empty", () => {
    expect(isExcluded("anything.myshopify.com", new Set(), new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExcludedShop
// ---------------------------------------------------------------------------

describe("isExcludedShop", () => {
  // Intentionally EMPTY domain-based sets so these assertions isolate the durable
  // isInternal signal from the domain/prefix paths.
  const emptySet = new Set<string>();
  const emptyPrefixes = new Set<string>();
  const excludeSet = new Set(["dev-store.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);

  it("excludes an isInternal:true shop regardless of domain (durable primary signal)", () => {
    expect(
      isExcludedShop(
        { domain: "real-merchant.myshopify.com", isInternal: true },
        emptySet,
        emptyPrefixes,
      ),
    ).toBe(true);
  });

  it("excludes an isInternal:false shop whose domain is an exact match", () => {
    expect(
      isExcludedShop(
        { domain: "dev-store.myshopify.com", isInternal: false },
        excludeSet,
        excludePrefixes,
      ),
    ).toBe(true);
  });

  it("excludes a shop whose domain matches a prefix even when isInternal is undefined", () => {
    expect(
      isExcludedShop({ domain: "app-review-abc.myshopify.com" }, excludeSet, excludePrefixes),
    ).toBe(true);
  });

  it("keeps a real shop that is not internal and matches neither the set nor a prefix", () => {
    expect(
      isExcludedShop(
        { domain: "real-merchant.myshopify.com", isInternal: false },
        excludeSet,
        excludePrefixes,
      ),
    ).toBe(false);
    expect(
      isExcludedShop({ domain: "real-merchant.myshopify.com" }, excludeSet, excludePrefixes),
    ).toBe(false);
  });
});
