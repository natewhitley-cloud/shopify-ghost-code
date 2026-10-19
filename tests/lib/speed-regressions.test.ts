/**
 * Tests for the per-app speed regression rule in app/lib/speed-report.ts
 * (gc-vgqc): speedAppRegressions (which apps to name), speedRegressionLine
 * (the summary email sentence) and speedRegressionBadges (the Store speed
 * page badges). One pure function feeds both surfaces.
 */
import { describe, it, expect } from "vitest";

import {
  SPEED_REGRESSION_MAX_APPS,
  SPEED_REGRESSION_MIN_BYTES,
  SPEED_REGRESSION_MIN_MS,
  SPEED_REGRESSION_MIN_RATIO,
  speedAppRegressions,
  speedRegressionBadges,
  speedRegressionLine,
  type SpeedAppRegression,
  type SpeedCostRow,
  type SpeedPageResult,
} from "../../app/lib/speed-report";

const URL_A = "https://shop.example/";

const app = (name: string, mainThreadMs: number, transferBytes: number): SpeedCostRow => ({
  name,
  mainThreadMs,
  transferBytes,
  unusedPct: null,
  requestCount: 1,
});

function page(apps: SpeedCostRow[], over: Partial<SpeedPageResult> = {}): SpeedPageResult {
  return {
    page: "home",
    status: "OK",
    url: URL_A,
    runsAttempted: 3,
    runsOk: 3,
    metrics: {
      score: 50,
      lcpMs: 4000,
      tbtMs: 900,
      cls: 0,
      fcpMs: 1000,
      speedIndexMs: 3000,
      totalBytes: 2_000_000,
      requestCount: 80,
    },
    apps,
    otherThirdParty: [],
    ...over,
  };
}

const names = (rs: SpeedAppRegression[]) => rs.map((r) => r.name);

describe("constants", () => {
  it("floors are 100 KB / 200 ms / 25%, capped at 3 apps", () => {
    expect(SPEED_REGRESSION_MIN_BYTES).toBe(100_000);
    expect(SPEED_REGRESSION_MIN_MS).toBe(200);
    expect(SPEED_REGRESSION_MIN_RATIO).toBe(0.25);
    expect(SPEED_REGRESSION_MAX_APPS).toBe(3);
  });
});

describe("speedAppRegressions", () => {
  it("names a NEW app with a non-trivial cost", () => {
    const r = speedAppRegressions(
      page([app("Klaviyo", 1000, 500_000), app("PushOwl", 300, 140_000)]),
      page([app("Klaviyo", 1000, 500_000)]),
    );
    expect(r).toEqual([
      {
        name: "PushOwl",
        kind: "new",
        current: { mainThreadMs: 300, transferBytes: 140_000 },
        previous: null,
        timeUp: true,
        sizeUp: true,
      },
    ]);
  });

  it("does not name a new app whose cost is below both floors", () => {
    expect(
      speedAppRegressions(page([app("Tiny", 199, 99_999)]), page([app("Klaviyo", 1, 1)])),
    ).toEqual([]);
  });

  it("jump by KB only: +100 KB and >= 25% is named (size only)", () => {
    const r = speedAppRegressions(
      page([app("Judge.me", 400, 400_000)]),
      page([app("Judge.me", 400, 300_000)]),
    );
    expect(r).toEqual([expect.objectContaining({ kind: "up", sizeUp: true, timeUp: false })]);
  });

  it("jump by ms only: +200 ms and >= 25% is named (time only)", () => {
    const r = speedAppRegressions(
      page([app("Judge.me", 900, 120_000)]),
      page([app("Judge.me", 400, 118_000)]),
    );
    expect(r).toEqual([
      expect.objectContaining({
        kind: "up",
        timeUp: true,
        sizeUp: false,
        previous: { mainThreadMs: 400, transferBytes: 118_000 },
        current: { mainThreadMs: 900, transferBytes: 120_000 },
      }),
    ]);
  });

  it("below the floor: +199 ms / +99,999 bytes is not named, even at a huge %", () => {
    expect(
      speedAppRegressions(page([app("A", 299, 199_999)]), page([app("A", 100, 100_000)])),
    ).toEqual([]);
  });

  it("exactly at the floor and exactly 25% is named", () => {
    // 800 -> 1000 ms: +200 = 25% of 800. 400 KB -> 500 KB: +100 KB = 25%.
    expect(names(speedAppRegressions(page([app("A", 1000, 0)]), page([app("A", 800, 0)])))).toEqual(
      ["A"],
    );
    expect(
      names(speedAppRegressions(page([app("B", 0, 500_000)]), page([app("B", 0, 400_000)]))),
    ).toEqual(["B"]);
  });

  it("above the floor but under 25% is not named (the ratio guard)", () => {
    // +300 ms on 2000 ms = 15%; +150 KB on 1 MB = 15%.
    expect(
      speedAppRegressions(page([app("Big", 2300, 1_150_000)]), page([app("Big", 2000, 1_000_000)])),
    ).toEqual([]);
    // Just under: +200 ms on 801 ms is 24.97%.
    expect(speedAppRegressions(page([app("A", 1001, 0)]), page([app("A", 801, 0)]))).toEqual([]);
  });

  it("a cost that went DOWN is never named", () => {
    expect(
      speedAppRegressions(page([app("A", 100, 10_000)]), page([app("A", 900, 500_000)])),
    ).toEqual([]);
  });

  it("previous page FAILED (row missing because the page failed): nothing named", () => {
    const failed = page([], { status: "FAILED", metrics: undefined, failureCode: "timeout" });
    expect(speedAppRegressions(page([app("PushOwl", 900, 400_000)]), failed)).toEqual([]);
    // Status OK but no metrics is treated the same.
    expect(
      speedAppRegressions(page([app("PushOwl", 900, 400_000)]), page([], { metrics: undefined })),
    ).toEqual([]);
  });

  it("current page not OK, or no previous page at all: nothing named", () => {
    const cur = page([app("PushOwl", 900, 400_000)], { status: "FAILED" });
    expect(speedAppRegressions(cur, page([]))).toEqual([]);
    expect(speedAppRegressions(page([app("PushOwl", 900, 400_000)]), undefined)).toEqual([]);
    expect(speedAppRegressions(page([app("PushOwl", 900, 400_000)]), null)).toEqual([]);
  });

  it("a different URL tested: nothing named (different product/domain is not comparable)", () => {
    expect(
      speedAppRegressions(
        page([app("PushOwl", 900, 400_000)], { url: "https://other.example/" }),
        page([]),
      ),
    ).toEqual([]);
    // A null URL on both sides is not "the same URL".
    expect(
      speedAppRegressions(
        page([app("PushOwl", 900, 400_000)], { url: null }),
        page([], { url: null }),
      ),
    ).toEqual([]);
  });

  it("only matched apps: an unmatched third-party host is never named", () => {
    const cur = page([], { otherThirdParty: [app("cdn.example.com", 900, 900_000)] });
    expect(speedAppRegressions(cur, page([]))).toEqual([]);
  });

  it("caps at 3, biggest processing-time rise first, then size rise, then name", () => {
    const r = speedAppRegressions(
      page([
        app("SizeOnly", 0, 900_000), // +0 ms, +900 KB
        app("Zeta", 600, 0), // new, +600 ms
        app("Alpha", 600, 0), // new, +600 ms (ties Zeta: name decides)
        app("Mid", 1400, 0), // up from 1000: +400 ms, 40% (named, but 4th)
        app("Top", 2000, 0), // new, +2000 ms
      ]),
      page([app("Mid", 1000, 0), app("SizeOnly", 0, 0)]),
    );
    expect(names(r)).toEqual(["Top", "Alpha", "Zeta"]);
    // Deterministic: input order does not change the result.
    const reversed = speedAppRegressions(
      page([app("Zeta", 600, 0), app("Top", 2000, 0), app("Alpha", 600, 0)]),
      page([]),
    );
    expect(names(reversed)).toEqual(["Top", "Alpha", "Zeta"]);
  });

  it("an equal processing-time rise is ordered by the download-size rise", () => {
    const r = speedAppRegressions(
      page([app("Small", 500, 110_000), app("Large", 500, 300_000)]),
      page([]),
    );
    expect(names(r)).toEqual(["Large", "Small"]);
  });
});

describe("speedRegressionLine (summary email)", () => {
  const up = (prev: [number, number], cur: [number, number], timeUp: boolean, sizeUp: boolean) =>
    ({
      name: "Judge.me",
      kind: "up",
      previous: { mainThreadMs: prev[0], transferBytes: prev[1] },
      current: { mainThreadMs: cur[0], transferBytes: cur[1] },
      timeUp,
      sizeUp,
    }) satisfies SpeedAppRegression;

  it("new app: KB and processing time", () => {
    const [r] = speedAppRegressions(page([app("Klaviyo", 300, 140_000)]), page([]));
    expect(speedRegressionLine(r)).toBe(
      "Klaviyo is new since the test before and adds 140 KB and 0.3 s of processing time on your homepage.",
    );
  });

  it("new app: a cost that rounds to zero is left out", () => {
    const [r] = speedAppRegressions(page([app("Klaviyo", 40, 140_000)]), page([]));
    expect(speedRegressionLine(r)).toBe(
      "Klaviyo is new since the test before and adds 140 KB on your homepage.",
    );
    const [t] = speedAppRegressions(page([app("Klaviyo", 250, 400)]), page([]));
    expect(speedRegressionLine(t)).toBe(
      "Klaviyo is new since the test before and adds 0.3 s of processing time on your homepage.",
    );
  });

  it("time only, size only, both", () => {
    expect(speedRegressionLine(up([400, 118_000], [900, 120_000], true, false))).toBe(
      "Judge.me's processing time on your homepage rose from 0.4 s to 0.9 s.",
    );
    expect(speedRegressionLine(up([400, 120_000], [400, 340_000], false, true))).toBe(
      "Judge.me's download size on your homepage rose from 120 KB to 340 KB.",
    );
    expect(speedRegressionLine(up([400, 120_000], [900, 340_000], true, true))).toBe(
      "Judge.me's processing time on your homepage rose from 0.4 s to 0.9 s and its download size from 120 KB to 340 KB.",
    );
  });

  it("rounds deltas the way the page does (one decimal second, whole KB, MB above 1,000 KB)", () => {
    expect(speedRegressionLine(up([449, 960_400], [1_251, 1_250_000], true, true))).toBe(
      "Judge.me's processing time on your homepage rose from 0.4 s to 1.3 s and its download size from 960 KB to 1.3 MB.",
    );
  });

  it("a name ending in s takes a bare apostrophe; the email can pass a sanitized name", () => {
    const r = { ...up([400, 0], [900, 0], true, false), name: "Yotpo Reviews" };
    expect(speedRegressionLine(r)).toBe(
      "Yotpo Reviews' processing time on your homepage rose from 0.4 s to 0.9 s.",
    );
    expect(speedRegressionLine(r, "Clean")).toBe(
      "Clean's processing time on your homepage rose from 0.4 s to 0.9 s.",
    );
  });

  it("never says script time, checkout, or uses a dash", () => {
    const lines = [
      speedRegressionLine(up([400, 120_000], [900, 340_000], true, true)),
      ...speedAppRegressions(page([app("Klaviyo", 300, 140_000)]), page([])).map((r) =>
        speedRegressionLine(r),
      ),
    ];
    for (const l of lines) {
      expect(l).not.toMatch(/script time|checkout|[–—]/i);
    }
  });
});

describe("speedRegressionBadges (Store speed page)", () => {
  it('"New" for a new app', () => {
    const [r] = speedAppRegressions(page([app("Klaviyo", 300, 140_000)]), page([]));
    expect(speedRegressionBadges(r)).toEqual(["New"]);
  });

  it('"Up 0.5 s" / "Up 120 KB" per cost that passed its floor', () => {
    const [t] = speedAppRegressions(page([app("A", 900, 120_000)]), page([app("A", 400, 118_000)]));
    expect(speedRegressionBadges(t)).toEqual(["Up 0.5 s"]);
    const [s] = speedAppRegressions(page([app("A", 400, 240_000)]), page([app("A", 400, 120_000)]));
    expect(speedRegressionBadges(s)).toEqual(["Up 120 KB"]);
    const [b] = speedAppRegressions(page([app("A", 900, 240_000)]), page([app("A", 400, 120_000)]));
    expect(speedRegressionBadges(b)).toEqual(["Up 0.5 s", "Up 120 KB"]);
  });
});
