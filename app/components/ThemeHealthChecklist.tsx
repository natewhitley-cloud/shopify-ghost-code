import { Link } from "react-router";

import { partitionHealthRows } from "../lib/theme-health";
import type { HealthRow, HealthStatus } from "../lib/theme-health";
import {
  sectionCard,
  sectionHeader,
  TABLE_BORDER_LIGHT,
  TEXT_PRIMARY,
  textSubduedSm,
} from "../styles/shared";

export const THEME_HEALTH_HEADING = "Theme health";
export const THEME_HEALTH_INTRO =
  "What your last scan checked in your theme, and what each check found.";

type BadgeTone = "success" | "caution" | "critical" | "info" | "neutral";

const STATUS_TONE: Record<HealthStatus, BadgeTone> = {
  issues: "caution",
  clean: "success",
  partial: "neutral",
  not_checked: "neutral",
  info: "info",
};

/** Malicious code is the one row whose findings are critical, not a caution. */
function rowTone(row: HealthRow): BadgeTone {
  return row.key === "malicious" && row.status === "issues" ? "critical" : STATUS_TONE[row.status];
}

/**
 * One row: the label (the link to its findings when there are any), ONE
 * secondary line, and the status badge on the right. The line is the row's
 * cost or gap (`cost`: 14px primary, so it reads as the finding) or what the
 * row checks (subdued helper text).
 */
function Row({
  row,
  line,
  cost = false,
  first,
}: {
  row: HealthRow;
  line: string;
  cost?: boolean;
  first: boolean;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "16px",
        padding: "8px 0",
        ...(first ? {} : { borderTop: `1px solid ${TABLE_BORDER_LIGHT}` }),
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: TEXT_PRIMARY }}>
          {row.href ? (
            <Link to={row.href} aria-label={`View findings: ${row.label}`}>
              {row.label}
            </Link>
          ) : (
            row.label
          )}
        </h3>
        <div
          style={{
            ...(cost ? { fontSize: "14px", color: TEXT_PRIMARY } : textSubduedSm),
            marginTop: "2px",
            wordBreak: "break-word",
          }}
        >
          {line}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        <s-badge tone={rowTone(row)}>{row.statusLabel}</s-badge>
      </div>
    </li>
  );
}

/**
 * Theme health checklist (gc-i6du): a compact row per check that needs a look
 * (anything found, partly checked or not checked), plus malicious code, the
 * theme's type and version and the unpublished themes, which always show. Each
 * row has one secondary line: its cost or gap when there is one, otherwise
 * what it checks. The other clean checks fold into a closed "Clean:" group
 * that NAMES them and opens to show what each one covered
 * (partitionHealthRows decides; a row that is not clean never folds).
 * Deliberately a plain list: NO score, grade, percentage, count of clean
 * checks or "x of y" summary (the 0-100 health score was removed in gc-k2ub).
 *
 * The rows carry counts and fixed copy only (app/lib/theme-health.ts), so the
 * same markup is safe on every plan; findings open on the scan page, where the
 * plan's own gating applies.
 *
 * Accessibility: a labelled region with a real heading and lists; the fold is
 * a native details element, so it needs no script. Not a live region: Home
 * revalidates every 3s while a scan runs.
 */
export function ThemeHealthChecklist({ rows = [] }: { rows?: readonly HealthRow[] }) {
  if (rows.length === 0) return null;
  const { visible, folded } = partitionHealthRows(rows);
  return (
    <section aria-labelledby="theme-health-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 id="theme-health-heading" style={{ ...sectionHeader, margin: 0 }}>
        {THEME_HEALTH_HEADING}
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 8px" }}>{THEME_HEALTH_INTRO}</p>
      {visible.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {visible.map((row, i) => (
            <Row
              key={row.key}
              row={row}
              line={row.detail ?? row.checks}
              cost={row.detail != null}
              first={i === 0}
            />
          ))}
        </ul>
      )}
      {folded.length > 0 && (
        <details
          style={visible.length > 0 ? { borderTop: `1px solid ${TABLE_BORDER_LIGHT}` } : undefined}
        >
          <summary style={{ ...textSubduedSm, padding: "8px 0", cursor: "pointer" }}>
            {`Clean: ${folded.map((row) => row.label).join(", ")}`}
          </summary>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {folded.map((row, i) => (
              <Row key={row.key} row={row} line={row.checks} first={i === 0} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
