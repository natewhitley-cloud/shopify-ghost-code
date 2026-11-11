import { Link } from "react-router";

import { cleanCopyRunPath, type CleanCopyRunLine } from "../lib/clean-copy-view";
import { TEXT_SUBDUED } from "../styles/shared";

/**
 * The way back to a clean copy's result page (gc-tib.20), on the scan and
 * select pages. A warning (don't publish, or a run that didn't finish) is a
 * banner; a finished or running copy is a quiet line, so it doesn't shout on
 * every visit.
 */
export function CleanCopyRunLines({ lines }: { lines: readonly CleanCopyRunLine[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => {
        const link = <Link to={cleanCopyRunPath(line.runId)}>{line.linkLabel}</Link>;
        if (line.tone === "critical" || line.tone === "warning") {
          return (
            <s-banner key={line.runId} tone={line.tone}>
              <s-paragraph>
                {line.text} {link}
              </s-paragraph>
            </s-banner>
          );
        }
        return (
          <p
            key={line.runId}
            style={{ margin: 0, color: TEXT_SUBDUED, fontSize: "14px", lineHeight: "21px" }}
          >
            {line.text} {link}
          </p>
        );
      })}
    </>
  );
}
