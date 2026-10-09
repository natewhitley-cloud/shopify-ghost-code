/**
 * Tests for app/lib/journey-stage.ts (gc-dpm.3): milestone derivation (incl.
 * the "opened" implication) and the furthest-stage label, exhaustively.
 */
import { describe, it, expect } from "vitest";

import {
  deriveJourneyMilestones,
  isPaidPlan,
  isResultsViewMeasurable,
  JOURNEY_MILESTONES,
  JOURNEY_STAGES,
  journeyStage,
  reachedMilestoneNames,
  RESULTS_VIEW_TRACKED_SINCE,
  type JourneyFacts,
  type JourneyMilestones,
} from "../../app/lib/journey-stage";

const T = new Date("2026-09-26T05:00:00Z");

const NO_FACTS: JourneyFacts = {
  plan: "free",
  firstOpenedAt: null,
  lastSeenAt: null,
  firstResultsViewedAt: null,
  upgradePreviewShownAt: null,
  upgradePreviewClickedAt: null,
  upgradeReturnShownAt: null,
  upgradeReturnClickedAt: null,
  staleResultsShownAt: null,
  staleResultsClickedAt: null,
  hasAnyScan: false,
  hasSuccessfulScan: false,
};

const NONE: JourneyMilestones = {
  opened: false,
  scanned: false,
  viewedResults: false,
  sawUpgrade: false,
  clickedUpgrade: false,
  paid: false,
};

describe("isPaidPlan", () => {
  it.each([
    ["Standard", true],
    ["Professional", true],
    ["free", false],
    ["", false],
    ["standard", false], // plan values are case-sensitive, like computePlanMix
    ["LegacyPro", false], // unknown/legacy counts as free
  ])("%j -> %s", (plan, expected) => {
    expect(isPaidPlan(plan)).toBe(expected);
  });
});

describe("deriveJourneyMilestones", () => {
  it("reaches nothing for a shop with no facts", () => {
    expect(deriveJourneyMilestones(NO_FACTS)).toEqual(NONE);
  });

  it.each([
    ["firstOpenedAt", { firstOpenedAt: T }],
    ["lastSeenAt", { lastSeenAt: T }],
    ["any scan (even a failed one)", { hasAnyScan: true }],
  ])("treats %s alone as opened", (_name, facts) => {
    expect(deriveJourneyMilestones({ ...NO_FACTS, ...facts })).toEqual({ ...NONE, opened: true });
  });

  it("counts scanned only for a successful scan", () => {
    expect(deriveJourneyMilestones({ ...NO_FACTS, hasAnyScan: true }).scanned).toBe(false);
    expect(
      deriveJourneyMilestones({ ...NO_FACTS, hasAnyScan: true, hasSuccessfulScan: true }),
    ).toEqual({ ...NONE, opened: true, scanned: true });
  });

  it("maps each stamp to its milestone independently (no forced monotonicity)", () => {
    expect(deriveJourneyMilestones({ ...NO_FACTS, firstResultsViewedAt: T })).toEqual({
      ...NONE,
      viewedResults: true,
    });
    expect(deriveJourneyMilestones({ ...NO_FACTS, upgradePreviewShownAt: T })).toEqual({
      ...NONE,
      sawUpgrade: true,
    });
    expect(deriveJourneyMilestones({ ...NO_FACTS, upgradePreviewClickedAt: T })).toEqual({
      ...NONE,
      clickedUpgrade: true,
    });
    // The return banner (gc-97k.9) counts exactly like the teaser.
    expect(deriveJourneyMilestones({ ...NO_FACTS, upgradeReturnShownAt: T })).toEqual({
      ...NONE,
      sawUpgrade: true,
    });
    expect(deriveJourneyMilestones({ ...NO_FACTS, upgradeReturnClickedAt: T })).toEqual({
      ...NONE,
      clickedUpgrade: true,
    });
    // Paid via the Settings page without ever seeing the preview.
    expect(deriveJourneyMilestones({ ...NO_FACTS, plan: "Standard" })).toEqual({
      ...NONE,
      paid: true,
    });
  });
});

describe("deriveJourneyMilestones: either upgrade ask (audit 2 #2)", () => {
  it.each([
    ["teaser only", { upgradePreviewShownAt: T }, true],
    ["return banner only", { upgradeReturnShownAt: T }, true],
    ["both", { upgradePreviewShownAt: T, upgradeReturnShownAt: T }, true],
    ["stale-results banner only (gc-mgi)", { staleResultsShownAt: T }, true],
    ["neither", {}, false],
  ])("saw upgrade: %s -> %s", (_name, facts, expected) => {
    expect(deriveJourneyMilestones({ ...NO_FACTS, ...facts }).sawUpgrade).toBe(expected);
  });

  it.each([
    ["teaser only", { upgradePreviewClickedAt: T }, true],
    ["return banner only", { upgradeReturnClickedAt: T }, true],
    ["both", { upgradePreviewClickedAt: T, upgradeReturnClickedAt: T }, true],
    ["stale-results banner only (gc-mgi)", { staleResultsClickedAt: T }, true],
    ["neither", {}, false],
  ])("clicked: %s -> %s", (_name, facts, expected) => {
    expect(deriveJourneyMilestones({ ...NO_FACTS, ...facts }).clickedUpgrade).toBe(expected);
  });
});

describe("journeyStage", () => {
  it("labels every stage (one milestone set at a time)", () => {
    expect(journeyStage(NONE)).toBe("never opened");
    expect(journeyStage({ ...NONE, opened: true })).toBe("opened, no scan");
    expect(journeyStage({ ...NONE, scanned: true })).toBe("scanned");
    expect(journeyStage({ ...NONE, viewedResults: true })).toBe("viewed results");
    expect(journeyStage({ ...NONE, sawUpgrade: true })).toBe("saw upgrade");
    expect(journeyStage({ ...NONE, clickedUpgrade: true })).toBe("clicked upgrade");
    expect(journeyStage({ ...NONE, paid: true })).toBe("paid");
  });

  // All 64 milestone combinations: the label is always the most advanced
  // milestone set, and "never opened" only when none is.
  const keys = JOURNEY_MILESTONES.map((m) => m.key);
  const combos = Array.from({ length: 2 ** keys.length }, (_, bits) =>
    Object.fromEntries(keys.map((k, i) => [k, Boolean(bits & (1 << i))])),
  ) as unknown as JourneyMilestones[];

  it.each(combos)("labels the furthest milestone reached: %j", (m) => {
    const furthest = keys.reduce((acc, k, i) => (m[k] ? i : acc), -1);
    expect(journeyStage(m)).toBe(JOURNEY_STAGES[furthest + 1]);
  });

  it("keeps JOURNEY_STAGES aligned with the milestone order", () => {
    expect(JOURNEY_STAGES).toHaveLength(JOURNEY_MILESTONES.length + 1);
  });
});

describe("reachedMilestoneNames", () => {
  it("lists reached milestones in funnel order", () => {
    expect(
      reachedMilestoneNames({ ...NONE, sawUpgrade: true, opened: true, viewedResults: true }),
    ).toEqual(["opened", "viewed results", "saw upgrade"]);
  });

  it("is empty when nothing is reached", () => {
    expect(reachedMilestoneNames(NONE)).toEqual([]);
  });
});

describe("isResultsViewMeasurable (RESULTS_VIEW_TRACKED_SINCE)", () => {
  it("starts tracking at 2026-09-23T00:00:00Z, the UTC midnight after page_visit shipped", () => {
    expect(RESULTS_VIEW_TRACKED_SINCE.toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("is measurable for a first success at or after the cutoff", () => {
    expect(isResultsViewMeasurable(RESULTS_VIEW_TRACKED_SINCE)).toBe(true);
    expect(isResultsViewMeasurable(new Date("2026-10-01T00:00:00Z"))).toBe(true);
  });

  it("is not measurable for a first success before the cutoff, or none", () => {
    expect(isResultsViewMeasurable(new Date(RESULTS_VIEW_TRACKED_SINCE.getTime() - 1))).toBe(false);
    expect(isResultsViewMeasurable(null)).toBe(false);
  });
});
