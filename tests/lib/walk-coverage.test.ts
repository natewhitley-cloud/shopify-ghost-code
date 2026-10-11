/**
 * Tests for app/lib/walk-coverage.ts (gc-747u): parsing Scan.walkCoverage and
 * the merchant-facing "checked N of M" disclosure copy.
 */
import { describe, expect, it } from "vitest";

import {
  parseWalkCoverage,
  walkCoverageNotices,
  type WalkCoverage,
} from "../../app/lib/walk-coverage";

const full = (checked: number): WalkCoverage => ({
  checked,
  total: null,
  truncated: false,
  lastId: null,
});

describe("parseWalkCoverage", () => {
  it("returns null for a legacy scan (NULL column) and non-objects", () => {
    expect(parseWalkCoverage(null)).toBeNull();
    expect(parseWalkCoverage(undefined)).toBeNull();
    expect(parseWalkCoverage("x")).toBeNull();
    expect(parseWalkCoverage([])).toBeNull();
  });

  it("returns {} (not null) when no walk ran: distinct from a legacy scan", () => {
    expect(parseWalkCoverage({})).toEqual({});
  });

  it("keeps well-formed walks and drops malformed ones", () => {
    expect(
      parseWalkCoverage({
        products: {
          checked: 5000,
          total: 7213,
          truncated: true,
          lastId: "gid://shopify/Product/9",
        },
        redirects: { checked: "lots", truncated: true },
      }),
    ).toEqual({
      products: { checked: 5000, total: 7213, truncated: true, lastId: "gid://shopify/Product/9" },
    });
  });

  it("normalizes a missing total / lastId to null", () => {
    expect(parseWalkCoverage({ redirects: { checked: 12, truncated: false } })).toEqual({
      redirects: full(12),
    });
  });
});

describe("walkCoverageNotices", () => {
  it("is empty for a legacy scan or when nothing was truncated", () => {
    expect(walkCoverageNotices(null)).toEqual([]);
    expect(walkCoverageNotices({})).toEqual([]);
    expect(walkCoverageNotices({ products: full(42), redirects: full(7) })).toEqual([]);
  });

  it("states the store total and how many were checked when the total is known", () => {
    expect(
      walkCoverageNotices({
        products: {
          checked: 5000,
          total: 7213,
          truncated: true,
          lastId: "gid://shopify/Product/1",
        },
      }),
    ).toEqual([
      "Your store has 7,213 products, including drafts and archived. This scan checked the first 5,000.",
    ]);
  });

  it("falls back to 'the first N' when the total is unavailable", () => {
    expect(
      walkCoverageNotices({
        redirects: { checked: 10000, total: null, truncated: true, lastId: null },
      }),
    ).toEqual(["This scan checked the first 10,000 URL redirects in your store."]);
  });

  it("falls back when the total no longer exceeds what was checked (records deleted mid-scan)", () => {
    expect(
      walkCoverageNotices({
        products: { checked: 500, total: 480, truncated: true, lastId: null },
      }),
    ).toEqual(["This scan checked the first 500 products in your store."]);
  });

  it("lists products before redirects when both were truncated", () => {
    expect(
      walkCoverageNotices({
        redirects: { checked: 4000, total: 6001, truncated: true, lastId: null },
        products: { checked: 2000, total: null, truncated: true, lastId: null },
      }),
    ).toEqual([
      "This scan checked the first 2,000 products in your store.",
      "Your store has 6,001 URL redirects. This scan checked the first 4,000.",
    ]);
  });

  it("uses no em dashes in merchant copy", () => {
    const lines = walkCoverageNotices({
      products: { checked: 5000, total: 7213, truncated: true, lastId: null },
      redirects: { checked: 1000, total: null, truncated: true, lastId: null },
    });
    for (const line of lines) expect(line).not.toMatch(/[—–]/);
  });
});
