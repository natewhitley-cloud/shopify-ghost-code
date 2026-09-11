/**
 * Tests for app/lib/finding-sort.ts
 *
 * Strategy:
 *   - Pure, in-place sort function with no dependencies — test directly.
 *   - Cover the full comparator cascade: severity -> findingType -> filename.
 *   - Cover the unknown-severity `?? 3` branch, empty-array guard, and in-place
 *     mutation semantics.
 *   - Use minimal inline object literals shaped to the function's param type.
 */

import { describe, it, expect } from "vitest";

import { sortDiffFindingsBySeverity } from "../../app/lib/finding-sort";

// ---------------------------------------------------------------------------
// Helpers — minimal literals shaped to the function's parameter type.
// ---------------------------------------------------------------------------

type DiffFinding = {
  severity: string;
  findingType: string;
  filename: string;
};

function diffFinding(overrides: Partial<DiffFinding> = {}): DiffFinding {
  return {
    severity: "LOW",
    findingType: "GHOST_SCRIPT",
    filename: "a.liquid",
    ...overrides,
  };
}

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
