import { describe, expect, it } from "vitest";

import {
  findingGroupHeading,
  findingGroupSubline,
  groupFindingRuns,
  OTHER_CODE_GROUP_LABEL,
  rankFindingGroups,
  sortIntoGroups,
} from "../../app/lib/finding-groups";

describe("rankFindingGroups (decision 3A)", () => {
  it("orders by worst severity, then count, then name; no app last", () => {
    expect(
      rankFindingGroups([
        { appName: "Judge.me", severity: "MEDIUM", count: 4 },
        { appName: null, severity: "HIGH", count: 9 },
        { appName: "Loox", severity: "LOW", count: 1 },
        { appName: "Loox", severity: "HIGH", count: 1 },
        { appName: "Privy", severity: "HIGH", count: 1 },
        { appName: "Privy", severity: "LOW", count: 2 },
        { appName: "Beta", severity: "LOW", count: 4 },
        { appName: "Alpha", severity: "LOW", count: 4 },
      ]),
    ).toEqual([
      { appName: "Privy", count: 3 },
      { appName: "Loox", count: 2 },
      { appName: "Judge.me", count: 4 },
      { appName: "Alpha", count: 4 },
      { appName: "Beta", count: 4 },
      { appName: null, count: 9 },
    ]);
  });

  it("drops zero counts and returns nothing for no rows", () => {
    expect(rankFindingGroups([])).toEqual([]);
    expect(rankFindingGroups([{ appName: "A", severity: "HIGH", count: 0 }])).toEqual([]);
  });

  it("a worse severity outranks any count", () => {
    expect(
      rankFindingGroups([
        { appName: "Many", severity: "MEDIUM", count: 50 },
        { appName: "One", severity: "HIGH", count: 1 },
      ]).map((g) => g.appName),
    ).toEqual(["One", "Many"]);
  });
});

describe("group header copy", () => {
  it("names the app, or Other code", () => {
    expect(findingGroupHeading("Privy")).toBe("Privy");
    expect(findingGroupHeading(null)).toBe(OTHER_CODE_GROUP_LABEL);
    expect(OTHER_CODE_GROUP_LABEL).toBe("Other code");
  });

  it("counts the group, and how many are shown only when fewer", () => {
    expect(findingGroupSubline(1)).toBe("1 finding");
    expect(findingGroupSubline(3)).toBe("3 findings");
    expect(findingGroupSubline(3, 1)).toBe("3 findings · 1 shown");
    expect(findingGroupSubline(2, 2)).toBe("2 findings");
  });

  it("never claims an install status", () => {
    expect(findingGroupSubline(3)).not.toMatch(/uninstall|installed|leftover/i);
  });
});

describe("groupFindingRuns", () => {
  const groups = [
    { appName: "Privy", count: 3 },
    { appName: null, count: 5 },
  ];

  it("splits a page into runs of one app with each group's full total", () => {
    const runs = groupFindingRuns(
      [
        { id: "p1", appName: "Privy" },
        { id: "o1", appName: null },
        { id: "o2", appName: null },
      ],
      groups,
    );
    expect(runs).toEqual([
      { appName: "Privy", count: 3, findings: [{ id: "p1", appName: "Privy" }] },
      {
        appName: null,
        count: 5,
        findings: [
          { id: "o1", appName: null },
          { id: "o2", appName: null },
        ],
      },
    ]);
  });

  it("an unlisted group's count is never lower than its rows", () => {
    const runs = groupFindingRuns([{ appName: "X" }, { appName: "X" }], []);
    expect(runs).toEqual([
      { appName: "X", count: 2, findings: [{ appName: "X" }, { appName: "X" }] },
    ]);
  });

  it("no findings: no runs", () => {
    expect(groupFindingRuns([], groups)).toEqual([]);
  });
});

describe("sortIntoGroups (Free preview)", () => {
  const row = (id: string, appName: string | null, severity: string, filename = "a") => ({
    id,
    appName,
    severity,
    filename,
  });

  it("orders by the ranked groups, then severity, then filename, with no app last", () => {
    const sorted = sortIntoGroups(
      [
        row("o", null, "HIGH"),
        row("l-low", "Loox", "LOW"),
        row("p-low-b", "Privy", "LOW", "b"),
        row("unlisted", "Zed", "HIGH"),
        row("p-high", "Privy", "HIGH"),
        row("p-low-a", "Privy", "LOW", "a"),
      ],
      [
        { appName: "Privy", count: 9 },
        { appName: "Loox", count: 1 },
      ],
    );
    expect(sorted.map((r) => r.id)).toEqual([
      "p-high",
      "p-low-a",
      "p-low-b",
      "l-low",
      "unlisted",
      "o",
    ]);
  });

  it("gives one run per app afterwards, even when the input interleaves apps", () => {
    const groups = [
      { appName: "A", count: 2 },
      { appName: "B", count: 1 },
    ];
    const sorted = sortIntoGroups(
      [row("a1", "A", "HIGH"), row("b1", "B", "HIGH"), row("a2", "A", "LOW")],
      groups,
    );
    expect(groupFindingRuns(sorted, groups).map((r) => r.appName)).toEqual(["A", "B"]);
  });
});
