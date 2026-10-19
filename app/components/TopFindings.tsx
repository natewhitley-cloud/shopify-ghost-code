import { Link } from "react-router";

import { newlyInactiveBadge } from "../lib/app-removal-notice";
import { laneLabelForLane } from "../lib/finding-consequence";
import { SECURITY_RISK_LABEL } from "../lib/security-risk";
import { TOP_FINDINGS_MAX } from "../lib/top-findings";
import type { TopFindingView } from "../lib/top-findings";
import { LANE_COLOR, SECURITY_RISK_COLOR } from "../styles/lane-colors";
import type { LanePalette } from "../styles/lane-colors";
import {
  BG_WHITE,
  sectionCard,
  sectionHeader,
  styles,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  textSubduedSm,
} from "../styles/shared";

type Severity = TopFindingView["severity"];

const SEVERITY_TONE: Record<Severity, "critical" | "warning" | "info"> = {
  HIGH: "critical",
  MEDIUM: "warning",
  LOW: "info",
};

/**
 * True when every shown finding has the same severity: the intro then says
 * it once and the cards carry no severity badge.
 */
function hasUniformSeverity(severities: readonly Severity[]): boolean {
  return severities.every((s) => s === severities[0]);
}

/**
 * The block's one-line intro, from the shown findings' severities (in order).
 * One severity for all of them is said here, once; mixed severities are left
 * to each card's badge.
 */
export function topFindingsIntro(severities: readonly Severity[]): string {
  const count = severities.length;
  const ask = count === 1 ? "Fix this first." : `Fix these ${count} first.`;
  if (!hasUniformSeverity(severities)) return ask;
  const level = `${severities[0].toLowerCase()} severity.`;
  if (count === 1) return `${ask} It's ${level}`;
  if (count === 2) return `${ask} Both are ${level}`;
  return `${ask} All ${count === 3 ? "three" : count} are ${level}`;
}

/** A finding's card colours and chip text: its primary lane, or a security risk. */
function cardTheme(f: TopFindingView): { palette: LanePalette; label: string } {
  if (f.securityRisk || f.lane === null) {
    return { palette: SECURITY_RISK_COLOR, label: SECURITY_RISK_LABEL };
  }
  return { palette: LANE_COLOR[f.lane], label: laneLabelForLane(f.lane) };
}

// Grid columns = number of cards; one column at phone width (the design
// standards' single 600px breakpoint). A class per count, because an inline
// grid-template-columns would beat the media query.
const GRID_COLUMN_RULES = Array.from(
  { length: TOP_FINDINGS_MAX },
  (_, i) =>
    `.top-findings__grid--${i + 1} { grid-template-columns: repeat(${i + 1}, minmax(0, 1fr)); }`,
).join("\n");

const TOP_FINDINGS_CSS = `
.top-findings__grid {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
${GRID_COLUMN_RULES}
@media (max-width: 600px) {
  .top-findings__grid { grid-template-columns: minmax(0, 1fr); }
}
.top-findings__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid;
  border-top-width: 4px;
  border-radius: 10px;
  min-width: 0;
}
.top-findings__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.top-findings__num {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: ${BG_WHITE};
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.top-findings__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 6px;
  background: ${BG_WHITE};
}
.top-findings__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.top-findings__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.top-findings__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  color: ${TEXT_PRIMARY};
  overflow-wrap: anywhere;
}
.top-findings__app {
  font-weight: 400;
  color: ${TEXT_SUBDUED};
}
.top-findings__cost {
  font-size: 14px;
  line-height: 1.45;
  color: ${TEXT_PRIMARY};
}
.top-findings__foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.top-findings__location {
  font-size: 12px;
  color: ${TEXT_SUBDUED};
  overflow-wrap: anywhere;
}`;

/**
 * "Start here" block (gc-bn0x, redesigned gc-g034): the scan's most important
 * findings (at most 3, ranked by app/lib/top-findings.ts), one card per
 * finding across the block (stacked on a phone). Each card is in its primary
 * lane's colours with the lane's chip; a security finding (malicious code, an
 * affected-app advisory) is red with a "Security risk" chip. A card shows the
 * title ("from {App}" when known), what it costs, where it lives, and a "See
 * how to fix" button to its row on the scan page. Severity is said once in the
 * intro when all cards share it, else each card carries a badge after its
 * title. Shared by the scan page and Home. Renders nothing for an empty list,
 * so a clean scan keeps its existing state.
 *
 * A finding from an app the scan found no longer active (gc-frda) carries
 * the shared NEW badge style with the app's name, next to its title.
 *
 * Navigation: a react-router `Link` around an `s-button`, the app's pattern for
 * an in-app button (SecurityRiskBanner, Home's banners); the Link carries the
 * full accessible label.
 *
 * Accessibility: a labelled region with a real heading and an ordered list.
 * Not a live region: Home revalidates every 3s while a scan runs, and this block
 * must not announce on those polls.
 */
export function TopFindings({
  findings: allFindings,
  newlyInactiveApps = [],
}: {
  findings: readonly TopFindingView[];
  /**
   * gc-frda: apps found no longer active on THIS scan. A finding from one of
   * them gets a "New · {App}" badge next to its title.
   */
  newlyInactiveApps?: readonly string[];
}) {
  const findings = allFindings.slice(0, TOP_FINDINGS_MAX);
  if (findings.length === 0) return null;
  const inactive = new Set(newlyInactiveApps);
  const severities = findings.map((f) => f.severity);
  const showBadges = !hasUniformSeverity(severities);
  return (
    <section aria-labelledby="top-findings-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <style>{TOP_FINDINGS_CSS}</style>
      <h2 id="top-findings-heading" style={{ ...sectionHeader, margin: 0 }}>
        Start here
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 16px" }}>{topFindingsIntro(severities)}</p>
      <ol className={`top-findings__grid top-findings__grid--${findings.length}`}>
        {findings.map((f, i) => {
          const { palette, label } = cardTheme(f);
          const title = f.title ?? f.typeLabel;
          const linkLabel = f.linkLabel ?? "See how to fix";
          // An override title (an advisory's) already names the app.
          const showApp = f.title === undefined && f.appName !== null;
          return (
            <li
              key={f.id}
              className="top-findings__card"
              style={{
                background: palette.tint,
                borderTopColor: palette.fill,
                borderRightColor: palette.bd,
                borderBottomColor: palette.bd,
                borderLeftColor: palette.bd,
              }}
            >
              <div className="top-findings__top">
                <span
                  className="top-findings__num"
                  style={{ background: palette.fill }}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span className="top-findings__chip" style={{ color: palette.ink }}>
                  <span
                    className="top-findings__dot"
                    style={{ background: palette.fill }}
                    aria-hidden="true"
                  />
                  {label}
                </span>
              </div>
              <div className="top-findings__title-row">
                <h3 className="top-findings__title">
                  {title}
                  {showApp && <span className="top-findings__app"> from {f.appName}</span>}
                </h3>
                {/* After the title, not beside the lane chip: a badge plus the
                  longest chip ("Found by Google & AI") overflows a 3-across card's top row. */}
                {showBadges && <s-badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</s-badge>}
                {f.appName !== null && inactive.has(f.appName) && (
                  <span style={styles.newBadge}>{newlyInactiveBadge(f.appName)}</span>
                )}
              </div>
              <div className="top-findings__cost">{f.cost}</div>
              <div className="top-findings__foot">
                <div className="top-findings__location">{f.location}</div>
                <Link to={f.href} aria-label={`${linkLabel}: ${title}, ${f.location}`}>
                  <s-button variant="secondary">{linkLabel}</s-button>
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
