/**
 * HealthScoreTrendChart and HealthScoreTrendEmptyState components.
 *
 * Renders the health score trend bar chart (SVG) and its empty state for
 * shops on paid plans that have not yet completed enough scans to show
 * a trend. Both components are feature-flagged: they render nothing when
 * `trendChartEnabled` is false.
 *
 * Types `TrendScoreEntry` and `HealthScoreTrend` are exported so the route
 * loader can use them for typing the loader return value.
 */

import {
  BG_SURFACE_ALT,
  BORDER_DEFAULT,
  COLOR_CRITICAL,
  COLOR_INFO,
  COLOR_SUCCESS,
  COLOR_WARNING,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Types (exported for use in the route loader)
// ---------------------------------------------------------------------------

export type TrendScoreEntry = {
  scanId: string;
  score: number;
  tone: string;
  label: string;
  completedAt: string;
  themeName: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
};

export type HealthScoreTrend = {
  scores: TrendScoreEntry[];
  direction: "improving" | "declining" | "stable";
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string as an abbreviated month + day label for chart axes.
 * Example: "2024-03-15T12:00:00Z" -> "Mar 15"
 */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type HealthScoreTrendChartProps = {
  trendChartEnabled: boolean;
  healthScoreTrend: HealthScoreTrend | null;
};

export type HealthScoreTrendEmptyStateProps = {
  trendChartEnabled: boolean;
  showTrendEmptyState: boolean;
  scansNeeded: number;
  onStartScan: () => void;
  isSubmitting: boolean;
  scanDisabled: boolean;
};

// ---------------------------------------------------------------------------
// HealthScoreTrendChart
// ---------------------------------------------------------------------------

export function HealthScoreTrendChart({
  trendChartEnabled,
  healthScoreTrend,
}: HealthScoreTrendChartProps) {
  if (!trendChartEnabled || healthScoreTrend === null) {
    return null;
  }

  const scores = healthScoreTrend.scores;
  const barCount = scores.length;
  const viewBoxWidth = 700;
  const viewBoxHeight = 270;
  const chartTop = 30;
  const chartBottom = viewBoxHeight - 50;
  const chartHeight = chartBottom - chartTop;
  // Thin bars: each section gets equal width, bar occupies ~30% of its section, centered
  const sectionWidth = viewBoxWidth / barCount;
  const barWidth = Math.floor(sectionWidth * 0.3);
  const barX = (i: number) => Math.floor(sectionWidth * i + (sectionWidth - barWidth) / 2);
  const maxTotal = Math.max(...scores.map((s) => s.highCount + s.mediumCount + s.lowCount), 1);
  const minBarH = 4;
  const segH = (count: number) =>
    count === 0 ? 0 : Math.max(minBarH, Math.round((count / maxTotal) * chartHeight));

  const directionClass = `trend-chart-direction--${healthScoreTrend.direction}`;
  const directionLabel =
    healthScoreTrend.direction === "improving"
      ? "Improving"
      : healthScoreTrend.direction === "declining"
        ? "Declining"
        : "Stable";

  const HIGH_COLOR = COLOR_CRITICAL;
  const MEDIUM_COLOR = COLOR_WARNING;
  const LOW_COLOR = COLOR_INFO;

  return (
    <>
      <style>{`
        .trend-chart-card {
          margin-top: 16px;
        }
        .trend-chart-heading {
          font-size: 18px;
          font-weight: 600;
          color: ${TEXT_PRIMARY};
          margin: 0 0 4px 0;
        }
        .trend-chart-direction--improving { color: ${COLOR_SUCCESS}; }
        .trend-chart-direction--declining { color: ${COLOR_WARNING}; }
        .trend-chart-direction--stable { color: ${TEXT_SUBDUED}; }
        .trend-chart-svg-container {
          margin-top: 12px;
          width: 100%;
        }
      `}</style>
      <div className="trend-chart-card">
        <s-card>
          <h2 className="trend-chart-heading">
            Findings Trend: <span className={directionClass}>{directionLabel}</span>
          </h2>
          <div className="trend-chart-svg-container">
            <svg
              viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
              width="100%"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Findings trend stacked bar chart"
            >
              {scores.map((entry, i) => {
                const x = barX(i);
                const cx = x + barWidth / 2;
                const total = entry.highCount + entry.mediumCount + entry.lowCount;
                // Order from top: Low, Medium, High
                const lH = segH(entry.lowCount);
                const mH = segH(entry.mediumCount);
                const hH = segH(entry.highCount);
                const totalH = lH + mH + hH || minBarH;
                const topY = chartBottom - totalH;
                const dateLabel = formatShortDate(entry.completedAt);
                // Segment y positions
                const lowY = topY;
                const medY = topY + lH;
                const highY = topY + lH + mH;
                // Show count inside a segment if it's tall enough
                const labelIfFits = (count: number, y: number, h: number) =>
                  h >= 16 ? (
                    <text
                      x={cx}
                      y={y + h / 2 + 4}
                      textAnchor="middle"
                      fontSize="11"
                      fill="white"
                      fontWeight="600"
                    >
                      {count}
                    </text>
                  ) : null;
                const clipId = `bar-clip-${i}`;
                return (
                  <g key={entry.scanId}>
                    {/* Clip path rounds the outer corners of the whole stacked bar */}
                    <defs>
                      <clipPath id={clipId}>
                        <rect x={x} y={topY} width={barWidth} height={totalH} rx="4" />
                      </clipPath>
                    </defs>
                    {/* Total label above bar */}
                    <text
                      x={cx}
                      y={topY - 6}
                      textAnchor="middle"
                      fontSize="12"
                      fill={TEXT_PRIMARY}
                      fontWeight="600"
                    >
                      {total}
                    </text>
                    {/* Stacked segments — no rx; clip path handles rounding */}
                    <g clipPath={`url(#${clipId})`} aria-label={`${total} total findings`}>
                      {entry.lowCount > 0 && (
                        <rect
                          x={x}
                          y={lowY}
                          width={barWidth}
                          height={lH}
                          fill={LOW_COLOR}
                          aria-label={`${entry.lowCount} low`}
                        />
                      )}
                      {entry.mediumCount > 0 && (
                        <rect
                          x={x}
                          y={medY}
                          width={barWidth}
                          height={mH}
                          fill={MEDIUM_COLOR}
                          aria-label={`${entry.mediumCount} medium`}
                        />
                      )}
                      {entry.highCount > 0 && (
                        <rect
                          x={x}
                          y={highY}
                          width={barWidth}
                          height={hH}
                          fill={HIGH_COLOR}
                          aria-label={`${entry.highCount} high`}
                        />
                      )}
                      {total === 0 && (
                        <rect
                          x={x}
                          y={chartBottom - minBarH}
                          width={barWidth}
                          height={minBarH}
                          fill={BORDER_DEFAULT}
                        />
                      )}
                    </g>
                    {/* Segment count labels rendered outside clip so text isn't cut off */}
                    {labelIfFits(entry.lowCount, lowY, lH)}
                    {labelIfFits(entry.mediumCount, medY, mH)}
                    {labelIfFits(entry.highCount, highY, hH)}
                    {/* Date label centered in section */}
                    <text
                      x={sectionWidth * i + sectionWidth / 2}
                      y={chartBottom + 16}
                      textAnchor="middle"
                      fontSize="11"
                      fill={TEXT_SUBDUED}
                    >
                      {dateLabel}
                    </text>
                  </g>
                );
              })}
              {/* Legend */}
              <g transform={`translate(10, ${viewBoxHeight - 18})`}>
                <rect width="10" height="10" fill={HIGH_COLOR} rx="2" />
                <text x="14" y="9" fontSize="10" fill={TEXT_SUBDUED}>
                  High
                </text>
                <rect x="50" width="10" height="10" fill={MEDIUM_COLOR} rx="2" />
                <text x="64" y="9" fontSize="10" fill={TEXT_SUBDUED}>
                  Medium
                </text>
                <rect x="120" width="10" height="10" fill={LOW_COLOR} rx="2" />
                <text x="134" y="9" fontSize="10" fill={TEXT_SUBDUED}>
                  Low
                </text>
              </g>
            </svg>
          </div>
        </s-card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// HealthScoreTrendEmptyState
// ---------------------------------------------------------------------------

export function HealthScoreTrendEmptyState({
  trendChartEnabled,
  showTrendEmptyState,
  scansNeeded,
  onStartScan,
  isSubmitting,
  scanDisabled,
}: HealthScoreTrendEmptyStateProps) {
  if (!trendChartEnabled || !showTrendEmptyState) {
    return null;
  }

  return (
    <>
      <style>{`
        .trend-chart-empty {
          background: ${BG_SURFACE_ALT};
          border: 1px solid ${BORDER_DEFAULT};
          border-radius: 12px;
          padding: 24px 20px;
          margin-top: 16px;
        }
        .trend-chart-empty-heading {
          font-size: 16px;
          font-weight: 600;
          color: ${TEXT_PRIMARY};
          margin: 0 0 8px 0;
        }
        .trend-chart-empty-text {
          font-size: 14px;
          color: ${TEXT_SUBDUED};
          margin: 0 0 16px 0;
        }
      `}</style>
      <div className="trend-chart-empty">
        <h2 className="trend-chart-empty-heading">Health Score Trend</h2>
        <p className="trend-chart-empty-text">
          Complete {scansNeeded} more scan{scansNeeded !== 1 ? "s" : ""} to see your health score
          trend.
        </p>
        <s-button
          variant="secondary"
          onClick={onStartScan}
          {...(isSubmitting ? { loading: true } : {})}
          {...(scanDisabled ? { disabled: true } : {})}
        >
          {isSubmitting ? "Starting..." : "Start New Scan"}
        </s-button>
      </div>
    </>
  );
}
