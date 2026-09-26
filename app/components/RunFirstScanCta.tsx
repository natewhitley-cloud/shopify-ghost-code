import { Link } from "react-router";

/**
 * Primary "Run your first scan" call to action for empty states on pages a
 * brand-new merchant may visit before scanning (gc-vg4: Scan History, Ignored
 * Findings). Render it ONLY when the shop has zero scans ever.
 *
 * It links to Home rather than starting a scan itself, so the single scan-start
 * action (the onboarding card's "Start First Scan", with its theme check and
 * plan gating) is never duplicated. Uses a react-router Link like the other
 * in-app links so embedded navigation stays inside the admin.
 */
export function RunFirstScanCta() {
  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>Ghost Code hasn&apos;t scanned your theme yet.</s-paragraph>
      <Link to="/app">
        <s-button variant="primary">Run your first scan</s-button>
      </Link>
    </s-stack>
  );
}
