import { Link } from "react-router";

import { newlyInactiveBadge } from "../lib/app-removal-notice";
import type { TopFindingView } from "../lib/top-findings";
import { sectionCard, sectionHeader, styles, TEXT_PRIMARY, textSubduedSm } from "../styles/shared";

const SEVERITY_TONE: Record<TopFindingView["severity"], "critical" | "warning" | "info"> = {
  HIGH: "critical",
  MEDIUM: "warning",
  LOW: "info",
};

/** The block's one-line intro, by how many findings it shows. */
export function topFindingsIntro(count: number): string {
  return count === 1
    ? "The finding that matters most in this scan, and what it costs you."
    : `The ${count} findings that matter most in this scan, and what each costs you.`;
}

/**
 * "Start here" block (gc-bn0x): the scan's most important findings (at most 3,
 * ranked by app/lib/top-findings.ts), each with where it lives, one line on
 * what it costs, and a link to its row on the scan page. Shared by the scan
 * page and Home. Renders nothing for an empty list, so a clean scan keeps its
 * existing state.
 *
 * A finding from an app the scan found no longer active (gc-frda) carries
 * the shared NEW badge style with the app's name.
 *
 * Accessibility: a labelled region with a real heading and an ordered list.
 * Not a live region: Home revalidates every 3s while a scan runs, and this
 * block must not announce on those polls.
 */
export function TopFindings({
  findings,
  newlyInactiveApps = [],
}: {
  findings: readonly TopFindingView[];
  /**
   * gc-frda: apps found no longer active on THIS scan. A finding from one of
   * them gets a "New · {App}" badge after its severity badge.
   */
  newlyInactiveApps?: readonly string[];
}) {
  if (findings.length === 0) return null;
  const inactive = new Set(newlyInactiveApps);
  return (
    <section aria-labelledby="top-findings-heading" style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 id="top-findings-heading" style={{ ...sectionHeader, margin: 0 }}>
        Start here
      </h2>
      <p style={{ ...textSubduedSm, margin: "4px 0 12px" }}>{topFindingsIntro(findings.length)}</p>
      <ol style={{ margin: 0, paddingLeft: "20px" }}>
        {findings.map((f, i) => (
          <li key={f.id} style={i > 0 ? { marginTop: "12px" } : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: TEXT_PRIMARY }}>
                {f.typeLabel}
              </h3>
              <s-badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</s-badge>
              {f.appName !== null && inactive.has(f.appName) && (
                <span style={styles.newBadge}>{newlyInactiveBadge(f.appName)}</span>
              )}
            </div>
            <div style={{ ...textSubduedSm, marginTop: "2px", wordBreak: "break-word" }}>
              {f.location}
            </div>
            <div style={{ fontSize: "14px", color: TEXT_PRIMARY, marginTop: "4px" }}>{f.cost}</div>
            <div style={{ marginTop: "4px", fontSize: "13px" }}>
              <Link to={f.href} aria-label={`See how to fix: ${f.typeLabel}, ${f.location}`}>
                See how to fix
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
