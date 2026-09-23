/**
 * Tests for app/lib/finding-safety.ts
 *
 * Strategy:
 *   - Pure function with no dependencies — test directly.
 *   - Exhaustiveness: every FindingType enum member has an explicit
 *     REMOVAL_SAFETY entry (drift guard as the enum grows).
 *   - Representative-mapping assertions for the trust-sensitive calls
 *     (safe-to-remove and leave-alone are the ones a wrong call would hurt).
 *   - Unknown/empty types fall back to the conservative default.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  getRemovalSafety,
  REMOVAL_SAFETY_LABELS,
  REMOVAL_SAFETY_MAP,
} from "../../app/lib/finding-safety";

// ---------------------------------------------------------------------------
// Exhaustiveness / drift guard
// ---------------------------------------------------------------------------

describe("REMOVAL_SAFETY — coverage", () => {
  const ALL_TYPES = Object.values(FindingType);

  it("has 34 finding types (guards against silent enum drift)", () => {
    expect(ALL_TYPES).toHaveLength(34);
  });

  it("maps every FindingType enum member explicitly (exhaustiveness)", () => {
    for (const type of ALL_TYPES) {
      expect(type in REMOVAL_SAFETY_MAP, `${type} must have an explicit REMOVAL_SAFETY entry`).toBe(
        true,
      );
    }
  });

  it.each(ALL_TYPES)("returns one of the three valid levels for %s", (type) => {
    expect(["safe-to-remove", "verify-first", "leave-alone"]).toContain(getRemovalSafety(type));
  });
});

// ---------------------------------------------------------------------------
// Trust-sensitive representative mappings
// ---------------------------------------------------------------------------

describe("getRemovalSafety — representative mappings", () => {
  // The only four types allowed to be marked safe-to-remove: signature-matched
  // orphan code that is inert once the source app is gone.
  const SAFE_TO_REMOVE = [
    "GHOST_SCRIPT",
    "GHOST_STYLE",
    "GHOST_SNIPPET",
    "GHOST_PRECONNECT",
    // Known-malicious domain: nothing legitimate depends on attacker code.
    "MALICIOUS_SCRIPT",
  ];

  it.each(SAFE_TO_REMOVE)('classifies %s as "safe-to-remove"', (type) => {
    expect(getRemovalSafety(type)).toBe("safe-to-remove");
  });

  it("marks NO other type safe-to-remove (conservative allow-list)", () => {
    const actualSafe = Object.values(FindingType).filter(
      (t) => getRemovalSafety(t) === "safe-to-remove",
    );
    expect(actualSafe.sort()).toEqual([...SAFE_TO_REMOVE].sort());
  });

  // Types where removal is the WRONG action — migrate or fix the data instead.
  const LEAVE_ALONE = [
    "JSON_LD_CONFLICT",
    "JSON_LD_PRICE_CONFLICT",
    "JSON_LD_INVALID",
    "DANGLING_REFERENCE",
    "CHECKOUT_SUNSET",
    "SETTINGS_DRIFT",
  ];

  it.each(LEAVE_ALONE)('classifies %s as "leave-alone"', (type) => {
    expect(getRemovalSafety(type)).toBe("leave-alone");
  });

  it("marks exactly the migrate/fix types leave-alone", () => {
    const actualLeave = Object.values(FindingType).filter(
      (t) => getRemovalSafety(t) === "leave-alone",
    );
    expect(actualLeave.sort()).toEqual([...LEAVE_ALONE].sort());
  });

  // Spot-check the conservative default: a pixel could still be a live Google/
  // Meta tag, so it must never be auto-labeled safe-to-remove.
  it('keeps GHOST_PIXEL at "verify-first" (may still be a live tag)', () => {
    expect(getRemovalSafety("GHOST_PIXEL")).toBe("verify-first");
  });

  it('keeps ORPHAN_ASSET at "verify-first" (dynamic references are missed)', () => {
    expect(getRemovalSafety("ORPHAN_ASSET")).toBe("verify-first");
  });
});

// ---------------------------------------------------------------------------
// Fallback + labels
// ---------------------------------------------------------------------------

describe("getRemovalSafety — fallback", () => {
  it('defaults an unknown type to "verify-first" (never over-claims safety)', () => {
    expect(getRemovalSafety("UNKNOWN_TYPE")).toBe("verify-first");
  });

  it('defaults an empty string to "verify-first"', () => {
    expect(getRemovalSafety("")).toBe("verify-first");
  });

  it("is case-sensitive (lowercase does not match a safe-to-remove entry)", () => {
    expect(getRemovalSafety("ghost_script")).toBe("verify-first");
  });
});

describe("REMOVAL_SAFETY_LABELS", () => {
  it("has a short, non-empty label for each level", () => {
    expect(REMOVAL_SAFETY_LABELS["safe-to-remove"]).toBe("Likely safe — confirm app removed");
    expect(REMOVAL_SAFETY_LABELS["verify-first"]).toBe("Verify first");
    expect(REMOVAL_SAFETY_LABELS["leave-alone"]).toBe("Leave in place");
  });
});
