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
   * Security risks in `total` (gc-q5z8): every malicious finding the scan
   * found (ignored or not, like the total) plus the non-ignored affected-app
   * advisories. The subtitle names them ("13 findings, 1 security risk").
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
}

export function buildFindingsTile({
  filteredTotal,
  maliciousFound,
  maliciousKept,
  advisoryKept = 0,
}: FindingsTileInput): FindingsTile {
  // Clamped: the two counts come from separate reads, and a stale one must
  // never pull the number below the ignore-filtered total.
  const maliciousIgnored = Math.max(0, maliciousFound - maliciousKept);
  const total = filteredTotal + maliciousIgnored;
  const securityRisks = maliciousFound + Math.max(0, advisoryKept);
  // A security risk (malicious code, or an app named in a security incident,
  // gc-q5z8) turns the tile red.
  const tone: FindingsTileTone =
    securityRisks > 0 ? "critical" : total === 0 ? "success" : "warning";
  return { total, tone, securityRisks };
}
