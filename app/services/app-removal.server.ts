/**
 * App-removal detection (gc-frda). Pure: no DB access, no I/O.
 *
 * Rule 1D: app X is REMOVED on scan S, against the previous successful scan P
 * of the SAME shop + theme, when all of these hold:
 *
 *   1. X had a LIVE HOOK in P: an enabled theme app embed (embedHandles) or a
 *      storefront ScriptTag (the SCRIPT_TAG_SUNSET check).
 *   2. X has NO live hook in S, in any hook source S observed.
 *   3. A hook source only counts when it was OBSERVED in both scans: the embed
 *      set recorded on both, the ScriptTag set only when the storefront check
 *      ran and read the storefront in both (not dark, not unreachable, not
 *      capped). A legacy P with no recorded hooks yields no removals.
 *   4. X has >= 1 finding in S that passes the guards below; that count is the
 *      leftover count. Prior findings are irrelevant: a live app's own-file
 *      findings are hidden while its embed is on, and show once it is off.
 *
 * Finding guards:
 *   - Coverage: a finding only counts when its type was audited in BOTH scans
 *     (not skipped / capped / unreachable / not live in either; see
 *     unauditedCategories) and, for a per-file type, its file was scanned in
 *     both (not size-skipped in either; same rule as diffScans). Real case:
 *     P skipped GHOST_METAFIELD (read_products not granted), the merchant
 *     granted it, S found 172 metafields: a newly checked category.
 *   - Signature: X's signature fingerprint (APP_SIGNATURES, which includes
 *     embedHandles) must be recorded on both scans and equal.
 *   - Ignores: findings the merchant ignored (APP or INSTANCE scope) are
 *     dropped first, with the merchant alert's filter.
 *   - SCRIPT_TAG_SUNSET findings describe a LIVE app and never count.
 *
 * Findings alone are never a trigger: an app with no recognised hook (most
 * signatures have no embedHandles) has its code flagged while live, so its
 * install would otherwise read as a 0 -> N "removal" (the Rule 1A flaw).
 *
 * Merchant-facing meaning: "X is no longer active in your store. It left N
 * items behind." It never claims the merchant uninstalled X.
 */

import { AppRemovalState } from "@prisma/client";

import { filterIgnoredFindings, type IgnorableFinding } from "./finding-aggregation.server";
import { djb2Hex, parseLiveFindingTypes, unauditedCategories } from "./scan-differ.server";
import type { ScanCoverage } from "./scan-differ.server";
import { MAX_SCRIPT_TAG_GROUPS, MAX_SCRIPT_TAG_URLS } from "./script-tag-sunset-detector.server";
import { APP_SIGNATURES, type AppSignature } from "../data/app-signatures.server";
import {
  CROSS_FILE_FINDING_TYPES,
  SIZE_SKIP_STILL_SCANNED_FINDING_TYPES,
} from "../lib/finding-classification";
import type { ShopIgnores } from "../models/ignored-finding.server";

// ---------------------------------------------------------------------------
// Signature fingerprints
// ---------------------------------------------------------------------------

/** Canonical JSON-able form: RegExp as source + flags, object keys sorted. */
function canonicalize(value: unknown): unknown {
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/**
 * `{ [appName]: fingerprint }` over every field of each app's signature. Two
 * entries with the same appName (none today) are hashed together, so editing
 * either changes the app's fingerprint.
 */
export function computeAppSignatureFingerprints(
  signatures: readonly AppSignature[] = APP_SIGNATURES,
): Record<string, string> {
  const serialized = new Map<string, string[]>();
  for (const signature of signatures) {
    const parts = serialized.get(signature.appName) ?? [];
    parts.push(JSON.stringify(canonicalize(signature)));
    serialized.set(signature.appName, parts);
  }
  const out: Record<string, string> = {};
  for (const appName of [...serialized.keys()].sort()) {
    out[appName] = djb2Hex(serialized.get(appName)!.sort().join("\n"));
  }
  return out;
}

/**
 * Parse `Scan.appSignatureFingerprints` (Json?). NULL or any malformed value is
 * "never recorded" (null), so a bad row can only suppress removals.
 */
export function parseAppSignatureFingerprints(raw: unknown): Map<string, string> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.every(([, v]) => typeof v === "string")) return null;
  return new Map(entries as Array<[string, string]>);
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Finding types that never count toward a removal (see guard 4). */
export const REMOVAL_EXCLUDED_TYPES: ReadonlySet<string> = new Set(["SCRIPT_TAG_SUNSET"]);

export type RemovalFinding = IgnorableFinding;

/** What a scan contributes to removal detection. */
export interface RemovalScan extends ScanCoverage {
  findings: readonly RemovalFinding[];
  skippedFiles: readonly string[];
  appSignatureFingerprints?: unknown;
  /** Raw `Scan.liveAppHooks` (see LiveAppHooks). */
  liveAppHooks?: unknown;
}

/** True when `scan` actually checked this finding's type (and file). */
function auditedIn(
  finding: RemovalFinding,
  unaudited: ReadonlySet<string>,
  skippedFiles: ReadonlySet<string>,
): boolean {
  if (unaudited.has(finding.findingType)) return false;
  return !(
    skippedFiles.has(finding.filename) &&
    !CROSS_FILE_FINDING_TYPES.has(finding.findingType) &&
    !SIZE_SKIP_STILL_SCANNED_FINDING_TYPES.has(finding.findingType)
  );
}

interface CoverageView {
  unaudited: ReadonlySet<string>;
  skippedFiles: ReadonlySet<string>;
}

function coverageOf(scan: RemovalScan): CoverageView {
  return {
    unaudited: new Set(unauditedCategories(scan)),
    skippedFiles: new Set(scan.skippedFiles),
  };
}

/** Per-app count of kept findings that every given coverage audited. */
function countByApp(
  findings: readonly RemovalFinding[],
  ignores: ShopIgnores,
  coverages: readonly CoverageView[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of filterIgnoredFindings([...findings], ignores).kept) {
    if (f.appName === null || REMOVAL_EXCLUDED_TYPES.has(f.findingType)) continue;
    if (!coverages.every((c) => auditedIn(f, c.unaudited, c.skippedFiles))) continue;
    counts.set(f.appName, (counts.get(f.appName) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Live hooks
// ---------------------------------------------------------------------------

/**
 * `Scan.liveAppHooks`: app names with a live hook, per source. null = that
 * source was not observed on this scan.
 */
export interface LiveAppHooks {
  embedApps: string[] | null;
  scriptTagApps: string[] | null;
}

interface HookSets {
  embed: ReadonlySet<string> | null;
  scriptTag: ReadonlySet<string> | null;
}

const HOOK_SOURCES = ["embed", "scriptTag"] as const;

function parseHookList(raw: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) return null;
  return new Set(raw as string[]);
}

/**
 * Parse `Scan.liveAppHooks` (Json?). NULL or a non-object = never recorded
 * (null); a malformed source list is "not observed" for that source only.
 */
export function parseLiveAppHooks(raw: unknown): HookSets | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return { embed: parseHookList(record.embedApps), scriptTag: parseHookList(record.scriptTagApps) };
}

/**
 * The ScriptTag hook set from one storefront read: the signature app names in
 * the detector's groups. null (not observed) when a detector cap may have
 * dropped an app (too many URLs or groups), since a missing app would look
 * like an ended hook.
 */
export function scriptTagHookApps(
  urls: readonly string[],
  groups: ReadonlyArray<{ appName?: string | null }>,
): string[] | null {
  if (urls.length > MAX_SCRIPT_TAG_URLS || groups.length >= MAX_SCRIPT_TAG_GROUPS) return null;
  const apps = groups.map((g) => g.appName).filter((a): a is string => typeof a === "string");
  return [...new Set(apps)].sort();
}

/** True when X has a hook in any source `hooks` observed. */
function hasObservedHook(hooks: HookSets, appName: string): boolean {
  return HOOK_SOURCES.some((source) => hooks[source]?.has(appName) === true);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectedRemoval {
  appName: string;
  leftoverCount: number;
}

/**
 * Apps removed between `previous` and `current` (Rule 1D + guards), sorted by
 * appName. Empty when either scan lacks recorded hooks, a live set or
 * signature fingerprints (a legacy row cannot be judged).
 */
export function detectAppRemovals(
  current: RemovalScan,
  previous: RemovalScan,
  opts: { ignores: ShopIgnores },
): DetectedRemoval[] {
  const previousHooks = parseLiveAppHooks(previous.liveAppHooks);
  const currentHooks = parseLiveAppHooks(current.liveAppHooks);
  if (!previousHooks || !currentHooks) return [];
  const previousFingerprints = parseAppSignatureFingerprints(previous.appSignatureFingerprints);
  const currentFingerprints = parseAppSignatureFingerprints(current.appSignatureFingerprints);
  if (!previousFingerprints || !currentFingerprints) return [];
  // Without both live sets, an unrecorded type cannot be told from a clean one.
  if (
    !parseLiveFindingTypes(previous.liveFindingTypes) ||
    !parseLiveFindingTypes(current.liveFindingTypes)
  ) {
    return [];
  }

  // Apps hooked in P through a source observed in BOTH scans.
  const hookedBefore = new Set<string>();
  for (const source of HOOK_SOURCES) {
    const before = previousHooks[source];
    if (before && currentHooks[source]) for (const app of before) hookedBefore.add(app);
  }
  if (hookedBefore.size === 0) return [];

  const counts = countByApp(current.findings, opts.ignores, [
    coverageOf(previous),
    coverageOf(current),
  ]);
  const removals: DetectedRemoval[] = [];
  for (const appName of hookedBefore) {
    // Still live in S through any observed source: not removed.
    if (hasObservedHook(currentHooks, appName)) continue;
    const leftoverCount = counts.get(appName) ?? 0;
    // Nothing left behind: nothing to tell the merchant.
    if (leftoverCount === 0) continue;
    const fingerprint = currentFingerprints.get(appName);
    if (fingerprint === undefined || previousFingerprints.get(appName) !== fingerprint) continue;
    removals.push({ appName, leftoverCount });
  }
  return removals.sort((a, b) => a.appName.localeCompare(b.appName));
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export interface OpenRemoval {
  id: string;
  appName: string;
  leftoverCount: number;
}

/** A change to an open record; `state` is set only when it leaves REMOVED. */
export interface RemovalUpdate {
  id: string;
  leftoverCount: number;
  state?: typeof AppRemovalState.CLEANED | typeof AppRemovalState.REINSTALLED;
}

/**
 * The next state of a REMOVED record on `current`, or null for no change.
 *
 *   - No hook source observed on `current`: unchanged (cannot tell).
 *   - X has a live hook again in an observed source: REINSTALLED.
 *   - X has 0 findings left (ignores applied, SCRIPT_TAG_SUNSET excluded) with
 *     X's categories audited: CLEANED, keeping the record's last count.
 *   - Otherwise the leftover count is refreshed (null when unchanged).
 *
 * "X's categories" are the types of X's findings on `previous` (the scan
 * before `current` for this theme). If `previous` had none (its own view of X
 * was incomplete) or `current` did not audit any of them (scope revoked, cap,
 * file size-skipped), the count is unknown: unchanged. An APP-ignored app is
 * left unchanged (hiding its findings is not cleaning them), as is a record
 * with no `previous` (baseline pruned).
 */
export function nextRemovalState(
  record: OpenRemoval,
  current: RemovalScan,
  previous: RemovalScan | null,
  opts: { ignores: ShopIgnores },
): RemovalUpdate | null {
  const currentHooks = parseLiveAppHooks(current.liveAppHooks);
  if (!currentHooks || HOOK_SOURCES.every((source) => currentHooks[source] === null)) return null;
  if (hasObservedHook(currentHooks, record.appName)) {
    return {
      id: record.id,
      leftoverCount: record.leftoverCount,
      state: AppRemovalState.REINSTALLED,
    };
  }
  if (!previous || opts.ignores.appNames.has(record.appName)) return null;

  const currentCoverage = coverageOf(current);
  const priorOfApp = filterIgnoredFindings([...previous.findings], opts.ignores).kept.filter(
    (f) => f.appName === record.appName && !REMOVAL_EXCLUDED_TYPES.has(f.findingType),
  );
  if (
    priorOfApp.length === 0 ||
    priorOfApp.some((f) => !auditedIn(f, currentCoverage.unaudited, currentCoverage.skippedFiles))
  ) {
    return null;
  }

  const count =
    countByApp(current.findings, opts.ignores, [currentCoverage]).get(record.appName) ?? 0;
  // CLEANED keeps the last REMOVED count: what was cleaned up (Home's "The N
  // items X left behind are gone as of this scan").
  if (count === 0) {
    return { id: record.id, leftoverCount: record.leftoverCount, state: AppRemovalState.CLEANED };
  }
  return count === record.leftoverCount ? null : { id: record.id, leftoverCount: count };
}

/** Everything one scan changes: new removals and updates to open ones. */
export interface AppRemovalPlan {
  creates: DetectedRemoval[];
  updates: RemovalUpdate[];
}

/**
 * Plan the AppRemoval writes for `current`. Open (REMOVED) records detected on
 * `current` itself are skipped, so an Inngest retry never re-evaluates its own
 * fresh detections.
 */
export function planAppRemovals(input: {
  currentScanId: string;
  current: RemovalScan;
  previous: RemovalScan;
  openRemovals: ReadonlyArray<OpenRemoval & { detectedScanId: string }>;
  ignores: ShopIgnores;
}): AppRemovalPlan {
  const updates: RemovalUpdate[] = [];
  for (const record of input.openRemovals) {
    if (record.detectedScanId === input.currentScanId) continue;
    const update = nextRemovalState(record, input.current, input.previous, input);
    if (update) updates.push(update);
  }
  const creates = detectAppRemovals(input.current, input.previous, { ignores: input.ignores });
  return { creates, updates };
}
