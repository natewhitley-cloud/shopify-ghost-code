import { groupHealthRows } from "../lib/theme-health";
import type { HealthRow } from "../lib/theme-health";
import { sectionCard, sectionHeader, TEXT_PRIMARY, textSubduedSm } from "../styles/shared";

export const THEME_HEALTH_HEADING = "Theme health";
export const THEME_HEALTH_INTRO = "What your last scan checked, beyond the findings above.";

const GROUP_LABEL_THEME = "Theme";
const GROUP_LABEL_CLEAN = "Clean";
const GROUP_LABEL_NOT_CHECKED = "Not checked";
/** Used when any gap is partial: part of that check ran and found nothing. */
const GROUP_LABEL_NOT_FULLY_CHECKED = "Not fully checked";

const primaryLine: React.CSSProperties = {
  fontSize: "14px",
  color: TEXT_PRIMARY,
  wordBreak: "break-word",
};
const secondaryLine: React.CSSProperties = {
  ...textSubduedSm,
  marginTop: "2px",
  wordBreak: "break-word",
};

/**
 * The theme row as one line: "Dawn 15.2.0 by Shopify · Online Store 2.0" for a
 * detected (or undetected) type. A vintage theme and a theme that was not
 * checked already carry a full sentence in `detail`, shown as it is.
 */
function themeLine(row: HealthRow): string | null {
  if (row.status === "clean" || row.status === "info") {
    return [row.detail, row.statusLabel].filter(Boolean).join(" · ");
  }
  return row.detail;
}

/**
 * One labelled group: the label on the left, its content on the right. The
 * content wraps under the label when the two do not fit side by side, so a
 * narrow screen stacks them with no overflow.
 */
function Group({
  label,
  first,
  children,
}: {
  label: string;
  first: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "2px 16px",
        ...(first ? {} : { marginTop: "12px" }),
      }}
    >
      <dt style={{ ...textSubduedSm, fontWeight: 600, flex: "0 0 120px", lineHeight: "20px" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, flex: "1 1 240px", minWidth: 0, lineHeight: "20px" }}>{children}</dd>
    </div>
  );
}

/**
 * Theme health on Home (gc-i6du): a slim strip of what the last scan checked
 * that the consequence lanes above it cannot show. Three labelled groups, each
 * left out when it is empty (and the whole section when all three are):
 *   - Theme: the theme's name, version and type, and the theme library.
 *   - Clean: the NAMES of the checks that ran in full and found nothing.
 *   - Not checked / Not fully checked: each check that did not (fully) run,
 *     with the reason.
 * A check that FOUND something is not here at all: its findings are in the
 * lanes, and repeating them would duplicate the card above. groupHealthRows
 * decides the groups; only a row whose status is exactly "clean" is named
 * under Clean.
 *
 * Deliberately names only: NO score, grade, percentage, count of clean checks
 * or "x of y" summary (the 0-100 health score was removed in gc-k2ub).
 *
 * The rows carry counts and fixed copy only (app/lib/theme-health.ts), so the
 * same markup is safe on every plan.
 *
 * Accessibility: a labelled region with a real heading and a description
 * list. Not a live region: Home revalidates every 3s while a scan runs.
 */
export function ThemeHealthChecklist({ rows = [] }: { rows?: readonly HealthRow[] }) {
  const { theme, unpublished, clean, gaps, hasPartial } = groupHealthRows(rows);
  const themeText = theme ? themeLine(theme) : null;
  const unpublishedText = unpublished?.detail ?? null;
  const hasTheme = Boolean(themeText) || Boolean(unpublishedText);
  if (!hasTheme && clean.length === 0 && gaps.length === 0) return null;
  return (
    <section aria-labelledby="theme-health-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 id="theme-health-heading" style={{ ...sectionHeader, margin: 0 }}>
        {THEME_HEALTH_HEADING}
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 12px" }}>{THEME_HEALTH_INTRO}</p>
      <dl style={{ margin: 0 }}>
        {hasTheme && (
          <Group label={GROUP_LABEL_THEME} first>
            {themeText && <div style={primaryLine}>{themeText}</div>}
            {unpublishedText && (
              <div style={themeText ? secondaryLine : { ...secondaryLine, marginTop: 0 }}>
                {unpublishedText}
              </div>
            )}
          </Group>
        )}
        {clean.length > 0 && (
          <Group label={GROUP_LABEL_CLEAN} first={!hasTheme}>
            <div style={primaryLine}>{clean.map((row) => row.label).join(", ")}</div>
          </Group>
        )}
        {gaps.length > 0 && (
          <Group
            label={hasPartial ? GROUP_LABEL_NOT_FULLY_CHECKED : GROUP_LABEL_NOT_CHECKED}
            first={!hasTheme && clean.length === 0}
          >
            {gaps.map((row, i) => (
              <div key={row.key} style={i > 0 ? { marginTop: "8px" } : undefined}>
                <div style={primaryLine}>{row.label}</div>
                {row.detail && <div style={secondaryLine}>{row.detail}</div>}
              </div>
            ))}
          </Group>
        )}
      </dl>
    </section>
  );
}
