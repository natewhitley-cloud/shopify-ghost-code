import { Link } from "react-router";

import {
  REMOVAL_NOTICE_DISMISS_LABEL,
  REMOVAL_NOTICE_MAX_APPS,
  removalAppHref,
  removalNoticeAppLine,
  removalNoticeBody,
  removalNoticeHeading,
  removalNoticeOverflow,
  removalNoticePrimaryLabel,
} from "../lib/app-removal-notice";
import type { RemovalNotice } from "../lib/app-removal-notice";

/**
 * Home's app-removal banner (gc-frda, layout A): apps the latest scan found no
 * longer active in the store (info), or whose leftovers that scan found
 * cleaned up (success). Built like Home's other banners: an s-banner with a
 * heading, a paragraph, then the actions. Every link goes to that app's
 * filtered view of the scan (`?app=`), where Free sees the app-scoped preview.
 * Dismiss is per scan (the page wires it to the dismiss-removal-notice intent).
 */
export function AppRemovalBanner({
  notice,
  scanId,
  fullList,
  linkParams,
  onDismiss,
}: {
  notice: RemovalNotice;
  scanId: string;
  /** True when the plan shows the full findings list (paid). */
  fullList: boolean;
  /** Current search params, merged into each link (embedded context). */
  linkParams?: URLSearchParams;
  onDismiss: () => void;
}) {
  const inactive = notice.kind === "inactive";
  const [first] = notice.apps;
  const overflow = removalNoticeOverflow(notice);
  return (
    <s-banner tone={inactive ? "info" : "success"} heading={removalNoticeHeading(notice)}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{removalNoticeBody(notice)}</s-paragraph>
        {inactive && notice.apps.length > 1 && (
          <div>
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {notice.apps.slice(0, REMOVAL_NOTICE_MAX_APPS).map((app) => (
                <li key={app.appName}>
                  <Link to={removalAppHref(scanId, app.appName, linkParams)}>
                    {removalNoticeAppLine(app)}
                  </Link>
                </li>
              ))}
            </ul>
            {overflow && <s-paragraph>{overflow}</s-paragraph>}
          </div>
        )}
        <s-stack direction="inline" gap="base">
          {inactive && (
            <Link to={removalAppHref(scanId, first.appName, linkParams)}>
              <s-button variant="primary">{removalNoticePrimaryLabel(notice, fullList)}</s-button>
            </Link>
          )}
          <s-button variant="secondary" onClick={onDismiss}>
            {REMOVAL_NOTICE_DISMISS_LABEL}
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
