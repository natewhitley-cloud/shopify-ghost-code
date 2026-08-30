/**
 * Shared design tokens and style constants for Ghost Code.
 *
 * Single source of truth for all colors, typography, spacing, and layout
 * utilities used across routes and components.
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
export const COLOR_WARNING = "#b98900";
/** Healthy, low severity, health score 80–100 */
export const COLOR_SUCCESS = "#008060";
/** Informational, low-severity findings, links, current-plan highlight */
export const COLOR_INFO = "#2c6ecb";

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

/**
 * Per-status border, background, and text colors.
 * Used for severity stat tiles, health score tiles, and inline badge spans.
 *
 * Usage:
 *   border: `1px solid ${STATUS_TINTS.critical.border}`
 *   background: STATUS_TINTS.critical.bg
 *   color: STATUS_TINTS.critical.text
 */
export const STATUS_TINTS = {
  critical: { border: "#fde8e8", bg: "#fef6f6", text: "#d72c0d" },
  warning: { border: "#fdf0cd", bg: "#fffcf2", text: "#916a00" },
  success: { border: "#c8e6c1", bg: "#f1f8ef", text: "#1a8a3f" },
  info: { border: "#b4d5fe", bg: "#f5f8ff", text: "#2c6ecb" },
} as const;

/**
 * Success badge / pill-label background.
 * Used for the "NEW" badge, health-score success labels, and scan-tile
 * success labels. Slightly darker green tint than STATUS_TINTS.success.bg.
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
   * Stat tile container — centered, bordered, tintable.
   * Apply STATUS_TINTS border/bg on top of these base styles for colored variants.
   */
  statTile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px 16px",
    borderRadius: "12px",
    border: `1px solid ${BORDER_DEFAULT}`,
    textAlign: "center",
  } as React.CSSProperties,

  /**
   * Inline severity badge span — reliable colored badge for severity indicators.
   * Use when <s-badge tone="..."> color fallback is not acceptable.
   *
   * Example:
   *   <span style={styles.severityBadge("HIGH")}>HIGH</span>
   */
  severityBadge: (severity: "HIGH" | "MEDIUM" | "LOW"): React.CSSProperties => {
    const tintMap = {
      HIGH: STATUS_TINTS.critical,
      MEDIUM: STATUS_TINTS.warning,
      LOW: STATUS_TINTS.info,
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
   * Green background, matches STATUS_TINTS.success text color.
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
   * Red background using STATUS_TINTS.critical colors.
   */
  trackerBadge: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "4px",
    background: STATUS_TINTS.critical.border,
    color: STATUS_TINTS.critical.text,
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
    background: STATUS_TINTS.warning.border,
    color: STATUS_TINTS.warning.text,
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
    background: STATUS_TINTS.info.border,
    color: STATUS_TINTS.info.text,
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
 * appropriate STATUS_TINTS border-color and background.
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
  .${classNames.success} { border-color: ${STATUS_TINTS.success.border}; background: ${STATUS_TINTS.success.bg}; }
  .${classNames.warning} { border-color: ${STATUS_TINTS.warning.border}; background: ${STATUS_TINTS.warning.bg}; }
  .${classNames.critical} { border-color: ${STATUS_TINTS.critical.border}; background: ${STATUS_TINTS.critical.bg}; }`.trim();
}
