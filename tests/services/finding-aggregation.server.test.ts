/**
 * Tests for app/services/finding-aggregation.server.ts (E2.2, gc-57t).
 *
 * Two layers:
 *
 *   1. filterIgnoredFindings / isFindingIgnored — pure choke point. No DB.
 *      Verifies fingerprint (INSTANCE) and appName (APP) suppression, the
 *      partition into { kept, ignored }, and the empty-sets short-circuit.
 *
 *   2. getFilteredFindingSummary — aggregate choke point. Prisma is mocked at
 *      the model boundary (getFindingsForScan / getFindingSummary); the zero-map
 *      factories (createZeroSeverityCounts/createZeroTypeCounts) and the djb2
 *      fingerprint are the REAL implementations so the rollup is exercised end
 *      to end.
 *
 *   3. "Ignore moves nothing" — the acceptance test. Takes a fixture scan +
 *      previous scan, computes all SIX outputs the product derives (total,
 *      per-severity counts, health score, consequence-lane membership, diff
 *      new/resolved/unchanged, and the health delta) with NO ignores, then
 *      re-computes with one finding ignored by fingerprint and one whole app
 *      ignored, and asserts the ignored findings vanish from every output while
 *      a non-ignored finding is untouched — and that un-ignoring restores the
 *      originals. It wires the SAME real functions the routes use
 *      (filterIgnoredFindings, computeHealthScore, computeLaneSummary,
 *      diffScans, computeHealthDelta) so a regression in any path is caught.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted). Only the DB-touching model reads are mocked; the
// zero-map factories are kept REAL via importOriginal so the rollup is genuine.
// ---------------------------------------------------------------------------

vi.mock("../../app/models/finding.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/models/finding.server")>();
  return {
    ...actual,
    getFindingsForScan: vi.fn(),
    getFindingSummary: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { computeLaneSummary, type LaneKey } from "../../app/lib/finding-consequence";
import {
  computeHealthDelta,
  computeHealthScore,
  type SeverityDiff,
} from "../../app/lib/health-score";
import { getFindingsForScan, getFindingSummary } from "../../app/models/finding.server";
import type { ShopIgnores } from "../../app/models/ignored-finding.server";
import {
  filterIgnoredFindings,
  getFilteredFindingSummary,
  isFindingIgnored,
} from "../../app/services/finding-aggregation.server";
import { diffScans, fingerprintFinding } from "../../app/services/scan-differ.server";
import type { DiffableFinding } from "../../app/services/scan-differ.server";

const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockGetFindingSummary = getFindingSummary as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<DiffableFinding> = {}): DiffableFinding {
  return {
    filename: "layout/theme.liquid",
    findingType: "GHOST_SCRIPT",
    codeSnippet: "<script src='x'>",
    lineNumber: 1,
    severity: "HIGH",
    appName: null,
    description: "a finding",
    ...overrides,
  };
}

const NO_IGNORES: ShopIgnores = { fingerprints: new Set(), appNames: new Set() };

// ---------------------------------------------------------------------------
// isFindingIgnored / filterIgnoredFindings — pure choke point
// ---------------------------------------------------------------------------

describe("isFindingIgnored", () => {
  it("is true when the finding's fingerprint is INSTANCE-ignored", () => {
    const f = makeFinding({
      filename: "a.js",
      findingType: "GHOST_SCRIPT",
      codeSnippet: "s",
      lineNumber: 1,
    });
    const fp = fingerprintFinding("a.js", "GHOST_SCRIPT", "s", 1);
    expect(isFindingIgnored(f, { fingerprints: new Set([fp]), appNames: new Set() })).toBe(true);
  });

  it("is true when the finding's appName is APP-ignored", () => {
    const f = makeFinding({ appName: "Klaviyo" });
    expect(isFindingIgnored(f, { fingerprints: new Set(), appNames: new Set(["Klaviyo"]) })).toBe(
      true,
    );
  });

  it("is false when neither the fingerprint nor the appName matches", () => {
    const f = makeFinding({ appName: "Judge.me" });
    expect(
      isFindingIgnored(f, { fingerprints: new Set(["deadbeef"]), appNames: new Set(["Klaviyo"]) }),
    ).toBe(false);
  });

  it("does not APP-ignore a finding with a null appName", () => {
    const f = makeFinding({ appName: null });
    // An empty appName set on the finding side must never match; only real
    // (non-null) appNames can be suppressed.
    expect(isFindingIgnored(f, { fingerprints: new Set(), appNames: new Set([""]) })).toBe(false);
  });
});

describe("filterIgnoredFindings", () => {
  it("returns the input untouched (and no ignored) when both sets are empty", () => {
    const findings = [makeFinding({ filename: "a" }), makeFinding({ filename: "b" })];
    const result = filterIgnoredFindings(findings, NO_IGNORES);
    // Short-circuit returns the SAME array reference — no fingerprinting done.
    expect(result.kept).toBe(findings);
    expect(result.ignored).toEqual([]);
  });

  it("drops a finding whose fingerprint is ignored, keeps the rest", () => {
    const target = makeFinding({ filename: "a.js", codeSnippet: "s1", lineNumber: 1 });
    const other = makeFinding({ filename: "b.js", codeSnippet: "s2", lineNumber: 1 });
    const fp = fingerprintFinding("a.js", "GHOST_SCRIPT", "s1", 1);

    const result = filterIgnoredFindings([target, other], {
      fingerprints: new Set([fp]),
      appNames: new Set(),
    });

    expect(result.kept).toEqual([other]);
    expect(result.ignored).toEqual([target]);
  });

  it("drops ALL findings for an ignored appName", () => {
    const k1 = makeFinding({ filename: "a", appName: "Klaviyo" });
    const k2 = makeFinding({ filename: "b", appName: "Klaviyo" });
    const keep = makeFinding({ filename: "c", appName: "Judge.me" });

    const result = filterIgnoredFindings([k1, keep, k2], {
      fingerprints: new Set(),
      appNames: new Set(["Klaviyo"]),
    });

    expect(result.kept).toEqual([keep]);
    expect(result.ignored).toEqual([k1, k2]);
  });

  it("partition is exhaustive: kept + ignored recombine to the input", () => {
    const findings = [
      makeFinding({ filename: "a", appName: "Klaviyo" }),
      makeFinding({ filename: "b", codeSnippet: "s", lineNumber: 1 }),
      makeFinding({ filename: "c", appName: "Judge.me" }),
    ];
    const result = filterIgnoredFindings(findings, {
      fingerprints: new Set([fingerprintFinding("b", "GHOST_SCRIPT", "s", 1)]),
      appNames: new Set(["Klaviyo"]),
    });
    expect(result.kept.length + result.ignored.length).toBe(findings.length);
  });
});

// ---------------------------------------------------------------------------
// getFilteredFindingSummary — aggregate choke point
// ---------------------------------------------------------------------------

describe("getFilteredFindingSummary", () => {
  it("fast-paths to getFindingSummary (no findings load) when the shop has no ignores", async () => {
    const summary = { total: 3, bySeverity: { HIGH: 1, MEDIUM: 1, LOW: 1 }, byType: {} };
    mockGetFindingSummary.mockResolvedValue(summary);

    const result = await getFilteredFindingSummary("scan-1", NO_IGNORES);

    expect(result).toBe(summary);
    expect(mockGetFindingSummary).toHaveBeenCalledWith("scan-1");
    expect(mockGetFindingsForScan).not.toHaveBeenCalled();
  });

  it("loads findings and rolls up ONLY the kept set when the shop has ignores", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      makeFinding({
        filename: "a",
        findingType: "GHOST_SCRIPT",
        severity: "HIGH",
        appName: "Klaviyo",
      }),
      makeFinding({ filename: "b", findingType: "GHOST_FONT", severity: "LOW", appName: null }),
      makeFinding({
        filename: "c",
        findingType: "GHOST_JSON_LD",
        severity: "LOW",
        appName: "Judge.me",
      }),
    ]);

    const result = await getFilteredFindingSummary("scan-1", {
      fingerprints: new Set(),
      appNames: new Set(["Klaviyo"]),
    });

    // The Klaviyo (HIGH) finding is dropped; two LOW findings remain.
    expect(result.total).toBe(2);
    expect(result.bySeverity.HIGH).toBe(0);
    expect(result.bySeverity.LOW).toBe(2);
    expect(result.byType.GHOST_FONT).toBe(1);
    expect(result.byType.GHOST_JSON_LD).toBe(1);
    expect(result.byType.GHOST_SCRIPT).toBe(0);
    // getFindingSummary must NOT be used on the ignore path.
    expect(mockGetFindingSummary).not.toHaveBeenCalled();
    expect(mockGetFindingsForScan).toHaveBeenCalledWith("scan-1");
  });
});

// ---------------------------------------------------------------------------
// Acceptance: an ignored finding moves NONE of the six outputs
// ---------------------------------------------------------------------------

/**
 * Compute all six product outputs from a current + previous finding set and a
 * set of ignores, wiring the SAME real functions the routes use:
 *   - total / bySeverity / byType : rolled up from filterIgnoredFindings(current).kept
 *   - health score                : computeHealthScore(bySeverity)
 *   - lanes                        : computeLaneSummary(byType) — lane membership
 *   - diff                         : diffScans over BOTH filtered sets
 *   - delta                        : computeHealthDelta(bySeverity, severityDiff)
 */
function computeSix(current: DiffableFinding[], previous: DiffableFinding[], ignores: ShopIgnores) {
  const keptCurrent = filterIgnoredFindings(current, ignores).kept;
  const keptPrevious = filterIgnoredFindings(previous, ignores).kept;

  const bySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<"HIGH" | "MEDIUM" | "LOW", number>;
  const byType: Record<string, number> = {};
  for (const f of keptCurrent) {
    bySeverity[f.severity as "HIGH" | "MEDIUM" | "LOW"] += 1;
    byType[f.findingType] = (byType[f.findingType] ?? 0) + 1;
  }
  const total = bySeverity.HIGH + bySeverity.MEDIUM + bySeverity.LOW;

  const health = computeHealthScore(bySeverity);
  const lanes = computeLaneSummary(byType as Parameters<typeof computeLaneSummary>[0]);

  const diff = diffScans(keptCurrent, keptPrevious);
  const severityDiff: SeverityDiff = {
    newHigh: diff.newFindings.filter((f) => f.severity === "HIGH").length,
    newMedium: diff.newFindings.filter((f) => f.severity === "MEDIUM").length,
    newLow: diff.newFindings.filter((f) => f.severity === "LOW").length,
    resolvedHigh: diff.resolvedFindings.filter((f) => f.severity === "HIGH").length,
    resolvedMedium: diff.resolvedFindings.filter((f) => f.severity === "MEDIUM").length,
    resolvedLow: diff.resolvedFindings.filter((f) => f.severity === "LOW").length,
  };
  const delta = computeHealthDelta(bySeverity, severityDiff);

  const laneCount = (lane: LaneKey) => lanes.find((r) => r.lane === lane)?.count ?? 0;

  return { total, bySeverity, byType, health, lanes, laneCount, diff, delta };
}

describe("ignore moves nothing across all six aggregation outputs", () => {
  // Current scan. F1 (Klaviyo) + F2 (fingerprint) will be ignored; F3/F4/F5 stay.
  // F1..F4 are also present unchanged in the previous scan; F5 is genuinely new.
  const F1 = makeFinding({
    filename: "a.js",
    findingType: "GHOST_SCRIPT", // lane: speed
    severity: "HIGH",
    appName: "Klaviyo",
    codeSnippet: "s1",
  });
  const F2 = makeFinding({
    filename: "c.liquid",
    findingType: "DANGLING_REFERENCE", // lane: customers-see-it
    severity: "HIGH",
    appName: null,
    codeSnippet: "s2",
  });
  const F3 = makeFinding({
    filename: "d.liquid",
    findingType: "GHOST_JSON_LD", // lane: discoverability
    severity: "LOW",
    appName: "Judge.me", // a DIFFERENT app — must NOT be dropped
    codeSnippet: "s3",
  });
  const F4 = makeFinding({
    filename: "e.css",
    findingType: "GHOST_FONT", // lane: speed
    severity: "LOW",
    appName: null,
    codeSnippet: "s4",
  });
  const F5 = makeFinding({
    filename: "f.liquid",
    findingType: "GHOST_ROBOTS", // lane: discoverability; genuinely NEW
    severity: "HIGH",
    appName: null,
    codeSnippet: "s5",
  });

  const CURRENT = [F1, F2, F3, F4, F5];
  // Previous: F1..F4 unchanged, plus a resolved (non-ignored) finding P5.
  const P5 = makeFinding({
    filename: "g.liquid",
    findingType: "GHOST_CANONICAL", // lane: discoverability; resolved (gone now)
    severity: "HIGH",
    appName: null,
    codeSnippet: "s6",
  });
  const PREVIOUS = [F1, F2, F3, F4, P5];

  // Ignore: the whole "Klaviyo" app (drops F1) + F2 by its exact fingerprint.
  const IGNORES: ShopIgnores = {
    fingerprints: new Set([fingerprintFinding("c.liquid", "DANGLING_REFERENCE", "s2", 1)]),
    appNames: new Set(["Klaviyo"]),
  };

  it("baseline (no ignores) counts every finding", () => {
    const base = computeSix(CURRENT, PREVIOUS, NO_IGNORES);
    expect(base.total).toBe(5);
    expect(base.bySeverity).toEqual({ HIGH: 3, MEDIUM: 0, LOW: 2 });
    expect(base.health.score).toBe(100 - (3 * 10 + 2 * 1)); // 68
    // Lanes present: speed (F1+F4=2), customers-see-it (F2=1), discoverability (F3+F5=2).
    expect(base.laneCount("speed")).toBe(2);
    expect(base.laneCount("customers-see-it")).toBe(1);
    expect(base.laneCount("discoverability")).toBe(2);
    // Diff: F5 new, P5 resolved, F1..F4 unchanged.
    expect(base.diff.newFindings).toHaveLength(1);
    expect(base.diff.resolvedFindings).toHaveLength(1);
    expect(base.diff.unchangedCount).toBe(4);
    expect(base.delta).toBe(0);
  });

  it("removes the fingerprint-ignored and app-ignored findings from every output; keeps the rest", () => {
    const filtered = computeSix(CURRENT, PREVIOUS, IGNORES);

    // (1) total: F1 + F2 gone.
    expect(filtered.total).toBe(3);

    // (2) per-severity: both ignored findings were HIGH.
    expect(filtered.bySeverity).toEqual({ HIGH: 1, MEDIUM: 0, LOW: 2 });

    // (3) health score rises because the two HIGH deductions are gone.
    expect(filtered.health.score).toBe(100 - (1 * 10 + 2 * 1)); // 88
    expect(filtered.health.score).toBeGreaterThan(
      computeSix(CURRENT, PREVIOUS, NO_IGNORES).health.score,
    );

    // (4) lane membership: customers-see-it (only F2) disappears; speed drops
    //     2 -> 1 (F1 gone, F4 stays); discoverability is untouched (F3, F5).
    expect(filtered.laneCount("customers-see-it")).toBe(0);
    expect(filtered.lanes.some((r) => r.lane === "customers-see-it")).toBe(false);
    expect(filtered.laneCount("speed")).toBe(1);
    expect(filtered.laneCount("discoverability")).toBe(2);

    // (5) diff: F1 (app) + F2 (fingerprint) were "unchanged" — now gone from the
    //     diff entirely (unchanged 4 -> 2). The non-ignored new (F5) and
    //     resolved (P5) findings are untouched.
    expect(filtered.diff.unchangedCount).toBe(2);
    expect(filtered.diff.newFindings.map((f) => f.filename)).toEqual(["f.liquid"]); // F5
    expect(filtered.diff.resolvedFindings.map((f) => f.filename)).toEqual(["g.liquid"]); // P5
    // No trace of the ignored findings in new/resolved.
    const diffFiles = [
      ...filtered.diff.newFindings.map((f) => f.filename),
      ...filtered.diff.resolvedFindings.map((f) => f.filename),
    ];
    expect(diffFiles).not.toContain("a.js"); // F1
    expect(diffFiles).not.toContain("c.liquid"); // F2

    // (6) health delta: the ignored findings were UNCHANGED between scans, so
    //     removing them from BOTH sides leaves the delta exactly where it was.
    expect(filtered.delta).toBe(0);
  });

  it("does not drop findings for a non-ignored app or fingerprint", () => {
    const filtered = computeSix(CURRENT, PREVIOUS, IGNORES);
    const keptTypes = filterIgnoredFindings(CURRENT, IGNORES).kept.map((f) => f.findingType);
    // Judge.me finding (F3) and the anonymous F4/F5 survive.
    expect(keptTypes).toContain("GHOST_JSON_LD"); // F3, appName Judge.me
    expect(keptTypes).toContain("GHOST_FONT"); // F4
    expect(keptTypes).toContain("GHOST_ROBOTS"); // F5
    expect(filtered.byType.GHOST_JSON_LD).toBe(1);
  });

  it("un-ignoring (empty sets) restores every original output", () => {
    const base = computeSix(CURRENT, PREVIOUS, NO_IGNORES);
    const restored = computeSix(CURRENT, PREVIOUS, {
      fingerprints: new Set(),
      appNames: new Set(),
    });
    expect(restored.total).toBe(base.total);
    expect(restored.bySeverity).toEqual(base.bySeverity);
    expect(restored.health.score).toBe(base.health.score);
    expect(restored.laneCount("customers-see-it")).toBe(base.laneCount("customers-see-it"));
    expect(restored.laneCount("speed")).toBe(base.laneCount("speed"));
    expect(restored.diff.unchangedCount).toBe(base.diff.unchangedCount);
    expect(restored.delta).toBe(base.delta);
  });
});
