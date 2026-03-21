/**
 * Permission risk scoring for installed Shopify apps.
 *
 * Scores each app 0-100 based on three factors:
 *   1. Scope count — more scopes = higher baseline (diminishing returns)
 *   2. Scope sensitivity — CRITICAL scopes weigh far more than LOW ones
 *   3. Category mismatch — scopes unexpected for the app's category amplify risk
 *
 * Design principle: scores are based only on what we can confirm (granted scopes,
 * sensitivity levels, category expectations). Inactivity is NOT factored in
 * because it's unmeasurable.
 */

import {
  ScopeSensitivity,
  getUnexpectedScopes,
  getScopeSensitivity,
} from "../data/category-permissions.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskFactor = {
  /** Human-readable explanation, e.g. "Holds 3 unexpected scopes for this category" */
  description: string;
  /** How much this factor contributed to the final score (before clamping) */
  impact: number;
};

export type AppRiskScore = {
  /** 0-100 risk score */
  score: number;
  /** Bucketed risk level */
  level: RiskLevel;
  /** Human-readable explanations of what drove the score */
  factors: RiskFactor[];
};

export type StoreRiskScore = {
  /** 0-100 aggregate store risk score */
  score: number;
  /** Bucketed risk level */
  level: RiskLevel;
  /** Total number of apps scored */
  appCount: number;
  /** Apps with critical risk level */
  criticalApps: number;
  /** Apps with high risk level */
  highApps: number;
  /** Top 3 store-wide risk concerns */
  topRiskFactors: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sensitivity weights — CRITICAL scopes count 4x more than LOW */
const SENSITIVITY_WEIGHT: Record<ScopeSensitivity, number> = {
  [ScopeSensitivity.LOW]: 1,
  [ScopeSensitivity.MEDIUM]: 2,
  [ScopeSensitivity.HIGH]: 3,
  [ScopeSensitivity.CRITICAL]: 4,
};

/**
 * Maximum raw weighted score before normalization. Calibrated so that a
 * realistic worst case (e.g. 10 scopes all CRITICAL) maps to ~100.
 * Using log-based diminishing returns on scope count, the raw contribution
 * is weight * (1 + ln(count_at_that_level)). For 10 CRITICAL scopes:
 * 4 * (1 + ln(10)) ≈ 4 * 3.3 ≈ 13.2, plus mismatch multiplier of 2x ≈ 26.4.
 * We set MAX_RAW = 25 so that extreme cases hit the ceiling.
 */
const MAX_RAW_SCORE = 25;

/** Mismatch multiplier — unexpected scopes amplify their weighted contribution */
const MISMATCH_MULTIPLIER = 2.0;

// ---------------------------------------------------------------------------
// Risk level thresholds
// ---------------------------------------------------------------------------

export function riskLevelFromScore(score: number): RiskLevel {
  if (score <= 25) return "low";
  if (score <= 50) return "medium";
  if (score <= 75) return "high";
  return "critical";
}

// ---------------------------------------------------------------------------
// Per-app scoring
// ---------------------------------------------------------------------------

/**
 * Score a single app's permission risk.
 *
 * @param grantedScopes - OAuth scopes the app holds
 * @param categorySlug  - App Store category slug, or null if unknown
 */
export function scoreApp(grantedScopes: string[], categorySlug: string | null): AppRiskScore {
  if (grantedScopes.length === 0) {
    return { score: 0, level: "low", factors: [] };
  }

  const factors: RiskFactor[] = [];
  let rawScore = 0;

  // --- Factor 1: scope sensitivity (with diminishing returns per level) ---
  const countByLevel = countScopesByLevel(grantedScopes);
  let sensitivityScore = 0;

  for (const [level, count] of Object.entries(countByLevel)) {
    if (count === 0) continue;
    const weight = SENSITIVITY_WEIGHT[level as ScopeSensitivity];
    // Diminishing returns: weight * (1 + ln(count))
    const contribution = weight * (1 + Math.log(count));
    sensitivityScore += contribution;
  }

  if (sensitivityScore > 0) {
    const levelSummary = formatLevelSummary(countByLevel);
    factors.push({
      description: `Holds ${grantedScopes.length} scope${grantedScopes.length !== 1 ? "s" : ""} (${levelSummary})`,
      impact: round(sensitivityScore),
    });
    rawScore += sensitivityScore;
  }

  // --- Factor 2: category mismatch amplification ---
  if (categorySlug !== null) {
    const unexpected = getUnexpectedScopes(categorySlug, grantedScopes);

    if (unexpected.length > 0) {
      // Calculate the additional penalty for unexpected scopes
      let mismatchPenalty = 0;
      for (const scope of unexpected) {
        const sensitivity = getScopeSensitivity(scope);
        const weight = SENSITIVITY_WEIGHT[sensitivity];
        // Each unexpected scope adds (multiplier - 1) * weight on top of its
        // base contribution (which was already counted in sensitivityScore)
        mismatchPenalty += (MISMATCH_MULTIPLIER - 1) * weight;
      }

      const criticalUnexpected = unexpected.filter(
        (s: string) => getScopeSensitivity(s) === ScopeSensitivity.CRITICAL,
      );
      const highUnexpected = unexpected.filter(
        (s: string) => getScopeSensitivity(s) === ScopeSensitivity.HIGH,
      );

      let description = `Holds ${unexpected.length} unexpected scope${unexpected.length !== 1 ? "s" : ""} for this category`;
      if (criticalUnexpected.length > 0) {
        description += ` (${criticalUnexpected.length} critical: ${criticalUnexpected.join(", ")})`;
      } else if (highUnexpected.length > 0) {
        description += ` (${highUnexpected.length} high: ${highUnexpected.join(", ")})`;
      }

      factors.push({
        description,
        impact: round(mismatchPenalty),
      });
      rawScore += mismatchPenalty;
    }
  }

  // --- Normalize to 0-100 ---
  const normalizedScore = Math.min(100, Math.round((rawScore / MAX_RAW_SCORE) * 100));

  return {
    score: normalizedScore,
    level: riskLevelFromScore(normalizedScore),
    factors,
  };
}

// ---------------------------------------------------------------------------
// Store-wide scoring
// ---------------------------------------------------------------------------

/**
 * Aggregate risk across all installed apps in a store.
 *
 * The store score is derived from the worst apps, not an average — a single
 * critical app makes the store high-risk regardless of how many safe apps exist.
 *
 * Algorithm: weighted combination of max app score (70%) and mean app score (30%).
 * This ensures one bad app dominates while many medium-risk apps still raise concern.
 */
export function scoreStore(appScores: AppRiskScore[]): StoreRiskScore {
  if (appScores.length === 0) {
    return {
      score: 0,
      level: "low",
      appCount: 0,
      criticalApps: 0,
      highApps: 0,
      topRiskFactors: [],
    };
  }

  const criticalApps = appScores.filter((a) => a.level === "critical").length;
  const highApps = appScores.filter((a) => a.level === "high").length;

  const maxScore = Math.max(...appScores.map((a) => a.score));
  const meanScore = appScores.reduce((sum, a) => sum + a.score, 0) / appScores.length;

  const storeScore = Math.min(100, Math.round(maxScore * 0.7 + meanScore * 0.3));

  // Collect top risk factors across all apps, deduplicated, sorted by impact
  const allFactors = appScores.flatMap((a) => a.factors).sort((a, b) => b.impact - a.impact);

  const seenDescriptions = new Set<string>();
  const topRiskFactors: string[] = [];
  for (const factor of allFactors) {
    if (!seenDescriptions.has(factor.description)) {
      seenDescriptions.add(factor.description);
      topRiskFactors.push(factor.description);
      if (topRiskFactors.length >= 3) break;
    }
  }

  return {
    score: storeScore,
    level: riskLevelFromScore(storeScore),
    appCount: appScores.length,
    criticalApps,
    highApps,
    topRiskFactors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countScopesByLevel(scopes: string[]): Record<ScopeSensitivity, number> {
  const counts: Record<ScopeSensitivity, number> = {
    [ScopeSensitivity.LOW]: 0,
    [ScopeSensitivity.MEDIUM]: 0,
    [ScopeSensitivity.HIGH]: 0,
    [ScopeSensitivity.CRITICAL]: 0,
  };

  for (const scope of scopes) {
    const sensitivity = getScopeSensitivity(scope);
    counts[sensitivity]++;
  }

  return counts;
}

function formatLevelSummary(counts: Record<ScopeSensitivity, number>): string {
  const parts: string[] = [];
  if (counts.CRITICAL > 0) parts.push(`${counts.CRITICAL} critical`);
  if (counts.HIGH > 0) parts.push(`${counts.HIGH} high`);
  if (counts.MEDIUM > 0) parts.push(`${counts.MEDIUM} medium`);
  if (counts.LOW > 0) parts.push(`${counts.LOW} low`);
  return parts.join(", ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
