/**
 * App-removal notices (gc-frda, Rule 1D): which apps a scan found no longer
 * active, or cleaned up, and every merchant-facing line about them.
 *
 * Pure and client-safe (no DB, no React, no `.server` imports), so Home's
 * loader, the banner component, the scan page and tests share one source.
 *
 * COPY RULE: never say the merchant "removed" or "uninstalled" the app. An app
 * whose live hook disappeared "is no longer active in your store"; we cannot
 * know why. Plain short sentences, no dashes.
 */

import { mergeSearchParams } from "./merge-search-params";

/** One app's row on Home's banner (AppRemoval.state as a plain string). */
export type RemovalNoticeInput = {
  appName: string;
  leftoverCount: number;
  state: string;
};

export type RemovalNoticeApp = { appName: string; count: number };

/**
 * What Home's banner shows for one scan, or null for nothing:
 *   - "inactive": any app detected as no longer active on the scan (info).
 *   - "cleaned": none of those, but some app's leftovers became CLEANED on the
 *     scan (success).
 * Apps are sorted by count (largest first), then name. REINSTALLED rows, and
 * any row with no items, never show.
 */
export type RemovalNotice = {
  kind: "inactive" | "cleaned";
  apps: RemovalNoticeApp[];
  total: number;
};

/** Most apps the multi-app banner lists; the rest fold into "and N more". */
export const REMOVAL_NOTICE_MAX_APPS = 5;

function sortApps(apps: RemovalNoticeApp[]): RemovalNoticeApp[] {
  return [...apps].sort((a, b) => b.count - a.count || a.appName.localeCompare(b.appName));
}

function noticeOf(kind: RemovalNotice["kind"], rows: RemovalNoticeInput[]): RemovalNotice | null {
  const apps = sortApps(
    rows
      .filter((r) => r.leftoverCount > 0)
      .map((r) => ({ appName: r.appName, count: r.leftoverCount })),
  );
  if (apps.length === 0) return null;
  return { kind, apps, total: apps.reduce((sum, a) => sum + a.count, 0) };
}

/** Build Home's notice from getRemovalNoticeRows' rows (see RemovalNotice). */
export function buildRemovalNotice(rows: readonly RemovalNoticeInput[]): RemovalNotice | null {
  return (
    noticeOf(
      "inactive",
      rows.filter((r) => r.state === "REMOVED"),
    ) ??
    noticeOf(
      "cleaned",
      rows.filter((r) => r.state === "CLEANED"),
    )
  );
}

/** "1 item" / "3 items". */
export function itemCount(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

/**
 * The scan page link for one app's findings on a scan (the `?app=` view).
 * Merges into `current` (Home's embedded params: host, shop, ...) like Home's
 * lane links, so the embedded context survives the navigation.
 */
export function removalAppHref(
  scanId: string,
  appName: string,
  current: URLSearchParams = new URLSearchParams(),
): string {
  return `/app/scans/${scanId}?${mergeSearchParams(current, { app: appName })}`;
}

/** Banner heading. */
export function removalNoticeHeading(notice: RemovalNotice): string {
  const [first] = notice.apps;
  if (notice.kind === "cleaned") {
    return notice.apps.length === 1
      ? `${first.appName}'s leftovers are cleaned up`
      : `${notice.apps.length} apps' leftovers are cleaned up`;
  }
  return notice.apps.length === 1
    ? `${first.appName} is no longer active in your store`
    : `${notice.apps.length} apps are no longer active in your store`;
}

/** Banner paragraph. */
export function removalNoticeBody(notice: RemovalNotice): string {
  const [first] = notice.apps;
  const single = notice.apps.length === 1;
  if (notice.kind === "cleaned") {
    const verb = notice.total === 1 ? "is" : "are";
    return single
      ? `The ${itemCount(notice.total)} ${first.appName} left behind ${verb} gone as of this scan.`
      : `The ${itemCount(notice.total)} they left behind ${verb} gone as of this scan.`;
  }
  return single
    ? `It left ${itemCount(notice.total)} behind.`
    : `Together they left ${itemCount(notice.total)} behind.`;
}

/** One line of the multi-app list: "Klaviyo: 3 items". */
export function removalNoticeAppLine(app: RemovalNoticeApp): string {
  return `${app.appName}: ${itemCount(app.count)}`;
}

/** "and 2 more" under a capped list, or null when every app is listed. */
export function removalNoticeOverflow(notice: RemovalNotice): string | null {
  const extra = notice.apps.length - REMOVAL_NOTICE_MAX_APPS;
  return extra > 0 ? `and ${extra} more` : null;
}

/**
 * The info banner's primary button. One app: paid "Review 3 items", Free "See
 * what Klaviyo left" (Free sees the items behind its preview gate). Several
 * apps: "Review {first app}" on every plan.
 */
export function removalNoticePrimaryLabel(notice: RemovalNotice, fullList: boolean): string {
  const [first] = notice.apps;
  if (notice.apps.length > 1) return `Review ${first.appName}`;
  return fullList ? `Review ${itemCount(first.count)}` : `See what ${first.appName} left`;
}

export const REMOVAL_NOTICE_DISMISS_LABEL = "Dismiss";

// ---------------------------------------------------------------------------
// Scan page (`?app=X` with X detected on that scan)
// ---------------------------------------------------------------------------

/** The scan page's context-banner title for an app no longer active. */
export function removalContextTitle(appName: string): string {
  return `${appName} is no longer active in your store`;
}

/**
 * The context banner's body, split around the previous scan's date (the page
 * renders it with FormattedDate). `before` and `after` join with the date in
 * the middle; with no date (baseline pruned) `before` alone is the body start.
 */
export function removalContextBody(
  appName: string,
  count: number,
  hasPreviousDate: boolean,
): { before: string; after: string } {
  const these = count === 1 ? "this 1 item" : `these ${count} items`;
  const tail = ` It left ${these} behind. This code stays in your theme until it's cleaned up.`;
  return hasPreviousDate
    ? { before: `${appName} was active at your previous scan (`, after: `) and isn't now.${tail}` }
    : { before: `${appName} was active at your previous scan and isn't now.${tail}`, after: "" };
}

/** The Free summary card's heading when scoped to one app. */
export function scopedFindingsHeading(appName: string, count: number): string {
  return `${count} finding${count === 1 ? "" : "s"} from ${appName}`;
}

/** The Start here badge for a finding from an app newly inactive on the scan. */
export function newlyInactiveBadge(appName: string): string {
  return `New · ${appName}`;
}
