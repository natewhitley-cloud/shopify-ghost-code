/**
 * gc-np1d.1: the select page in about two clicks (Nathan 2026-11-14). Every
 * removable piece starts selected (capped at what the trial still allows), one
 * checkbox per app, one consent line for all the apps, and a plain-words summary
 * per app. Written before the functions.
 */
import { describe, expect, it } from "vitest";

import {
  appPiecesSummary,
  appSelectionState,
  consentLabel,
  groupCandidatesByApp,
  initialSelection,
  selectionHeading,
  toggleApp,
  type CleanCopyCandidate,
} from "../../app/lib/clean-copy-view";

const cand = (over: Partial<CleanCopyCandidate>): CleanCopyCandidate => ({
  findingId: "f1",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 10,
  appName: "Privy",
  spanText: "<script></script>",
  blocked: null,
  ...over,
});

const groups = groupCandidatesByApp([
  cand({ findingId: "p1", appName: "Privy", lineNumber: 1 }),
  cand({ findingId: "p2", appName: "Privy", lineNumber: 2, findingType: "GHOST_STYLE" }),
  cand({ findingId: "p3", appName: "Privy", lineNumber: 3, findingType: "GHOST_SNIPPET" }),
  cand({ findingId: "l1", appName: "Loox", lineNumber: 1 }),
  cand({ findingId: "l2", appName: "Loox", lineNumber: 2, blocked: "NO_SPAN", spanText: null }),
  cand({ findingId: "u1", appName: null, lineNumber: 1, blocked: "APP_UNKNOWN", spanText: null }),
]);
const privy = groups.find((g) => g.appName === "Privy")!;
const loox = groups.find((g) => g.appName === "Loox")!;
const unknown = groups.find((g) => g.appName === null)!;

describe("initialSelection", () => {
  it("selects every removable piece on a paid plan, never a blocked one", () => {
    expect([...initialSelection(groups, Number.POSITIVE_INFINITY)].sort()).toEqual(
      ["l1", "p1", "p2", "p3"].sort(),
    );
  });

  it("caps at what the trial still allows, in page order (apps by name)", () => {
    // Loox sorts before Privy.
    expect([...initialSelection(groups, 2)]).toEqual(["l1", "p1"]);
  });

  it("selects nothing when the trial has nothing left", () => {
    expect(initialSelection(groups, 0).size).toBe(0);
  });

  it("selects nothing when nothing is removable", () => {
    expect(initialSelection([unknown], 5).size).toBe(0);
  });
});

describe("appSelectionState", () => {
  it("reads all, some or none of the app's removable pieces", () => {
    expect(appSelectionState(privy, new Set(["p1", "p2", "p3"]))).toBe("all");
    expect(appSelectionState(privy, new Set(["p1"]))).toBe("some");
    expect(appSelectionState(privy, new Set(["l1"]))).toBe("none");
  });

  it("is none for an app with nothing removable", () => {
    expect(appSelectionState(unknown, new Set(["u1"]))).toBe("none");
  });
});

describe("toggleApp", () => {
  it("unticking an app removes all its pieces and keeps the others", () => {
    const next = toggleApp(privy, new Set(["p1", "p2", "p3", "l1"]), false, Infinity);
    expect([...next]).toEqual(["l1"]);
  });

  it("ticking an app adds all its removable pieces, never blocked ones", () => {
    const next = toggleApp(loox, new Set(), true, Infinity);
    expect([...next]).toEqual(["l1"]);
  });

  it("ticking during the trial adds only up to what is left", () => {
    const next = toggleApp(privy, new Set(["l1"]), true, 2);
    expect([...next].sort()).toEqual(["l1", "p1"]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["p1"]);
    toggleApp(privy, before, true, Infinity);
    expect([...before]).toEqual(["p1"]);
  });
});

describe("appPiecesSummary", () => {
  it("names what will be removed in merchant words", () => {
    expect(appPiecesSummary(privy)).toBe("1 script, 1 stylesheet, 1 snippet");
  });

  it("pluralises and leaves out blocked pieces", () => {
    const g = groupCandidatesByApp([
      cand({ findingId: "a" }),
      cand({ findingId: "b", lineNumber: 11 }),
      cand({ findingId: "c", lineNumber: 12, blocked: "NO_SPAN", spanText: null }),
    ])[0];
    expect(appPiecesSummary(g)).toBe("2 scripts");
  });

  it("calls a preconnect a connection hint", () => {
    const g = groupCandidatesByApp([cand({ findingType: "GHOST_PRECONNECT" })])[0];
    expect(appPiecesSummary(g)).toBe("1 connection hint");
  });

  it("is empty when nothing is removable", () => {
    expect(appPiecesSummary(unknown)).toBe("");
  });
});

describe("consentLabel", () => {
  it("names one app", () => {
    expect(consentLabel(["Privy"])).toBe("I've uninstalled Privy.");
  });
  it("names two apps", () => {
    expect(consentLabel(["Loox", "Privy"])).toBe("I've uninstalled Loox and Privy.");
  });
  it("names several apps", () => {
    expect(consentLabel(["Judge.me", "Loox", "Privy"])).toBe(
      "I've uninstalled Judge.me, Loox and Privy.",
    );
  });
});

describe("selectionHeading", () => {
  it("counts the selection", () => {
    expect(selectionHeading(12)).toBe("12 pieces of leftover code selected");
    expect(selectionHeading(1)).toBe("1 piece of leftover code selected");
    expect(selectionHeading(0)).toBe("Nothing selected yet");
  });
});
