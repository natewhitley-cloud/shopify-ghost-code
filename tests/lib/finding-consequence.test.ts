/**
 * Tests for app/lib/finding-consequence.ts
 *
 * Strategy:
 *   - Pure module, no dependencies — test directly.
 *   - Exhaustiveness / drift guard: every FindingType has a CONSEQUENCE_MAP entry.
 *   - Partition: PRIMARY lanes cleanly partition all 26 types (each in exactly one).
 *   - computeLaneSummary: sums, most-urgent urgency, hasAgentic, zero-lane omission.
 *   - startHereLane / dominantLane: urgency-first vs count-first tie-breaking, null.
 *   - Spot-check specific mappings against the grounded table.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  CONSEQUENCE_MAP,
  LANES,
  URGENCY_RANK,
  computeLaneSummary,
  dominantLane,
  laneForType,
  startHereLane,
  typesForLane,
  type LaneKey,
} from "../../app/lib/finding-consequence";

const ALL_LANES: LaneKey[] = [
  "customers-see-it",
  "discoverability",
  "speed",
  "privacy",
  "housekeeping",
];

// ---------------------------------------------------------------------------
// Exhaustiveness / drift guard
// ---------------------------------------------------------------------------

describe("CONSEQUENCE_MAP exhaustiveness", () => {
  it("maps every FindingType enum member (drift guard)", () => {
    const allTypes = Object.values(FindingType);
    expect(allTypes).toHaveLength(26);

    for (const type of allTypes) {
      const entry = CONSEQUENCE_MAP[type];
      expect(entry, `${type} must have a CONSEQUENCE_MAP entry`).toBeDefined();
      expect(ALL_LANES).toContain(entry.primary);
      for (const sec of entry.secondary) {
        expect(ALL_LANES).toContain(sec);
      }
      expect(Object.keys(URGENCY_RANK)).toContain(entry.urgency);
      expect(typeof entry.agentic).toBe("boolean");
    }
  });

  it("has no extra keys beyond the FindingType enum", () => {
    const mapKeys = Object.keys(CONSEQUENCE_MAP).sort();
    const enumKeys = Object.values(FindingType).sort();
    expect(mapKeys).toEqual(enumKeys);
  });
});

// ---------------------------------------------------------------------------
// LANES metadata
// ---------------------------------------------------------------------------

describe("LANES", () => {
  it("declares all 5 lanes in fixed order with exact labels", () => {
    expect(LANES.map((l) => l.key)).toEqual(ALL_LANES);
    expect(LANES.map((l) => l.label)).toEqual([
      "Customers see it",
      "Found by Google & AI",
      "Speed",
      "Still tracking you",
      "Housekeeping",
    ]);
  });

  it("gives every lane a non-empty soWhat template", () => {
    for (const lane of LANES) {
      expect(lane.soWhat.length).toBeGreaterThan(0);
    }
  });
});

describe("URGENCY_RANK", () => {
  it("orders act-now < compounding < whenever", () => {
    expect(URGENCY_RANK["act-now"]).toBe(0);
    expect(URGENCY_RANK.compounding).toBe(1);
    expect(URGENCY_RANK.whenever).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Partition: primary lanes cleanly cover all 26 types
// ---------------------------------------------------------------------------

describe("typesForLane partition", () => {
  it("primary lanes partition all 26 types with no type in two lanes", () => {
    const seen = new Set<FindingType>();
    let total = 0;

    for (const lane of ALL_LANES) {
      const types = typesForLane(lane);
      for (const type of types) {
        expect(seen.has(type), `${type} appears in more than one primary lane`).toBe(false);
        seen.add(type);
        expect(laneForType(type)).toBe(lane);
      }
      total += types.length;
    }

    expect(total).toBe(26);
    expect(seen.size).toBe(26);
    // Union equals the full enum set.
    expect([...seen].sort()).toEqual(Object.values(FindingType).sort());
  });
});

// ---------------------------------------------------------------------------
// laneForType — spot checks against the grounded table
// ---------------------------------------------------------------------------

describe("laneForType / CONSEQUENCE_MAP spot checks", () => {
  it("GHOST_PRICE -> customers-see-it / act-now / agentic true", () => {
    const e = CONSEQUENCE_MAP[FindingType.GHOST_PRICE];
    expect(e.primary).toBe("customers-see-it");
    expect(e.urgency).toBe("act-now");
    expect(e.agentic).toBe(true);
    expect(e.secondary).toEqual(["discoverability"]);
  });

  it("GHOST_ROBOTS -> discoverability / act-now / agentic true", () => {
    const e = CONSEQUENCE_MAP[FindingType.GHOST_ROBOTS];
    expect(e.primary).toBe("discoverability");
    expect(e.urgency).toBe("act-now");
    expect(e.agentic).toBe(true);
  });

  it("ORPHAN_ASSET -> housekeeping / whenever / agentic false", () => {
    const e = CONSEQUENCE_MAP[FindingType.ORPHAN_ASSET];
    expect(e.primary).toBe("housekeeping");
    expect(e.urgency).toBe("whenever");
    expect(e.agentic).toBe(false);
    expect(e.secondary).toEqual(["speed"]);
  });

  it("GHOST_PIXEL -> privacy / act-now / agentic false", () => {
    const e = CONSEQUENCE_MAP[FindingType.GHOST_PIXEL];
    expect(e.primary).toBe("privacy");
    expect(e.urgency).toBe("act-now");
    expect(e.agentic).toBe(false);
  });

  it("GHOST_AJAX -> speed with two secondaries / act-now", () => {
    const e = CONSEQUENCE_MAP[FindingType.GHOST_AJAX];
    expect(e.primary).toBe("speed");
    expect(e.secondary).toEqual(["privacy", "customers-see-it"]);
    expect(e.urgency).toBe("act-now");
    expect(e.agentic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeLaneSummary
// ---------------------------------------------------------------------------

describe("computeLaneSummary", () => {
  it("returns an empty array for empty input", () => {
    expect(computeLaneSummary({})).toEqual([]);
  });

  it("omits zero-count and absent lanes", () => {
    // Only a housekeeping type present; every other lane is absent/zero.
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 3,
      [FindingType.ORPHAN_ASSET]: 0, // explicit zero must not create a row/contrib
    });
    expect(summary).toHaveLength(1);
    expect(summary[0].lane).toBe("housekeeping");
    expect(summary[0].count).toBe(3);
    expect(summary[0].hasAgentic).toBe(false);
  });

  it("sums multiple types into the same primary lane", () => {
    // GHOST_SNIPPET + GHOST_SECTION + GHOST_TEXT all primary customers-see-it.
    const summary = computeLaneSummary({
      [FindingType.GHOST_SNIPPET]: 2,
      [FindingType.GHOST_SECTION]: 1,
      [FindingType.GHOST_TEXT]: 4,
    });
    const row = summary.find((r) => r.lane === "customers-see-it");
    expect(row?.count).toBe(7);
  });

  it("picks the MOST-URGENT urgency among contributing types", () => {
    // customers-see-it: GHOST_SECTION (whenever) + GHOST_TEXT (act-now) => act-now.
    const summary = computeLaneSummary({
      [FindingType.GHOST_SECTION]: 5,
      [FindingType.GHOST_TEXT]: 1,
    });
    const row = summary.find((r) => r.lane === "customers-see-it");
    expect(row?.urgency).toBe("act-now");
  });

  it("marks a lane agentic if any contributing type is agentic", () => {
    // discoverability: GHOST_JSON_LD is agentic.
    const summary = computeLaneSummary({ [FindingType.GHOST_JSON_LD]: 1 });
    const row = summary.find((r) => r.lane === "discoverability");
    expect(row?.hasAgentic).toBe(true);
  });

  it("marks a pure-housekeeping lane as not agentic", () => {
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 1,
      [FindingType.GHOST_TAG]: 2,
    });
    const row = summary.find((r) => r.lane === "housekeeping");
    expect(row?.hasAgentic).toBe(false);
  });

  it("preserves LANES display order and sets order to the LANES index", () => {
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 1, // housekeeping (order 4)
      [FindingType.GHOST_TEXT]: 1, // customers-see-it (order 0)
      [FindingType.GHOST_ROBOTS]: 1, // discoverability (order 1)
    });
    expect(summary.map((r) => r.lane)).toEqual([
      "customers-see-it",
      "discoverability",
      "housekeeping",
    ]);
    expect(summary.map((r) => r.order)).toEqual([0, 1, 4]);
  });

  it("attaches the lane's merchant-facing label", () => {
    const summary = computeLaneSummary({ [FindingType.GHOST_PIXEL]: 1 });
    expect(summary[0].label).toBe("Still tracking you");
  });
});

// ---------------------------------------------------------------------------
// startHereLane — urgency-first, count tie-break
// ---------------------------------------------------------------------------

describe("startHereLane", () => {
  it("returns null for empty summary", () => {
    expect(startHereLane([])).toBeNull();
  });

  it("picks the most-urgent lane even when another lane has more findings", () => {
    // housekeeping has a huge count (whenever) but privacy is act-now.
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 50, // housekeeping / whenever
      [FindingType.GHOST_PIXEL]: 1, // privacy / act-now
    });
    expect(startHereLane(summary)).toBe("privacy");
  });

  it("breaks an urgency tie by highest count", () => {
    // Both act-now: customers-see-it (GHOST_TEXT x2) vs privacy (GHOST_PIXEL x5).
    const summary = computeLaneSummary({
      [FindingType.GHOST_TEXT]: 2, // customers-see-it / act-now
      [FindingType.GHOST_PIXEL]: 5, // privacy / act-now
    });
    expect(startHereLane(summary)).toBe("privacy");
  });
});

// ---------------------------------------------------------------------------
// dominantLane — count-first, urgency tie-break
// ---------------------------------------------------------------------------

describe("dominantLane", () => {
  it("returns null for empty summary", () => {
    expect(dominantLane([])).toBeNull();
  });

  it("picks the highest-count lane even if it is less urgent", () => {
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 50, // housekeeping / whenever
      [FindingType.GHOST_PIXEL]: 1, // privacy / act-now
    });
    expect(dominantLane(summary)).toBe("housekeeping");
  });

  it("breaks a count tie by most-urgent urgency", () => {
    // Equal counts (3 each): privacy (act-now) should win over housekeeping (whenever).
    const summary = computeLaneSummary({
      [FindingType.SETTINGS_DRIFT]: 3, // housekeeping / whenever
      [FindingType.GHOST_PIXEL]: 3, // privacy / act-now
    });
    expect(dominantLane(summary)).toBe("privacy");
  });
});
