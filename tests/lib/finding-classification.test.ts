/**
 * Tests for app/lib/finding-classification.ts
 *
 * Strategy:
 *   - Pure function with no dependencies — test directly.
 *   - Cover all visual types (return true) and all non-visual types (return false).
 *   - Cover unknown/empty input edge cases.
 */

import { describe, it, expect } from "vitest";

import { hasVisualImpact } from "../../app/lib/finding-classification";

// ---------------------------------------------------------------------------
// Visual finding types (should return true)
// ---------------------------------------------------------------------------

describe("hasVisualImpact", () => {
  const VISUAL_TYPES = [
    "GHOST_SECTION",
    "GHOST_SNIPPET",
    "GHOST_TEXT",
    "GHOST_PRICE",
    "GHOST_PAGE",
    "GHOST_LAYOUT",
    "GHOST_FONT",
  ];

  it.each(VISUAL_TYPES)("returns true for visual type %s", (type) => {
    expect(hasVisualImpact(type)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Non-visual finding types (should return false)
  // ---------------------------------------------------------------------------

  const NON_VISUAL_TYPES = [
    "GHOST_SCRIPT",
    "GHOST_STYLE",
    "GHOST_HREFLANG",
    "ORPHAN_ASSET",
    "DUPLICATE_META",
    "GHOST_JSON_LD",
    "GHOST_TRANSLATION",
    "SETTINGS_DRIFT",
    "GHOST_PIXEL",
    "JSON_LD_CONFLICT",
    "GHOST_TAG",
    "GHOST_METAFIELD",
    "GHOST_REDIRECT",
    "GHOST_ROBOTS",
    "GHOST_CANONICAL",
    "GHOST_TITLE",
    "GHOST_OG",
    "GHOST_PRECONNECT",
    "GHOST_AJAX",
  ];

  it.each(NON_VISUAL_TYPES)("returns false for non-visual type %s", (type) => {
    expect(hasVisualImpact(type)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("returns false for an unknown finding type", () => {
    expect(hasVisualImpact("UNKNOWN_TYPE")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(hasVisualImpact("")).toBe(false);
  });

  it("is case-sensitive (lowercase does not match)", () => {
    expect(hasVisualImpact("ghost_section")).toBe(false);
  });
});
