/**
 * Tests for app/lib/finding-classification.ts
 *
 * Strategy:
 *   - Pure function with no dependencies — test directly.
 *   - Cover all visual types (return true) and all non-visual types (return false).
 *   - Cover unknown/empty input edge cases.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  CONFIDENCE_TYPE_SETS,
  getFindingConfidence,
  hasVisualImpact,
} from "../../app/lib/finding-classification";

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

// ---------------------------------------------------------------------------
// getFindingConfidence — signature vs heuristic tier
// ---------------------------------------------------------------------------

describe("getFindingConfidence", () => {
  // Signature-matched types: emission requires a known app-signature match.
  const SIGNATURE_TYPES = [
    "GHOST_SCRIPT",
    "GHOST_STYLE",
    "GHOST_SNIPPET",
    "GHOST_SECTION",
    "GHOST_HREFLANG",
    "GHOST_TEXT",
    "GHOST_PIXEL",
    "GHOST_PRECONNECT",
    "GHOST_FONT",
    "GHOST_AJAX",
    "GHOST_PRICE",
  ];

  it.each(SIGNATURE_TYPES)('returns "signature" for %s', (type) => {
    expect(getFindingConfidence(type)).toBe("signature");
  });

  // Heuristic types: emission is a structural inference, no app match required.
  const HEURISTIC_TYPES = [
    "ORPHAN_ASSET",
    "DUPLICATE_META",
    "JSON_LD_CONFLICT",
    "GHOST_JSON_LD",
    "SETTINGS_DRIFT",
    "GHOST_LAYOUT",
    "GHOST_ROBOTS",
    "GHOST_CANONICAL",
    "GHOST_TITLE",
    "GHOST_OG",
    "GHOST_REDIRECT",
    "GHOST_TRANSLATION",
    "GHOST_TAG",
    "GHOST_PAGE",
    "GHOST_METAFIELD",
  ];

  it.each(HEURISTIC_TYPES)('returns "heuristic" for %s', (type) => {
    expect(getFindingConfidence(type)).toBe("heuristic");
  });

  // The two anchors called out explicitly in the ticket.
  it("classifies the ticket's signature anchors (GHOST_SCRIPT/PIXEL/PRICE)", () => {
    expect(getFindingConfidence("GHOST_SCRIPT")).toBe("signature");
    expect(getFindingConfidence("GHOST_PIXEL")).toBe("signature");
    expect(getFindingConfidence("GHOST_PRICE")).toBe("signature");
  });

  it("classifies the ticket's heuristic anchors (ORPHAN_ASSET/SETTINGS_DRIFT)", () => {
    expect(getFindingConfidence("ORPHAN_ASSET")).toBe("heuristic");
    expect(getFindingConfidence("SETTINGS_DRIFT")).toBe("heuristic");
  });

  it('defaults unknown/empty types to "heuristic" (never over-claims confidence)', () => {
    expect(getFindingConfidence("UNKNOWN_TYPE")).toBe("heuristic");
    expect(getFindingConfidence("")).toBe("heuristic");
  });

  // ---------------------------------------------------------------------------
  // Drift guard: every FindingType enum member must be explicitly classified in
  // exactly one of the two curated sets. A new enum value added without a
  // classification fails here, forcing a deliberate signature-vs-heuristic call.
  // ---------------------------------------------------------------------------
  it("classifies every FindingType enum member in exactly one tier (drift guard)", () => {
    const allTypes = Object.values(FindingType);
    expect(allTypes).toHaveLength(27);

    for (const type of allTypes) {
      const inSignature = CONFIDENCE_TYPE_SETS.signature.has(type);
      const inHeuristic = CONFIDENCE_TYPE_SETS.heuristic.has(type);
      // XOR: present in one set, not both, not neither.
      expect(inSignature !== inHeuristic, `${type} must be in exactly one confidence set`).toBe(
        true,
      );
    }
  });

  it("has no overlap and full coverage between the two confidence sets", () => {
    const signature = [...CONFIDENCE_TYPE_SETS.signature];
    const heuristic = [...CONFIDENCE_TYPE_SETS.heuristic];
    const overlap = signature.filter((t) => CONFIDENCE_TYPE_SETS.heuristic.has(t));
    expect(overlap).toEqual([]);
    expect(signature.length + heuristic.length).toBe(27);
  });
});
