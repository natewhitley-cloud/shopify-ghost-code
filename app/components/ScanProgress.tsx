import { useEffect, useState } from "react";

import {
  findingsSoFarLabel,
  formatElapsedTime,
  SCAN_DURATION_EXPECTATION,
  scanElapsedSeconds,
  scanProgressPhrase,
} from "../lib/scan-progress";
import { TEXT_DISABLED, TEXT_PRIMARY, TEXT_SUBDUED, visuallyHidden } from "../styles/shared";

interface ScanProgressProps {
  /** The scan's createdAt: the fixed origin for the phrase and elapsed time. */
  createdAt: Date | string;
  /** Partial count while running; omit where the page does not poll it. */
  findingCount?: number;
}

/**
 * Shared "scan in progress" body for the scan detail page and the home page:
 * a rotating phrase, the findings-so-far line (count > 0), a static duration
 * expectation, and the elapsed time.
 *
 * Elapsed time is measured from createdAt (not startedAt, which is null while
 * PENDING and would jump the clock when the scan starts), so loader
 * revalidations never reset the rotation. The clock starts after mount: the
 * server and first client render show the first phrase and no elapsed line,
 * which keeps hydration stable.
 *
 * Accessibility: one stable, visually hidden status ("Scan in progress") is
 * the only live region and the only announced text. The rotating phrase and
 * the per-second elapsed line are aria-hidden so they never spam a screen
 * reader; the findings count and expectation stay readable on demand. Do not
 * render this inside another live region (it would announce every change).
 */
export function ScanProgress({ createdAt, findingCount = 0 }: ScanProgressProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const elapsedSeconds = now === null ? 0 : scanElapsedSeconds(createdAt, now);
  const soFar = findingsSoFarLabel(findingCount);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span role="status" style={visuallyHidden}>
        Scan in progress
      </span>
      <div aria-hidden="true" style={{ fontSize: "15px", fontWeight: 500, color: TEXT_PRIMARY }}>
        {scanProgressPhrase(elapsedSeconds)}
      </div>
      {soFar && <div style={{ fontSize: "14px", color: TEXT_PRIMARY }}>{soFar}</div>}
      <div style={{ fontSize: "13px", color: TEXT_SUBDUED }}>{SCAN_DURATION_EXPECTATION}</div>
      {/* Always rendered (empty before mount) so it is aria-hidden either way. */}
      <div aria-hidden="true" style={{ fontSize: "13px", color: TEXT_DISABLED }}>
        {now !== null && `Started ${formatElapsedTime(elapsedSeconds)} ago`}
      </div>
    </div>
  );
}
