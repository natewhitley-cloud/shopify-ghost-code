# Spec: Health Score Trend Chart

**Status:** READY FOR REVIEW
**Created:** 2026-03-29
**Author:** Claude Opus 4.6 (user-initiated)

---

## Problem Statement

Health score trend bar chart — a visual chart on the dashboard showing health score over time for paid-plan merchants with 3+ completed scans. Lightweight implementation (inline SVG or CSS bars, no heavy chart library). Show empty state messaging when < 3 scans exist.

---

## Context & Constraints

### Current State

The dashboard (`app/routes/app._index.tsx`) currently shows:
- A **health score tile** displaying the latest scan's score (0-100) with tone-colored styling (success/warning/critical)
- A **previous health score delta** showing the diff between the two most recent scans (e.g., "Prev: 85 (+5)")
- **Finding severity counts** (High/Medium/Low) for the most recent scan
- Scan actions (New Scan button, Scan History link)

The loader currently fetches only the 2 most recent scans (`getScansForShop(shop.id, { limit: 2 })`) to compute the current health score and the previous-scan delta.

### Health Score Computation

`computeHealthScore()` in `app/lib/health-score.ts` is a **pure function** that takes `{ HIGH: number, MEDIUM: number, LOW: number }` severity counts and returns `{ score, label, tone }`. The score formula: `max(0, 100 - (HIGH * 10 + MEDIUM * 5 + LOW * 1))`. This function is client-safe (no `.server.ts` suffix).

### Data Model

Scans are stored in the `Scan` model with `shopId`, `status`, `completedAt`, `themeName`, and `findingCount`. Findings are in a separate `Finding` model linked by `scanId`. The `getFindingSummary(scanId)` function returns `{ total, bySeverity, byType }` — the `bySeverity` output is exactly what `computeHealthScore` consumes. There is an index on `[shopId, createdAt]`.

### Plan Gating

- **Free plan**: Shows only a preview finding (single highest-severity), empty findings array. Server-side gating prevents leaking full findings. Health score is shown for the latest scan only — no historical comparison.
- **Standard plan**: Full findings, health score with previous-scan delta.
- **Professional plan**: Full findings, all features.

The feature check pattern uses `getPlanFeatures(shop.plan)` from `app/lib/billing.server.ts`. Plan constants are in `app/lib/plans.ts` (`PLANS.FREE`, `PLANS.STANDARD`, `PLANS.PROFESSIONAL`).

### Constraints

1. **No heavy chart libraries**: The goal explicitly requires inline SVG or CSS bars. No Chart.js, Recharts, D3, etc.
2. **Polaris Web Components**: The app uses `<s-*>` CDN components, not npm React Polaris. Custom UI uses standard HTML/CSS with inline styles or `<style>` blocks in the component.
3. **Loader/action pattern**: All data fetching happens in the `loader()`. No client-side API calls.
4. **Performance**: Each `getFindingSummary()` call runs 2 parallel DB queries (groupBy severity + groupBy type). Fetching summaries for N scans means N calls. Must avoid excessive DB load for merchants with many scans.
5. **Embedded app**: Renders inside Shopify Admin iframe. Responsive layout needed (the dashboard already has a 600px breakpoint).

---

## Prior Art

### Existing Health Score Tile (app/routes/app._index.tsx, lines 666-694)

The health score tile uses a custom CSS class pattern (`health-score-tile--{tone}`, `health-score-number--{tone}`, `health-score-label--{tone}`) with inline `<style>` blocks. This establishes the project's visual pattern for tone-colored UI: success (green), warning (amber), critical (red).

### Existing CSS Pattern

The dashboard uses a `<style>{...}</style>` block inside the component (lines 429-641) with custom classes for layout (`.dashboard-top-row`, `.findings-row`, `.finding-stat`, `.usage-bar-*`). New chart styles should follow this same pattern.

### Usage Bar (lines 565-586)

The scan usage indicator uses a CSS bar pattern: `.usage-bar-track` (gray background), `.usage-bar-fill--normal` (blue fill), `.usage-bar-fill--full` (red fill). This is a precedent for bar-based visualization in the codebase.

### getScansForShop (app/models/scan.server.ts)

Already supports `limit` and cursor-based pagination. Can be extended or called with a higher limit to fetch scan history for the chart.

### computeHealthScore (app/lib/health-score.ts)

Pure function, already imported in the dashboard. Can be called N times for N historical scans with no side effects.

---

## Proposed Approach

### High-Level Design

Add a **"Health Score Trend" section** to the dashboard, positioned between the existing "Theme Health / Findings" card and the "Scan Actions" card. The section displays a vertical bar chart showing health scores from the most recent 7 completed scans, newest on the right. The heading includes a trend direction indicator ("Improving", "Declining", or "Stable") based on comparing the oldest and newest scores in the window (stable = within +/- 3 points).

### Data Flow

1. **Loader change**: Fetch up to 7 completed scans via `getCompletedScansForShop(shop.id, { limit: 10 })`. For each, call `getFindingSummary()` in parallel via `Promise.all` to get severity counts, then `computeHealthScore()` to derive the score. Return an array of `{ scanId, score, tone, label, completedAt, themeName }` objects sorted oldest-first (chronological) for chart display. **Performance note**: 7 scans = 14 groupBy queries (2 per scan via `getFindingSummary`). All run in parallel. This is bounded (max 7) and uses indexed columns (`scanId`). Acceptable for a dashboard loader.
2. **Plan gating**: Only compute and return the trend data for Standard and Professional plans. Free plan merchants see no trend chart (they only get a single preview finding per scan — historical scores would be misleading).
3. **Minimum threshold**: Only render the chart when 3+ data points exist. Below 3, show an empty state message encouraging more scans.
4. **Component**: A new `HealthScoreTrendChart` component (inline in the dashboard file, consistent with existing pattern of no separate component files for dashboard sections) renders the bar chart using inline SVG.

### Visual Design

- **Inline SVG bar chart**: Vertical bars, one per scan, with bar height proportional to score (0-100 scale). Bar color matches the score's tone (green for Excellent/Good, amber for Fair, orange for Poor, red for Critical).
- **X-axis labels**: Abbreviated date (e.g., "Mar 15") below each bar.
- **Y-axis**: Implied by bar height; score value displayed above each bar.
- **Responsive**: Chart width fills the card; bars distribute evenly. On mobile (< 600px), the chart stacks naturally.

### Why SVG Over CSS Bars

- SVG provides precise control over bar heights, labels, and spacing without layout hacks
- SVG scales cleanly in responsive containers via `viewBox`
- No external dependencies
- Accessible: supports `<title>` and `aria-label` attributes on bars

---

## API / Interface Contract

### Loader Return Shape Change

The loader's return type gains one new field:

```typescript
// New field added to the loader return object
healthScoreTrend: Array<{
  scanId: string;
  score: number;
  tone: "success" | "info" | "warning" | "caution" | "critical";
  label: string;
  completedAt: string; // ISO date string
  themeName: string;
}> | null;
// null when: free plan, or < 3 completed scans
```

### New Model Function

```typescript
// app/models/scan.server.ts
/**
 * Fetch the N most recent COMPLETED scans for a shop, newest first.
 * Used by the dashboard trend chart — only returns completed scans
 * since in-progress/failed scans have no health score.
 */
export async function getCompletedScansForShop(
  shopId: string,
  options?: { limit?: number },
): Promise<Array<{ id: string; completedAt: Date; themeName: string }>>;
```

### Component Interface (internal, not exported)

```typescript
// Inline in app/routes/app._index.tsx
function HealthScoreTrendChart(props: {
  trend: Array<{
    scanId: string;
    score: number;
    tone: string;
    label: string;
    completedAt: string;
    themeName: string;
  }>;
}): JSX.Element;
```

---

## Data Model Changes

No data model changes. All required data (scan completion dates, finding severity counts) already exists in the `Scan` and `Finding` tables. The `[shopId, createdAt]` index on `Scan` supports the query efficiently.

---

## Migration / Rollout Plan

No migration needed — standard deployment. The change is additive:
- The loader returns an additional `healthScoreTrend` field (null for free plan or < 3 scans)
- The component renders an additional section when trend data exists
- No feature flag needed: the plan-gating and minimum-scan threshold naturally hide the chart for ineligible merchants
- Backward compatible: existing dashboard behavior is unchanged for all plan tiers

---

## Non-Requirements

- **Interactive chart**: No tooltips, click-to-drill-down, or hover effects beyond basic accessibility. This is a static visualization.
- **Configurable time range**: The chart always shows the most recent N completed scans (up to 7). No date picker or time window selector.
- **Per-theme filtering**: The chart shows all completed scans regardless of which theme was scanned. No theme filter dropdown.
- **Score persistence**: Health scores are not stored in the database. They are computed on-the-fly from finding severity counts (existing pattern). This spec does not add a `healthScore` column to the Scan model.
- **Animation**: No bar-grow animations or transitions.
- **Chart library integration**: Explicitly no Chart.js, Recharts, D3, Victory, or any npm chart dependency.
- **Free plan access**: Free plan merchants do not see the trend chart (their finding data is gated server-side).

---

## Acceptance Criteria

- [ ] Dashboard loader returns `healthScoreTrend` array with score, tone, label, completedAt, and themeName for each of the last 10 completed scans (Standard and Professional plans only)
- [ ] Dashboard loader returns `healthScoreTrend: null` for Free plan merchants
- [ ] Dashboard loader returns `healthScoreTrend: null` when the shop has fewer than 3 completed scans
- [ ] An inline SVG bar chart renders on the dashboard when `healthScoreTrend` has 3+ data points
- [ ] Each bar's height is proportional to its score (0-100 scale)
- [ ] Each bar is colored according to its tone (success=green, info=blue, warning=amber, caution=orange, critical=red)
- [ ] Each bar displays its numeric score above the bar
- [ ] Each bar displays an abbreviated date label below (e.g., "Mar 15")
- [ ] The chart is wrapped in an `<s-card>` with a "Health Score Trend" heading
- [ ] When `healthScoreTrend` is null and the merchant is on a paid plan with < 3 scans, an empty state message is shown: "Complete 3 or more scans to see your health score trend."
- [ ] When `healthScoreTrend` is null and the merchant is on the Free plan, no trend section is rendered at all
- [ ] The chart is responsive: it fills the card width and bars distribute evenly
- [ ] On mobile (< 600px), the chart remains readable
- [ ] SVG bars include `aria-label` attributes for screen reader accessibility (e.g., "Score 85, Good, scanned Mar 15")
- [ ] Unit tests cover the new `getCompletedScansForShop` model function
- [ ] Unit tests cover the loader's trend computation logic (3+ scans, < 3 scans, free plan, paid plan)
- [ ] No TypeScript errors (`npx tsc --noEmit`)
- [ ] Formatted with Prettier

---

## Resolved Questions

1. **Maximum bar count**: **7 bars**. Balances visual density with readability.

2. **Trend direction indicator**: **Yes** — heading shows "Health Score Trend: Improving" / "Declining" / "Stable" based on oldest vs newest score in window. Stable threshold: +/- 3 points.

3. **Time bucketing**: **None** — chart shows the last N completed scans regardless of when they occurred. Scan frequency varies by plan; dates on x-axis communicate cadence naturally.

## Resolved Questions (continued)

4. **Empty state for paid plans with 1-2 scans**: **Muted card with CTA**. Shows "Complete N more scans to see your health score trend" with a "Start New Scan" button. Encourages the behavior that unlocks the feature.

## Open Questions

None — all questions resolved.

---
