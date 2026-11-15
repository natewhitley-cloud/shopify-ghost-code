/**
 * gc-np1d.6 (Nathan, 2026-11-15, decision 3A): the scan page's status bar
 * says "Since your last scan: N new, M fixed." on plans with scan diffing,
 * replacing the removed summary tiles' "+N new / -M resolved".
 */
import { describe, expect, it } from "vitest";

import { sinceLastScanLine } from "../../app/lib/scan-diff-line";

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
