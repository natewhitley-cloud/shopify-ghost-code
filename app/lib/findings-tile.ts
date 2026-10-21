/**
 * Home's findings tile (gc-j8xq): the number and its tone.
 *
 * Product rule: known malicious code (MALICIOUS_SCRIPT) shows regardless of
 * ignores. Every other count on Home leaves out ignored findings, so with
 * every malicious finding ignored and nothing else found the tile used to read
 * a green 0 right above Theme health's critical "Known malicious code" line.
 *
 *   total = ignore-filtered total + malicious findings the merchant ignored
 *
 * The ignore-filtered total already holds the malicious findings that are NOT
 * ignored, so only the ignored ones are added: none is counted twice, and the
 * number is never lower than the malicious count.
 *
 * Pure and client-safe: no React, no server imports.
 */

export type FindingsTileTone = "success" | "warning" | "critical";

export interface FindingsTile {
  total: number;
  tone: FindingsTileTone;
  /**
   * Distinct security risks (gc-xtno): the number of Security risk banners,
   * one per known malicious domain (ignored or not, like the total) and one
   * per non-ignored affected-app advisory. The subtitle names them ("13
   * findings, 1 security risk"); three lines on one domain are 1 risk.
   */
  securityRisks: number;
}

export interface FindingsTileInput {
  /** The scan's finding count with ignored findings left out. */
  filteredTotal: number;
  /** MALICIOUS_SCRIPT findings the scan found, ignored ones included. */
  maliciousFound: number;
  /** MALICIOUS_SCRIPT findings left after ignores (part of `filteredTotal`). */
  maliciousKept: number;
  /**
   * APP_INCIDENT_ADVISORY findings left after ignores (part of
   * `filteredTotal`). An advisory honours ignores, so an ignored one neither
   * counts nor turns the tile red. Omitted = 0.
   */
  advisoryKept?: number;
  /**
   * The distinct security risks (the banners the caller built), gc-xtno.
   * Omitted or 0 while the counts above say there is a risk (the banners
   * could not be read) = the finding count, so the subtitle never reads 0
   * risks on a red tile.
   */
  distinctRisks?: number;
}

export function buildFindingsTile({
  filteredTotal,
  maliciousFound,
  maliciousKept,
  advisoryKept = 0,
  distinctRisks = 0,
}: FindingsTileInput): FindingsTile {
  // Clamped: the two counts come from separate reads, and a stale one must
  // never pull the number below the ignore-filtered total.
  const maliciousIgnored = Math.max(0, maliciousFound - maliciousKept);
  const total = filteredTotal + maliciousIgnored;
  const riskFindings = maliciousFound + Math.max(0, advisoryKept);
  // A security risk (malicious code, or an app named in a security incident,
  // gc-q5z8) turns the tile red.
  const tone: FindingsTileTone =
    riskFindings > 0 ? "critical" : total === 0 ? "success" : "warning";
  const securityRisks = riskFindings > 0 && distinctRisks > 0 ? distinctRisks : riskFindings;
  return { total, tone, securityRisks };
}
