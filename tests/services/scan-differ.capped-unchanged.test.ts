/**
 * gc-zji: a category the CURRENT scan only partly audited (capped/skipped) has
 * its prior findings dropped from the diff, so a still-present finding there
 * found no match and counted as "new".
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  diffScans,
  scanDiffOptions,
  type DiffableFinding,
} from "../../app/services/scan-differ.server";

function finding(
  findingType: string,
  codeSnippet: string,
  over: Partial<DiffableFinding> = {},
): DiffableFinding {
  return {
    filename: "config/settings_data.json",
    findingType,
    codeSnippet,
    lineNumber: 1,
    severity: "MEDIUM",
    appName: null,
    description: "d",
    ...over,
  };
}

describe("gc-zji: a partly audited category never reads a still-present finding as new", () => {
  const ALL = Object.values(FindingType);
  const coverage = (capped: string[] = []) => ({
    skippedCategories: [] as string[],
    cappedCategories: capped,
    unreachableCategories: [] as string[],
    skippedFiles: [] as string[],
    liveFindingTypes: ALL as unknown,
  });
  const dangling = (ref: string) =>
    finding("DANGLING_REFERENCE", `{% render '${ref}' %}`, { filename: "sections/a.liquid" });

  it("current capped, baseline full: the same finding is unchanged, not new", () => {
    const opts = scanDiffOptions(coverage(["DANGLING_REFERENCE"]), coverage());
    const diff = diffScans([dangling("x")], [dangling("x")], opts);
    expect(diff.newFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("current capped, baseline full: a genuinely new finding is still new", () => {
    const opts = scanDiffOptions(coverage(["DANGLING_REFERENCE"]), coverage());
    const diff = diffScans([dangling("x"), dangling("y")], [dangling("x")], opts);
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.unchangedCount).toBe(1);
  });

  it("current capped: a prior finding not seen now is unknown, never resolved", () => {
    const opts = scanDiffOptions(coverage(["DANGLING_REFERENCE"]), coverage());
    const diff = diffScans([], [dangling("x")], opts);
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.newFindings).toEqual([]);
  });

  it("cap recurs on both scans: stable finding unchanged, unmatched one not new", () => {
    const opts = scanDiffOptions(
      coverage(["DANGLING_REFERENCE"]),
      coverage(["DANGLING_REFERENCE"]),
    );
    const diff = diffScans([dangling("x"), dangling("y")], [dangling("x")], opts);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toEqual([]);
  });

  it("duplicates: one prior copy matches one current copy; the extra copy is new", () => {
    const opts = scanDiffOptions(coverage(["DANGLING_REFERENCE"]), coverage());
    const diff = diffScans([dangling("x"), dangling("x")], [dangling("x")], opts);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(1);
  });

  it("raw diffScans with skippedCategories only (no scanDiffOptions): same rule", () => {
    const diff = diffScans([dangling("x")], [dangling("x")], {
      skippedCategories: ["DANGLING_REFERENCE"],
    });
    expect(diff.newFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });
});
