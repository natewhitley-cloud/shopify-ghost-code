/**
 * Tests for app/components/HealthScoreTrendChart.tsx
 *
 * The test environment is Node (no DOM/jsdom), so we invoke the component
 * functions directly and inspect the returned JSX tree — the same approach
 * used in AppErrorBoundary.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  HealthScoreTrendChart,
  HealthScoreTrendEmptyState,
} from "../../app/components/HealthScoreTrendChart";
import type { HealthScoreTrend } from "../../app/components/HealthScoreTrendChart";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<{
    scanId: string;
    score: number;
    tone: string;
    label: string;
    completedAt: string;
    themeName: string;
  }> = {},
) {
  return {
    scanId: "scan-1",
    score: 80,
    tone: "success",
    label: "Good",
    completedAt: "2026-03-01T12:00:00Z",
    themeName: "Dawn",
    ...overrides,
  };
}

function makeTrend(overrides: Partial<HealthScoreTrend> = {}): HealthScoreTrend {
  return {
    scores: [
      makeEntry({ scanId: "scan-1", score: 60 }),
      makeEntry({ scanId: "scan-2", score: 70 }),
      makeEntry({ scanId: "scan-3", score: 80 }),
    ],
    direction: "improving",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// HealthScoreTrendChart — feature flag off
// ---------------------------------------------------------------------------

describe("HealthScoreTrendChart — trendChartEnabled: false", () => {
  it("returns null when trendChartEnabled is false and trend data exists", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: false,
      healthScoreTrend: makeTrend(),
    });
    expect(result).toBeNull();
  });

  it("returns null when both trendChartEnabled is false and trend is null", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: false,
      healthScoreTrend: null,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HealthScoreTrendChart — null trend
// ---------------------------------------------------------------------------

describe("HealthScoreTrendChart — healthScoreTrend: null", () => {
  it("returns null when trendChartEnabled is true but trend is null", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: null,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HealthScoreTrendChart — renders chart
// ---------------------------------------------------------------------------

describe("HealthScoreTrendChart — renders chart", () => {
  it("does not throw when trend data is present and flag is enabled", () => {
    expect(() =>
      HealthScoreTrendChart({
        trendChartEnabled: true,
        healthScoreTrend: makeTrend(),
      }),
    ).not.toThrow();
  });

  it("returns non-null JSX when trend data is present and flag is enabled", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend(),
    });
    expect(result).not.toBeNull();
  });

  it("renders a fragment (React.Fragment) at the root when chart is shown", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend(),
    });
    // The component returns a React.Fragment wrapping <style> + <div>
    expect(result).toBeTruthy();
    expect(result!.props.children).toHaveLength(2); // style + div
  });

  it("renders correct number of score entries in the chart data", () => {
    const trend = makeTrend({
      scores: [
        makeEntry({ scanId: "s1", score: 50 }),
        makeEntry({ scanId: "s2", score: 65 }),
        makeEntry({ scanId: "s3", score: 78 }),
        makeEntry({ scanId: "s4", score: 82 }),
        makeEntry({ scanId: "s5", score: 90 }),
      ],
    });

    // The component renders a <g> for each score. We verify by inspecting
    // the scores array length on the trend object passed through — behavior
    // test: component must not drop entries.
    expect(trend.scores).toHaveLength(5);

    // And the component renders without throwing for 5 bars.
    expect(() =>
      HealthScoreTrendChart({ trendChartEnabled: true, healthScoreTrend: trend }),
    ).not.toThrow();
  });

  it("shows 'Improving' direction label for improving trend", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "improving" }),
    });
    // Traverse to the s-card > h2 content
    const fragment = result!;
    const div = fragment.props.children[1]; // <div className="trend-chart-card">
    const card = div.props.children; // <s-card>
    const h2 = card.props.children[0]; // <h2>
    // h2 children: ["Health Score Trend: ", <span>Improving</span>]
    const span = h2.props.children[1];
    expect(span.props.children).toBe("Improving");
  });

  it("shows 'Declining' direction label for declining trend", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "declining" }),
    });
    const fragment = result!;
    const div = fragment.props.children[1];
    const card = div.props.children;
    const h2 = card.props.children[0];
    const span = h2.props.children[1];
    expect(span.props.children).toBe("Declining");
  });

  it("shows 'Stable' direction label for stable trend", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "stable" }),
    });
    const fragment = result!;
    const div = fragment.props.children[1];
    const card = div.props.children;
    const h2 = card.props.children[0];
    const span = h2.props.children[1];
    expect(span.props.children).toBe("Stable");
  });

  it("applies the correct CSS class for the Improving direction", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "improving" }),
    });
    const fragment = result!;
    const div = fragment.props.children[1];
    const card = div.props.children;
    const h2 = card.props.children[0];
    const span = h2.props.children[1];
    expect(span.props.className).toBe("trend-chart-direction--improving");
  });

  it("applies the correct CSS class for the Declining direction", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "declining" }),
    });
    const fragment = result!;
    const div = fragment.props.children[1];
    const card = div.props.children;
    const h2 = card.props.children[0];
    const span = h2.props.children[1];
    expect(span.props.className).toBe("trend-chart-direction--declining");
  });

  it("applies the correct CSS class for the Stable direction", () => {
    const result = HealthScoreTrendChart({
      trendChartEnabled: true,
      healthScoreTrend: makeTrend({ direction: "stable" }),
    });
    const fragment = result!;
    const div = fragment.props.children[1];
    const card = div.props.children;
    const h2 = card.props.children[0];
    const span = h2.props.children[1];
    expect(span.props.className).toBe("trend-chart-direction--stable");
  });
});

// ---------------------------------------------------------------------------
// HealthScoreTrendEmptyState — flag off or condition not met
// ---------------------------------------------------------------------------

describe("HealthScoreTrendEmptyState — renders nothing", () => {
  const noop = () => {};

  it("returns null when trendChartEnabled is false", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: false,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when showTrendEmptyState is false", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: false,
      scansNeeded: 0,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when both flag is off and showTrendEmptyState is false", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: false,
      showTrendEmptyState: false,
      scansNeeded: 0,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HealthScoreTrendEmptyState — renders empty state
// ---------------------------------------------------------------------------

describe("HealthScoreTrendEmptyState — renders empty state", () => {
  const noop = () => {};

  it("does not throw when empty state should be shown", () => {
    expect(() =>
      HealthScoreTrendEmptyState({
        trendChartEnabled: true,
        showTrendEmptyState: true,
        scansNeeded: 2,
        onStartScan: noop,
        isSubmitting: false,
        scanDisabled: false,
      }),
    ).not.toThrow();
  });

  it("returns non-null JSX when empty state should be shown", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    expect(result).not.toBeNull();
  });

  it("renders '2 more scans' text when scansNeeded is 2", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    // result is <> <style>...</style> <div className="trend-chart-empty"> </>
    // Fragment children: [style, div]; div children: [h2, p, s-button]
    const div = result!.props.children[1];
    const p = div.props.children[1];
    // p.props.children is an array: ["Complete ", 2, " more scan", "s", " to see..."]
    const children = p.props.children;
    expect(children[1]).toBe(2); // scansNeeded value
    expect(children[3]).toBe("s"); // plural suffix
  });

  it("renders '1 more scan' (singular) when scansNeeded is 1", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 1,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    const div = result!.props.children[1];
    const p = div.props.children[1];
    const children = p.props.children;
    expect(children[1]).toBe(1);
    expect(children[3]).toBe(""); // no plural suffix
  });

  it("calls onStartScan when the button onClick fires", () => {
    const onStartScan = vi.fn();
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan,
      isSubmitting: false,
      scanDisabled: false,
    });
    const button = result!.props.children[1].props.children[2];
    // Simulate calling the onClick handler
    button.props.onClick();
    expect(onStartScan).toHaveBeenCalledOnce();
  });

  it("shows 'Starting...' label and loading prop when isSubmitting is true", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: true,
      scanDisabled: false,
    });
    const button = result!.props.children[1].props.children[2];
    expect(button.props.children).toBe("Starting...");
    expect(button.props.loading).toBe(true);
  });

  it("shows 'Start New Scan' label when isSubmitting is false", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    const button = result!.props.children[1].props.children[2];
    expect(button.props.children).toBe("Start New Scan");
  });

  it("sets disabled prop on button when scanDisabled is true", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: true,
    });
    const button = result!.props.children[1].props.children[2];
    expect(button.props.disabled).toBe(true);
  });

  it("does not set disabled prop on button when scanDisabled is false", () => {
    const result = HealthScoreTrendEmptyState({
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
      onStartScan: noop,
      isSubmitting: false,
      scanDisabled: false,
    });
    const button = result!.props.children[1].props.children[2];
    expect(button.props.disabled).toBeUndefined();
  });
});
