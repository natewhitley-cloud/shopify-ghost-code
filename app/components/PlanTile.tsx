/**
 * PlanTile: one plan/pricing card (gc-4wvb).
 *
 * Copied with attribution from FraudPilot (`fraud-triage-app`)
 * `app/components/PlanTile.tsx` @ origin/main, restyled from GhostCode's
 * `app/styles/shared.ts` tokens only. Domain-free: it renders the plain data it
 * is handed (name, price, bullets, optional badge + CTA).
 *
 * Layout: a min-height header block (so the dividers and feature lists line up
 * across tiles whether or not one carries the badge), a divider, a flex-1
 * features area that pins the CTA to the bottom, and a min-height card. This is
 * ONE tile; the parent owns the responsive grid.
 */
import { BG_WHITE, BORDER_DEFAULT, COLOR_INFO, TEXT_PRIMARY, TEXT_SUBDUED } from "../styles/shared";

export interface PlanTileProps {
  /** Plan name shown as the tile heading (e.g. "Free"). */
  name: string;
  /** Price line, already formatted (e.g. "$9 / month"). */
  price: string;
  /** Feature bullets, already formatted for display. */
  features: readonly string[];
  /** Highlight this tile (info border + ring). */
  current?: boolean;
  /** Optional short badge (e.g. "Current plan"). */
  badge?: string;
  /** Optional call to action; `variant` defaults to primary. */
  cta?: { label: string; url: string; variant?: "primary" | "secondary" };
}

const headerStyle: React.CSSProperties = {
  minHeight: "88px",
  marginBottom: "4px",
};

const nameStyle: React.CSSProperties = {
  fontSize: "22px",
  fontWeight: 700,
  color: TEXT_PRIMARY,
  margin: 0,
};

const priceStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  color: TEXT_SUBDUED,
  margin: "4px 0 0 0",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block",
  background: COLOR_INFO,
  color: BG_WHITE,
  fontSize: "12px",
  fontWeight: 600,
  padding: "3px 10px",
  borderRadius: "12px",
  marginTop: "8px",
};

const dividerStyle: React.CSSProperties = {
  border: "none",
  borderTop: `1px solid ${BORDER_DEFAULT}`,
  margin: "16px 0",
};

export function PlanTile({ name, price, features, current = false, badge, cta }: PlanTileProps) {
  const cardStyle: React.CSSProperties = {
    background: BG_WHITE,
    borderRadius: "12px",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    minHeight: "300px",
    // Inline (not a class) so the highlight state is self-contained and testable.
    border: current ? `2px solid ${COLOR_INFO}` : `1px solid ${BORDER_DEFAULT}`,
    ...(current ? { boxShadow: `0 0 0 1px ${COLOR_INFO}` } : {}),
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <h3 style={nameStyle}>{name}</h3>
        <p style={priceStyle}>{price}</p>
        {badge ? <span style={badgeStyle}>{badge}</span> : null}
      </div>

      <hr style={dividerStyle} />

      <div style={{ flex: 1 }}>
        <s-unordered-list>
          {features.map((feature) => (
            <s-list-item key={feature}>{feature}</s-list-item>
          ))}
        </s-unordered-list>
      </div>

      {cta ? (
        // An anchor with target="_top": an `<s-button url>` does not navigate
        // out of the embedded App Bridge iframe to the Managed Pricing page.
        <div style={{ marginTop: "16px" }}>
          <a href={cta.url} target="_top" rel="noreferrer">
            <s-button variant={cta.variant ?? "primary"}>{cta.label}</s-button>
          </a>
        </div>
      ) : null}
    </div>
  );
}
