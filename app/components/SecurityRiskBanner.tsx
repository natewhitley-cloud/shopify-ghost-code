import type { ReactNode } from "react";
import { Link } from "react-router";

import { FormattedDate } from "./FormattedDate";
import {
  SECURITY_RISK_LABEL,
  SECURITY_RISK_PLAN_NOTE,
  SEE_WHAT_TO_CHECK,
  securityRiskAnchorId,
  securityRiskBody,
  securityRiskDateWords,
  securityRiskSourceLabel,
  securityRiskTitle,
  type SecurityRisk,
} from "../lib/security-risk";
import {
  BG_WHITE,
  COLOR_CRITICAL,
  CRIT_BD,
  CRIT_BG,
  CRIT_TEXT_STRONG,
  TEXT_PRIMARY,
  textSubduedSm,
} from "../styles/shared";

const WARNING_SIGN = "⚠";

const card: React.CSSProperties = {
  borderRadius: "12px",
  overflow: "hidden",
  border: `1px solid ${CRIT_BD}`,
  background: BG_WHITE,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  minWidth: 0,
  // Home and the scan page jump here with a hash link.
  scrollMarginTop: "16px",
};
const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "12px 20px",
  background: COLOR_CRITICAL,
  color: BG_WHITE,
  fontSize: "15px",
  fontWeight: 700,
};
const body: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "18px 20px",
  background: CRIT_BG,
  minWidth: 0,
};
const title: React.CSSProperties = {
  margin: 0,
  fontSize: "17px",
  fontWeight: 700,
  lineHeight: "22px",
  color: CRIT_TEXT_STRONG,
  overflowWrap: "anywhere",
};
const facts: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  lineHeight: "21px",
  color: TEXT_PRIMARY,
  overflowWrap: "anywhere",
};
const actions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px 16px",
};

/**
 * Security risk banner (gc-q5z8): ONE banner per app named in a security
 * incident (an APP_INCIDENT_ADVISORY finding) and per known malicious domain
 * (its MALICIOUS_SCRIPT findings), at the top of Home and of the scan page,
 * on EVERY plan (never paywalled). The copy is app/lib/security-risk.ts.
 *
 * Top to bottom: a red "Security risk" bar; the title (names the app or the
 * domain); the facts (the source's own words, its date, and what GhostCode
 * found); `children` (the scan page's inline steps or finding cards); the
 * actions; the scan date and "shown on every plan".
 *
 *   - Home passes `checkHref`: the primary "See what to check" button links to
 *     the banner on the scan page.
 *   - The scan page passes `children` (the steps are shown inline, so there is
 *     no "See what to check" button) and `actions` (Copy steps).
 *   - The source link opens the developer's statement (or the report) in a new
 *     tab; there is none for malicious code, or once an entry has expired.
 *   - `footer` sits under everything (the scan page's Ignore control).
 *
 * Accessibility: a labelled region whose name is the title; the warning sign
 * is decorative. The scan page gives it the anchor Home links to.
 */
export function SecurityRiskBanner({
  risk,
  scanDate,
  checkHref,
  anchor = false,
  children,
  actions: extraActions,
  footer,
}: {
  risk: SecurityRisk;
  /** When the scan (or, for a speed-test hit, the speed test) that found it ran. */
  scanDate: Date | string;
  /** Home: where "See what to check" goes. Omitted on the scan page. */
  checkHref?: string;
  /** Scan page: give the banner the id Home's "See what to check" targets. */
  anchor?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const id = securityRiskAnchorId(risk);
  const headingId = `${id}-title`;
  const sourceLabel = securityRiskSourceLabel(risk);
  const sourceUrl = risk.kind === "advisory" ? risk.sourceUrl : null;
  const dateWords = securityRiskDateWords(risk);
  return (
    <section id={anchor ? id : undefined} aria-labelledby={headingId} style={card}>
      <div style={bar}>
        <span aria-hidden="true">{WARNING_SIGN}</span>
        <span>{SECURITY_RISK_LABEL}</span>
      </div>
      <div style={body}>
        <h2 id={headingId} style={title}>
          {securityRiskTitle(risk)}
        </h2>
        <p style={facts}>{securityRiskBody(risk)}</p>
        {children}
        {(checkHref || extraActions || (sourceLabel && sourceUrl)) && (
          <div style={actions}>
            {checkHref && (
              <Link to={checkHref}>
                <s-button variant="primary">{SEE_WHAT_TO_CHECK}</s-button>
              </Link>
            )}
            {extraActions}
            {sourceLabel && sourceUrl && (
              // Leaves the admin: a plain anchor in a new tab, with `rel`.
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "14px" }}
              >
                {sourceLabel}
              </a>
            )}
          </div>
        )}
        <div style={{ ...textSubduedSm, overflowWrap: "anywhere" }}>
          {dateWords.before} <FormattedDate value={scanDate} /> {dateWords.after} ·{" "}
          {SECURITY_RISK_PLAN_NOTE}
        </div>
        {footer}
      </div>
    </section>
  );
}
