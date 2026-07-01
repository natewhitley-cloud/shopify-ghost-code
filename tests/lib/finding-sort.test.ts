/**
 * Tests for app/lib/finding-sort.ts
 *
 * Strategy:
 *   - Two pure, in-place sort functions with no dependencies — test directly.
 *   - Cover the full comparator cascade: severity -> findingType -> filename
 *     -> lineNumber (the last only for sortFindingsBySeverity).
 *   - Cover the unknown-severity `?? 3` branch, empty-array guard, numeric
 *     (not lexicographic) line ordering, and in-place mutation semantics.
 *   - Use minimal inline object literals shaped to each function's param type.
 */

import { describe, it, expect } from "vitest";

import { sortDiffFindingsBySeverity, sortFindingsBySeverity } from "../../app/lib/finding-sort";

// ---------------------------------------------------------------------------
// Helpers — minimal literals shaped to each function's parameter type.
// ---------------------------------------------------------------------------

type Finding = {
  severity: string;
  findingType: string;
  filename: string;
  lineNumber: number;
};

type DiffFinding = {
  severity: string;
  findingType: string;
  filename: string;
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "LOW",
    findingType: "GHOST_SCRIPT",
    filename: "a.liquid",
    lineNumber: 1,
    ...overrides,
  };
}

function diffFinding(overrides: Partial<DiffFinding> = {}): DiffFinding {
  return {
    severity: "LOW",
    findingType: "GHOST_SCRIPT",
    filename: "a.liquid",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortFindingsBySeverity
// ---------------------------------------------------------------------------

describe("sortFindingsBySeverity", () => {
  // --- Primary: severity ordering ------------------------------------------

  it("orders HIGH before MEDIUM before LOW", () => {
    const findings = [
      finding({ severity: "LOW" }),
      finding({ severity: "HIGH" }),
      finding({ severity: "MEDIUM" }),
    ];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("sorts an unknown severity value last (the `?? 3` branch)", () => {
    const findings = [
      finding({ severity: "CRITICAL" }),
      finding({ severity: "LOW" }),
      finding({ severity: "HIGH" }),
      finding({ severity: "MEDIUM" }),
    ];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["HIGH", "MEDIUM", "LOW", "CRITICAL"]);
  });

  it("sorts an empty-string severity last (also the `?? 3` branch)", () => {
    const findings = [finding({ severity: "" }), finding({ severity: "HIGH" })];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["HIGH", ""]);
  });

  it("keeps two unknown severities together after all known ones", () => {
    const findings = [
      finding({ severity: "CRITICAL", findingType: "GHOST_A" }),
      finding({ severity: "LOW" }),
      finding({ severity: "UNKNOWN", findingType: "GHOST_B" }),
    ];

    sortFindingsBySeverity(findings);

    // Both unknowns collapse to weight 3, so LOW leads; unknowns then tiebreak
    // by findingType (GHOST_A before GHOST_B).
    expect(findings.map((f) => f.severity)).toEqual(["LOW", "CRITICAL", "UNKNOWN"]);
  });

  // --- Secondary: findingType ----------------------------------------------

  it("tiebreaks by findingType when severity is equal", () => {
    const findings = [
      finding({ severity: "HIGH", findingType: "GHOST_STYLE" }),
      finding({ severity: "HIGH", findingType: "GHOST_SCRIPT" }),
      finding({ severity: "HIGH", findingType: "GHOST_SECTION" }),
    ];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => f.findingType)).toEqual([
      "GHOST_SCRIPT",
      "GHOST_SECTION",
      "GHOST_STYLE",
    ]);
  });

  // --- Tertiary: filename ---------------------------------------------------

  it("tiebreaks by filename when severity and findingType are equal", () => {
    const findings = [
      finding({ severity: "MEDIUM", findingType: "GHOST_SCRIPT", filename: "c.liquid" }),
      finding({ severity: "MEDIUM", findingType: "GHOST_SCRIPT", filename: "a.liquid" }),
      finding({ severity: "MEDIUM", findingType: "GHOST_SCRIPT", filename: "b.liquid" }),
    ];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => f.filename)).toEqual(["a.liquid", "b.liquid", "c.liquid"]);
  });

  // --- Quaternary: lineNumber (numeric, not lexicographic) -----------------

  it("tiebreaks by lineNumber numerically (line 9 before line 10)", () => {
    const findings = [
      finding({ lineNumber: 10 }),
      finding({ lineNumber: 9 }),
      finding({ lineNumber: 100 }),
      finding({ lineNumber: 2 }),
    ];

    sortFindingsBySeverity(findings);

    // Lexicographic order would give 10, 100, 2, 9 — assert numeric instead.
    expect(findings.map((f) => f.lineNumber)).toEqual([2, 9, 10, 100]);
  });

  // --- Guards ---------------------------------------------------------------

  it("returns without throwing for an empty array", () => {
    const findings: Finding[] = [];

    expect(() => sortFindingsBySeverity(findings)).not.toThrow();
    expect(findings).toEqual([]);
  });

  // Note: the null/undefined guard (`if (!findings ...)`) is not exercised
  // directly because the parameter type is a non-nullable array — passing
  // null/undefined would require a cast, which we avoid per project convention.

  // --- In-place mutation semantics -----------------------------------------

  it("sorts the same array reference in place and returns void", () => {
    const findings = [finding({ severity: "LOW" }), finding({ severity: "HIGH" })];
    const ref = findings;

    const result = sortFindingsBySeverity(findings);

    expect(result).toBeUndefined();
    expect(findings).toBe(ref);
    expect(findings[0].severity).toBe("HIGH");
  });

  // --- Realistic mixed case -------------------------------------------------

  it("applies the full comparator cascade on a realistic mixed set", () => {
    const findings = [
      finding({ severity: "LOW", findingType: "GHOST_STYLE", filename: "z.liquid", lineNumber: 5 }),
      finding({
        severity: "HIGH",
        findingType: "GHOST_SCRIPT",
        filename: "b.liquid",
        lineNumber: 20,
      }),
      finding({
        severity: "HIGH",
        findingType: "GHOST_SCRIPT",
        filename: "b.liquid",
        lineNumber: 3,
      }),
      finding({
        severity: "HIGH",
        findingType: "GHOST_SCRIPT",
        filename: "a.liquid",
        lineNumber: 99,
      }),
      finding({
        severity: "HIGH",
        findingType: "GHOST_SECTION",
        filename: "a.liquid",
        lineNumber: 1,
      }),
      finding({
        severity: "MEDIUM",
        findingType: "GHOST_STYLE",
        filename: "a.liquid",
        lineNumber: 7,
      }),
      finding({
        severity: "CRITICAL",
        findingType: "GHOST_A",
        filename: "a.liquid",
        lineNumber: 1,
      }),
    ];

    sortFindingsBySeverity(findings);

    expect(findings.map((f) => [f.severity, f.findingType, f.filename, f.lineNumber])).toEqual([
      ["HIGH", "GHOST_SCRIPT", "a.liquid", 99],
      ["HIGH", "GHOST_SCRIPT", "b.liquid", 3],
      ["HIGH", "GHOST_SCRIPT", "b.liquid", 20],
      ["HIGH", "GHOST_SECTION", "a.liquid", 1],
      ["MEDIUM", "GHOST_STYLE", "a.liquid", 7],
      ["LOW", "GHOST_STYLE", "z.liquid", 5],
      ["CRITICAL", "GHOST_A", "a.liquid", 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// sortDiffFindingsBySeverity (no lineNumber)
// ---------------------------------------------------------------------------

describe("sortDiffFindingsBySeverity", () => {
  it("orders HIGH before MEDIUM before LOW", () => {
    const findings = [
      diffFinding({ severity: "MEDIUM" }),
      diffFinding({ severity: "LOW" }),
      diffFinding({ severity: "HIGH" }),
    ];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("sorts an unknown severity value last (the `?? 3` branch)", () => {
    const findings = [
      diffFinding({ severity: "CRITICAL" }),
      diffFinding({ severity: "HIGH" }),
      diffFinding({ severity: "LOW" }),
    ];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["HIGH", "LOW", "CRITICAL"]);
  });

  it("sorts an empty-string severity last (also the `?? 3` branch)", () => {
    const findings = [diffFinding({ severity: "" }), diffFinding({ severity: "MEDIUM" })];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => f.severity)).toEqual(["MEDIUM", ""]);
  });

  it("tiebreaks by findingType when severity is equal", () => {
    const findings = [
      diffFinding({ severity: "HIGH", findingType: "GHOST_STYLE" }),
      diffFinding({ severity: "HIGH", findingType: "GHOST_SCRIPT" }),
    ];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => f.findingType)).toEqual(["GHOST_SCRIPT", "GHOST_STYLE"]);
  });

  it("tiebreaks by filename when severity and findingType are equal", () => {
    const findings = [
      diffFinding({ severity: "LOW", findingType: "GHOST_SCRIPT", filename: "c.liquid" }),
      diffFinding({ severity: "LOW", findingType: "GHOST_SCRIPT", filename: "a.liquid" }),
      diffFinding({ severity: "LOW", findingType: "GHOST_SCRIPT", filename: "b.liquid" }),
    ];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => f.filename)).toEqual(["a.liquid", "b.liquid", "c.liquid"]);
  });

  it("returns without throwing for an empty array", () => {
    const findings: DiffFinding[] = [];

    expect(() => sortDiffFindingsBySeverity(findings)).not.toThrow();
    expect(findings).toEqual([]);
  });

  it("sorts the same array reference in place and returns void", () => {
    const findings = [diffFinding({ severity: "LOW" }), diffFinding({ severity: "HIGH" })];
    const ref = findings;

    const result = sortDiffFindingsBySeverity(findings);

    expect(result).toBeUndefined();
    expect(findings).toBe(ref);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("applies the full comparator cascade on a realistic mixed set", () => {
    const findings = [
      diffFinding({ severity: "LOW", findingType: "GHOST_STYLE", filename: "z.liquid" }),
      diffFinding({ severity: "HIGH", findingType: "GHOST_SCRIPT", filename: "b.liquid" }),
      diffFinding({ severity: "HIGH", findingType: "GHOST_SCRIPT", filename: "a.liquid" }),
      diffFinding({ severity: "HIGH", findingType: "GHOST_SECTION", filename: "a.liquid" }),
      diffFinding({ severity: "MEDIUM", findingType: "GHOST_STYLE", filename: "a.liquid" }),
      diffFinding({ severity: "CRITICAL", findingType: "GHOST_A", filename: "a.liquid" }),
    ];

    sortDiffFindingsBySeverity(findings);

    expect(findings.map((f) => [f.severity, f.findingType, f.filename])).toEqual([
      ["HIGH", "GHOST_SCRIPT", "a.liquid"],
      ["HIGH", "GHOST_SCRIPT", "b.liquid"],
      ["HIGH", "GHOST_SECTION", "a.liquid"],
      ["MEDIUM", "GHOST_STYLE", "a.liquid"],
      ["LOW", "GHOST_STYLE", "z.liquid"],
      ["CRITICAL", "GHOST_A", "a.liquid"],
    ]);
  });
});
