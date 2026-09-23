import { describe, it, expect } from "vitest";

import { computeStats, parseThemeSizeSample } from "../../scripts/theme-size-report";

describe("computeStats", () => {
  it("returns all-zero stats for empty input", () => {
    expect(computeStats([])).toEqual({ count: 0, max: 0, p95: 0, median: 0 });
  });

  it("computes count/max/p95/median on a small array", () => {
    const stats = computeStats([10, 20, 30, 40, 50]);

    expect(stats.count).toBe(5);
    expect(stats.max).toBe(50);
    expect(stats.median).toBe(30);
    expect(stats.p95).toBe(50);
  });

  it("does not mutate the input array", () => {
    const values = [30, 10, 20];
    computeStats(values);

    expect(values).toEqual([30, 10, 20]);
  });

  it("handles a single value", () => {
    expect(computeStats([42])).toEqual({ count: 1, max: 42, p95: 42, median: 42 });
  });
});

describe("parseThemeSizeSample", () => {
  it("extracts totalTextBytes/largestFileBytes from a well-formed row", () => {
    expect(
      parseThemeSizeSample({ totalTextBytes: 1000, largestFileBytes: 200, other: "ignored" }),
    ).toEqual({ totalTextBytes: 1000, largestFileBytes: 200 });
  });

  it("skips a legacy row that predates the new fields", () => {
    expect(parseThemeSizeSample({ fileCount: 12, scannableFileCount: 8 })).toBeNull();
  });

  it("skips null metadata", () => {
    expect(parseThemeSizeSample(null)).toBeNull();
  });

  it("skips non-object metadata", () => {
    expect(parseThemeSizeSample("not-an-object")).toBeNull();
  });

  it("skips a row with malformed (non-numeric) fields", () => {
    expect(parseThemeSizeSample({ totalTextBytes: "1000", largestFileBytes: 200 })).toBeNull();
  });
});
