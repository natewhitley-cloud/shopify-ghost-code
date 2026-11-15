/**
 * The page's value-action card (gc-np1d.2): the one thing to do, at the top of
 * Home and the scan page, for the merchant's plan and state. The model and copy
 * live in app/lib/value-action.ts; this only renders it. Rule:
 * ~/.claude/rules/merchant-ux.md.
 *
 * Buttons by action:
 *   clean_copy -> in-app link to the select page (+ click ping)
 *   diy        -> in-app link to the findings list (+ click ping)
 *   upgrade    -> top-level link to Shopify's plan page (+ upgrade click ping)
 *   plans      -> the same plan page, as a plain link
 *   scan       -> the page's own scan handler
 */
import { Link } from "react-router";

import { recordUpgradeClick } from "../lib/upgrade-preview";
import {
  recordValueActionClick,
  type ValueActionButton,
  type ValueActionCard as Card,
} from "../lib/value-action";
import {
  ACCENT_BORDER,
  ACCENT_FILL,
  ACCENT_INK,
  ACCENT_TINT,
  COLOR_INFO,
  COLOR_SUCCESS,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
} from "../styles/shared";

const UPSELL_FILL = "#7c5cff";
const UPSELL_BORDER = "#ddd5ff";
const CLEAR_BORDER = "#cfe6d3";

export type ValueActionTargets = {
  cleanCopyHref: string | null;
  diyHref: string;
  pricingPlansUrl: string;
  onScan: (() => void) | null;
  scanning?: boolean;
};

function edge(kind: Card["kind"]): { fill: string; border: string } {
  if (kind === "upsell") return { fill: UPSELL_FILL, border: UPSELL_BORDER };
  if (kind === "clear") return { fill: COLOR_SUCCESS, border: CLEAR_BORDER };
  return { fill: ACCENT_FILL, border: ACCENT_BORDER };
}

function ActionButton({
  button,
  variant,
  card,
  targets,
}: {
  button: ValueActionButton;
  variant: "primary" | "secondary";
  card: Card;
  targets: ValueActionTargets;
}) {
  const asLink = variant === "secondary";
  switch (button.action) {
    case "clean_copy":
      if (!targets.cleanCopyHref) return null;
      return (
        <Link
          to={targets.cleanCopyHref}
          onClick={() => recordValueActionClick("clean_copy_action")}
        >
          <s-button variant={variant}>{button.label}</s-button>
        </Link>
      );
    case "diy":
      return (
        <Link to={targets.diyHref} onClick={() => recordValueActionClick("clean_copy_diy")}>
          <s-button variant={variant}>{button.label}</s-button>
        </Link>
      );
    case "upgrade": {
      const src = variant === "primary" ? card.telemetryKey : card.upsellKey;
      return (
        <a
          href={targets.pricingPlansUrl}
          target="_top"
          rel="noreferrer"
          onClick={src === "clean_copy_upsell" ? () => recordUpgradeClick(src) : undefined}
          style={asLink ? { color: COLOR_INFO, fontSize: "14px", textDecoration: "none" } : {}}
        >
          {asLink ? button.label : <s-button variant={variant}>{button.label}</s-button>}
        </a>
      );
    }
    case "plans":
      return (
        <a
          href={targets.pricingPlansUrl}
          target="_top"
          rel="noreferrer"
          style={{ color: COLOR_INFO, fontSize: "14px", textDecoration: "none" }}
        >
          {button.label}
        </a>
      );
    case "scan":
      if (!targets.onScan) return null;
      return (
        <s-button
          variant={variant}
          loading={targets.scanning ? true : undefined}
          onClick={targets.onScan}
        >
          {button.label}
        </s-button>
      );
  }
}

export function ValueActionCard({ card, targets }: { card: Card; targets: ValueActionTargets }) {
  const { fill, border } = edge(card.kind);
  return (
    <section
      aria-label={card.heading}
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        padding: "22px 24px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        border: `1px solid ${border}`,
        borderLeft: `6px solid ${fill}`,
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: "20px",
          lineHeight: "28px",
          fontWeight: 650,
          color: TEXT_PRIMARY,
        }}
      >
        {card.heading}
      </h2>
      <p style={{ margin: 0, fontSize: "14px", lineHeight: "21px", maxWidth: "760px" }}>
        {card.body}
      </p>
      {card.apps.length > 0 && card.kind !== "clear" && (
        <ul
          aria-label="Apps that left code"
          style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: 0, padding: 0 }}
        >
          {card.apps.map((app) => (
            <li
              key={app.name}
              style={{
                listStyle: "none",
                fontSize: "12px",
                lineHeight: "18px",
                padding: "2px 10px",
                borderRadius: "6px",
                background: ACCENT_TINT,
                color: ACCENT_INK,
                border: `1px solid ${ACCENT_BORDER}`,
              }}
            >
              {app.name} · {app.count}
            </li>
          ))}
        </ul>
      )}
      {(card.primary || card.secondary || card.note) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
          {card.primary && (
            <ActionButton button={card.primary} variant="primary" card={card} targets={targets} />
          )}
          {card.secondary && (
            <ActionButton
              button={card.secondary}
              variant="secondary"
              card={card}
              targets={targets}
            />
          )}
          {card.note && <span style={{ fontSize: "13px", color: TEXT_SUBDUED }}>{card.note}</span>}
        </div>
      )}
    </section>
  );
}
