import { Link } from "react-router";

import {
  groupGapsByReason,
  groupHealthRows,
  themeHealthVerdict,
  HEALTH_CATEGORIES,
} from "../lib/theme-health";
import type { HealthRow, HealthVerdictTone } from "../lib/theme-health";
import {
  BG_BADGE_SUCCESS,
  COLOR_CRITICAL,
  COLOR_SUCCESS,
  COLOR_WARNING,
  CRIT_BD,
  CRIT_BG,
  CRIT_TEXT_STRONG,
  LANE_GREY_FILL,
  sectionCard,
  sectionHeader,
  SUCCESS_TEXT_STRONG,
  TEXT_PRIMARY,
  textSubduedSm,
  visuallyHidden,
  WARN_BD,
  WARN_BG,
  WARN_TEXT_STRONG,
} from "../styles/shared";

export const THEME_HEALTH_HEADING = "Theme health";
export const THEME_HEALTH_INTRO = "What your last scan checked, beyond the findings above.";

const MALICIOUS_LINK_LABEL = "View findings";
const TICK = "\u2713";

const primaryLine: React.CSSProperties = {
  fontSize: "14px",
  color: TEXT_PRIMARY,
  wordBreak: "break-word",
};
const subduedLine: React.CSSProperties = { ...textSubduedSm, wordBreak: "break-word" };

/** The blocks under the intro: one column, evenly spaced, free to shrink. */
const body: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  minWidth: 0,
};

const verdictLine: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  margin: 0,
  fontSize: "15px",
  fontWeight: 600,
  lineHeight: "20px",
  color: TEXT_PRIMARY,
};
const DOT_COLOR: Record<HealthVerdictTone, string> = {
  ok: COLOR_SUCCESS,
  neutral: LANE_GREY_FILL,
  warn: COLOR_WARNING,
  critical: COLOR_CRITICAL,
};

const chipList: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  margin: 0,
  padding: 0,
  listStyle: "none",
  minWidth: 0,
};
const chip: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "4px 10px",
  borderRadius: "999px",
  fontSize: "13px",
  fontWeight: 500,
  minWidth: 0,
  wordBreak: "break-word",
};
const chipOk: React.CSSProperties = {
  ...chip,
  background: BG_BADGE_SUCCESS,
  color: SUCCESS_TEXT_STRONG,
};
const chipWarn: React.CSSProperties = { ...chip, background: WARN_BD, color: WARN_TEXT_STRONG };
/** A check that found a security risk (gc-q5z8: an open app security advisory). */
const chipFailed: React.CSSProperties = {
  ...chip,
  background: CRIT_BD,
  color: CRIT_TEXT_STRONG,
  fontWeight: 600,
};
const WARNING_SIGN = "\u26a0";

const actionBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  minWidth: 0,
  padding: "12px 14px",
  border: `1px solid ${WARN_BD}`,
  borderLeft: `5px solid ${COLOR_WARNING}`,
  borderRadius: "8px",
  background: WARN_BG,
};

const CATEGORY_ORDER = new Map<string, number>([
  ...HEALTH_CATEGORIES.map((c, i) => [c.key, i] as const),
  // The advisory check (gc-q5z8) sits right after known malicious code.
  ["app-advisories", 0.5] as const,
]);

/**
 * How one check shows as a chip. Green ONLY for a status of exactly "clean":
 * a check that did not run, or only partly ran, is amber and never described
 * as clean. The glyph is decorative; the hidden prefix says the same in words.
 */
function chipOf(row: HealthRow): { style: React.CSSProperties; glyph: string; prefix: string } {
  if (row.status === "clean") return { style: chipOk, glyph: TICK, prefix: "Clean: " };
  if (row.status === "issues") return { style: chipFailed, glyph: WARNING_SIGN, prefix: "Found: " };
  return {
    style: chipWarn,
    glyph: "!",
    prefix: row.status === "partial" ? "Partly checked: " : "Not checked: ",
  };
}

/**
 * The theme facts, as the lines to show. A detected (or undetected) type is
 * ONE subdued line: "Dawn 15.2.0 by Shopify · Online Store 2.0 · Your store
 * has 3 themes...". A vintage theme and a theme that was not checked already
 * carry a full sentence in `detail`, shown as it is (vintage in primary ink:
 * it is the one theme fact with a consequence), with the theme library on its
 * own line under it.
 */
function themeFacts(
  theme: HealthRow | null,
  unpublished: string | null,
): Array<{ text: string; style: React.CSSProperties }> {
  if (theme && (theme.status === "clean" || theme.status === "info")) {
    const text = [theme.detail, theme.statusLabel, unpublished].filter(Boolean).join(" · ");
    return text ? [{ text, style: subduedLine }] : [];
  }
  const facts = [];
  if (theme?.detail) {
    facts.push({
      text: theme.detail,
      style: theme.status === "issues" ? primaryLine : subduedLine,
    });
  }
  if (unpublished) facts.push({ text: unpublished, style: subduedLine });
  return facts;
}

/**
 * Known malicious code with findings: the one check that found something and
 * is still shown here, first and in critical colours. Home has no malicious
 * code alert of its own, and a security finding is never hidden or played
 * down, on any plan.
 */
function MaliciousLine({ row }: { row: HealthRow }) {
  return (
    <div
      style={{
        marginBottom: "12px",
        padding: "12px",
        border: `1px solid ${CRIT_BD}`,
        borderLeft: `5px solid ${COLOR_CRITICAL}`,
        borderRadius: "8px",
        background: CRIT_BG,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px" }}>
        <s-badge tone="critical">{row.statusLabel}</s-badge>
        <strong style={{ ...primaryLine, fontWeight: 600 }}>{row.label}</strong>
        {row.href && (
          <Link to={row.href} aria-label={`${MALICIOUS_LINK_LABEL}: ${row.label}`}>
            {MALICIOUS_LINK_LABEL}
          </Link>
        )}
      </div>
      {row.detail && <div style={{ ...primaryLine, marginTop: "4px" }}>{row.detail}</div>}
    </div>
  );
}

/**
 * Theme health on Home (gc-i6du): what the last scan checked that the
 * consequence lanes above it cannot show, leading with what it means.
 * Top to bottom, each part left out when it has nothing to say (and the whole
 * section when none has):
 *   - Known malicious code with findings: a critical line (see MaliciousLine).
 *     Home passes it as `malicious`, built from the scan's count alone, so it
 *     shows even when `rows` is empty. When it shows it IS the verdict.
 *   - Verdict: a dot and one sentence (themeHealthVerdict). It says no known
 *     malicious code was found ONLY when the malicious check ran in full and
 *     found nothing. The dot is green only when, as well, every check ran in
 *     full and none found anything; grey when another check found something.
 *   - Chips: one per check that is clean (green) or did not fully run (amber).
 *     A check that FOUND something has no chip: its findings are in the lanes,
 *     and repeating them would duplicate the card above. The exception is
 *     "App security advisories" with an advisory open (gc-q5z8): a failed red
 *     chip, first, under the red verdict.
 *   - Action box: why the amber checks did not run and what to do, each
 *     distinct reason stated once under the names it applies to. No button:
 *     Home has its own scan control, and its one upgrade ask.
 *   - Theme: the theme's name, version and type, and the theme library.
 * groupHealthRows decides the groups; only a row whose status is exactly
 * "clean" is ever green.
 *
 * Deliberately names only: NO score, grade, percentage, count of checks or
 * "x of y" summary (the 0-100 health score was removed in gc-k2ub).
 *
 * The rows carry counts and fixed copy only (app/lib/theme-health.ts), so the
 * same markup is safe on every plan.
 *
 * Accessibility: a labelled region with a real heading. The dot and the chip
 * glyphs are decorative; the verdict sentence and each chip's hidden prefix
 * carry the meaning. Not a live region: Home revalidates every 3s while a
 * scan runs.
 */
export function ThemeHealthChecklist({
  rows = [],
  malicious: maliciousRow = null,
}: {
  rows?: readonly HealthRow[];
  malicious?: HealthRow | null;
}) {
  const groups = groupHealthRows(rows, maliciousRow);
  const { theme, unpublished, clean, gaps, malicious, advisory } = groups;
  const facts = themeFacts(theme, unpublished?.detail ?? null);
  // An open advisory is a failed chip, first (gc-q5z8); then every other chip
  // in category order.
  const chips = [
    ...(advisory ? [advisory] : []),
    ...[...clean, ...gaps].sort(
      (a, b) => (CATEGORY_ORDER.get(a.key) ?? 0) - (CATEGORY_ORDER.get(b.key) ?? 0),
    ),
  ];
  const hasBody = facts.length > 0 || chips.length > 0;
  if (!hasBody && !malicious) return null;
  const verdict = themeHealthVerdict(groups);
  const reasons = groupGapsByReason(gaps);
  return (
    <section aria-labelledby="theme-health-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 id="theme-health-heading" style={{ ...sectionHeader, margin: 0 }}>
        {THEME_HEALTH_HEADING}
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 12px" }}>{THEME_HEALTH_INTRO}</p>
      {malicious && <MaliciousLine row={malicious} />}
      {hasBody && (
        <div style={body}>
          {verdict && (
            <p style={verdictLine}>
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  width: "10px",
                  height: "10px",
                  marginTop: "5px",
                  borderRadius: "5px",
                  background: DOT_COLOR[verdict.tone],
                }}
              />
              <span style={{ minWidth: 0, wordBreak: "break-word" }}>{verdict.text}</span>
            </p>
          )}
          {chips.length > 0 && (
            <ul style={chipList}>
              {chips.map((row) => {
                const { style, glyph, prefix } = chipOf(row);
                return (
                  <li key={row.key} style={style}>
                    <span aria-hidden="true" style={{ fontWeight: 700 }}>
                      {glyph}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={visuallyHidden}>{prefix}</span>
                      {row.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {reasons.length > 0 && (
            <div style={actionBox}>
              {reasons.map(({ reason, labels }) => (
                <div key={reason ?? ""} style={{ minWidth: 0 }}>
                  <strong style={{ ...primaryLine, display: "block", fontWeight: 600 }}>
                    {labels.join(", ")}
                  </strong>
                  {reason && <span style={subduedLine}>{reason}</span>}
                </div>
              ))}
            </div>
          )}
          {facts.map((fact) => (
            <div key={fact.text} style={fact.style}>
              {fact.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
