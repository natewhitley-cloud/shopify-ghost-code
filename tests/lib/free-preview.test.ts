/**
 * Tests for app/lib/free-preview.ts (gc-97k.10): the Free preview formula and
 * the lane round-robin pick.
 *
 * Lanes used below (primary lane per finding-consequence.ts):
 *   GHOST_SCRIPT, GHOST_STYLE      -> Speed
 *   GHOST_HREFLANG, DUPLICATE_META -> Found by Google & AI
 *   GHOST_SNIPPET                  -> Customers see it
 *   GHOST_PIXEL                    -> Still tracking you
 *   ORPHAN_ASSET                   -> Housekeeping
 */
import type { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  comparePreviewCandidates,
  FREE_PREVIEW_MAX,
  freePreviewCount,
  pickFreePreviewFindings,
} from "../../app/lib/free-preview";

function c(id: string, findingType: FindingType, severity: Severity, minute = 0) {
  return { id, findingType, severity, createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)) };
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("freePreviewCount", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [5, 2],
    [7, 3],
    [10, 5],
    [11, 5],
    [100, 5],
  ])("total %i -> %i shown", (total, shown) => {
    expect(freePreviewCount(total)).toBe(shown);
  });

  it("never shows more than half of the findings from 2 up, and never more than the cap", () => {
    for (let total = 2; total <= 200; total += 1) {
      const shown = freePreviewCount(total);
      expect(shown).toBeGreaterThanOrEqual(1);
      expect(shown).toBeLessThanOrEqual(Math.min(FREE_PREVIEW_MAX, total / 2));
    }
  });

  it("treats a negative total as nothing to show", () => {
    expect(freePreviewCount(-3)).toBe(0);
  });
});

describe("comparePreviewCandidates", () => {
  it("orders by severity, then createdAt, then id", () => {
    const rows = [
      c("b", "GHOST_SCRIPT", "LOW", 0),
      c("z", "GHOST_SCRIPT", "HIGH", 5),
      c("y", "GHOST_SCRIPT", "HIGH", 5),
      c("x", "GHOST_SCRIPT", "HIGH", 1),
      c("a", "GHOST_SCRIPT", "MEDIUM", 0),
    ];
    expect(ids([...rows].sort(comparePreviewCandidates))).toEqual(["x", "y", "z", "a", "b"]);
  });
});

describe("pickFreePreviewFindings", () => {
  it("takes one row per lane before repeating any lane", () => {
    const picked = pickFreePreviewFindings(
      [
        c("s1", "GHOST_SCRIPT", "HIGH", 0),
        c("s2", "GHOST_STYLE", "HIGH", 1),
        c("s3", "GHOST_SCRIPT", "HIGH", 2),
        c("d1", "GHOST_HREFLANG", "LOW", 3),
        c("h1", "ORPHAN_ASSET", "LOW", 4),
      ],
      4,
    );
    // Round 1: Speed's best, then the two LOW lanes (by createdAt); round 2: Speed.
    expect(ids(picked)).toEqual(["s1", "d1", "h1", "s2"]);
  });

  it("orders each round by severity, so the scan's most severe finding leads", () => {
    const picked = pickFreePreviewFindings(
      [
        c("house-low", "ORPHAN_ASSET", "LOW", 0),
        c("track-med", "GHOST_PIXEL", "MEDIUM", 1),
        c("see-high", "GHOST_SNIPPET", "HIGH", 2),
      ],
      3,
    );
    expect(ids(picked)).toEqual(["see-high", "track-med", "house-low"]);
  });

  it("uses each lane's best rows in severity order within the lane", () => {
    const picked = pickFreePreviewFindings(
      [
        c("low", "GHOST_SCRIPT", "LOW", 0),
        c("high", "GHOST_STYLE", "HIGH", 9),
        c("med", "GHOST_SCRIPT", "MEDIUM", 1),
      ],
      3,
    );
    expect(ids(picked)).toEqual(["high", "med", "low"]);
  });

  it("is deterministic regardless of input order (createdAt then id tie-break)", () => {
    const rows = [
      c("b", "GHOST_SCRIPT", "HIGH", 0),
      c("a", "GHOST_SCRIPT", "HIGH", 0),
      c("c", "GHOST_SCRIPT", "HIGH", 0),
      c("d", "GHOST_HREFLANG", "HIGH", 0),
    ];
    const expected = ["a", "d", "b"];
    expect(ids(pickFreePreviewFindings(rows, 3))).toEqual(expected);
    expect(ids(pickFreePreviewFindings([...rows].reverse(), 3))).toEqual(expected);
    expect(ids(pickFreePreviewFindings([rows[2], rows[0], rows[3], rows[1]], 3))).toEqual(expected);
  });

  it("never picks a MALICIOUS_SCRIPT finding", () => {
    const picked = pickFreePreviewFindings(
      [c("mal", "MALICIOUS_SCRIPT", "HIGH", 0), c("px", "GHOST_PIXEL", "LOW", 1)],
      2,
    );
    expect(ids(picked)).toEqual(["px"]);
  });

  it("returns fewer rows than asked when there are fewer candidates", () => {
    expect(ids(pickFreePreviewFindings([c("only", "GHOST_SCRIPT", "LOW")], 5))).toEqual(["only"]);
  });

  it("returns nothing for zero count or no candidates", () => {
    expect(pickFreePreviewFindings([c("x", "GHOST_SCRIPT", "LOW")], 0)).toEqual([]);
    expect(pickFreePreviewFindings([], 5)).toEqual([]);
  });

  it("returns the caller's objects untouched and does not mutate the input", () => {
    const row = { ...c("x", "GHOST_SCRIPT", "LOW"), filename: "layout/theme.liquid" };
    const input = [c("y", "GHOST_SCRIPT", "LOW", 5), row];
    const snapshot = [...input];
    const picked = pickFreePreviewFindings(input, 1);
    expect(picked[0]).toBe(row);
    expect(input).toEqual(snapshot);
  });
});
