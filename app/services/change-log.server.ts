/**
 * "What changed" change computation (gc-rrh.4, spec 2 and 3).
 *
 * Runs once per finalized scan in the scan worker's `compute-changes` step
 * (recordChangeSetForScan) and stores typed rows in ScanChangeSet. The rows
 * explain what changed in the theme since the last comparable check and why:
 * one row per cause (an app, the theme, an unknown script host, or "not from
 * a known app"), in a fixed claim order where each changed file goes to the
 * first row that claims it (spec 2.5).
 *
 * Conservative by construction (spec 2.7, 3):
 *   - the finding diff is the summary email's recipe (ignores except known
 *     malicious code, scanDiffOptions coverage, live in both scans), so a
 *     scope grant, a newly live detector or a capped walk is never a change;
 *   - a new or fixed theme-file finding counts only when its file changed;
 *   - "app added" needs an equal signature fingerprint in both scans;
 *   - a file is attributed by filename or snippet name only (the manifest's
 *     owner app), never by content; unknown files are "not from a known app";
 *   - editor data, locales and page-builder churn are footnotes, never
 *     counted.
 *
 * Hashes, paths, app names and hostnames only: no theme file content is read
 * or stored here. Never imports a speed module (decoupling test).
 */

import { FindingType } from "@prisma/client";

import { identifyAppFromFilename, isTrackerApp } from "./app-lookup.server";
import { parseAppSignatureFingerprints, parseLiveAppHooks } from "./app-removal.server";
import { filterIgnoredExceptMalicious } from "./finding-aggregation.server";
import {
  diffScans,
  parseLiveFindingTypes,
  restrictToLiveInBoth,
  scanDiffOptions,
  unauditedCategories,
} from "./scan-differ.server";
import type { DiffableFinding, ScanCoverage, ScanDiff } from "./scan-differ.server";
import { APP_SIGNATURES } from "../data/app-signatures.server";
import { getPlanFeatures } from "../lib/billing.server";
import {
  type ChangeCounts,
  type ChangeFile,
  type ChangeFootnotes,
  type ChangeLane,
  type ChangeRow,
  type ChangeSetKind,
  CHANGE_ROW_TYPES,
  type CheckKind,
  countRows,
  emptyCounts,
  emptyFootnotes,
  FILE_EDIT_GROUP_THRESHOLD,
  MAX_CHANGE_ROWS,
  MAX_FILES_PER_ROW,
} from "../lib/change-log";
import { computeLaneSummary, dominantLane, laneForType } from "../lib/finding-consequence";
import { classifyThemeFile, type ThemeFileKind } from "../lib/theme-file-kind";
import { parseThemeInfo } from "../lib/theme-info";
import { diffManifests, type ManifestEntry } from "../lib/theme-manifest";
import { hostnameFromUrl } from "../lib/url.server";
import { getRemovalNoticeRows, type RemovalNoticeRow } from "../models/app-removal.server";
import { getIgnoredFindingsForShop, type ShopIgnores } from "../models/ignored-finding.server";
import {
  getLatestPublishedChangeSetBefore,
  getScanForChangeLog,
  upsertScanChangeSet,
  type ChangeLogScanRow,
} from "../models/scan-change.server";
import { getLatestManifestForTheme, getScanManifest } from "../models/scan-manifest.server";

// ---------------------------------------------------------------------------
// Finding diff, shared with the summary email (spec 2.7)
// ---------------------------------------------------------------------------

/** A baseline scan as the finding diff reads it. */
export type FindingDiffBaseline = ScanCoverage & {
  findings: DiffableFinding[];
  liveFindingTypes: unknown;
};

export type FindingDiffArgs = {
  currentFindings: DiffableFinding[];
  currentCoverage: ScanCoverage & { skippedFiles: readonly string[] };
  currentLiveFindingTypes: unknown;
  baseline: FindingDiffBaseline;
  ignores: ShopIgnores;
};

export type FindingListDiff =
  | {
      ok: true;
      newFindings: ScanDiff["newFindings"];
      fixedFindings: ScanDiff["resolvedFindings"];
      /** Current findings after the ignore filter ("Still in your theme"). */
      openCount: number;
    }
  | { ok: false; reason: "baseline_unversioned" | "current_unversioned" };

/**
 * New and fixed findings with the in-app diff's guards: ignored findings never
 * count except known malicious code (filterIgnoredExceptMalicious), a category
 * either scan did not audit is neither new nor fixed (scanDiffOptions), and
 * only types live in BOTH scans count (restrictToLiveInBoth). A scan without a
 * recorded live set cannot be judged. The summary email's counts
 * (computeFindingChanges) and the change log's rows both come from here; the
 * email leaves affected-app advisories out (`includeAdvisories: false`,
 * gc-14x5), and code in a menu with them (gc-7gjj.1: store data, not theme
 * code, and in-app only like the advisory); the change log keeps both
 * (security rows).
 */
export function diffFindingLists(
  args: FindingDiffArgs,
  opts: { includeAdvisories: boolean },
): FindingListDiff {
  const baselineLive = parseLiveFindingTypes(args.baseline.liveFindingTypes);
  if (!baselineLive) return { ok: false, reason: "baseline_unversioned" };
  const currentLive = parseLiveFindingTypes(args.currentLiveFindingTypes);
  if (!currentLive) return { ok: false, reason: "current_unversioned" };

  const scoped = <T extends DiffableFinding>(findings: T[]): T[] =>
    opts.includeAdvisories
      ? findings
      : findings.filter(
          (f) => f.findingType !== "APP_INCIDENT_ADVISORY" && f.findingType !== "MENU_INJECTION",
        );
  const current = filterIgnoredExceptMalicious(scoped(args.currentFindings), args.ignores).shown;
  const diff = diffScans(
    current,
    filterIgnoredExceptMalicious(scoped(args.baseline.findings), args.ignores).shown,
    scanDiffOptions(args.currentCoverage, args.baseline),
  );
  return {
    ok: true,
    newFindings: restrictToLiveInBoth(diff.newFindings, baselineLive, currentLive),
    fixedFindings: restrictToLiveInBoth(diff.resolvedFindings, baselineLive, currentLive),
    openCount: current.length,
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One side of a comparison: a successful scan plus its manifest. */
export type ChangeLogScan = {
  scanId: string;
  themeId: string;
  /** Scan.themeName (the theme's name at scan time), the fallback for themeInfo. */
  themeName: string | null;
  coverage: ScanCoverage & { skippedFiles: readonly string[] };
  findings: DiffableFinding[];
  liveAppHooks: unknown;
  appSignatureFingerprints: unknown;
  unknownScripts: ReadonlyArray<{
    filename: string;
    lineNumber: number;
    url: string;
    domain: string | null;
  }>;
  scanDomains: ReadonlyArray<{ domain: string; matched: boolean; benign: boolean }>;
  themeInfo: unknown;
  manifest: readonly ManifestEntry[];
};

export type ComputedChangeSet = {
  kind: ChangeSetKind;
  baselineScanId: string | null;
  themeName: string | null;
  themeVersion: string | null;
  changeCount: number;
  worthALookCount: number;
  checksRan: number;
  counts: ChangeCounts;
  rows: ChangeRow[];
  footnotes: ChangeFootnotes;
};

/** Scan origins that always scan the shop's MAIN (published) theme (spec 0). */
const MAIN_THEME_ORIGINS: ReadonlySet<string> = new Set(["SCHEDULED", "AUTO_PUBLISH"]);

// gc-7gjj.1: code in a menu is a security row too, never a housekeeping one.
const SECURITY_TYPES: ReadonlySet<string> = new Set([
  "MALICIOUS_SCRIPT",
  "APP_INCIDENT_ADVISORY",
  "MENU_INJECTION",
]);

const CONTENT_BUILDERS: ReadonlySet<string> = new Set(
  APP_SIGNATURES.filter((s) => s.contentBuilder === true).map((s) => s.appName),
);

const TYPE_ORDER = new Map<string, number>(CHANGE_ROW_TYPES.map((t, i) => [t, i]));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `checksRan` (spec 2.6): the FindingType values this scan actually audited,
 * its live set minus every un-audited category. 0 for an unversioned scan.
 */
export function countChecksRan(coverage: ScanCoverage): number {
  if (!parseLiveFindingTypes(coverage.liveFindingTypes)) return 0;
  const unaudited = new Set(unauditedCategories(coverage));
  return Object.values(FindingType).filter((t) => !unaudited.has(t)).length;
}

/** "weekly" | "monthly" | "publish" | "manual" from the scan's origin and plan. */
export function checkKindFor(origin: string, plan: string): CheckKind {
  if (origin === "AUTO_PUBLISH") return "publish";
  if (origin === "SCHEDULED") {
    return getPlanFeatures(plan).alertCadence === "weekly" ? "weekly" : "monthly";
  }
  return "manual";
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

type FileChange = {
  path: string;
  /** The old path of a rename. */
  fromPath: string | null;
  status: ChangeFile["status"];
  /** The owner app now (or, for a removed file, before). */
  owner: string | null;
  /** The owner app in the baseline (null for an added file). */
  beforeOwner: string | null;
  kind: ThemeFileKind;
  changedAt: number | null;
};

/** The manifest diff as one path-ordered list. Owner apps never decide a change. */
function fileChanges(
  baseline: readonly ManifestEntry[],
  current: readonly ManifestEntry[],
): FileChange[] {
  const diff = diffManifests(baseline, current);
  const out: FileChange[] = [
    ...diff.added.map((e) => ({
      path: e[0],
      fromPath: null,
      status: "added" as const,
      owner: e[4],
      beforeOwner: null,
      changedAt: e[3],
    })),
    ...diff.removed.map((e) => ({
      path: e[0],
      fromPath: null,
      status: "removed" as const,
      owner: e[4],
      beforeOwner: e[4],
      changedAt: null,
    })),
    ...diff.changed.map(({ before, after }) => ({
      path: after[0],
      fromPath: null,
      status: "changed" as const,
      owner: after[4] ?? before[4],
      beforeOwner: before[4],
      changedAt: after[3],
    })),
    ...diff.renamed.map(({ from, to }) => ({
      path: to[0],
      fromPath: from[0],
      status: "renamed" as const,
      owner: to[4] ?? from[4],
      beforeOwner: from[4],
      changedAt: to[3],
    })),
  ].map((c) => ({ ...c, kind: classifyThemeFile(c.path) }));
  return out.sort((a, b) => cmp(a.path, b.path));
}

const toChangeFile = (c: FileChange): ChangeFile => ({
  path: c.path,
  status: c.status,
  changedAt: c.changedAt,
});

/** Files for a row: path order, capped, the rest counted. */
function rowFiles(changes: readonly FileChange[]): { files: ChangeFile[]; moreFiles: number } {
  return {
    files: changes.slice(0, MAX_FILES_PER_ROW).map(toChangeFile),
    moreFiles: Math.max(0, changes.length - MAX_FILES_PER_ROW),
  };
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

/**
 * Compute one check's change set. Pure.
 *
 * `kind` "baseline" (or no baseline) gives an empty set: no rows, no
 * footnotes, only `checksRan` (spec 2.10). Otherwise rows are built in the
 * claim order of spec 2.5, counted (countRows), and capped at MAX_CHANGE_ROWS
 * with worth-a-look rows kept first; `changeCount` and `worthALookCount` are
 * over every row, so the numbers stay true when the stored list is capped.
 */
export function computeChangeSet(input: {
  current: ChangeLogScan;
  baseline: ChangeLogScan | null;
  kind: ChangeSetKind;
  /** AppRemoval rows detected (REMOVED) or cleaned (CLEANED) on this scan. */
  removals: readonly RemovalNoticeRow[];
  ignores: ShopIgnores;
}): ComputedChangeSet {
  const { current, ignores } = input;
  const currentInfo = parseThemeInfo(current.themeInfo);
  const header = {
    themeName: currentInfo?.name ?? current.themeName,
    themeVersion: currentInfo?.version ?? null,
    checksRan: countChecksRan(current.coverage),
  };
  const baseline = input.kind === "baseline" ? null : input.baseline;
  if (!baseline) {
    return {
      kind: "baseline",
      baselineScanId: null,
      ...header,
      changeCount: 0,
      worthALookCount: 0,
      counts: emptyCounts(),
      rows: [],
      footnotes: emptyFootnotes(),
    };
  }
  const kind = input.kind;
  const scanId = current.scanId;

  // --- Files: counted candidates vs footnotes -----------------------------
  const changes = fileChanges(baseline.manifest, current.manifest);
  const footnotes = emptyFootnotes();
  const unclaimed = new Map<string, FileChange>();
  for (const change of changes) {
    if (change.kind === "editor_data") footnotes.editorDataFiles += 1;
    else if (change.kind === "locale") footnotes.localeFiles += 1;
    else if (change.kind === "code") unclaimed.set(change.path, change);
    // static (images, fonts) and other files are neither changes nor noise.
  }
  const claim = (predicate: (c: FileChange) => boolean): FileChange[] => {
    const taken = [...unclaimed.values()].filter(predicate);
    for (const c of taken) unclaimed.delete(c.path);
    return taken;
  };

  const rows: ChangeRow[] = [];
  /** File path (new and old for a rename) -> the row that claimed it. */
  const rowByPath = new Map<string, ChangeRow>();
  const addRow = (row: ChangeRow, claimed: readonly FileChange[] = []) => {
    rows.push(row);
    for (const c of claimed) {
      rowByPath.set(c.path, row);
      if (c.fromPath) rowByPath.set(c.fromPath, row);
    }
  };
  const base = (key: string, type: ChangeRow["type"], lane: ChangeLane, app: string | null) => ({
    key,
    type,
    app,
    lane,
    worthALook: false,
    files: [] as ChangeFile[],
    moreFiles: 0,
    scanId,
  });

  // --- Findings (guarded diff + file-changed guard) ------------------------
  const diff = diffFindingLists(
    {
      currentFindings: current.findings,
      currentCoverage: current.coverage,
      currentLiveFindingTypes: current.coverage.liveFindingTypes,
      baseline: {
        ...baseline.coverage,
        findings: baseline.findings,
        liveFindingTypes: baseline.coverage.liveFindingTypes,
      },
      ignores,
    },
    { includeAdvisories: true },
  );
  // Unversioned scans: no finding rows; file rows still compute (spec 2.7).
  const newFindings = diff.ok ? diff.newFindings : [];
  const fixedFindings = diff.ok ? diff.fixedFindings : [];

  const changedPaths = new Set(
    changes.flatMap((c) => (c.fromPath ? [c.path, c.fromPath] : [c.path])),
  );
  const themePaths = new Set([...baseline.manifest, ...current.manifest].map((e) => e[0]));
  /** A theme-file finding counts only if its file changed (detector-only changes never do). */
  const fileGuard = (f: { filename: string }) =>
    !(themePaths.has(f.filename) || classifyThemeFile(f.filename) !== "other") ||
    changedPaths.has(f.filename);

  // --- 1. security: new malicious / advisory findings, one row per file -----
  const securityByFile = new Map<string, typeof newFindings>();
  for (const f of newFindings) {
    if (!SECURITY_TYPES.has(f.findingType)) continue;
    securityByFile.set(f.filename, [...(securityByFile.get(f.filename) ?? []), f]);
  }
  for (const filename of [...securityByFile.keys()].sort(cmp)) {
    const found = securityByFile.get(filename)!;
    const claimed = claim((c) => c.path === filename || c.fromPath === filename);
    const apps = new Set(found.map((f) => f.appName));
    addRow(
      {
        ...base(
          `security:${filename}`,
          "security",
          "security",
          apps.size === 1 ? [...apps][0] : null,
        ),
        worthALook: true,
        ...rowFiles(claimed),
        findingCount: found.length,
        securityCount: found.length,
        findingTypes: [...new Set(found.map((f) => f.findingType))].sort(cmp),
      },
      claimed,
    );
  }

  // Current findings as the merchant sees them (ignores except malicious).
  const shown = filterIgnoredExceptMalicious([...current.findings], ignores).shown;

  // --- 2. app_inactive / 3. app_cleaned (AppRemoval on this scan) ----------
  const removalApps = new Set<string>();
  for (const removal of [...input.removals].sort((a, b) => cmp(a.appName, b.appName))) {
    const app = removal.appName;
    if (removal.state === "REMOVED") {
      const claimed = claim((c) => c.owner === app);
      const typeCounts: Partial<Record<FindingType, number>> = {};
      for (const f of shown) {
        if (f.appName !== app) continue;
        const type = f.findingType as FindingType;
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      }
      addRow(
        {
          ...base(
            `app_inactive:${app}`,
            "app_inactive",
            dominantLane(computeLaneSummary(typeCounts)) ?? "housekeeping",
            app,
          ),
          worthALook: removal.leftoverCount > 0,
          ...rowFiles(claimed),
          leftoverCount: removal.leftoverCount,
        },
        claimed,
      );
      removalApps.add(app);
    } else if (removal.state === "CLEANED") {
      const claimed = claim((c) => c.owner === app && c.status === "removed");
      addRow(
        {
          ...base(`app_cleaned:${app}`, "app_cleaned", "housekeeping", app),
          ...rowFiles(claimed),
          leftoverCount: removal.leftoverCount,
        },
        claimed,
      );
      removalApps.add(app);
    }
  }

  // --- 4. app_added ---------------------------------------------------------
  const currentHooks = parseLiveAppHooks(current.liveAppHooks);
  const baselineHooks = parseLiveAppHooks(baseline.liveAppHooks);
  const currentPrints = parseAppSignatureFingerprints(current.appSignatureFingerprints);
  const baselinePrints = parseAppSignatureFingerprints(baseline.appSignatureFingerprints);
  /** Same signature version on both sides (a signature edit is never "added"). */
  const sameSignature = (app: string) => {
    const now = currentPrints?.get(app);
    return now !== undefined && baselinePrints?.get(app) === now;
  };
  const addedApps = new Set<string>();
  if (currentHooks && baselineHooks) {
    for (const source of ["embed", "scriptTag"] as const) {
      const before = baselineHooks[source];
      const after = currentHooks[source];
      // A source must be observed on BOTH sides: unobserved is not "absent".
      if (!before || !after) continue;
      for (const app of after) {
        const hookedBefore =
          baselineHooks.embed?.has(app) === true || baselineHooks.scriptTag?.has(app) === true;
        if (!before.has(app) && !hookedBefore && sameSignature(app)) addedApps.add(app);
      }
    }
  }
  const baselineOwners = new Set(baseline.manifest.map((e) => e[4]).filter((o) => o !== null));
  for (const c of unclaimed.values()) {
    if (
      c.status === "added" &&
      c.owner !== null &&
      !baselineOwners.has(c.owner) &&
      sameSignature(c.owner)
    ) {
      addedApps.add(c.owner);
    }
  }
  for (const app of [...addedApps].sort(cmp)) {
    if (removalApps.has(app)) continue;
    const claimed = claim((c) => c.owner === app && c.status === "added");
    addRow(
      {
        ...base(`app_added:${app}`, "app_added", isTrackerApp(app) ? "privacy" : "speed", app),
        ...rowFiles(claimed),
      },
      claimed,
    );
  }

  // --- 5. app_files (and page-builder churn footnotes) ----------------------
  const ownersLeft = new Set(
    [...unclaimed.values()].map((c) => c.owner).filter((o): o is string => o !== null),
  );
  const builderChurn = new Map<string, number>();
  for (const app of [...ownersLeft].sort(cmp)) {
    const claimed = claim((c) => c.owner === app);
    const builder = CONTENT_BUILDERS.has(app);
    const liveBuilder = builder && currentHooks?.embed?.has(app) === true;
    // A page builder rewriting files it already owned: a footnote, while the
    // builder has a live embed hook (spec 2.8), or when the file's own path
    // is the builder's (a filePatterns match). The path is the stronger
    // signal: a builder without a verified embed handle never shows a live
    // hook, yet its page saves rewrite exactly those files. A file owned only
    // by an exact snippet name still needs the live hook. Added or removed
    // builder files still count.
    const isChurn = (c: FileChange) =>
      builder &&
      c.status === "changed" &&
      c.beforeOwner === app &&
      (liveBuilder || identifyAppFromFilename(c.path)?.appName === app);
    const churn = claimed.filter(isChurn);
    const counted = claimed.filter((c) => !isChurn(c));
    if (churn.length > 0) builderChurn.set(app, churn.length);
    if (counted.length === 0) continue;
    addRow(
      { ...base(`app_files:${app}`, "app_files", "housekeeping", app), ...rowFiles(counted) },
      counted,
    );
  }
  footnotes.pageBuilderFiles = [...builderChurn].map(([app, n]) => ({ app, n }));

  // --- 6. theme_published / 7. theme_update ---------------------------------
  const baselineInfo = parseThemeInfo(baseline.themeInfo);
  const themeRow = (type: "theme_published" | "theme_update", key: string) => {
    const claimed = claim(() => true);
    addRow(
      {
        ...base(key, type, "customers-see-it", null),
        ...rowFiles(claimed),
        theme: {
          name: header.themeName,
          version: header.themeVersion,
          previousName: baselineInfo?.name ?? baseline.themeName,
          previousVersion: baselineInfo?.version ?? null,
          filesChanged: claimed.length,
        },
      },
      claimed,
    );
  };
  // Both versions known and different: a version missing on one side (theme
  // info not read) is not an update, and must not swallow the code edits
  // into a theme row.
  const versionNow = currentInfo?.version ?? null;
  const versionBefore = baselineInfo?.version ?? null;
  if (kind === "theme_switch") {
    themeRow("theme_published", `theme_published:${current.themeId}`);
  } else if (versionNow !== null && versionBefore !== null && versionNow !== versionBefore) {
    themeRow("theme_update", `theme_update:${versionNow}`);
  }

  // --- 9. file_edit / 10. files_edit_group (not from a known app) -----------
  const issueFiles = new Set(shown.map((f) => f.filename));
  const noIssues = (list: readonly FileChange[]) => {
    const present = list.filter((c) => c.status !== "removed");
    return present.length === 0 ? undefined : present.every((c) => !issueFiles.has(c.path));
  };
  const edits = claim(() => true);
  if (edits.length > FILE_EDIT_GROUP_THRESHOLD) {
    addRow(
      {
        ...base("files_edit_group", "files_edit_group", "housekeeping", null),
        ...rowFiles(edits),
        noIssuesInNewVersion: noIssues(edits),
      },
      edits,
    );
  } else {
    for (const edit of edits) {
      const flag = noIssues([edit]);
      addRow(
        {
          ...base(`file_edit:${edit.path}`, "file_edit", "housekeeping", null),
          ...rowFiles([edit]),
          ...(flag === undefined ? {} : { noIssuesInNewVersion: flag }),
        },
        [edit],
      );
    }
  }

  // --- 8. unknown_script (annotates the row that claimed its file) ----------
  const changeByPath = new Map(changes.map((c) => [c.path, c]));
  const baselineScripts = new Set(
    baseline.unknownScripts.map((s) => `${s.domain ?? hostnameFromUrl(s.url)}\n${s.filename}`),
  );
  const recognised = new Set(
    current.scanDomains.filter((d) => d.matched || d.benign).map((d) => d.domain),
  );
  const seenScripts = new Set<string>();
  const scripts = [...current.unknownScripts].sort(
    (a, b) => cmp(a.filename, b.filename) || a.lineNumber - b.lineNumber || cmp(a.url, b.url),
  );
  for (const script of scripts) {
    const host = script.domain ?? hostnameFromUrl(script.url);
    if (!host) continue;
    const key = `${host}\n${script.filename}`;
    if (seenScripts.has(key) || baselineScripts.has(key) || recognised.has(host)) continue;
    // Only in an added or changed file: a host newly flagged in an untouched
    // file (a detector or signature change) is not new (spec 2.7).
    const change = changeByPath.get(script.filename);
    if (!change || change.status === "removed") continue;
    seenScripts.add(key);
    const owner = rowByPath.get(script.filename);
    if (owner && owner.host === undefined) {
      Object.assign(owner, {
        host,
        scriptFile: script.filename,
        line: script.lineNumber,
        worthALook: true,
      });
    } else {
      addRow({
        ...base(`unknown_script:${host}:${script.filename}`, "unknown_script", "unknown", null),
        worthALook: true,
        ...rowFiles([change]),
        host,
        scriptFile: script.filename,
        line: script.lineNumber,
      });
    }
  }

  // --- 11. findings_new / 12. findings_fixed --------------------------------
  const newByLane = new Map<ChangeLane, typeof newFindings>();
  for (const f of newFindings) {
    if (SECURITY_TYPES.has(f.findingType) || !fileGuard(f)) continue;
    const high = f.severity === "HIGH";
    const owner = rowByPath.get(f.filename);
    if (owner) {
      owner.findingCount = (owner.findingCount ?? 0) + 1;
      owner.findingTypes = [...new Set([...(owner.findingTypes ?? []), f.findingType])].sort(cmp);
      if (high) owner.worthALook = true;
      continue;
    }
    const lane: ChangeLane = laneForType(f.findingType as FindingType) ?? "housekeeping";
    newByLane.set(lane, [...(newByLane.get(lane) ?? []), f]);
  }
  for (const [lane, found] of newByLane) {
    addRow({
      ...base(`findings_new:${lane}`, "findings_new", lane, null),
      worthALook: found.some((f) => f.severity === "HIGH"),
      findingCount: found.length,
      findingTypes: [...new Set(found.map((f) => f.findingType))].sort(cmp),
    });
  }
  const fixedLeft: typeof fixedFindings = [];
  for (const f of fixedFindings) {
    if (!fileGuard(f)) continue;
    const owner = rowByPath.get(f.filename);
    if (owner) owner.fixedCount = (owner.fixedCount ?? 0) + 1;
    else fixedLeft.push(f);
  }
  if (fixedLeft.length > 0) {
    addRow({
      ...base("findings_fixed", "findings_fixed", "housekeeping", null),
      fixedCount: fixedLeft.length,
      findingTypes: [...new Set(fixedLeft.map((f) => f.findingType))].sort(cmp),
    });
  }

  // --- Order, count, cap ----------------------------------------------------
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (TYPE_ORDER.get(a.row.type) ?? 99) - (TYPE_ORDER.get(b.row.type) ?? 99) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
  const worth = ordered.filter((r) => r.worthALook);
  const kept = new Set(
    [...worth, ...ordered.filter((r) => !r.worthALook)].slice(0, MAX_CHANGE_ROWS),
  );
  return {
    kind,
    baselineScanId: baseline.scanId,
    ...header,
    changeCount: ordered.length,
    worthALookCount: worth.length,
    counts: countRows(ordered),
    rows: ordered.filter((r) => kept.has(r)),
    footnotes,
  };
}

// ---------------------------------------------------------------------------
// Orchestration (the scan worker's compute-changes step)
// ---------------------------------------------------------------------------

export type ChangeLogOutcome =
  | { status: "saved"; kind: ChangeSetKind; changeCount: number; worthALookCount: number }
  | { status: "skipped"; reason: "scan_not_found" | "no_manifest" };

function toChangeLogScan(row: ChangeLogScanRow, manifest: readonly ManifestEntry[]): ChangeLogScan {
  return {
    scanId: row.id,
    themeId: row.themeId,
    themeName: row.themeName,
    coverage: {
      skippedCategories: row.skippedCategories,
      cappedCategories: row.cappedCategories,
      unreachableCategories: row.unreachableCategories,
      skippedFiles: row.skippedFiles,
      liveFindingTypes: row.liveFindingTypes,
      walkCoverage: row.walkCoverage,
    },
    findings: row.findings,
    liveAppHooks: row.liveAppHooks,
    appSignatureFingerprints: row.appSignatureFingerprints,
    unknownScripts: row.unknownScripts,
    scanDomains: row.scanDomains,
    themeInfo: row.themeInfo,
    manifest,
  };
}

/**
 * Compute and save one finalized scan's change set (spec 2.1-2.2). Throws on a
 * read or write error: the worker step catches, logs and records it, and the
 * scan stays finalized. Idempotent: a re-run upserts the same row, against the
 * same baseline (only scans created before this one are considered, and the
 * prune keeps the newest two successful manifests per theme).
 *
 * Baseline choice: on the published theme, a different published theme at the
 * previous published check with a surviving manifest is a theme switch;
 * otherwise the latest earlier successful scan of this theme with a manifest;
 * otherwise a baseline check.
 */
export async function recordChangeSetForScan(input: {
  scanId: string;
  shopId: string;
  themeId: string;
  /** From fetch-and-scan; null when the published-theme read failed (see below). */
  isPublishedTheme: boolean | null;
}): Promise<ChangeLogOutcome> {
  const { scanId, shopId, themeId } = input;
  const [scan, manifest] = await Promise.all([
    getScanForChangeLog(scanId),
    getScanManifest(scanId),
  ]);
  if (!scan) return { status: "skipped", reason: "scan_not_found" };
  if (!manifest) return { status: "skipped", reason: "no_manifest" };

  // Published theme unknown (the read failed twice): saving it as "not
  // published" would hide this check from every published-theme surface and
  // the next check would compare against it, so its changes would never show.
  // Scheduled and publish scans always target the MAIN theme (poll-check-shop
  // and the themes/publish webhook resolve it at dispatch), so they are
  // published; any other scan is published when its theme is the one the
  // latest published check was on; otherwise not.
  const readPrevious = () => getLatestPublishedChangeSetBefore(shopId, scan.createdAt, scanId);
  let previous: Awaited<ReturnType<typeof readPrevious>> | undefined;
  let onPublishedTheme: boolean;
  if (input.isPublishedTheme !== null) {
    onPublishedTheme = input.isPublishedTheme;
  } else if (MAIN_THEME_ORIGINS.has(scan.origin)) {
    onPublishedTheme = true;
  } else {
    previous = await readPrevious();
    onPublishedTheme = previous?.themeId === themeId;
  }

  let kind: ChangeSetKind = "baseline";
  let baselineManifest = null;
  if (onPublishedTheme) {
    if (previous === undefined) previous = await readPrevious();
    if (previous && previous.themeId !== themeId) {
      baselineManifest = await getLatestManifestForTheme(shopId, previous.themeId, {
        before: scan.createdAt,
      });
      if (baselineManifest) kind = "theme_switch";
    }
  }
  if (!baselineManifest) {
    baselineManifest = await getLatestManifestForTheme(shopId, themeId, {
      excludeScanId: scanId,
      before: scan.createdAt,
    });
    if (baselineManifest) kind = "compared";
  }
  const baselineRow = baselineManifest ? await getScanForChangeLog(baselineManifest.scanId) : null;
  if (!baselineRow) kind = "baseline";

  const [removals, ignores] = await Promise.all([
    // AppRemoval detection is per theme: on a theme switch it adds nothing
    // (spec 2.2), so removal rows are read only for a same-theme comparison.
    kind === "compared" ? getRemovalNoticeRows(shopId, themeId, scanId) : [],
    getIgnoredFindingsForShop(shopId),
  ]);
  const computed = computeChangeSet({
    current: toChangeLogScan(scan, manifest.entries),
    baseline:
      baselineRow && baselineManifest
        ? toChangeLogScan(baselineRow, baselineManifest.entries)
        : null,
    kind,
    removals,
    ignores,
  });
  await upsertScanChangeSet(scanId, {
    shopId,
    themeId,
    checkKind: checkKindFor(scan.origin, scan.shop.plan),
    onPublishedTheme,
    ...computed,
  });
  return {
    status: "saved",
    kind: computed.kind,
    changeCount: computed.changeCount,
    worthALookCount: computed.worthALookCount,
  };
}
