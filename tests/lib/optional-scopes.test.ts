import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  allOptionalScopesGranted,
  missingOptionalScopes,
  OPTIONAL_SCOPE_INFO,
  OPTIONAL_SCOPES,
  scanSkippedForScopes,
  SKIPPABLE_CATEGORY_INFO,
  skippedCategoryLabels,
} from "../../app/lib/optional-scopes";

describe("OPTIONAL_SCOPES", () => {
  it("matches the optional_scopes declared in shopify.app.toml", () => {
    const toml = readFileSync(
      fileURLToPath(new URL("../../shopify.app.toml", import.meta.url)),
      "utf8",
    );
    const match = toml.match(/optional_scopes\s*=\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const declared = (match![1].match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    // Same set (order-independent) — the constant is the request set, the TOML is
    // authoritative. A drift here means the modal would request an undeclared
    // scope (rejected by Shopify) or miss a declared one.
    expect([...OPTIONAL_SCOPES].sort()).toEqual([...declared].sort());
  });

  it("has label + unlocks copy for every optional scope", () => {
    for (const scope of OPTIONAL_SCOPES) {
      expect(OPTIONAL_SCOPE_INFO[scope].label.length).toBeGreaterThan(0);
      expect(OPTIONAL_SCOPE_INFO[scope].unlocks.length).toBeGreaterThan(0);
    }
  });
});

describe("missingOptionalScopes", () => {
  it("returns all optional scopes when none are granted", () => {
    expect(missingOptionalScopes([])).toEqual([...OPTIONAL_SCOPES]);
  });

  it("returns none when all optional scopes are granted", () => {
    expect(missingOptionalScopes([...OPTIONAL_SCOPES])).toEqual([]);
  });

  it("returns only the ungranted optional scopes, preserving declared order", () => {
    // granted includes a required scope (read_themes) and one optional scope.
    const granted = ["read_themes", "read_products"];
    expect(missingOptionalScopes(granted)).toEqual([
      "read_translations",
      "read_content",
      "read_online_store_navigation",
    ]);
  });

  it("ignores unrelated granted scopes", () => {
    const granted = ["read_orders", "write_products", ...OPTIONAL_SCOPES];
    expect(missingOptionalScopes(granted)).toEqual([]);
  });
});

describe("allOptionalScopesGranted", () => {
  it("is false when at least one is missing", () => {
    expect(allOptionalScopesGranted(["read_products"])).toBe(false);
    expect(allOptionalScopesGranted([])).toBe(false);
  });

  it("is true when every optional scope is present", () => {
    expect(allOptionalScopesGranted([...OPTIONAL_SCOPES, "read_themes"])).toBe(true);
  });
});

describe("scanSkippedForScopes", () => {
  it("is true when status is PARTIAL (even with no categories)", () => {
    expect(scanSkippedForScopes({ status: "PARTIAL", skippedCategories: [] })).toBe(true);
  });

  it("is true when skippedCategories is non-empty", () => {
    expect(scanSkippedForScopes({ status: "COMPLETED", skippedCategories: ["GHOST_PAGE"] })).toBe(
      true,
    );
  });

  it("is false for a COMPLETED scan with no skipped categories", () => {
    expect(scanSkippedForScopes({ status: "COMPLETED", skippedCategories: [] })).toBe(false);
  });

  it("is false for a FAILED scan with no skipped categories", () => {
    expect(scanSkippedForScopes({ status: "FAILED", skippedCategories: [] })).toBe(false);
  });
});

describe("skippedCategoryLabels", () => {
  it("maps known categories to their human labels", () => {
    expect(skippedCategoryLabels(["GHOST_PAGE", "GHOST_REDIRECT"])).toEqual([
      "Content pages",
      "URL redirects",
    ]);
  });

  it("dedupes repeated labels while preserving first-seen order", () => {
    // GHOST_TAG / GHOST_PRICE / GHOST_METAFIELD all map to distinct labels, but
    // repeats of the same category collapse.
    expect(skippedCategoryLabels(["GHOST_PAGE", "GHOST_PAGE"])).toEqual(["Content pages"]);
  });

  it("falls back to the raw enum name for an unknown category", () => {
    expect(skippedCategoryLabels(["MYSTERY_CATEGORY"])).toEqual(["MYSTERY_CATEGORY"]);
  });

  it("returns an empty array for no categories", () => {
    expect(skippedCategoryLabels([])).toEqual([]);
  });
});

describe("SKIPPABLE_CATEGORY_INFO mapping", () => {
  it("references only declared optional scopes", () => {
    const optional = new Set<string>(OPTIONAL_SCOPES);
    for (const [category, info] of Object.entries(SKIPPABLE_CATEGORY_INFO)) {
      expect(info.label.length, `${category} needs a label`).toBeGreaterThan(0);
      expect(info.scopes.length, `${category} needs at least one scope`).toBeGreaterThan(0);
      for (const scope of info.scopes) {
        expect(optional.has(scope), `${category} → unknown scope ${scope}`).toBe(true);
      }
    }
  });

  // Drift guard: every FindingType the scan engine can push into
  // `skippedCategories` MUST be labeled here, or the banner would render a raw
  // enum name (or an unlabeled skip) for a real, merchant-facing skip.
  it("covers every category the scan engine can emit into skippedCategories", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../inngest/functions/scan-theme.ts", import.meta.url)),
      "utf8",
    );
    const block = src.match(/const skippedCategories:\s*string\[\]\s*=\s*\[([\s\S]*?)\]\s*\n/);
    expect(block, "could not locate the skippedCategories array in scan-theme.ts").not.toBeNull();
    const emitted = [...block![1].matchAll(/FindingType\.(\w+)/g)].map((m) => m[1]);
    // Sanity: the extraction found the categories we expect (guards the regex
    // itself from silently matching nothing).
    expect(emitted.length).toBeGreaterThanOrEqual(8);
    for (const category of emitted) {
      expect(
        SKIPPABLE_CATEGORY_INFO[category],
        `scan engine can skip ${category} but SKIPPABLE_CATEGORY_INFO has no entry`,
      ).toBeDefined();
    }
  });
});
