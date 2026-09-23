import { describe, it, expect } from "vitest";

import {
  computeStats,
  parseThemeSizeSample,
  summarizeScanSignals,
} from "../../scripts/theme-size-report";

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
  it("recognizes an aborted over-cap row (gc-d4e follow-up) rather than skipping it", () => {
    expect(
      parseThemeSizeSample({
        shopId: "s1",
        aborted: "theme_too_large",
        bytesAtAbort: 30_000_001,
        maxTotalBytes: 30_000_000,
      }),
    ).toEqual({ kind: "aborted", bytesAtAbort: 30_000_001, maxTotalBytes: 30_000_000 });
  });

  it("skips an aborted row with a malformed bytesAtAbort", () => {
    expect(
      parseThemeSizeSample({ aborted: "theme_too_large", bytesAtAbort: "big", maxTotalBytes: 1 }),
    ).toBeNull();
  });

  it("skips a row with an unknown aborted reason", () => {
    expect(
      parseThemeSizeSample({ aborted: "something_else", bytesAtAbort: 5, maxTotalBytes: 1 }),
    ).toBeNull();
  });

  it("extracts totalTextBytes/largestFileBytes from a well-formed row", () => {
    expect(
      parseThemeSizeSample({ totalTextBytes: 1000, largestFileBytes: 200, other: "ignored" }),
    ).toEqual({ kind: "completed", totalTextBytes: 1000, largestFileBytes: 200 });
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

describe("summarizeScanSignals", () => {
  it("splits completed, aborted and skipped rows and reports max bytesAtAbort", () => {
    const summary = summarizeScanSignals([
      { totalTextBytes: 100, largestFileBytes: 10 },
      { totalTextBytes: 300, largestFileBytes: 50 },
      { aborted: "theme_too_large", bytesAtAbort: 31_000_000, maxTotalBytes: 30_000_000 },
      { aborted: "theme_too_large", bytesAtAbort: 45_000_000, maxTotalBytes: 30_000_000 },
      { fileCount: 3 }, // legacy
      null,
    ]);

    expect(summary.completed).toEqual([
      { kind: "completed", totalTextBytes: 100, largestFileBytes: 10 },
      { kind: "completed", totalTextBytes: 300, largestFileBytes: 50 },
    ]);
    expect(summary.abortedCount).toBe(2);
    expect(summary.maxBytesAtAbort).toBe(45_000_000);
    expect(summary.skipped).toBe(2);
  });

  it("returns zero aborted and a zero max when nothing aborted", () => {
    const summary = summarizeScanSignals([{ totalTextBytes: 1, largestFileBytes: 1 }]);

    expect(summary.abortedCount).toBe(0);
    expect(summary.maxBytesAtAbort).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it("handles empty input", () => {
    expect(summarizeScanSignals([])).toEqual({
      completed: [],
      abortedCount: 0,
      maxBytesAtAbort: 0,
      skipped: 0,
    });
  });
});
