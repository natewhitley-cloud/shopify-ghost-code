/**
 * "What changed" change log types (gc-rrh.4, spec 2.5-2.8). Pure and
 * client-safe: the page, Home line, email and Sidekick read these shapes from
 * `ScanChangeSet` rows. Typed rows, no copy: wording is rendered at read time,
 * so it can change without a data migration. Filenames, app names and
 * hostnames only, never code.
 *
 * The rows themselves are computed once at scan time by
 * app/services/change-log.server.ts.
 */

import type { LaneKey } from "./finding-consequence";

/** Row encoding version, stored on each ScanChangeSet row. */
export const CHANGE_SET_VERSION = 1;
/** Rows stored per check (spec 1.2). Worth-a-look rows are kept first. */
export const MAX_CHANGE_ROWS = 50;
/** Files listed per row; the rest are `moreFiles`. */
export const MAX_FILES_PER_ROW = 10;
/** More than this many unattributed file edits collapse into one group row. */
export const FILE_EDIT_GROUP_THRESHOLD = 3;

/** "baseline" = no comparable manifest (first scan, legacy, pruned). */
export type ChangeSetKind = "baseline" | "compared" | "theme_switch";
/** From Scan.origin + the plan's cadence at compute time. */
export type CheckKind = "weekly" | "monthly" | "publish" | "manual";

/** Row types, in claim order (spec 2.5): each file goes to the first row that claims it. */
export const CHANGE_ROW_TYPES = [
  "security",
  "app_inactive",
  "app_cleaned",
  "app_added",
  "app_files",
  "theme_published",
  "theme_update",
  "unknown_script",
  "file_edit",
  "files_edit_group",
  "findings_new",
  "findings_fixed",
] as const;
export type ChangeRowType = (typeof CHANGE_ROW_TYPES)[number];

export type ChangeLane = LaneKey | "unknown" | "security";
export type ChangeFileStatus = "added" | "changed" | "removed" | "renamed";

export type ChangeFile = {
  path: string;
  status: ChangeFileStatus;
  /** Shopify's updatedAt for the file, epoch seconds; null when removed or unknown. */
  changedAt: number | null;
};

export type ChangeRow = {
  /** Stable across checks, e.g. `app_inactive:PushOwl`, `file_edit:sections/header.liquid`. */
  key: string;
  type: ChangeRowType;
  /** Signature appName only, never a guess. */
  app: string | null;
  lane: ChangeLane;
  worthALook: boolean;
  files: ChangeFile[];
  moreFiles: number;
  /** A new unrecognised script host in this row's file (unknown_script, or attached). */
  host?: string;
  scriptFile?: string;
  line?: number;
  leftoverCount?: number;
  /** New findings on this row (attached or its own). */
  findingCount?: number;
  /**
   * Of `findingCount`, the new malicious-script and app-incident findings
   * (security rows). Counted as `security`; the rest of findingCount (a
   * non-security finding attached to the same file) as `findingsNew`.
   */
  securityCount?: number;
  /** Fixed findings on this row (attached or its own). */
  fixedCount?: number;
  findingTypes?: string[];
  /** file rows: no current non-ignored finding in the new version of the file(s). */
  noIssuesInNewVersion?: boolean;
  theme?: {
    name: string | null;
    version: string | null;
    previousName: string | null;
    previousVersion: string | null;
    filesChanged: number;
  };
  /** The check's scan, for links. */
  scanId: string;
};

export type ChangeCounts = {
  appsAdded: number;
  appsInactive: number;
  appsCleaned: number;
  unknownScripts: number;
  filesChanged: number;
  themeUpdates: number;
  /** New findings outside the security rows. */
  findingsNew: number;
  findingsFixed: number;
  /** New malicious-script and app-incident findings. */
  security: number;
};

/** Uncounted noise (spec 2.8): shown as one muted line, never a change. */
export type ChangeFootnotes = {
  editorDataFiles: number;
  localeFiles: number;
  pageBuilderFiles: Array<{ app: string; n: number }>;
};

export function emptyCounts(): ChangeCounts {
  return {
    appsAdded: 0,
    appsInactive: 0,
    appsCleaned: 0,
    unknownScripts: 0,
    filesChanged: 0,
    themeUpdates: 0,
    findingsNew: 0,
    findingsFixed: 0,
    security: 0,
  };
}

export function emptyFootnotes(): ChangeFootnotes {
  return { editorDataFiles: 0, localeFiles: 0, pageBuilderFiles: [] };
}

/** Row types whose files are changed theme files (unknown_script only annotates). */
const FILE_COUNTING_TYPES: ReadonlySet<ChangeRowType> = new Set([
  "security",
  "app_inactive",
  "app_cleaned",
  "app_added",
  "app_files",
  "theme_published",
  "theme_update",
  "file_edit",
  "files_edit_group",
]);

/**
 * The counts a list of rows adds up to. One definition for a single check and
 * for merged checks, so Home, page and email always agree.
 */
export function countRows(rows: readonly ChangeRow[]): ChangeCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.type === "app_added") counts.appsAdded += 1;
    if (row.type === "app_inactive") counts.appsInactive += 1;
    if (row.type === "app_cleaned") counts.appsCleaned += 1;
    if (row.type === "theme_update" || row.type === "theme_published") counts.themeUpdates += 1;
    if (row.host !== undefined) counts.unknownScripts += 1;
    if (FILE_COUNTING_TYPES.has(row.type)) counts.filesChanged += row.files.length + row.moreFiles;
    // By finding type, not by row: a security row can also carry a
    // non-security finding attached to its file.
    counts.security += row.securityCount ?? 0;
    counts.findingsNew += (row.findingCount ?? 0) - (row.securityCount ?? 0);
    counts.findingsFixed += row.fixedCount ?? 0;
  }
  return counts;
}

/** Sum of two footnote summaries (page-builder files per app). */
function addFootnotes(a: ChangeFootnotes, b: ChangeFootnotes): ChangeFootnotes {
  const builders = new Map<string, number>();
  for (const { app, n } of [...a.pageBuilderFiles, ...b.pageBuilderFiles]) {
    builders.set(app, (builders.get(app) ?? 0) + n);
  }
  return {
    editorDataFiles: a.editorDataFiles + b.editorDataFiles,
    localeFiles: a.localeFiles + b.localeFiles,
    pageBuilderFiles: [...builders]
      .map(([app, n]) => ({ app, n }))
      .sort((x, y) => (x.app < y.app ? -1 : x.app > y.app ? 1 : 0)),
  };
}

const TYPE_ORDER = new Map<string, number>(CHANGE_ROW_TYPES.map((t, i) => [t, i]));

/**
 * Row types that stand for a GROUP of things in one check (several
 * unattributed files, several new findings in a lane, several fixes) under
 * one fixed key. Merging two checks adds them up; every other key names one
 * thing (an app, a file, a host), whose latest state wins.
 */
const AGGREGATE_TYPES: ReadonlySet<ChangeRowType> = new Set([
  "files_edit_group",
  "findings_new",
  "findings_fixed",
]);

const sumOptional = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/**
 * Two checks' rows under one aggregate key: files unioned by path (the newer
 * check's entry wins, so its status and changedAt), listed up to
 * MAX_FILES_PER_ROW with every unlisted file still counted; finding and fix
 * counts summed; finding types unioned; worth a look if either was (a new
 * HIGH finding stays worth a look); "no issues in the new version" only if
 * neither side had an issue. The newer check's scan link.
 */
function mergeAggregateRow(older: ChangeRow, newer: ChangeRow): ChangeRow {
  const byPath = new Map<string, ChangeFile>();
  for (const f of [...older.files, ...newer.files]) byPath.set(f.path, f);
  const files = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const types = [...new Set([...(older.findingTypes ?? []), ...(newer.findingTypes ?? [])])].sort();
  const noIssues =
    older.noIssuesInNewVersion === false || newer.noIssuesInNewVersion === false
      ? false
      : (newer.noIssuesInNewVersion ?? older.noIssuesInNewVersion);
  const merged: ChangeRow = {
    ...older,
    ...newer,
    worthALook: older.worthALook || newer.worthALook,
    files: files.slice(0, MAX_FILES_PER_ROW),
    moreFiles: Math.max(0, files.length - MAX_FILES_PER_ROW) + older.moreFiles + newer.moreFiles,
    host: newer.host ?? older.host,
    scriptFile: newer.host !== undefined ? newer.scriptFile : older.scriptFile,
    line: newer.host !== undefined ? newer.line : older.line,
    findingCount: sumOptional(older.findingCount, newer.findingCount),
    fixedCount: sumOptional(older.fixedCount, newer.fixedCount),
    findingTypes: types.length > 0 ? types : undefined,
    noIssuesInNewVersion: noIssues,
  };
  // Keep the stored shape: no keys holding undefined.
  for (const k of Object.keys(merged) as Array<keyof ChangeRow>) {
    if (merged[k] === undefined) delete merged[k];
  }
  return merged;
}

/** a - b per count, never below 0. */
function countsOverflow(stored: ChangeCounts, listed: ChangeCounts): ChangeCounts {
  const out = emptyCounts();
  for (const k of Object.keys(out) as Array<keyof ChangeCounts>) {
    out[k] = Math.max(0, (stored[k] ?? 0) - listed[k]);
  }
  return out;
}

function addCounts(a: ChangeCounts, b: ChangeCounts): ChangeCounts {
  const out = emptyCounts();
  for (const k of Object.keys(out) as Array<keyof ChangeCounts>) out[k] = a[k] + b[k];
  return out;
}

/** One check's stored change set, as `mergeChangeSets` reads it. */
export type MergeableChangeSet = {
  kind: ChangeSetKind;
  createdAt: Date | string;
  rows: readonly ChangeRow[];
  footnotes: ChangeFootnotes;
  /**
   * The stored totals over EVERY row of the check, including rows beyond the
   * MAX_CHANGE_ROWS cap that were not stored; the merge adds what the stored
   * rows do not show, so a capped check still adds up.
   */
  counts: ChangeCounts;
  changeCount: number;
  worthALookCount: number;
};

export type MergedChangeSets = {
  rows: ChangeRow[];
  counts: ChangeCounts;
  footnotes: ChangeFootnotes;
  changeCount: number;
  worthALookCount: number;
  /** Checks merged (baseline checks included: they ran). */
  checks: number;
};

/**
 * Merge several checks into one view (Standard's month groups, the email's
 * period). Rows dedupe by `key`: a key that names one thing (an app, a file,
 * a host) takes the latest check's row (its state, its worth-a-look flag, its
 * scan link); an aggregate key (files_edit_group, findings_new:<lane>,
 * findings_fixed) adds both checks up (mergeAggregateRow). Order: claim order
 * by type, then first appearance. Footnotes add up. Counts come from the
 * merged rows, so a file edited in two checks is one change, plus each
 * check's rows beyond the stored cap (from its stored totals), so a single
 * check reports exactly its stored numbers. Input order does not matter:
 * checks are applied oldest first by `createdAt`.
 */
export function mergeChangeSets(sets: readonly MergeableChangeSet[]): MergedChangeSets {
  const ordered = sets
    .map((set, index) => ({ set, index, at: new Date(set.createdAt).getTime() }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const byKey = new Map<string, ChangeRow>();
  let footnotes = emptyFootnotes();
  let overflow = emptyCounts();
  let changeOverflow = 0;
  let worthOverflow = 0;
  for (const { set } of ordered) {
    footnotes = addFootnotes(footnotes, set.footnotes);
    if (set.kind === "baseline") continue;
    for (const row of set.rows) {
      const seen = byKey.get(row.key);
      byKey.set(
        row.key,
        seen && AGGREGATE_TYPES.has(row.type) ? mergeAggregateRow(seen, row) : row,
      );
    }
    overflow = addCounts(overflow, countsOverflow(set.counts, countRows(set.rows)));
    changeOverflow += Math.max(0, set.changeCount - set.rows.length);
    worthOverflow += Math.max(0, set.worthALookCount - set.rows.filter((r) => r.worthALook).length);
  }
  const firstSeen = [...byKey.keys()];
  const rows = [...byKey.values()].sort(
    (a, b) =>
      (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99) ||
      firstSeen.indexOf(a.key) - firstSeen.indexOf(b.key),
  );
  return {
    rows,
    counts: addCounts(countRows(rows), overflow),
    footnotes,
    changeCount: rows.length + changeOverflow,
    worthALookCount: rows.filter((r) => r.worthALook).length + worthOverflow,
    checks: sets.length,
  };
}
