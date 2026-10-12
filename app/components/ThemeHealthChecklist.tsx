import { Link } from "react-router";

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
 * Theme health checklist (gc-i6du): one row per check category, each "Clean"
 * or "N issues" with what it costs, then the theme's type and version and the
 * unpublished themes. Deliberately a plain list: NO score, grade, percentage
 * or "x of y" summary (the 0-100 health score was removed in gc-k2ub).
 *
 * The rows carry counts and fixed copy only (app/lib/theme-health.ts), so the
 * same markup is safe on every plan; findings open on the scan page, where the
 * plan's own gating applies.
 *
 * Accessibility: a labelled region with a real heading and a list. Not a live
 * region: Home revalidates every 3s while a scan runs.
 */
export function ThemeHealthChecklist({ rows = [] }: { rows?: readonly HealthRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="theme-health-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 id="theme-health-heading" style={{ ...sectionHeader, margin: 0 }}>
        {THEME_HEALTH_HEADING}
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 12px" }}>{THEME_HEALTH_INTRO}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {rows.map((row, i) => (
          <li
            key={row.key}
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "16px",
              padding: "12px 0",
              ...(i > 0 ? { borderTop: `1px solid ${TABLE_BORDER_LIGHT}` } : {}),
            }}
          >
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: TEXT_PRIMARY }}>
                {row.label}
              </h3>
              <div style={{ ...textSubduedSm, marginTop: "2px" }}>{row.checks}</div>
              {row.detail && (
                <div
                  style={{
                    fontSize: "14px",
                    color: TEXT_PRIMARY,
                    marginTop: "4px",
                    wordBreak: "break-word",
                  }}
                >
                  {row.detail}
                </div>
              )}
              {row.href && (
                <div style={{ marginTop: "4px", fontSize: "13px" }}>
                  <Link to={row.href} aria-label={`View findings: ${row.label}`}>
                    View findings
                  </Link>
                </div>
              )}
            </div>
            <div style={{ flexShrink: 0 }}>
              <s-badge tone={rowTone(row)}>{row.statusLabel}</s-badge>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
