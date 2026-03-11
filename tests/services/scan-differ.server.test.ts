/**
 * Tests for app/services/scan-differ.server.ts
 *
 * Both fingerprintFinding and diffScans are pure functions — no mocks needed.
 * Tests cover:
 *   - fingerprintFinding: determinism, uniqueness, stability
 *   - diffScans: first scan (empty previous), identical scans, fully new scans,
 *     fully resolved scans, mixed diffs, and duplicate-finding edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  fingerprintFinding,
  diffScans,
  type DiffableFinding,
  type ScanDiff,
} from "../../app/services/scan-differ.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(
  filename: string,
  findingType: string,
  codeSnippet: string,
  overrides: Partial<DiffableFinding> = {},
): DiffableFinding {
  return {
    filename,
    findingType,
    codeSnippet,
    severity: "HIGH",
    appName: null,
    description: `Finding in ${filename}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fingerprintFinding
// ---------------------------------------------------------------------------

describe("fingerprintFinding", () => {
  it("returns the same fingerprint for identical inputs (determinism)", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>");
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>");
    expect(fp1).toBe(fp2);
  });

  it("returns different fingerprints when filename differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>");
    const fp2 = fingerprintFinding("sections/header.liquid", "GHOST_SCRIPT", "<script src='x'>");
    expect(fp1).not.toBe(fp2);
  });

  it("returns different fingerprints when findingType differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "code");
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_STYLE", "code");
    expect(fp1).not.toBe(fp2);
  });

  it("returns different fingerprints when codeSnippet differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet A");
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet B");
    expect(fp1).not.toBe(fp2);
  });

  it("returns an 8-character hex string", () => {
    const fp = fingerprintFinding("file.liquid", "GHOST_SCRIPT", "code");
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles empty string inputs without throwing", () => {
    expect(() => fingerprintFinding("", "", "")).not.toThrow();
    const fp = fingerprintFinding("", "", "");
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("treats delimiter position as significant — filename\\0type\\0snippet vs filename\\0snippet\\0type differ", () => {
    // The raw concat is "a\0b\0c" — changing order should change the hash.
    const fp1 = fingerprintFinding("a", "b", "c");
    const fp2 = fingerprintFinding("a", "c", "b");
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// diffScans — empty / first-scan cases
// ---------------------------------------------------------------------------

describe("diffScans — first scan (no previous findings)", () => {
  it("classifies all current findings as new when previousFindings is empty", () => {
    const current = [
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>"),
      makeFinding("snippets/old.liquid", "GHOST_SNIPPET", "{% render 'old' %}"),
    ];

    const diff = diffScans(current, []);

    expect(diff.newFindings).toHaveLength(2);
    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });

  it("returns an empty diff when both current and previous are empty", () => {
    const diff = diffScans([], []);

    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });

  it("classifies all previous findings as resolved when current is empty", () => {
    const previous = [
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>"),
    ];

    const diff = diffScans([], previous);

    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.unchangedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffScans — identical scans
// ---------------------------------------------------------------------------

describe("diffScans — identical scans (no changes)", () => {
  it("reports all findings as unchanged when both scans are identical", () => {
    const findings = [
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>"),
      makeFinding("sections/header.liquid", "GHOST_STYLE", "<link href='y'>"),
    ];

    const diff = diffScans(findings, findings);

    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// diffScans — fully different scans
// ---------------------------------------------------------------------------

describe("diffScans — completely different findings", () => {
  it("reports all current as new and all previous as resolved", () => {
    const current = [
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "new-script"),
    ];
    const previous = [
      makeFinding("snippets/old.liquid", "GHOST_SNIPPET", "old-snippet"),
    ];

    const diff = diffScans(current, previous);

    expect(diff.newFindings).toHaveLength(1);
    expect(diff.newFindings[0].filename).toBe("layout/theme.liquid");
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].filename).toBe("snippets/old.liquid");
    expect(diff.unchangedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffScans — mixed diffs
// ---------------------------------------------------------------------------

describe("diffScans — mixed diff (some new, some resolved, some unchanged)", () => {
  it("correctly categorises each finding in a realistic mixed scenario", () => {
    const shared = makeFinding(
      "layout/theme.liquid",
      "GHOST_SCRIPT",
      "<script src='shared'>",
    );
    const newFinding = makeFinding(
      "sections/new.liquid",
      "GHOST_STYLE",
      "<link href='new'>",
    );
    const resolvedFinding = makeFinding(
      "snippets/removed.liquid",
      "GHOST_SNIPPET",
      "{% render 'gone' %}",
    );

    const current = [shared, newFinding];
    const previous = [shared, resolvedFinding];

    const diff = diffScans(current, previous);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.newFindings[0].filename).toBe("sections/new.liquid");
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].filename).toBe("snippets/removed.liquid");
  });
});

// ---------------------------------------------------------------------------
// diffScans — metadata preserved in output
// ---------------------------------------------------------------------------

describe("diffScans — output shape", () => {
  it("preserves filename, findingType, severity, appName, description on new findings", () => {
    const finding = makeFinding(
      "layout/theme.liquid",
      "GHOST_SCRIPT",
      "snippet",
      { severity: "MEDIUM", appName: "SomeApp", description: "Ghost script" },
    );

    const diff = diffScans([finding], []);

    expect(diff.newFindings[0]).toEqual({
      filename: "layout/theme.liquid",
      findingType: "GHOST_SCRIPT",
      severity: "MEDIUM",
      appName: "SomeApp",
      description: "Ghost script",
    });
  });

  it("preserves filename, findingType, severity, appName, description on resolved findings", () => {
    const finding = makeFinding(
      "snippets/old.liquid",
      "GHOST_SNIPPET",
      "snippet",
      { severity: "LOW", appName: null, description: "Orphaned snippet" },
    );

    const diff = diffScans([], [finding]);

    expect(diff.resolvedFindings[0]).toEqual({
      filename: "snippets/old.liquid",
      findingType: "GHOST_SNIPPET",
      severity: "LOW",
      appName: null,
      description: "Orphaned snippet",
    });
  });
});

// ---------------------------------------------------------------------------
// diffScans — duplicate finding edge cases
// ---------------------------------------------------------------------------

describe("diffScans — duplicate findings (same fingerprint multiple times)", () => {
  it("treats each occurrence as independent — extra current copies become new", () => {
    const finding = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet");
    // Current has 2 copies, previous has 1 — the second copy should be new.
    const diff = diffScans([finding, finding], [finding]);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.resolvedFindings).toHaveLength(0);
  });

  it("treats extra previous copies as resolved when current has fewer", () => {
    const finding = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet");
    // Current has 1 copy, previous has 2 — the second previous copy should be resolved.
    const diff = diffScans([finding], [finding, finding]);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("correctly handles two identical copies in both sets — both unchanged, none new/resolved", () => {
    const finding = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet");
    const diff = diffScans([finding, finding], [finding, finding]);

    expect(diff.unchangedCount).toBe(2);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });
});
