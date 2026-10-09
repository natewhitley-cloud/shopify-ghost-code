import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  allOptionalScopesGranted,
  missingOptionalScopes,
  OPTIONAL_SCOPE_INFO,
  OPTIONAL_SCOPES,
  optionalScopeUnlocks,
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
      "read_locales",
    ]);
  });

  // gc-l1cm: the translations check needs read_locales too, so a shop that
  // granted only the original four is still missing (and gets asked for) it.
  it("still requests read_locales from a shop that granted the original four", () => {
    const granted = [
      "read_themes",
      "read_translations",
      "read_products",
      "read_content",
      "read_online_store_navigation",
    ];
    expect(missingOptionalScopes(granted)).toEqual(["read_locales"]);
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

  it("is false when only read_locales is missing (gc-l1cm)", () => {
    expect(
      allOptionalScopesGranted([
        "read_translations",
        "read_products",
        "read_content",
        "read_online_store_navigation",
      ]),
    ).toBe(false);
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
  it("references only declared optional scopes, with a label for every category", () => {
    const optional = new Set<string>(OPTIONAL_SCOPES);
    for (const [category, info] of Object.entries(SKIPPABLE_CATEGORY_INFO)) {
      expect(info.label.length, `${category} needs a label`).toBeGreaterThan(0);
      for (const scope of info.scopes) {
        expect(optional.has(scope), `${category} → unknown scope ${scope}`).toBe(true);
      }
    }
  });

  // Every category the engine can SCOPE-skip must name the scope(s) that unlock
  // it (the permissions banner and Settings card depend on it). Only categories
  // that are never scope-skipped (e.g. SCRIPT_TAG_SUNSET, recorded only as
  // unreachable) may have an empty scope list.
  it("gives every scope-skippable category at least one scope", () => {
    for (const category of emittedCategories("skippedCategories")) {
      expect(
        SKIPPABLE_CATEGORY_INFO[category]?.scopes.length ?? 0,
        `${category} can be scope-skipped but names no scope`,
      ).toBeGreaterThan(0);
    }
  });

  it("allows an empty scope list only for categories that are never scope-skipped", () => {
    const scopeSkippable = new Set(emittedCategories("skippedCategories"));
    const scopeless = Object.entries(SKIPPABLE_CATEGORY_INFO)
      .filter(([, info]) => info.scopes.length === 0)
      .map(([category]) => category);
    expect(scopeless).toEqual(["SCRIPT_TAG_SUNSET"]);
    for (const category of scopeless) expect(scopeSkippable.has(category)).toBe(false);
  });

  it('labels SCRIPT_TAG_SUNSET "Script tag sunset"', () => {
    expect(skippedCategoryLabels(["SCRIPT_TAG_SUNSET"])).toEqual(["Script tag sunset"]);
  });

  // Drift guard: every FindingType the scan engine can push into
  // `skippedCategories`, `cappedCategories` (gc-11f), or `unreachableCategories`
  // MUST be labeled here, or a notice would render a raw enum name for a real,
  // merchant-facing skip/cap/unreachable check.
  const scanThemeSrc = () =>
    readFileSync(
      fileURLToPath(new URL("../../inngest/functions/scan-theme.ts", import.meta.url)),
      "utf8",
    );

  function emittedCategories(listName: string): string[] {
    const block = scanThemeSrc().match(
      new RegExp(
        `const ${listName}:\\s*string\\[\\]\\s*=\\s*flaggedCategories\\(\\[([\\s\\S]*?)\\]\\);`,
      ),
    );
    expect(block, `could not locate the ${listName} builder in scan-theme.ts`).not.toBeNull();
    return [...block![1].matchAll(/FindingType\.(\w+)/g)].map((m) => m[1]);
  }

  it.each([
    // Sanity minimums guard the regex itself from silently matching nothing.
    ["skippedCategories", 8],
    ["cappedCategories", 2],
    ["unreachableCategories", 1],
  ])("covers every category the scan engine can emit into %s", (listName, minCount) => {
    const emitted = emittedCategories(listName);
    expect(emitted.length).toBeGreaterThanOrEqual(minCount);
    for (const category of emitted) {
      expect(
        SKIPPABLE_CATEGORY_INFO[category],
        `scan engine can emit ${category} into ${listName} but SKIPPABLE_CATEGORY_INFO has no entry`,
      ).toBeDefined();
    }
  });
});

describe("optionalScopeUnlocks (plan-aware copy)", () => {
  it("on a plan without Broken links, read_content makes no broken-links claim", () => {
    const line = optionalScopeUnlocks("read_content", false);
    expect(line).toBe("Finds orphaned content pages left behind by uninstalled apps.");
    expect(line.toLowerCase()).not.toContain("broken");
  });

  it("on a plan with Broken links, read_content keeps the full line", () => {
    expect(optionalScopeUnlocks("read_content", true)).toBe(
      OPTIONAL_SCOPE_INFO.read_content.unlocks,
    );
  });

  it("no other scope's line changes by plan", () => {
    for (const scope of OPTIONAL_SCOPES.filter((s) => s !== "read_content")) {
      expect(optionalScopeUnlocks(scope, false)).toBe(OPTIONAL_SCOPE_INFO[scope].unlocks);
      expect(OPTIONAL_SCOPE_INFO[scope].unlocks.toLowerCase()).not.toContain("broken link");
    }
  });
});
