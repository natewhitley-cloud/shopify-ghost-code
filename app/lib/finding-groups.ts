/**
 * Findings grouped by app on the scan page (gc-np1d.6, decision 3A, page map
 * "### Scan results"). Pure and client-safe.
 *
 * Group order: worst severity first (HIGH, MEDIUM, LOW), then the most
 * findings, then app name (a total order, so paging is deterministic).
 * Findings with no app go last, in an "Other code" group, whatever their
 * severity. Inside a group the existing severity-then-filename order stays.
 *
 * The paid list's server query (getFindingsPageForScan) pages in this order,
 * so a page is a run of whole groups plus at most a cut group at each end; the
 * page renders consecutive findings of one app under one header
 * (groupFindingRuns), and a group cut by a page boundary continues on the next
 * page under the same header.
 */

/** Header of the group of findings with no app. */
export const OTHER_CODE_GROUP_LABEL = "Other code";

/** Whitespace and invisible format characters (zero-width space, word joiner, ...). */
const BLANK_CHARS = /[\s\p{Cf}]/gu;

/**
 * The group a finding belongs to: its app, or null ("Other code") for no app
 * or a blank name (only whitespace and invisible format characters such as
 * U+200B), so those share one group and one header.
 */
export function findingGroupKey(appName: string | null): string | null {
  return appName !== null && appName.replace(BLANK_CHARS, "") !== "" ? appName : null;
}

/** One group's place in the order and its size under the active filters. */
export type FindingGroupMeta = { appName: string | null; count: number };

const SEVERITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const severityRank = (severity: string) => SEVERITY_RANK[severity] ?? 3;
/** Code-unit order: deterministic, the same on server and client. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Rank the groups of a scan's findings from per-(app, severity) counts (one
 * groupBy, or kept rows counted in memory). Zero counts are dropped.
 */
export function rankFindingGroups(
  rows: ReadonlyArray<{ appName: string | null; severity: string; count: number }>,
): FindingGroupMeta[] {
  const byApp = new Map<string | null, { count: number; worst: number }>();
  for (const row of rows) {
    if (row.count <= 0) continue;
    const key = findingGroupKey(row.appName);
    const entry = byApp.get(key) ?? { count: 0, worst: Number.POSITIVE_INFINITY };
    entry.count += row.count;
    entry.worst = Math.min(entry.worst, severityRank(row.severity));
    byApp.set(key, entry);
  }
  return [...byApp.entries()]
    .sort(([nameA, a], [nameB, b]) => {
      if (nameA === null || nameB === null) return nameA === null ? 1 : -1;
      if (a.worst !== b.worst) return a.worst - b.worst;
      if (a.count !== b.count) return b.count - a.count;
      return compareText(nameA, nameB);
    })
    .map(([appName, { count }]) => ({ appName, count }));
}

/** The group header: the app name, or "Other code" (no app, or a blank name). */
export function findingGroupHeading(appName: string | null): string {
  return findingGroupKey(appName) ?? OTHER_CODE_GROUP_LABEL;
}

/**
 * The group subline: the group's findings across every page under the active
 * filters. With `shown` (Free preview), how many of them this page shows.
 * No install status: the scan data does not say an app was uninstalled.
 */
export function findingGroupSubline(count: number, shown?: number): string {
  const total = `${count} ${count === 1 ? "finding" : "findings"}`;
  return shown !== undefined && shown < count ? `${total} · ${shown} shown` : total;
}

export type FindingGroupRun<T> = { appName: string | null; count: number; findings: T[] };

/**
 * Split an already-ordered page of findings into runs of one app, each with
 * its group's total from `groups` (the run's own length when the group is not
 * listed, so the count never reads lower than what is shown).
 */
export function groupFindingRuns<T extends { appName: string | null }>(
  findings: readonly T[],
  groups: readonly FindingGroupMeta[],
): FindingGroupRun<T>[] {
  const totals = new Map(groups.map((g) => [g.appName, g.count]));
  const runs: FindingGroupRun<T>[] = [];
  for (const finding of findings) {
    const key = findingGroupKey(finding.appName);
    const last = runs[runs.length - 1];
    if (last && last.appName === key) last.findings.push(finding);
    else runs.push({ appName: key, count: 0, findings: [finding] });
  }
  for (const run of runs) {
    run.count = Math.max(totals.get(run.appName) ?? 0, run.findings.length);
  }
  return runs;
}

/**
 * Order a small in-memory list (the Free preview) by group, then severity,
 * then filename, so groupFindingRuns gives one run per app. An app missing
 * from `groups` goes after the listed ones, still before "Other code".
 */
export function sortIntoGroups<
  T extends { appName: string | null; severity: string; filename: string },
>(findings: readonly T[], groups: readonly FindingGroupMeta[]): T[] {
  const index = new Map(groups.map((g, i) => [g.appName, i]));
  const groupIndex = (appName: string | null) =>
    appName === null ? Number.MAX_SAFE_INTEGER : (index.get(appName) ?? groups.length);
  return [...findings].sort(
    (a, b) =>
      groupIndex(findingGroupKey(a.appName)) - groupIndex(findingGroupKey(b.appName)) ||
      compareText(findingGroupKey(a.appName) ?? "", findingGroupKey(b.appName) ?? "") ||
      severityRank(a.severity) - severityRank(b.severity) ||
      compareText(a.filename, b.filename),
  );
}
