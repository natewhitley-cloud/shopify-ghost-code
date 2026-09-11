/**
 * Theme Health Score
 *
 * Pure, client-safe module — no DB access, no server imports.
 *
 * Formula (simple deduction, no normalization):
 *   score = max(0, 100 - (HIGH × 10 + MEDIUM × 5 + LOW × 1))
 *
 * Each finding deducts a fixed number of points based on its severity.
 * The score floors at 0 — it cannot go negative.
 */

export type HealthScoreResult = {
  score: number;
  label: string;
  /** Polaris badge tone string for <s-badge tone={...}> */
  tone: "success" | "info" | "warning" | "caution" | "critical";
};

type SeverityCounts = {
  HIGH: number;
  MEDIUM: number;
  LOW: number;
};

const DEDUCTION_WEIGHTS = {
  HIGH: 10,
  MEDIUM: 5,
  LOW: 1,
} as const;

/**
 * Map a numeric score to a label and Polaris badge tone.
 *
 * Bands:
 *   90-100 → Excellent / success
 *   70-89  → Good     / info
 *   50-69  → Fair     / warning
 *   25-49  → Poor     / caution
 *   0-24   → Critical / critical
 */
function scoreToBand(score: number): Pick<HealthScoreResult, "label" | "tone"> {
  if (score >= 90) return { label: "Excellent", tone: "success" };
  if (score >= 70) return { label: "Good", tone: "info" };
  if (score >= 50) return { label: "Fair", tone: "warning" };
  if (score >= 25) return { label: "Poor", tone: "caution" };
  return { label: "Critical", tone: "critical" };
}

/**
 * Compute the Theme Health Score from finding severity counts.
 *
 * Each finding deducts points from a perfect 100:
 *   HIGH × 10 + MEDIUM × 5 + LOW × 1
 *
 * The result is clamped to [0, 100].
 */
export function computeHealthScore(findings: SeverityCounts): HealthScoreResult {
  const deduction =
    findings.HIGH * DEDUCTION_WEIGHTS.HIGH +
    findings.MEDIUM * DEDUCTION_WEIGHTS.MEDIUM +
    findings.LOW * DEDUCTION_WEIGHTS.LOW;

  const score = Math.max(0, 100 - deduction);

  return { score, ...scoreToBand(score) };
}

/**
 * Per-severity diff between the current scan and the previous one, as produced
 * by the scan-detail component from a `scanDiff`. `new*` counts are findings
 * present now but absent before; `resolved*` counts are findings present before
 * but absent now.
 */
export type SeverityDiff = {
  newHigh: number;
  newMedium: number;
  newLow: number;
  resolvedHigh: number;
  resolvedMedium: number;
  resolvedLow: number;
};

/**
 * Compute the change in Theme Health Score versus the previous scan.
 *
 * Returns null when there is no previous scan to compare (`severityDiff` null).
 * Otherwise reconstructs the previous per-severity counts from the current
 * counts and the diff (previous = current - new + resolved, floored at 0) and
 * returns `currentScore - previousScore`.
 *
 * A positive delta means the score went up (health improved); negative means it
 * dropped (health regressed).
 */
export function computeHealthDelta(
  currentBySeverity: SeverityCounts,
  severityDiff: SeverityDiff | null,
): number | null {
  if (severityDiff === null) return null;

  const previous: SeverityCounts = {
    HIGH: Math.max(0, currentBySeverity.HIGH - severityDiff.newHigh + severityDiff.resolvedHigh),
    MEDIUM: Math.max(
      0,
      currentBySeverity.MEDIUM - severityDiff.newMedium + severityDiff.resolvedMedium,
    ),
    LOW: Math.max(0, currentBySeverity.LOW - severityDiff.newLow + severityDiff.resolvedLow),
  };

  return computeHealthScore(currentBySeverity).score - computeHealthScore(previous).score;
}
