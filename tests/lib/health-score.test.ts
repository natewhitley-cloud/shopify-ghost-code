/**
 * Tests for app/lib/health-score.ts
 *
 * computeHealthScore is a pure function — no mocking required.
 *
 * Formula:
 *   score = max(0, 100 - (HIGH × 10 + MEDIUM × 5 + LOW × 1))
 *
 * Band boundaries:
 *   90-100 → Excellent / success
 *   70-89  → Good     / info
 *   50-69  → Fair     / warning
 *   25-49  → Poor     / caution
 *   0-24   → Critical / critical
 */

import { describe, it, expect } from "vitest";

import { computeHealthScore } from "../../app/lib/health-score";

describe("computeHealthScore", () => {
  // ---------------------------------------------------------------------------
  // Known-input computation
  // ---------------------------------------------------------------------------

  describe("score computation with known inputs", () => {
    it("returns score 100 and Excellent when there are 0 findings", () => {
      const result = computeHealthScore({ HIGH: 0, MEDIUM: 0, LOW: 0 });

      expect(result.score).toBe(100);
      expect(result.label).toBe("Excellent");
      expect(result.tone).toBe("success");
    });

    it("returns score 97 and Excellent for 3 LOW findings", () => {
      // deduction = 3 × 1 = 3, score = 100 - 3 = 97
      const result = computeHealthScore({ HIGH: 0, MEDIUM: 0, LOW: 3 });

      expect(result.score).toBe(97);
      expect(result.label).toBe("Excellent");
      expect(result.tone).toBe("success");
    });

    it("returns score 90 and Excellent for 1 HIGH finding", () => {
      // deduction = 1 × 10 = 10, score = 100 - 10 = 90
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 0, LOW: 0 });

      expect(result.score).toBe(90);
      expect(result.label).toBe("Excellent");
      expect(result.tone).toBe("success");
    });

    it("returns score 85 and Good for 1 HIGH + 1 MEDIUM", () => {
      // deduction = 10 + 5 = 15, score = 100 - 15 = 85
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 1, LOW: 0 });

      expect(result.score).toBe(85);
      expect(result.label).toBe("Good");
      expect(result.tone).toBe("info");
    });

    it("returns score 52 and Fair for 3 HIGH + 3 MEDIUM + 3 LOW", () => {
      // deduction = 30 + 15 + 3 = 48, score = 100 - 48 = 52
      const result = computeHealthScore({ HIGH: 3, MEDIUM: 3, LOW: 3 });

      expect(result.score).toBe(52);
      expect(result.label).toBe("Fair");
      expect(result.tone).toBe("warning");
    });

    it("returns score 25 and Poor for 5 HIGH + 5 MEDIUM", () => {
      // deduction = 50 + 25 = 75, score = 100 - 75 = 25
      const result = computeHealthScore({ HIGH: 5, MEDIUM: 5, LOW: 0 });

      expect(result.score).toBe(25);
      expect(result.label).toBe("Poor");
      expect(result.tone).toBe("caution");
    });

    it("returns score 0 and Critical for 10 HIGH + 1 MEDIUM (clamped)", () => {
      // deduction = 100 + 5 = 105, score = max(0, 100 - 105) = 0
      const result = computeHealthScore({ HIGH: 10, MEDIUM: 1, LOW: 0 });

      expect(result.score).toBe(0);
      expect(result.label).toBe("Critical");
      expect(result.tone).toBe("critical");
    });
  });

  // ---------------------------------------------------------------------------
  // Band boundary tests
  // ---------------------------------------------------------------------------

  describe("band boundaries", () => {
    it("score 90 is Excellent (lower boundary)", () => {
      // 1 HIGH = deduction 10, score 90
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 0, LOW: 0 });

      expect(result.score).toBe(90);
      expect(result.label).toBe("Excellent");
      expect(result.tone).toBe("success");
    });

    it("score 89 is Good (just below Excellent)", () => {
      // deduction = 11 → 1 HIGH + 1 LOW = 10 + 1 = 11, score = 89
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 0, LOW: 1 });

      expect(result.score).toBe(89);
      expect(result.label).toBe("Good");
      expect(result.tone).toBe("info");
    });

    it("score 70 is Good (lower boundary)", () => {
      // deduction = 30 → 3 HIGH = 30, score = 70
      const result = computeHealthScore({ HIGH: 3, MEDIUM: 0, LOW: 0 });

      expect(result.score).toBe(70);
      expect(result.label).toBe("Good");
      expect(result.tone).toBe("info");
    });

    it("score 69 is Fair (just below Good)", () => {
      // deduction = 31 → 3 HIGH + 1 LOW = 30 + 1 = 31, score = 69
      const result = computeHealthScore({ HIGH: 3, MEDIUM: 0, LOW: 1 });

      expect(result.score).toBe(69);
      expect(result.label).toBe("Fair");
      expect(result.tone).toBe("warning");
    });

    it("score 50 is Fair (lower boundary)", () => {
      // deduction = 50 → 5 HIGH = 50, score = 50
      const result = computeHealthScore({ HIGH: 5, MEDIUM: 0, LOW: 0 });

      expect(result.score).toBe(50);
      expect(result.label).toBe("Fair");
      expect(result.tone).toBe("warning");
    });

    it("score 49 is Poor (just below Fair)", () => {
      // deduction = 51 → 5 HIGH + 1 LOW = 50 + 1 = 51, score = 49
      const result = computeHealthScore({ HIGH: 5, MEDIUM: 0, LOW: 1 });

      expect(result.score).toBe(49);
      expect(result.label).toBe("Poor");
      expect(result.tone).toBe("caution");
    });

    it("score 25 is Poor (lower boundary)", () => {
      // deduction = 75 → 5 HIGH + 5 MEDIUM = 50 + 25 = 75, score = 25
      const result = computeHealthScore({ HIGH: 5, MEDIUM: 5, LOW: 0 });

      expect(result.score).toBe(25);
      expect(result.label).toBe("Poor");
      expect(result.tone).toBe("caution");
    });

    it("score 24 is Critical (just below Poor)", () => {
      // deduction = 76 → 5 HIGH + 5 MEDIUM + 1 LOW = 50 + 25 + 1 = 76, score = 24
      const result = computeHealthScore({ HIGH: 5, MEDIUM: 5, LOW: 1 });

      expect(result.score).toBe(24);
      expect(result.label).toBe("Critical");
      expect(result.tone).toBe("critical");
    });

    it("score 0 is Critical (floor)", () => {
      // deduction = 105 → clamped to 0
      const result = computeHealthScore({ HIGH: 10, MEDIUM: 1, LOW: 0 });

      expect(result.score).toBe(0);
      expect(result.label).toBe("Critical");
      expect(result.tone).toBe("critical");
    });
  });

  // ---------------------------------------------------------------------------
  // Return shape
  // ---------------------------------------------------------------------------

  describe("return value structure", () => {
    it("always returns an object with score, label, and tone", () => {
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 0, LOW: 0 });

      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("label");
      expect(result).toHaveProperty("tone");
    });

    it("score is always an integer", () => {
      const result = computeHealthScore({ HIGH: 1, MEDIUM: 1, LOW: 1 });

      expect(Number.isInteger(result.score)).toBe(true);
    });
  });
});
