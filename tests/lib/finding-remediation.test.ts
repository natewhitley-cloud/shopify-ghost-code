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

import { getFindingRemediation } from "../../app/lib/finding-remediation";

// ---------------------------------------------------------------------------
// Coverage: every enum type has a non-empty, em-dash-free blurb
// ---------------------------------------------------------------------------

describe("getFindingRemediation — coverage", () => {
  const ALL_TYPES = Object.values(FindingType);

  it("has 26 finding types (guards against silent enum drift)", () => {
    expect(ALL_TYPES).toHaveLength(26);
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

  it("warns against hand-editing settings_data.json for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT");
    expect(blurb).toContain("settings_data.json");
  });

  it("does NOT tell merchants to delete a script tag for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT").toLowerCase();
    expect(blurb).not.toContain("script tag");
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
