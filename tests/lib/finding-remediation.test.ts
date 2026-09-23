/**
 * Tests for app/lib/finding-remediation.ts
 *
 * Strategy:
 *   - Pure function with no dependencies — test directly.
 *   - Every FindingType enum value must return a non-empty, accurate blurb.
 *   - Spot-check a few blurbs for accuracy (theme-file edits vs. Admin
 *     resources) so a mis-grouped type is caught.
 *   - Unmapped/unknown/empty input must fall back to generic guidance.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  buildRemovalInstructions,
  getFindingImpact,
  getFindingRemediation,
} from "../../app/lib/finding-remediation";

// The finding types that carry an agentic "why it matters" impact line — the
// signals AI shopping agents and answer engines read (canonical/hreflang/meta
// robots/JSON-LD/duplicate meta). Kept in sync with REMEDIATION in the module.
const AGENTIC_IMPACT_TYPES = [
  "GHOST_CANONICAL",
  "GHOST_HREFLANG",
  "GHOST_ROBOTS",
  "GHOST_JSON_LD",
  "GHOST_OG",
  "JSON_LD_CONFLICT",
  "JSON_LD_PRICE_CONFLICT",
  "JSON_LD_INVALID",
  "DUPLICATE_META",
  "DANGLING_REFERENCE",
] as const;

// ---------------------------------------------------------------------------
// Coverage: every enum type has a non-empty, em-dash-free blurb
// ---------------------------------------------------------------------------

describe("getFindingRemediation — coverage", () => {
  const ALL_TYPES = Object.values(FindingType);

  it("has 34 finding types (guards against silent enum drift)", () => {
    expect(ALL_TYPES).toHaveLength(34);
  });

  it.each(ALL_TYPES)("returns a non-empty blurb for %s", (type) => {
    const blurb = getFindingRemediation(type);
    expect(typeof blurb).toBe("string");
    expect(blurb.trim().length).toBeGreaterThan(0);
  });

  it.each(ALL_TYPES)("blurb for %s contains no em-dash or en-dash", (type) => {
    const blurb = getFindingRemediation(type);
    expect(blurb).not.toMatch(/[—–]/);
  });

  it("returns a distinct (mapped) blurb for every type — none fall through to the default", () => {
    const fallback = getFindingRemediation("DEFINITELY_NOT_A_TYPE");
    for (const type of ALL_TYPES) {
      expect(getFindingRemediation(type)).not.toBe(fallback);
    }
  });

  it.each(ALL_TYPES)("impact line for %s (when present) contains no em-dash or en-dash", (type) => {
    const impact = getFindingImpact(type);
    if (impact !== null) {
      expect(impact).not.toMatch(/[—–]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Agentic "why it matters" impact line
// ---------------------------------------------------------------------------

describe("getFindingImpact — agentic reframe", () => {
  it.each(AGENTIC_IMPACT_TYPES)("returns a non-empty impact line for %s", (type) => {
    const impact = getFindingImpact(type);
    expect(impact).not.toBeNull();
    expect((impact ?? "").trim().length).toBeGreaterThan(0);
  });

  it("returns null for a type with no distinct agent-facing consequence (GHOST_SCRIPT)", () => {
    expect(getFindingImpact("GHOST_SCRIPT")).toBeNull();
  });

  it("does NOT add an impact line for GHOST_PRICE (compare-at pricing, not a JSON-LD signal)", () => {
    expect(getFindingImpact("GHOST_PRICE")).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(getFindingImpact("SOME_FUTURE_TYPE")).toBeNull();
  });

  it("frames JSON_LD_CONFLICT around AI agents picking the wrong data", () => {
    const impact = getFindingImpact("JSON_LD_CONFLICT") ?? "";
    expect(impact.toLowerCase()).toContain("agent");
  });

  it("frames GHOST_OG around AI agents reading a stale price or availability", () => {
    const impact = getFindingImpact("GHOST_OG") ?? "";
    expect(impact.toLowerCase()).toContain("agent");
    expect(impact.toLowerCase()).toMatch(/price|availability/);
  });
});

// ---------------------------------------------------------------------------
// Accuracy spot-checks
// ---------------------------------------------------------------------------

describe("getFindingRemediation — accuracy", () => {
  it("tells merchants to remove a script tag from the theme for GHOST_SCRIPT", () => {
    const blurb = getFindingRemediation("GHOST_SCRIPT");
    expect(blurb.toLowerCase()).toContain("script");
    expect(blurb.toLowerCase()).toContain("theme");
  });

  it("points at Admin URL Redirects (not theme code) for GHOST_REDIRECT", () => {
    const blurb = getFindingRemediation("GHOST_REDIRECT");
    expect(blurb).toContain("URL Redirects");
  });

  it("points at product variants (not theme code) for GHOST_PRICE", () => {
    const blurb = getFindingRemediation("GHOST_PRICE");
    expect(blurb.toLowerCase()).toContain("compare-at");
    expect(blurb.toLowerCase()).toContain("variant");
  });

  it("tells merchants to fix or remove a broken link for DANGLING_REFERENCE", () => {
    const blurb = getFindingRemediation("DANGLING_REFERENCE").toLowerCase();
    expect(blurb).toContain("link");
    expect(blurb).toMatch(/remove|fix/);
  });

  it("warns against hand-editing settings_data.json for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT");
    expect(blurb).toContain("settings_data.json");
  });

  it("does NOT tell merchants to delete a script tag for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT").toLowerCase();
    expect(blurb).not.toContain("script tag");
  });

  it("tells merchants to remove the flagged reference (not just a script line) for MALICIOUS_SCRIPT", () => {
    const blurb = getFindingRemediation("MALICIOUS_SCRIPT").toLowerCase();
    expect(blurb).toContain("reference");
    expect(blurb).toContain("custom liquid");
    expect(blurb).toContain("app block");
    expect(blurb).not.toContain("this script line");
  });

  it("describes the checkout.liquid sunset as past, for every store, for CHECKOUT_SUNSET (gc-oam)", () => {
    const blurb = getFindingRemediation("CHECKOUT_SUNSET");
    expect(blurb).toContain("no longer renders");
    expect(blurb).toContain("August 28, 2025");
    expect(blurb).toContain("Checkout Extensibility");
    expect(blurb).not.toMatch(/2026/);
    expect(blurb).not.toMatch(/hard-block/i);
    expect(blurb).not.toMatch(/\bwill\b/i);
    expect(blurb).not.toMatch(/cutover/i);
    expect(blurb).not.toMatch(/\bPlus\b/);
  });

  it("steers settings_data.json fixes to the theme editor and minified JS to a surgical removal", () => {
    const blurb = getFindingRemediation("MALICIOUS_SCRIPT").toLowerCase();
    expect(blurb).toContain("settings_data.json");
    expect(blurb).toContain("theme editor (customize)");
    expect(blurb).toMatch(/minified/);
    expect(blurb).toContain("not the whole line");
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe("getFindingRemediation — fallback", () => {
  it("returns generic backup guidance for an unknown type", () => {
    const blurb = getFindingRemediation("SOME_FUTURE_TYPE");
    expect(blurb.trim().length).toBeGreaterThan(0);
    expect(blurb.toLowerCase()).toContain("duplicate");
  });

  it("returns the fallback (not a thrown error) for an empty string", () => {
    const blurb = getFindingRemediation("");
    expect(blurb.trim().length).toBeGreaterThan(0);
  });

  it("returns the same fallback string for two different unknown types", () => {
    expect(getFindingRemediation("UNKNOWN_A")).toBe(getFindingRemediation("UNKNOWN_B"));
  });
});

// ---------------------------------------------------------------------------
// buildRemovalInstructions — copy-paste instruction composition
// ---------------------------------------------------------------------------

describe("buildRemovalInstructions", () => {
  it("composes file, line, full snippet, and howTo for a theme-file finding", () => {
    const snippet = '<script src="https://cdn.example-app.com/loader.js"></script>';
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 42,
        codeSnippet: snippet,
      },
      "Scripts",
    );

    expect(out).toContain("Ghost Code finding: Scripts");
    expect(out).toContain("File: layout/theme.liquid  (line 42)");
    expect(out).toContain("Remove this code:");
    expect(out).toContain(snippet);
    expect(out).toContain(`How: ${getFindingRemediation("GHOST_SCRIPT")}`);
  });

  it("uses the FULL snippet, not the 80-char truncation shown in the table", () => {
    const longSnippet = `<script>${"x".repeat(200)}</script>`;
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "assets/app.js",
        lineNumber: 5,
        codeSnippet: longSnippet,
      },
      "Scripts",
    );
    expect(out).toContain(longSnippet);
    expect(out).not.toContain("…");
  });

  it("degrades gracefully for an Admin-resource finding (no bogus line/snippet)", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_PRICE",
        filename: "products/gid://shopify/Product/123",
        lineNumber: 0,
        codeSnippet: "",
      },
      "Compare-at Prices",
    );

    expect(out).toContain("Ghost Code finding: Compare-at Prices");
    // No theme line reference and no "Remove this code" block for Admin resources.
    expect(out).not.toContain("File:");
    expect(out).not.toContain("(line");
    expect(out).not.toContain("Remove this code:");
    // Leans on a plain-language location + the Admin-surface howTo.
    expect(out).toContain("Location:");
    expect(out).toContain(`How: ${getFindingRemediation("GHOST_PRICE")}`);
  });

  it("omits the line reference when a theme-file finding has lineNumber 0", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "ORPHAN_ASSET",
        filename: "assets/orphan.js",
        lineNumber: 0,
        codeSnippet: "",
      },
      "Orphan Assets",
    );
    expect(out).toContain("File: assets/orphan.js");
    expect(out).not.toContain("(line");
    // Empty snippet → no "Remove this code" block.
    expect(out).not.toContain("Remove this code:");
  });
});
