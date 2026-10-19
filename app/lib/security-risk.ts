/**
 * Security risk banner (gc-q5z8): the merchant-facing view of the two finding
 * types that are a security risk, an app named in a public security incident
 * (APP_INCIDENT_ADVISORY) and code from a known malicious source
 * (MALICIOUS_SCRIPT), and every sentence the banner, Home's findings tile and
 * the scan page's "Total findings" note say about them.
 *
 * The views are built on the server (app/services/security-risk.server.ts),
 * where the curated lists live, and passed to the page as plain values. This
 * file is pure and client-safe: no React, no server imports.
 *
 * Copy rules (both types): facts only. An advisory states what the developer
 * (or a public report) said and what GhostCode found in the theme, never that
 * the store was affected. Plain words, no dashes.
 *
 * Which findings become a view (the caller's job, see the server builder):
 *   - Advisory: honours ignores, like the scan page's old advisory section. An
 *     ignored advisory has no banner, and is not counted as a security risk.
 *   - Malicious: shown whether or not it was ignored, like the scan page's
 *     security alert has always been (ignoring it does not take the code out
 *     of the theme). Counted the way each surface already counts it: Home's
 *     tile adds ignored malicious code back (findings-tile.ts), the scan
 *     page's ignore-filtered total does not.
 */

import { getFindingCardCopy } from "./finding-remediation";

/** One stored finding a banner is about. */
export interface SecurityRiskFinding {
  id: string;
  filename: string;
  lineNumber: number;
}

/** An app named in a public security incident (one APP_INCIDENT_ADVISORY finding). */
export interface AdvisoryRisk {
  kind: "advisory";
  finding: SecurityRiskFinding;
  /**
   * The list entry's app name, or null when the stored finding no longer
   * matches an entry (removed or reworded since the scan): the banner then
   * falls back to the stored description.
   */
  appName: string | null;
  /** "On 13 October 2026, Logbase (Selleasy's developer) reported that ...", or null (see appName). */
  report: string | null;
  /** True when the source is the developer's own statement. */
  reportedByDeveloper: boolean;
  /** The source, or null when the entry is unknown or past its review date (no link). */
  sourceUrl: string | null;
  /** What matched: an enabled app embed, or a script host in theme code. */
  signal: "embed" | "host";
  /** The matched host (host signal), or null. */
  scriptHost: string | null;
  /** The stored finding description (the fallback facts). */
  description: string;
}

/** Code from one known malicious domain (one or more MALICIOUS_SCRIPT findings). */
export interface MaliciousRisk {
  kind: "malicious";
  /** The listed domain, or null when the stored finding no longer matches an entry. */
  domain: string | null;
  /** What the domain is, from the curated list (e.g. "lookalike of the jsDelivr CDN"), or null. */
  note: string | null;
  /** The entry's own advice (a domain added in good faith), or null for the default. */
  advice: string | null;
  /** Every finding that references the domain, in theme order. Never empty. */
  findings: SecurityRiskFinding[];
  /** The first finding's stored description (the fallback facts). */
  description: string;
}

export type SecurityRisk = AdvisoryRisk | MaliciousRisk;

/** The red bar's label. */
export const SECURITY_RISK_LABEL = "Security risk";

/** The primary action (Home links to the scan page; the scan page shows the steps inline). */
export const SEE_WHAT_TO_CHECK = "See what to check";

/**
 * DOM id of a banner on the scan page: the target of Home's "See what to
 * check". An advisory's banner IS its finding on the scan page, so it carries
 * the finding's own anchor (the target of the "Start here" links too). A
 * malicious banner holds its findings' cards, which carry those anchors, so
 * the banner gets its own id.
 */
export function securityRiskAnchorId(risk: SecurityRisk): string {
  return risk.kind === "advisory"
    ? `finding-${risk.finding.id}`
    : `security-risk-${risk.findings[0].id}`;
}

/** The banner's title. Names the app, or the domain. */
export function securityRiskTitle(risk: SecurityRisk): string {
  if (risk.kind === "malicious") {
    return risk.domain
      ? `Your theme references ${risk.domain}, a domain linked to malicious code`
      : "Your theme references a domain linked to malicious code";
  }
  if (risk.appName === null) {
    return "An app in your theme was named in a security incident report";
  }
  return risk.reportedByDeveloper
    ? `${risk.appName} is in your theme, and its developer reported a security incident`
    : `${risk.appName} is in your theme, and it was named in a security incident report`;
}

/** "layout/theme.liquid, line 12" (no line for a whole-file match). */
function where(finding: SecurityRiskFinding): string {
  return finding.lineNumber > 0
    ? `${finding.filename}, line ${finding.lineNumber}`
    : finding.filename;
}

/** What GhostCode found in the theme, from the stored finding. */
export function securityRiskFound(risk: SecurityRisk): string {
  if (risk.kind === "malicious") {
    const n = risk.findings.length;
    const places = risk.findings.slice(0, 3).map(where).join("; ");
    const more = n > 3 ? `; and ${n - 3} more` : "";
    return n === 1
      ? `GhostCode found it on 1 line of your theme (${places}).`
      : `GhostCode found it on ${n} lines of your theme (${places}${more}).`;
  }
  if (risk.signal === "embed") {
    return risk.appName
      ? `Your live theme has the ${risk.appName} app embed turned on.`
      : "Your live theme has this app's embed turned on.";
  }
  const host = risk.scriptHost ? ` from ${risk.scriptHost}` : "";
  return `Your live theme loads a script${host} (${where(risk.finding)}).`;
}

/** Sentence case for a list note: "lookalike of ..." as "Lookalike of ...". */
function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** `text` ending in exactly one full stop. */
function sentenceEnd(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** The banner's body: the source's facts, what GhostCode found, and what to do. */
export function securityRiskBody(risk: SecurityRisk): string {
  if (risk.kind === "malicious") {
    // The note's grammar varies by entry ("lookalike of ...", "sold in 2024
    // and then ..."), so it stays in brackets, as in the stored description.
    const what =
      risk.domain && risk.note
        ? `GhostCode lists ${risk.domain} as a source of malicious code (${risk.note}).`
        : sentenceEnd(capitalize(risk.description));
    const advice = risk.advice
      ? sentenceEnd(risk.advice)
      : "Code like this is usually added without the store owner knowing. Remove it as soon as possible.";
    return `${what} ${securityRiskFound(risk)} ${advice}`;
  }
  const facts = risk.report ?? `${risk.description}.`;
  return `${facts} ${securityRiskFound(risk)} GhostCode can't tell whether your store was affected, so check it now. It takes about a minute.`;
}

/** The secondary link's text, or null when there is no source to link. */
export function securityRiskSourceLabel(risk: SecurityRisk): string | null {
  if (risk.kind === "malicious" || risk.sourceUrl === null) return null;
  return risk.reportedByDeveloper && risk.appName
    ? `Read ${risk.appName}'s statement`
    : "Read the report";
}

/**
 * The advisory's "What to check" steps (the card copy's checkout self-check,
 * one source with the copy action), with the last step naming the app.
 */
export function advisoryCheckSteps(risk: AdvisoryRisk): string[] {
  const steps = getFindingCardCopy("APP_INCIDENT_ADVISORY", risk.finding.filename).steps ?? [];
  if (risk.appName === null) return [...steps];
  const app = risk.appName;
  return steps.map((step) =>
    step.replace("If you no longer use the app,", `If you no longer use ${app},`),
  );
}

/** The plan line under the actions (the date is rendered beside it). */
export const SECURITY_RISK_PLAN_NOTE = "shown on every plan";

// ---------------------------------------------------------------------------
// Counts (Home's tile, the scan page's "Total findings" note)
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The findings tile's subtitle: "13 findings, 1 security risk" (without the number). */
export function findingsTileSubtitle(total: number, securityRisks: number): string {
  const findings = total === 1 ? "finding" : "findings";
  return securityRisks > 0
    ? `${findings}, ${plural(securityRisks, "security risk", "security risks")}`
    : findings;
}

/**
 * The scan page's note under "Total findings", or null when there is no
 * security risk: "13 findings: 1 security risk (above), 12 leftover items (below)."
 */
export function totalFindingsNote(total: number, securityRisks: number): string | null {
  if (securityRisks <= 0) return null;
  const leftover = Math.max(0, total - securityRisks);
  const risks = `${plural(securityRisks, "security risk", "security risks")} (above)`;
  const rest =
    leftover > 0 ? `, ${plural(leftover, "leftover item", "leftover items")} (below)` : "";
  return `${plural(total, "finding", "findings")}: ${risks}${rest}.`;
}

/**
 * Home's one line under "Most Recent Findings" when the scan found a security
 * risk, or null when it found none: "1 app security advisory, 12 leftover
 * items." (the "See all" link follows it).
 */
export function homeRiskSummaryLine(input: {
  advisories: number;
  malicious: number;
  leftover: number;
}): string | null {
  if (input.advisories <= 0 && input.malicious <= 0) return null;
  const parts: string[] = [];
  if (input.malicious > 0) {
    parts.push(
      plural(input.malicious, "piece of known malicious code", "pieces of known malicious code"),
    );
  }
  if (input.advisories > 0) {
    parts.push(plural(input.advisories, "app security advisory", "app security advisories"));
  }
  if (input.leftover > 0) parts.push(plural(input.leftover, "leftover item", "leftover items"));
  return `${parts.join(", ")}.`;
}
