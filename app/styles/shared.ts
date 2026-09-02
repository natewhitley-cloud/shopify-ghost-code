/**
 * Shared design tokens and style constants for Ghost Code.
 *
 * Single source of truth for all colors, typography, spacing, and layout
 * utilities used across routes and components.
 *
 * PROVENANCE: This design system is a deliberate copy of ClearSignal
 * (`bot-analytics-cleanup-app`) `app/styles/shared.ts` v2 @ `df840fd`.
 * Resync from ClearSignal before diverging; drift here is what made this
 * file go stale before.
 *
 * NOTE: This file must NOT use the `.server.ts` suffix — routes with client
 * exports import from here and cannot import `.server.ts` modules.
 *
 * NOTE: Polaris CSS custom properties (`var(--p-*)`) do not resolve inside the
 * App Bridge iframe. All values are explicit hex strings or pixel values.
 */

// ---------------------------------------------------------------------------
// Semantic status colors
// ---------------------------------------------------------------------------

/** Errors, high severity, health score 0–49 */
export const COLOR_CRITICAL = "#d72c0d";
/** Caution, medium severity, health score 50–79 */
// Darkened from the WARN_TEXT tile tint (#916a00) to reach AA (≥4.5:1 on white).
export const COLOR_WARNING = "#8a6600";
/** Healthy, low severity, health score 80–100 */
// Also serves as the SUCCESS tile-tint text; AA-compliant (≥4.5:1 on white).
export const COLOR_SUCCESS = "#1a8a3f";
/** Informational, low-severity findings, links, current-plan highlight */
export const COLOR_INFO = "#2c6ecb";

// ---------------------------------------------------------------------------
// Forensic Slate accent (brand accent — NOT semantic status)
// ---------------------------------------------------------------------------
// Ghost Code's brand accent: a cool desaturated blue-grey. Drives card rails,
// section headers, chart bar fills, links, and primary buttons. These are the
// app's identity colors and must never stand in for status semantics (use the
// COLOR_* / tint tokens above for that).

/** Primary accent (7.0:1 on white, passes WCAG AA) */
export const ACCENT_FILL = "#3d5a80";
/** Accent text / darker variant */
export const ACCENT_INK = "#2c4562";
/** Accent-tinted subdued text */
export const ACCENT_SUB = "#5b6675";
/** Accent tint background for badges/pills */
export const ACCENT_TINT = "#eaeff6";
/** Accent border */
export const ACCENT_BORDER = "#cdd8e8";

// ---------------------------------------------------------------------------
// Branded shell (tinted-ground + floating-card surfaces)
// ---------------------------------------------------------------------------
// Ground and hairline tokens for the accent-tinted page shell that floats
// white cards above a subtly colored panel.

/** Tinted page ground behind cards */
export const GROUND = "#eef1f5";
/** Border around the ground panel */
export const GROUND_BORDER = "#e0e6ee";
/** Card hairline / accent-tinted divider */
export const HAIRLINE = "#e2e7ee";
/** Unfilled track for accent bar charts */
export const BAR_TRACK = "#e3e9f1";

/** Forensic Slate top-rail: a 3px single-accent bar across the top of each
 * branded page, fading to transparent at both ends. GC is monochrome (one
 * accent), so unlike ClearSignal's two-color rail this is a single-hue fade. */
export const hairline: React.CSSProperties = {
  height: "3px",
  borderRadius: "2px",
  background: `linear-gradient(90deg, transparent, ${ACCENT_FILL} 20%, ${ACCENT_FILL} 80%, transparent)`,
};

/** Branded page shell: the muted-slate ground that a page body sits on. White
 * cards/tiles float on top of it. */
export const groundStyle: React.CSSProperties = {
  background: GROUND,
  borderRadius: "14px",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

// ---------------------------------------------------------------------------
// Text colors
// ---------------------------------------------------------------------------

/** Body text, numbers, headings */
export const TEXT_PRIMARY = "#202223";
/** Secondary labels, helper text, descriptions */
export const TEXT_SUBDUED = "#6d7175";
/** Disabled states, tertiary info */
export const TEXT_DISABLED = "#8c9196";

// ---------------------------------------------------------------------------
// Surface and border colors
// ---------------------------------------------------------------------------

/** Card backgrounds, page surface */
export const BG_WHITE = "#ffffff";
/** Table headers, sub-cards, alternate backgrounds */
export const BG_SURFACE = "#f6f6f7";
/** Table row hover, interactive hover states */
export const BG_HOVER = "#f1f2f3";

export const TABLE_BG_HEADER = "#f6f6f7";
export const TABLE_BG_STRIPE = "#fafafa";
/** Alternate table row background — slightly off-white, used for even-row striping */
export const BG_SURFACE_ALT = "#fafbfb";
/** Card borders, table header bottom borders, dividers */
export const TABLE_BORDER = "#e1e3e5";
/** Table cell separators, subtle dividers */
export const TABLE_BORDER_LIGHT = "#edeeef";
export const BORDER_DEFAULT = "#e1e3e5";
/** Stronger border — table header bottom border, native form input borders */
export const BORDER_STRONG = "#c9cccf";

// ---------------------------------------------------------------------------
// Status tint colors (backgrounds for stat tiles, badges, alert backgrounds)
// ---------------------------------------------------------------------------

// Flat semantic tint tokens (border/bg pairs + explicit warning text).
// Mirrors ClearSignal's flat token shape. Text for critical/success/info reuses
// the semantic COLOR_* tokens (identical values); warning keeps a distinct
// WARN_TEXT because it intentionally diverges from COLOR_WARNING.
export const CRIT_BD = "#fde8e8";
export const CRIT_BG = "#fef6f6";
export const WARN_BD = "#fdf0cd";
export const WARN_BG = "#fffcf2";
export const WARN_TEXT = "#916a00";
export const SUCCESS_BD = "#c8e6c1";
export const SUCCESS_BG = "#f1f8ef";
export const INFO_BD = "#b4d5fe";
export const INFO_BG = "#f5f8ff";

/**
 * Success badge / pill-label background.
 * Used for the "NEW" badge, health-score success labels, and scan-tile
 * success labels. Slightly darker green tint than SUCCESS_BG.
 */
export const BG_BADGE_SUCCESS = "#e3f1df";

// ---------------------------------------------------------------------------
// Typography constants
// ---------------------------------------------------------------------------

/**
 * Standardized section header: 18px/600 weight, consistent across all pages.
 * Use above <s-card> or <div style={sectionCard}> containers.
 */
export const sectionHeader: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  marginBottom: "12px",
};

/**
 * Hero stat number: 48px/700 weight, used for the health score on the
 * dashboard. Letter-spacing of -2px is intentional at this size only.
 */
export const heroStat: React.CSSProperties = {
  fontSize: "48px",
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: "-2px",
};

/**
 * Large stat number (24px): used for finding counts in stat tiles that are
 * not the primary hero (e.g. severity count tiles on the scan detail page).
 */
export const statNumber: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  lineHeight: 1,
};

// ---------------------------------------------------------------------------
// Card and layout constants
// ---------------------------------------------------------------------------

/**
 * White card container. Use for Settings-style sections where <s-section>
 * spacing is unreliable. Standard card with subtle shadow.
 */
export const sectionCard: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "16px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};

// ---------------------------------------------------------------------------
// Subdued text helpers
// ---------------------------------------------------------------------------

/** 14px subdued — default body-level secondary text */
export const textSubdued: React.CSSProperties = {
  color: "#6d7175",
  fontSize: "14px",
};

/** 13px subdued — table headers, secondary labels, helper text */
export const textSubduedSm: React.CSSProperties = {
  color: "#6d7175",
  fontSize: "13px",
};

/** 16px subdued — larger secondary labels */
export const textSubduedLg: React.CSSProperties = {
  color: "#6d7175",
  fontSize: "16px",
};

// ---------------------------------------------------------------------------
// Reusable style utilities
// ---------------------------------------------------------------------------

export const styles = {
  /** Flex row with centered items and configurable gap (default 8px) */
  flexRow: (gap = "8px"): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap,
  }),

  /** Flex column layout with configurable gap (default 8px) */
  flexColumn: (gap = "8px"): React.CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    gap,
  }),

  /** Standard table — use with tableHeader and tableCell */
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "14px",
  } as React.CSSProperties,

  /** Table header cell — sticky-ready, uses BG_SURFACE and TABLE_BORDER */
  tableHeader: {
    textAlign: "left" as const,
    padding: "8px 12px",
    borderBottom: `2px solid ${TABLE_BORDER}`,
    fontWeight: 600,
    fontSize: "13px",
    backgroundColor: TABLE_BG_HEADER,
  } as React.CSSProperties,

  /** Table data cell — subtle bottom border, top-aligned */
  tableCell: {
    padding: "8px 12px",
    borderBottom: `1px solid ${TABLE_BORDER_LIGHT}`,
    verticalAlign: "top",
  } as React.CSSProperties,

  /**
   * Scan history table cell — wider padding for the scan history page
   * which uses a "comfortable" density rather than the default "compact".
   */
  tableCellComfortable: {
    padding: "12px 16px",
    borderBottom: `1px solid ${TABLE_BORDER_LIGHT}`,
    verticalAlign: "top",
  } as React.CSSProperties,

  /** Filter bar — horizontal bar above tables/charts */
  filterBar: {
    display: "flex",
    gap: "16px",
    alignItems: "flex-end",
    marginBottom: "16px",
    flexWrap: "wrap",
  } as React.CSSProperties,

  /** Pagination bar — centered, above or below a table */
  paginationBar: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: "16px",
    marginTop: "16px",
  } as React.CSSProperties,

  /** Chart legend item container — swatch + label */
  legendItem: (): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "4px",
  }),

  /** Chart legend color swatch — 12×12px square with 2px radius */
  legendSwatch: (color: string): React.CSSProperties => ({
    width: "12px",
    height: "12px",
    backgroundColor: color,
    borderRadius: "2px",
  }),

  /**
   * Inline severity badge span — reliable colored badge for severity indicators.
   * Use when <s-badge tone="..."> color fallback is not acceptable.
   *
   * Example:
   *   <span style={styles.severityBadge("HIGH")}>HIGH</span>
   */
  severityBadge: (severity: "HIGH" | "MEDIUM" | "LOW"): React.CSSProperties => {
    const tintMap = {
      HIGH: { border: CRIT_BD, text: COLOR_CRITICAL },
      MEDIUM: { border: WARN_BD, text: WARN_TEXT },
      LOW: { border: INFO_BD, text: COLOR_INFO },
    };
    const tint = tintMap[severity];
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "4px",
      fontSize: "12px",
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.5px",
      backgroundColor: tint.border,
      color: tint.text,
    };
  },

  /**
   * "NEW" diff badge used in the findings table to mark new findings.
   * Green background, matches COLOR_SUCCESS text color.
   */
  newBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: BG_BADGE_SUCCESS,
    color: "#1a8a3f",
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    lineHeight: "16px",
  } as React.CSSProperties,

  /**
   * "TRACKING" badge used in the findings table for tracker app findings.
   * Red background using the critical tint colors.
   */
  trackerBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: CRIT_BD,
    color: COLOR_CRITICAL,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    lineHeight: "16px",
  } as React.CSSProperties,

  /**
   * "VISUAL" badge used in the findings table for findings that produce
   * visible elements in the storefront (things shoppers can see).
   * Warm amber background to contrast with the red TRACKING badge.
   */
  visualBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: WARN_BD,
    color: WARN_TEXT,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    lineHeight: "16px",
  } as React.CSSProperties,

  /**
   * "HIGH CONFIDENCE" badge for signature-matched findings (detected via a
   * known app-signature match). Calm info-blue tint, kept subordinate to the
   * severity badge.
   */
  signatureBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: INFO_BD,
    color: COLOR_INFO,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    lineHeight: "16px",
  } as React.CSSProperties,

  /**
   * "HEURISTIC" badge for structurally-inferred findings (no app-signature
   * match required), which are more false-positive-prone and worth a review.
   * Neutral grey outline so it reads as metadata, not an alarm.
   */
  heuristicBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: BG_SURFACE,
    color: TEXT_SUBDUED,
    border: `1px solid ${BORDER_STRONG}`,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    lineHeight: "16px",
  } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------------
// CSS string helpers (for <style> blocks and FINDINGS_TABLE_STYLES constants)
// ---------------------------------------------------------------------------

/**
 * Generates compact HTML-table CSS for the given class name.
 *
 * Covers the common base used by the findings table, app-impact-map table,
 * and unknown-scripts table: dimensions, th/td borders and padding, header
 * background, and even-row striping.
 *
 * The findings table extends this with sticky positioning, a stronger header
 * bottom border, hover styling, and per-column widths — add those rules after
 * calling this helper.
 *
 * Usage:
 *   const FINDINGS_TABLE_STYLES = `
 *     ${htmlTableCss("findings-table")}
 *     .findings-table thead th { position: sticky; top: 0; border-bottom: 2px solid ${BORDER_STRONG}; }
 *     ...
 *   `;
 */
export function htmlTableCss(className: string): string {
  return `
  .${className} {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .${className} th,
  .${className} td {
    border: 1px solid ${TABLE_BORDER};
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
  }
  .${className} thead th {
    background: ${TABLE_BORDER_LIGHT};
    font-weight: 600;
  }
  .${className} tbody tr:nth-child(even) {
    background: ${BG_SURFACE_ALT};
  }`.trim();
}

/**
 * Generates status-tint variant CSS for a tile or card component.
 * Produces three rules — success, warning, critical — each applying the
 * appropriate tint border-color and background.
 *
 * Usage (dashboard health tile):
 *   tileStatusTintCss({
 *     success: "health-score-tile--success",
 *     warning: "health-score-tile--warning",
 *     critical: "health-score-tile--critical",
 *   })
 *
 * Usage (scan detail health tile):
 *   tileStatusTintCss({
 *     success: "scan-tile--health-success",
 *     warning: "scan-tile--health-warning",
 *     critical: "scan-tile--health-critical",
 *   })
 */
export function tileStatusTintCss(classNames: {
  success: string;
  warning: string;
  critical: string;
}): string {
  return `
  .${classNames.success} { border-color: ${SUCCESS_BD}; background: ${SUCCESS_BG}; }
  .${classNames.warning} { border-color: ${WARN_BD}; background: ${WARN_BG}; }
  .${classNames.critical} { border-color: ${CRIT_BD}; background: ${CRIT_BG}; }`.trim();
}
