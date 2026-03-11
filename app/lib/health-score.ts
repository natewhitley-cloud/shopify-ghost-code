/**
 * Theme Health Score
 *
 * Pure, client-safe module — no DB access, no server imports.
 *
 * Formula:
 *   rawDeduction = HIGH × 15 + MEDIUM × 7 + LOW × 3
 *   normalizedDeduction = rawDeduction / totalFilesScanned × 100
 *   score = max(0, min(100, 100 - normalizedDeduction))
 *
 * When totalFilesScanned === 0, there is nothing to deduct from, so we
 * return 100 (a theme with no files has no ghost code by definition).
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
  HIGH: 15,
  MEDIUM: 7,
  LOW: 3,
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
 * Compute the Theme Health Score from finding severity counts and the total
 * number of files scanned.
 *
 * Edge cases:
 * - totalFilesScanned === 0: returns score 100 (no files = no ghost code possible)
 * - all finding counts === 0: returns score 100 (clean theme)
 * - rawDeduction > totalFilesScanned × 100: floored at 0
 */
export function computeHealthScore(
  findings: SeverityCounts,
  totalFilesScanned: number,
): HealthScoreResult {
  if (totalFilesScanned === 0) {
    return { score: 100, ...scoreToBand(100) };
  }

  const rawDeduction =
    findings.HIGH * DEDUCTION_WEIGHTS.HIGH +
    findings.MEDIUM * DEDUCTION_WEIGHTS.MEDIUM +
    findings.LOW * DEDUCTION_WEIGHTS.LOW;

  // Normalize by file count so large themes aren't unfairly penalized.
  const normalizedDeduction = (rawDeduction / totalFilesScanned) * 100;

  const score = Math.max(0, Math.min(100, Math.round(100 - normalizedDeduction)));

  return { score, ...scoreToBand(score) };
}
