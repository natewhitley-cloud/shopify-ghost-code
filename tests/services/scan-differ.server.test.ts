/**
 * Tests for app/services/scan-differ.server.ts
 *
 * Both fingerprintFinding and diffScans are pure functions — no mocks needed.
 * Tests cover:
 *   - fingerprintFinding: determinism, uniqueness, stability
 *   - diffScans: first scan (empty previous), identical scans, fully new scans,
 *     fully resolved scans, mixed diffs, and duplicate-finding edge cases.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  fingerprintFinding,
  normalizeForFingerprint,
  diffScans,
  scanDiffOptions,
  unauditedCategories,
  type DiffableFinding,
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
    // Default to 1 (a single-line, no-leading-context snippet) so callers that
    // only care about filename/type/snippet behave like the old 3-field hash.
    lineNumber: 1,
    severity: "HIGH",
    appName: null,
    description: `Finding in ${filename}`,
    ...overrides,
  };
}

/**
 * Mirrors buildSnippet (scan-engine.server.ts): the matched line plus one line
 * of context before and after, capped at 300 chars. Returns the snippet and the
 * 1-based lineNumber of the matched line, ready to feed a DiffableFinding.
 */
function buildSnippetFixture(
  before: string,
  matched: string,
  after: string,
): { codeSnippet: string; lineNumber: number } {
  // The matched line is the 2nd of three; with a leading context line its
  // 1-based file line number is >= 2 (we use 2 here).
  return {
    codeSnippet: [before, matched, after].join("\n").slice(0, 300),
    lineNumber: 2,
  };
}

// ---------------------------------------------------------------------------
// fingerprintFinding
// ---------------------------------------------------------------------------

describe("fingerprintFinding", () => {
  it("returns the same fingerprint for identical inputs (determinism)", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>", 1);
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>", 1);
    expect(fp1).toBe(fp2);
  });

  it("returns different fingerprints when filename differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>", 1);
    const fp2 = fingerprintFinding("sections/header.liquid", "GHOST_SCRIPT", "<script src='x'>", 1);
    expect(fp1).not.toBe(fp2);
  });

  it("returns different fingerprints when findingType differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "code", 1);
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_STYLE", "code", 1);
    expect(fp1).not.toBe(fp2);
  });

  it("returns different fingerprints when the matched line differs", () => {
    const fp1 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet A", 1);
    const fp2 = fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet B", 1);
    expect(fp1).not.toBe(fp2);
  });

  it("returns an 8-character hex string", () => {
    const fp = fingerprintFinding("file.liquid", "GHOST_SCRIPT", "code", 1);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles empty string inputs without throwing", () => {
    expect(() => fingerprintFinding("", "", "", 0)).not.toThrow();
    const fp = fingerprintFinding("", "", "", 0);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("treats delimiter position as significant — filename\\0type\\0snippet vs filename\\0snippet\\0type differ", () => {
    // The raw concat is "a\0b\0c" — changing order should change the hash.
    const fp1 = fingerprintFinding("a", "b", "c", 1);
    const fp2 = fingerprintFinding("a", "c", "b", 1);
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// normalizeForFingerprint — LOG-10 matched-line normalization
//
// The fingerprint hashes a normalized matched line instead of the raw display
// snippet so that edits which don't touch the finding (adjacent context lines,
// volatile bulk-redirect counts/samples) no longer flip an unchanged finding to
// resolved + new. These tests pin the normalization rule directly; the
// fingerprintFinding and diffScans suites below exercise it end-to-end.
// ---------------------------------------------------------------------------

describe("normalizeForFingerprint (LOG-10)", () => {
  it("extracts the matched line (index 1) when a leading context line exists (lineNumber >= 2)", () => {
    const snippet =
      "<div>before</div>\n<script src='//cdn.app.com/x.js'></script>\n<div>after</div>";
    expect(normalizeForFingerprint(snippet, 10)).toBe("<script src='//cdn.app.com/x.js'></script>");
  });

  it("extracts the first line (index 0) when there is no leading context (lineNumber 1)", () => {
    const snippet = "<script src='//cdn.app.com/x.js'></script>\n<div>after</div>";
    expect(normalizeForFingerprint(snippet, 1)).toBe("<script src='//cdn.app.com/x.js'></script>");
  });

  it("extracts the first line for synthetic snippets (lineNumber 0)", () => {
    const snippet = "Page: Summer Sale\nHandle: /pagefly-summer\nContent: hello";
    expect(normalizeForFingerprint(snippet, 0)).toBe("Page: Summer Sale");
  });

  it("collapses internal whitespace and trims so reindentation does not churn", () => {
    expect(normalizeForFingerprint("    {%  render   'x'  %}   ", 1)).toBe("{% render 'x' %}");
  });

  it("falls back to the first line when the matched index is absent (single-line snippet)", () => {
    // A 300-char cap can truncate a buildSnippet down to its leading line only.
    expect(normalizeForFingerprint("only-one-line", 5)).toBe("only-one-line");
  });

  it("strips the leading volatile count from a bulk-redirect snippet", () => {
    const snippet =
      "84 redirects under /collections:\n  /collections/a → /b\n  /collections/c → /d";
    expect(normalizeForFingerprint(snippet, 0)).toBe("redirects under /collections:");
  });

  it("does NOT strip a leading number from an unrelated matched line", () => {
    // Guard against over-normalization: only the bulk-redirect shape is stripped.
    expect(normalizeForFingerprint("3 reviews left by Loox widget", 1)).toBe(
      "3 reviews left by Loox widget",
    );
  });

  it("handles an empty snippet without throwing", () => {
    expect(normalizeForFingerprint("", 0)).toBe("");
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
    const previous = [makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='x'>")];

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
    const current = [makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "new-script")];
    const previous = [makeFinding("snippets/old.liquid", "GHOST_SNIPPET", "old-snippet")];

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
    const shared = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "<script src='shared'>");
    const newFinding = makeFinding("sections/new.liquid", "GHOST_STYLE", "<link href='new'>");
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
    const finding = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "snippet", {
      severity: "MEDIUM",
      appName: "SomeApp",
      description: "Ghost script",
    });

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
    const finding = makeFinding("snippets/old.liquid", "GHOST_SNIPPET", "snippet", {
      severity: "LOW",
      appName: null,
      description: "Orphaned snippet",
    });

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

// ---------------------------------------------------------------------------
// diffScans — skipped (un-audited) categories (LOG-4)
//
// When the CURRENT scan did not audit a category (its optional scope was not
// granted → PARTIAL), prior findings in that category must NOT be reported as
// "resolved" — we never re-checked them, so we cannot claim they are gone.
// ---------------------------------------------------------------------------

describe("unauditedCategories (gc-11f)", () => {
  it("returns the union of scope-skipped and size-capped categories", () => {
    expect(
      unauditedCategories({
        skippedCategories: ["GHOST_PAGE"],
        cappedCategories: ["DANGLING_REFERENCE"],
        unreachableCategories: [],
      }),
    ).toEqual(["GHOST_PAGE", "DANGLING_REFERENCE"]);
  });

  it("dedupes a category that was both skipped and capped", () => {
    expect(
      unauditedCategories({
        skippedCategories: ["JSON_LD_PRICE_CONFLICT"],
        cappedCategories: ["JSON_LD_PRICE_CONFLICT"],
        unreachableCategories: [],
      }),
    ).toEqual(["JSON_LD_PRICE_CONFLICT"]);
  });

  it("returns an empty list for a fully-audited (or legacy, cappedCategories = []) scan", () => {
    expect(
      unauditedCategories({
        skippedCategories: [],
        cappedCategories: [],
        unreachableCategories: [],
      }),
    ).toEqual([]);
  });

  it("returns capped-only categories when nothing was scope-skipped", () => {
    expect(
      unauditedCategories({
        skippedCategories: [],
        cappedCategories: ["DANGLING_REFERENCE"],
        unreachableCategories: [],
      }),
    ).toEqual(["DANGLING_REFERENCE"]);
  });

  it("keeps a prior finding in a CAPPED category from being reported resolved", () => {
    // The dangling audit ran but hit its lookup budget, so the prior broken
    // link was not re-checked. It must be excluded, not falsely "resolved",
    // while an audited category still resolves normally.
    const priorDangling = makeFinding("sections/footer.liquid", "DANGLING_REFERENCE", "gone");
    const priorScript = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script");

    const diff = diffScans([], [priorDangling, priorScript], {
      skippedCategories: unauditedCategories({
        skippedCategories: [],
        cappedCategories: ["DANGLING_REFERENCE"],
        unreachableCategories: [],
      }),
    });

    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].findingType).toBe("GHOST_SCRIPT");
  });

  it("includes categories the scan could not reach (storefront unreadable)", () => {
    expect(
      unauditedCategories({
        skippedCategories: ["GHOST_PAGE"],
        cappedCategories: ["DANGLING_REFERENCE"],
        unreachableCategories: ["SCRIPT_TAG_SUNSET"],
      }),
    ).toEqual(["GHOST_PAGE", "DANGLING_REFERENCE", "SCRIPT_TAG_SUNSET"]);
  });

  it("does not resolve a prior SCRIPT_TAG_SUNSET finding when the storefront was unreachable", () => {
    const priorScriptTag = makeFinding(
      "storefront/script-tags",
      "SCRIPT_TAG_SUNSET",
      "https://cdn.example.com/widget.js",
    );
    const priorScript = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script");

    const diff = diffScans([], [priorScriptTag, priorScript], {
      skippedCategories: unauditedCategories({
        skippedCategories: [],
        cappedCategories: [],
        unreachableCategories: ["SCRIPT_TAG_SUNSET"],
      }),
    });

    expect(diff.resolvedFindings.map((f) => f.findingType)).toEqual(["GHOST_SCRIPT"]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("resolves a prior SCRIPT_TAG_SUNSET finding when the storefront was read and it is gone", () => {
    const priorScriptTag = makeFinding(
      "storefront/script-tags",
      "SCRIPT_TAG_SUNSET",
      "https://cdn.example.com/widget.js",
    );

    const diff = diffScans([], [priorScriptTag], {
      skippedCategories: unauditedCategories({
        skippedCategories: [],
        cappedCategories: [],
        unreachableCategories: [],
      }),
    });

    expect(diff.resolvedFindings.map((f) => f.findingType)).toEqual(["SCRIPT_TAG_SUNSET"]);
  });
});

describe("diffScans — skipped categories (LOG-4 un-audited exclusion)", () => {
  it("does NOT mark a prior finding as resolved when its category was skipped this run", () => {
    // The previous scan found an orphaned product tag; the current scan could
    // not audit GHOST_TAG (scope revoked). Without the guard this would be a
    // false "resolved".
    const previous = [makeFinding("n/a", "GHOST_TAG", "orphan-tag")];

    const diff = diffScans([], previous, { skippedCategories: ["GHOST_TAG"] });

    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });

  it("still resolves findings in AUDITED categories while excluding skipped ones (PARTIAL baseline)", () => {
    // A PARTIAL baseline is valid for the categories the current scan DID audit.
    const resolvedScript = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script");
    const skippedTag = makeFinding("n/a", "GHOST_TAG", "orphan-tag");
    const previous = [resolvedScript, skippedTag];

    // Current scan audited GHOST_SCRIPT (found nothing → resolved) but skipped
    // GHOST_TAG.
    const diff = diffScans([], previous, { skippedCategories: ["GHOST_TAG"] });

    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].findingType).toBe("GHOST_SCRIPT");
    expect(diff.unchangedCount).toBe(0);
    expect(diff.newFindings).toHaveLength(0);
  });

  it("keeps an unchanged finding in a skipped category from being miscounted", () => {
    // Edge case: the current scan reports a finding in a skipped category (e.g.
    // theme-level GHOST_TAG-shaped data). The prior copy is excluded, so the
    // current one is simply "new" rather than "unchanged" — never a false
    // resolved, and counts stay internally consistent.
    const tag = makeFinding("n/a", "GHOST_TAG", "orphan-tag");

    const diff = diffScans([tag], [tag], { skippedCategories: ["GHOST_TAG"] });

    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
    expect(diff.newFindings).toHaveLength(1);
  });

  it("supports multiple skipped categories at once", () => {
    const previous = [
      makeFinding("n/a", "GHOST_TAG", "orphan-tag"),
      makeFinding("n/a", "GHOST_PRICE", "stale-price"),
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script"),
    ];

    const diff = diffScans([], previous, {
      skippedCategories: ["GHOST_TAG", "GHOST_PRICE"],
    });

    // Only the audited GHOST_SCRIPT finding is resolved.
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].findingType).toBe("GHOST_SCRIPT");
  });

  it("behaves identically to no-opts when skippedCategories is empty or omitted", () => {
    const previous = [makeFinding("n/a", "GHOST_TAG", "orphan-tag")];

    const withEmpty = diffScans([], previous, { skippedCategories: [] });
    const without = diffScans([], previous);

    // Empty skip set must not suppress a genuine resolved finding.
    expect(withEmpty.resolvedFindings).toHaveLength(1);
    expect(without.resolvedFindings).toHaveLength(1);
  });

  it("skips only JSON_LD_PRICE_CONFLICT, leaving the worker's JSON_LD_CONFLICT to diff (gc-47c.10)", () => {
    // The live-price audit (JSON_LD_PRICE_CONFLICT) was scope-skipped, but the
    // worker's same-file conflict detector (JSON_LD_CONFLICT) always runs. Because
    // the two are DISTINCT types, listing only JSON_LD_PRICE_CONFLICT must NOT
    // suppress a genuinely-resolved worker JSON_LD_CONFLICT — the pre-fix bug that
    // shared one type would have hidden it.
    const previous = [
      makeFinding("sections/product.liquid", "JSON_LD_CONFLICT", "worker-conflict"),
      makeFinding("sections/product.liquid", "JSON_LD_PRICE_CONFLICT", "stale-price"),
    ];

    const diff = diffScans([], previous, {
      skippedCategories: ["JSON_LD_PRICE_CONFLICT"],
    });

    // The worker conflict is re-checked (audited) and gone -> resolved.
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].findingType).toBe("JSON_LD_CONFLICT");
    // The price conflict was NOT re-checked -> excluded, never false-resolved.
    expect(diff.resolvedFindings.some((f) => f.findingType === "JSON_LD_PRICE_CONFLICT")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// diffScans — skipped files (gc-06e.19 oversized-file exclusion)
// ---------------------------------------------------------------------------

describe("diffScans — skipped files (gc-06e.19 oversized-file exclusion)", () => {
  it("does NOT mark a prior finding as resolved when its file was skipped (oversized) this run", () => {
    // Scan A found ghost code in a .liquid file. Before scan B the file grew
    // past MAX_SCANNABLE_FILE_BYTES, so scan B skipped it entirely — its
    // per-file detectors never ran. Without the guard, scan B's diff would count
    // every prior finding in that file as a false "resolved", telling the
    // merchant they fixed something they did not.
    const previous = [
      makeFinding("sections/bloated.liquid", "GHOST_SCRIPT", "old-script"),
      makeFinding("sections/bloated.liquid", "GHOST_STYLE", "old-style"),
    ];

    const diff = diffScans([], previous, { skippedFiles: ["sections/bloated.liquid"] });

    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });

  it("still resolves findings in SCANNED files while excluding skipped ones", () => {
    const resolvedScript = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script");
    const skippedFileFinding = makeFinding("sections/bloated.liquid", "GHOST_SCRIPT", "old-script");
    const previous = [resolvedScript, skippedFileFinding];

    // Current scan scanned layout/theme.liquid (found nothing → resolved) but
    // skipped sections/bloated.liquid for being oversized.
    const diff = diffScans([], previous, { skippedFiles: ["sections/bloated.liquid"] });

    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].filename).toBe("layout/theme.liquid");
    expect(diff.unchangedCount).toBe(0);
    expect(diff.newFindings).toHaveLength(0);
  });

  it("excludes skipped-file findings via BOTH filters at once (category + file)", () => {
    const previous = [
      makeFinding("n/a", "GHOST_TAG", "orphan-tag"), // skipped category
      makeFinding("sections/bloated.liquid", "GHOST_SCRIPT", "old-script"), // skipped file
      makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "old-script"), // genuinely resolved
    ];

    const diff = diffScans([], previous, {
      skippedCategories: ["GHOST_TAG"],
      skippedFiles: ["sections/bloated.liquid"],
    });

    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].filename).toBe("layout/theme.liquid");
  });

  it("behaves identically to no-opts when skippedFiles is empty or omitted", () => {
    const previous = [makeFinding("sections/bloated.liquid", "GHOST_SCRIPT", "old-script")];

    const withEmpty = diffScans([], previous, { skippedFiles: [] });
    const without = diffScans([], previous);

    // Empty skip set must not suppress a genuine resolved finding.
    expect(withEmpty.resolvedFindings).toHaveLength(1);
    expect(without.resolvedFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// diffScans — cross-file findings on skipped files (gc-06e.19)
//
// The oversized-file skip only turns OFF the per-file detectors (Pass 1). The
// cross-file passes (Pass 2 ORPHAN_ASSET, Pass 4 GHOST_LAYOUT) still run over an
// oversized file, so cross-file findings attributed to that file ARE recomputed
// in the current scan and must diff normally — they are NOT excluded by the
// skipped-file filter (which would misreport them as new every rescan and drop
// genuine resolutions).
// ---------------------------------------------------------------------------

describe("diffScans — cross-file findings survive the skipped-file filter (gc-06e.19)", () => {
  it("reports an ORPHAN_ASSET on a skipped file as UNCHANGED when it exists in both scans", () => {
    // Pass 2 still ran on the oversized file, so the same ORPHAN_ASSET is present
    // in current and previous. Before the fix the skipped-file filter dropped the
    // previous copy, so the current copy became "new" AND the previous copy was
    // silently lost from the resolved calculation (a false new every rescan).
    const orphan = makeFinding("snippets/bloated.liquid", "ORPHAN_ASSET", "", {
      description: "snippets/bloated.liquid is never referenced",
    });
    const previous = [orphan];
    const current = [orphan];

    const diff = diffScans(current, previous, { skippedFiles: ["snippets/bloated.liquid"] });

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });

  it("reports an ORPHAN_ASSET on a skipped file as RESOLVED when absent from the current scan", () => {
    // Pass 2 still ran and found the snippet is now referenced (or removed), so
    // the ORPHAN_ASSET is genuinely gone. Because the cross-file pass DID run, the
    // absence is a real resolution and must be reported.
    const previous = [makeFinding("snippets/bloated.liquid", "ORPHAN_ASSET", "")];

    const diff = diffScans([], previous, { skippedFiles: ["snippets/bloated.liquid"] });

    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.resolvedFindings[0].findingType).toBe("ORPHAN_ASSET");
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });

  it("still excludes a PER-FILE finding (GHOST_SCRIPT) on a skipped file present in previous only", () => {
    // A per-file detector did NOT run on the oversized file, so its absence from
    // the current scan is unknown, not fixed — it must remain excluded (never a
    // false resolved), even though a cross-file finding on the same file would
    // diff normally.
    const previous = [makeFinding("snippets/bloated.liquid", "GHOST_SCRIPT", "old-script")];

    const diff = diffScans([], previous, { skippedFiles: ["snippets/bloated.liquid"] });

    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffScans — MALICIOUS_SCRIPT on skipped files (gc-qqt)
//
// The malicious-domain pass is the ONE per-file detector that still runs on an
// oversized (size-skipped) file, so its findings there are recomputed every
// scan and must diff normally, exactly like the cross-file types above.
// ---------------------------------------------------------------------------

describe("diffScans — MALICIOUS_SCRIPT on a skipped file diffs normally (gc-qqt)", () => {
  const SKIPPED = ["sections/padded.liquid"];
  const malicious = makeFinding(
    "sections/padded.liquid",
    "MALICIOUS_SCRIPT",
    '<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
  );

  it("reports a malicious finding newly found in a skipped file as NEW", () => {
    const diff = diffScans([malicious], [], { skippedFiles: SKIPPED });
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.newFindings[0].findingType).toBe("MALICIOUS_SCRIPT");
  });

  it("reports it as UNCHANGED (not a false 'new') when present in both scans", () => {
    const diff = diffScans([malicious], [malicious], { skippedFiles: SKIPPED });
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });

  it("reports it as RESOLVED when removed while the file is still oversized", () => {
    const stale = makeFinding("sections/padded.liquid", "GHOST_SCRIPT", "old-script");
    const diff = diffScans([], [malicious, stale], { skippedFiles: SKIPPED });
    // The malicious pass re-checked the file, so its absence is a real fix; the
    // per-file GHOST_SCRIPT was not re-checked and stays excluded.
    expect(diff.resolvedFindings.map((f) => f.findingType)).toEqual(["MALICIOUS_SCRIPT"]);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.unchangedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffScans — CHECKOUT_SUNSET on a skipped checkout.liquid (gc-4yg)
//
// detectCheckoutSunset still emits its presence finding for a checkout.liquid
// over the size cap (the scanner size-skips the same file), so like
// MALICIOUS_SCRIPT it is re-checked every scan and must diff normally.
// ---------------------------------------------------------------------------

describe("diffScans — CHECKOUT_SUNSET on a skipped checkout.liquid diffs normally (gc-4yg)", () => {
  const SKIPPED = ["layout/checkout.liquid"];
  const sunset = makeFinding("layout/checkout.liquid", "CHECKOUT_SUNSET", "<script>x()</script>");

  it("reports it as UNCHANGED (not a false 'new') when present in both scans", () => {
    const diff = diffScans([sunset], [sunset], { skippedFiles: SKIPPED });
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });

  it("reports it as RESOLVED when the current scan no longer emits it", () => {
    const diff = diffScans([], [sunset], { skippedFiles: SKIPPED });
    expect(diff.resolvedFindings.map((f) => f.findingType)).toEqual(["CHECKOUT_SUNSET"]);
  });
});

// ---------------------------------------------------------------------------
// LOG-10 — fingerprint stability across non-substantive snippet changes
//
// These are the acceptance criteria: a finding's identity must survive edits
// that don't touch it (adjacent context lines; bulk-redirect counts/samples),
// while genuinely different findings must keep distinct fingerprints.
// ---------------------------------------------------------------------------

describe("fingerprintFinding — LOG-10 stability", () => {
  it("is UNCHANGED when only an adjacent context line of a buildSnippet finding changes", () => {
    const matched = "<script src='//cdn.app.com/ghost.js'></script>";
    const before = buildSnippetFixture("<div class='hero'>", matched, "</div>");
    const after = buildSnippetFixture("<div class='hero promo'>", matched, "</div>");

    const fpBefore = fingerprintFinding(
      "sections/header.liquid",
      "GHOST_SCRIPT",
      before.codeSnippet,
      before.lineNumber,
    );
    const fpAfter = fingerprintFinding(
      "sections/header.liquid",
      "GHOST_SCRIPT",
      after.codeSnippet,
      after.lineNumber,
    );

    expect(fpAfter).toBe(fpBefore);
  });

  it("is UNCHANGED for a bulk redirect with the same prefix but a different count and samples", () => {
    const filename = "redirects/bulk/_collections";
    const earlier =
      "84 redirects under /collections:\n  /collections/a → /x\n  /collections/b → /y";
    const later = "85 redirects under /collections:\n  /collections/c → /z\n  /collections/d → /w";

    const fpEarlier = fingerprintFinding(filename, "GHOST_REDIRECT", earlier, 0);
    const fpLater = fingerprintFinding(filename, "GHOST_REDIRECT", later, 0);

    expect(fpLater).toBe(fpEarlier);
  });

  it("is DIFFERENT for two buildSnippet findings whose matched lines differ", () => {
    const a = buildSnippetFixture(
      "<head>",
      "<script src='//cdn.app.com/a.js'></script>",
      "</head>",
    );
    const b = buildSnippetFixture(
      "<head>",
      "<script src='//cdn.app.com/b.js'></script>",
      "</head>",
    );

    const fpA = fingerprintFinding(
      "layout/theme.liquid",
      "GHOST_SCRIPT",
      a.codeSnippet,
      a.lineNumber,
    );
    const fpB = fingerprintFinding(
      "layout/theme.liquid",
      "GHOST_SCRIPT",
      b.codeSnippet,
      b.lineNumber,
    );

    expect(fpA).not.toBe(fpB);
  });

  it("is DIFFERENT for two bulk redirects under different prefixes", () => {
    // Note: filenames already differ by prefix; this asserts the normalized
    // matched line stays distinct too, so neither layer can collide them.
    const collections = "60 redirects under /collections:\n  /collections/a → /x";
    const pages = "60 redirects under /pages:\n  /pages/a → /x";

    const fpCollections = fingerprintFinding(
      "redirects/bulk/_collections",
      "GHOST_REDIRECT",
      collections,
      0,
    );
    const fpPages = fingerprintFinding("redirects/bulk/_pages", "GHOST_REDIRECT", pages, 0);

    expect(fpCollections).not.toBe(fpPages);
  });
});

describe("diffScans — LOG-10 stability (end-to-end)", () => {
  it("counts a finding as unchanged when only its adjacent context line changed between scans", () => {
    const matched = "<script src='//cdn.app.com/ghost.js'></script>";
    const previousSnippet = buildSnippetFixture("<div class='a'>", matched, "</div>");
    const currentSnippet = buildSnippetFixture("<div class='a changed'>", matched, "</div>");

    const previous = [
      makeFinding("sections/header.liquid", "GHOST_SCRIPT", previousSnippet.codeSnippet, {
        lineNumber: previousSnippet.lineNumber,
      }),
    ];
    const current = [
      makeFinding("sections/header.liquid", "GHOST_SCRIPT", currentSnippet.codeSnippet, {
        lineNumber: currentSnippet.lineNumber,
      }),
    ];

    const diff = diffScans(current, previous);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });

  it("counts a bulk redirect as unchanged when only its count and samples grew", () => {
    const filename = "redirects/bulk/_collections";
    const previous = [
      makeFinding(
        filename,
        "GHOST_REDIRECT",
        "84 redirects under /collections:\n  /collections/a → /x\n  /collections/b → /y",
        { lineNumber: 0, appName: null },
      ),
    ];
    const current = [
      makeFinding(
        filename,
        "GHOST_REDIRECT",
        "85 redirects under /collections:\n  /collections/c → /z\n  /collections/d → /w",
        { lineNumber: 0, appName: null },
      ),
    ];

    const diff = diffScans(current, previous);

    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-attribution stability (gc-1ql)
// ---------------------------------------------------------------------------

describe("diffScans is stable across appName re-attribution", () => {
  it("reports re-attributed findings as persisted, not resolved+new", () => {
    // Same filename / findingType / codeSnippet / lineNumber, only appName
    // changes (Facebook Pixel/Google Analytics → Spreadr/PageFly). appName is
    // NOT part of fingerprintFinding, so the identity must be unchanged.
    const previous: DiffableFinding[] = [
      makeFinding("snippets/spreadr.liquid", "GHOST_PIXEL", "  fbq('init', '123');", {
        appName: "Facebook Pixel",
        description: "Inline tracking pixel from Facebook Pixel (fbq)",
      }),
      makeFinding("snippets/pagefly-main-js.liquid", "GHOST_SCRIPT", "gtag script", {
        appName: "Google Tag Manager",
        description: "External script from Google Tag Manager (...)",
      }),
    ];
    const current: DiffableFinding[] = [
      makeFinding("snippets/spreadr.liquid", "GHOST_PIXEL", "  fbq('init', '123');", {
        appName: "Spreadr",
        description: "Inline tracking pixel left by Spreadr (calls Facebook Pixel)",
      }),
      makeFinding("snippets/pagefly-main-js.liquid", "GHOST_SCRIPT", "gtag script", {
        appName: "PageFly",
        description: "External script left by PageFly (loads Google Tag Manager)",
      }),
    ];

    const diff = diffScans(current, previous);

    expect(diff.unchangedCount).toBe(2);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage across BOTH scans: types not live in the current scan are
// un-audited (M4); categories un-audited in the BASELINE are never "new" (H3).
// ---------------------------------------------------------------------------

describe("unauditedCategories with liveFindingTypes (M4)", () => {
  const base = { skippedCategories: [], cappedCategories: [], unreachableCategories: [] };

  it("adds every FindingType missing from the scan's live set", () => {
    const live = Object.values(FindingType).filter(
      (t) => t !== FindingType.SCRIPT_TAG_SUNSET && t !== FindingType.APP_EMBED_OFF,
    );
    expect(unauditedCategories({ ...base, liveFindingTypes: live }).sort()).toEqual(
      [FindingType.APP_EMBED_OFF, FindingType.SCRIPT_TAG_SUNSET].sort(),
    );
  });

  it("adds nothing for a legacy scan (null / malformed live set)", () => {
    expect(unauditedCategories({ ...base, liveFindingTypes: null })).toEqual([]);
    expect(unauditedCategories({ ...base, liveFindingTypes: "x" })).toEqual([]);
    expect(unauditedCategories(base)).toEqual([]);
  });

  it("dedupes a type that is both un-live and listed", () => {
    const live = Object.values(FindingType).filter((t) => t !== FindingType.SCRIPT_TAG_SUNSET);
    expect(
      unauditedCategories({
        ...base,
        unreachableCategories: ["SCRIPT_TAG_SUNSET"],
        liveFindingTypes: live,
      }),
    ).toEqual(["SCRIPT_TAG_SUNSET"]);
  });
});

describe("scanDiffOptions + diffScans notNewCategories (H3, M4)", () => {
  const ALL = Object.values(FindingType);
  const coverage = (over: Record<string, unknown> = {}) => ({
    skippedCategories: [] as string[],
    cappedCategories: [] as string[],
    unreachableCategories: [] as string[],
    skippedFiles: [] as string[],
    liveFindingTypes: ALL as unknown,
    ...over,
  });
  const tag = (url: string) =>
    makeFinding("storefront/script-tags", "SCRIPT_TAG_SUNSET", `script-tags: host ${url}`);

  it("A reachable -> B unreachable -> C reachable: C reports nothing new vs B", () => {
    const findingsA = [tag("a.io"), tag("b.io")];
    const scanB = coverage({ unreachableCategories: ["SCRIPT_TAG_SUNSET"] });
    const scanC = coverage();
    // B vs A: unreachable, so A's findings are neither resolved nor new.
    const bVsA = diffScans([], findingsA, scanDiffOptions(scanB, coverage()));
    expect(bVsA.resolvedFindings).toEqual([]);
    expect(bVsA.newFindings).toEqual([]);
    // C vs B: same findings as A are back; B never checked them, so not "new".
    const cVsB = diffScans(findingsA, [], scanDiffOptions(scanC, scanB));
    expect(cVsB.newFindings).toEqual([]);
    expect(cVsB.resolvedFindings).toEqual([]);
  });

  it("findings of a scope granted since the baseline are not new (generic H3)", () => {
    const page = makeFinding("pages/old", "GHOST_PAGE", "old-page");
    const script = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "new-script");
    const diff = diffScans(
      [page, script],
      [],
      scanDiffOptions(coverage(), coverage({ skippedCategories: ["GHOST_PAGE"] })),
    );
    expect(diff.newFindings.map((f) => f.findingType)).toEqual(["GHOST_SCRIPT"]);
  });

  it("a capped baseline category: a finding it did see is unchanged, an unseen one not new", () => {
    const seen = makeFinding("a.liquid", "DANGLING_REFERENCE", "seen");
    const unseen = makeFinding("b.liquid", "DANGLING_REFERENCE", "unseen");
    const diff = diffScans(
      [seen, unseen],
      [seen],
      scanDiffOptions(coverage(), coverage({ cappedCategories: ["DANGLING_REFERENCE"] })),
    );
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toEqual([]);
  });

  it("flag turned OFF (type not live now): prior findings are not resolved", () => {
    const current = coverage({ liveFindingTypes: ALL.filter((t) => t !== "SCRIPT_TAG_SUNSET") });
    const diff = diffScans([], [tag("a.io")], scanDiffOptions(current, coverage()));
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("flag turned ON (type not live in the baseline): current findings are not new", () => {
    const baseline = coverage({ liveFindingTypes: ALL.filter((t) => t !== "SCRIPT_TAG_SUNSET") });
    const diff = diffScans([tag("a.io")], [], scanDiffOptions(coverage(), baseline));
    expect(diff.newFindings).toEqual([]);
  });

  it("existing soft-launch types get the same treatment (APP_EMBED_OFF)", () => {
    const embed = makeFinding("config/settings_data.json", "APP_EMBED_OFF", "embed");
    const notLive = ALL.filter((t) => t !== "APP_EMBED_OFF");
    expect(
      diffScans([], [embed], scanDiffOptions(coverage({ liveFindingTypes: notLive }), coverage()))
        .resolvedFindings,
    ).toEqual([]);
    expect(
      diffScans([embed], [], scanDiffOptions(coverage(), coverage({ liveFindingTypes: notLive })))
        .newFindings,
    ).toEqual([]);
  });

  it("with no baseline coverage gaps, new and resolved behave as before", () => {
    const old = makeFinding("a.liquid", "GHOST_SCRIPT", "old");
    const fresh = makeFinding("a.liquid", "GHOST_SCRIPT", "fresh");
    const diff = diffScans([fresh], [old], scanDiffOptions(coverage(), coverage()));
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("passes the current scan's skippedFiles through", () => {
    expect(
      scanDiffOptions(coverage({ skippedFiles: ["assets/big.js"] }), coverage()).skippedFiles,
    ).toEqual(["assets/big.js"]);
  });
});

// ---------------------------------------------------------------------------
// gc-747u: capped product / redirect walks — record-level windows
// ---------------------------------------------------------------------------

describe("diffScans — capped walk windows (gc-747u)", () => {
  const ALL = Object.values(FindingType);
  const scan = (walkCoverage: unknown) => ({
    skippedCategories: [] as string[],
    cappedCategories: [] as string[],
    unreachableCategories: [] as string[],
    skippedFiles: [] as string[],
    liveFindingTypes: ALL as unknown,
    walkCoverage,
  });
  const truncatedAt = (lastNum: number, checked: number) => ({
    checked,
    total: null,
    truncated: true,
    // Only the GID's numeric tail matters to the window.
    lastId: `gid://shopify/Product/${lastNum}`,
  });
  const fullWalk = (checked: number) => ({ checked, total: null, truncated: false, lastId: null });

  const tagFor = (n: number) =>
    makeFinding(`products/gid://shopify/Product/${n}`, "GHOST_TAG", `Product: P${n}\nTag: bold-x`, {
      lineNumber: 0,
    });
  const metafieldFor = (n: number) =>
    makeFinding(`products/gid://shopify/Product/${n}/metafields`, "GHOST_METAFIELD", `mf ${n}`, {
      lineNumber: 0,
    });
  const redirectFor = (n: number) =>
    makeFinding(`redirects/gid://shopify/UrlRedirect/${n}`, "GHOST_REDIRECT", `/a/seo-${n} → /`, {
      lineNumber: 0,
    });
  const bulk = (prefix: string, count: number) =>
    makeFinding(
      `redirects/bulk/_${prefix}`,
      "GHOST_REDIRECT",
      `${count} redirects under /${prefix}:\n  /${prefix}/a → /b`,
      { lineNumber: 0 },
    );

  it("never resolves a prior finding for a product past the current cap (downgrade Pro -> Free)", () => {
    // Baseline (Pro) checked all 3,000 products; current (Free) stopped at
    // product 500. Product 2,000's finding was NOT re-checked: unknown, not fixed.
    const previous = [tagFor(10), tagFor(2000), metafieldFor(2500)];
    const current = [tagFor(10)];
    const diff = diffScans(
      current,
      previous,
      scanDiffOptions(
        scan({ products: truncatedAt(500, 500) }),
        scan({ products: fullWalk(3000) }),
      ),
    );
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toEqual([]);
  });

  it("non-vacuous: without the walk coverage the same diff false-resolves them", () => {
    const previous = [tagFor(10), tagFor(2000), metafieldFor(2500)];
    const diff = diffScans([tagFor(10)], previous, scanDiffOptions(scan(null), scan(null)));
    expect(diff.resolvedFindings).toHaveLength(2);
  });

  it("still resolves a genuinely fixed record INSIDE the window", () => {
    const diff = diffScans(
      [],
      [tagFor(10), tagFor(499)],
      scanDiffOptions(
        scan({ products: truncatedAt(500, 500) }),
        scan({ products: truncatedAt(500, 500) }),
      ),
    );
    expect(diff.resolvedFindings).toHaveLength(2);
  });

  it("the boundary record itself (ID == lastId) was checked", () => {
    const diff = diffScans(
      [],
      [tagFor(500), tagFor(501)],
      scanDiffOptions(scan({ products: truncatedAt(500, 500) }), scan({ products: fullWalk(900) })),
    );
    expect(diff.resolvedFindings.map((f) => f.filename)).toEqual([
      "products/gid://shopify/Product/500",
    ]);
  });

  it("a current finding past the BASELINE window is not new (upgrade Free -> Pro)", () => {
    const diff = diffScans(
      [tagFor(10), tagFor(3000), redirectFor(4000)],
      [tagFor(10)],
      scanDiffOptions(
        scan({ products: fullWalk(4000), redirects: fullWalk(5000) }),
        scan({ products: truncatedAt(500, 500), redirects: truncatedAt(1000, 1000) }),
      ),
    );
    expect(diff.newFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("a new finding inside both windows is still new", () => {
    const diff = diffScans(
      [tagFor(10), tagFor(20)],
      [tagFor(10)],
      scanDiffOptions(
        scan({ products: truncatedAt(500, 500) }),
        scan({ products: truncatedAt(500, 500) }),
      ),
    );
    expect(diff.newFindings.map((f) => f.filename)).toEqual(["products/gid://shopify/Product/20"]);
  });

  it("compares IDs numerically, not as strings (999 < 1000)", () => {
    const diff = diffScans(
      [],
      [tagFor(999), tagFor(1001)],
      scanDiffOptions(
        scan({ products: truncatedAt(1000, 1000) }),
        scan({ products: fullWalk(2000) }),
      ),
    );
    expect(diff.resolvedFindings.map((f) => f.filename)).toEqual([
      "products/gid://shopify/Product/999",
    ]);
  });

  it("redirect records past the window are never resolved", () => {
    const diff = diffScans(
      [],
      [redirectFor(5), redirectFor(4500)],
      scanDiffOptions(
        scan({ redirects: truncatedAt(1000, 1000) }),
        scan({ redirects: truncatedAt(4000, 4000) }),
      ),
    );
    expect(diff.resolvedFindings.map((f) => f.filename)).toEqual([
      "redirects/gid://shopify/UrlRedirect/5",
    ]);
  });

  it("a bulk redirect pattern is not resolved when the current window is narrower", () => {
    const diff = diffScans(
      [],
      [bulk("collections", 80)],
      scanDiffOptions(
        scan({ redirects: truncatedAt(1000, 1000) }),
        scan({ redirects: truncatedAt(4000, 4000) }),
      ),
    );
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("a bulk redirect pattern diffs normally when the window is the same", () => {
    const diff = diffScans(
      [],
      [bulk("collections", 80)],
      scanDiffOptions(
        scan({ redirects: truncatedAt(1000, 1000) }),
        scan({ redirects: truncatedAt(1000, 1000) }),
      ),
    );
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("a bulk pattern seen only through a wider window is not new", () => {
    const diff = diffScans(
      [bulk("pages", 60)],
      [],
      scanDiffOptions(
        scan({ redirects: fullWalk(9000) }),
        scan({ redirects: truncatedAt(1000, 1000) }),
      ),
    );
    expect(diff.newFindings).toEqual([]);
  });

  it("treats a walk finding with an unparseable record as unchecked (never resolved)", () => {
    const odd = makeFinding("products/not-a-gid", "GHOST_TAG", "x", { lineNumber: 0 });
    const diff = diffScans(
      [],
      [odd],
      scanDiffOptions(scan({ products: truncatedAt(500, 500) }), scan({ products: fullWalk(900) })),
    );
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("does not touch non-walk categories", () => {
    const script = makeFinding("layout/theme.liquid", "GHOST_SCRIPT", "s");
    const diff = diffScans(
      [],
      [script],
      scanDiffOptions(scan({ products: truncatedAt(1, 1) }), scan({ products: fullWalk(900) })),
    );
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("an untruncated (or not-run) current walk diffs exactly as before", () => {
    const previous = [tagFor(10), tagFor(2000)];
    const withCoverage = diffScans(
      [],
      previous,
      scanDiffOptions(scan({ products: fullWalk(3000) }), scan({ products: fullWalk(3000) })),
    );
    const legacy = diffScans([], previous, scanDiffOptions(scan(null), scan(null)));
    expect(withCoverage).toEqual(legacy);
  });

  describe("legacy baseline (no recorded coverage, walked the Free caps)", () => {
    it("current walked past the legacy cap: that walk's types are not new for this one diff", () => {
      const opts = scanDiffOptions(scan({ products: fullWalk(4000) }), scan(null));
      expect(opts.notNewCategories).toEqual(
        expect.arrayContaining(["GHOST_TAG", "GHOST_PRICE", "GHOST_METAFIELD"]),
      );
      expect(opts.notNewCategories).not.toContain("GHOST_REDIRECT");
      const diff = diffScans([tagFor(10), tagFor(3000)], [tagFor(10)], opts);
      expect(diff.newFindings).toEqual([]);
      expect(diff.unchangedCount).toBe(1);
    });

    it("current within the legacy cap: nothing suppressed (Free behavior unchanged)", () => {
      const opts = scanDiffOptions(
        scan({ products: truncatedAt(500, 500), redirects: fullWalk(1000) }),
        scan(null),
      );
      expect(opts.notNewCategories).toEqual([]);
      const diff = diffScans([tagFor(10), tagFor(20)], [tagFor(10)], opts);
      expect(diff.newFindings).toHaveLength(1);
    });

    it("legacy on both sides: options carry null windows and nothing changes", () => {
      const opts = scanDiffOptions(scan(null), scan(null));
      expect(opts.currentWalks).toBeNull();
      expect(opts.baselineWalks).toBeNull();
      expect(opts.notNewCategories).toEqual([]);
    });
  });
});
