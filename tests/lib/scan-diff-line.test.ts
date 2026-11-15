/**
 * gc-np1d.6 (Nathan, 2026-11-15, decision 3A): the scan page's status bar
 * says "Since your last scan: N new, M fixed." on plans with scan diffing,
 * replacing the removed summary tiles' "+N new / -M resolved".
 */
import { describe, expect, it } from "vitest";

import { diffForScan, sinceLastScanLine } from "../../app/lib/scan-diff-line";

const rows = (n: number) => Array.from({ length: n }, () => ({}));
const diff = (added: number, gone: number) => ({
  newFindings: rows(added),
  resolvedFindings: rows(gone),
});

describe("sinceLastScanLine", () => {
  it("states both counts", () => {
    expect(sinceLastScanLine(diff(3, 5))).toBe("Since your last scan: 3 new, 5 fixed.");
  });

  it("keeps a zero side when the other is non-zero", () => {
    expect(sinceLastScanLine(diff(2, 0))).toBe("Since your last scan: 2 new, 0 fixed.");
    expect(sinceLastScanLine(diff(0, 1))).toBe("Since your last scan: 0 new, 1 fixed.");
  });

  it("is null when nothing changed", () => {
    expect(sinceLastScanLine(diff(0, 0))).toBeNull();
  });

  it("is null with no diff (no earlier scan, plan without diffing, or not loaded yet)", () => {
    expect(sinceLastScanLine(null)).toBeNull();
  });
});

describe("diffForScan (audit M1: a diff belongs to the scan it answers for)", () => {
  it("returns the diff the route answered for this scan", () => {
    const d = diff(4, 2);
    expect(diffForScan("scan-a", { scanId: "scan-a", scanDiff: d })).toBe(d);
  });

  it("is null for another scan of the same route (param change keeps the old data)", () => {
    expect(diffForScan("scan-b", { scanId: "scan-a", scanDiff: diff(4, 2) })).toBeNull();
  });

  it("is null before any load, and for a null diff", () => {
    expect(diffForScan("scan-a", undefined)).toBeNull();
    expect(diffForScan("scan-a", { scanId: "scan-a", scanDiff: null })).toBeNull();
  });

  it("is null for a response without a scan id", () => {
    expect(diffForScan("scan-a", { scanDiff: diff(1, 1) })).toBeNull();
  });
});
