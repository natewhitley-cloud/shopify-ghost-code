/**
 * App-removal detection (gc-frda). Pure: no DB access, no I/O.
 *
 * Rule 1A: app X counts as REMOVED on scan S when, against the previous
 * successful scan P of the SAME shop + theme, P had ZERO audited findings
 * attributed to X and S has at least one. Guards, all of which must pass:
 *
 *   1. Coverage: a finding only counts when its type was audited in BOTH scans
 *      (not skipped / capped / unreachable / not live in either; see
 *      unauditedCategories) and, for a per-file type, its file was scanned in
 *      both (not size-skipped in either; same rule as diffScans). Real case:
 *      P skipped GHOST_METAFIELD (read_products not granted), the merchant
 *      granted it, S found 172 metafields for one app. That is a newly checked
 *      category, not an uninstall.
 *   2. Signature: X's signature fingerprint (APP_SIGNATURES) must be recorded
 *      on both scans and equal. A signature edit that makes existing code newly
 *      match X is not a removal. A legacy P (no fingerprints) yields none.
 *   3. Ignores: findings the merchant ignored (APP or INSTANCE scope) are
 *      dropped from both sides first, with the merchant alert's filter.
 *   4. Live-app types: SCRIPT_TAG_SUNSET findings describe an app that is still
 *      LIVE on the storefront, so they never count toward a removal.
 *
 * Embed changes alone are never a trigger.
 */

import { AppRemovalState } from "@prisma/client";

import { filterIgnoredFindings, type IgnorableFinding } from "./finding-aggregation.server";
import { djb2Hex, parseLiveFindingTypes, unauditedCategories } from "./scan-differ.server";
import type { ScanCoverage } from "./scan-differ.server";
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
// Detection
// ---------------------------------------------------------------------------

export interface DetectedRemoval {
  appName: string;
  leftoverCount: number;
}

/**
 * Apps removed between `previous` and `current` (Rule 1A + guards), sorted by
 * appName. Empty when either scan lacks a live set or signature fingerprints
 * (a legacy row cannot be judged).
 */
export function detectAppRemovals(
  current: RemovalScan,
  previous: RemovalScan,
  opts: { ignores: ShopIgnores },
): DetectedRemoval[] {
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

  const both = [coverageOf(previous), coverageOf(current)];
  const before = countByApp(previous.findings, opts.ignores, both);
  const after = countByApp(current.findings, opts.ignores, both);

  const removals: DetectedRemoval[] = [];
  for (const [appName, leftoverCount] of after) {
    if ((before.get(appName) ?? 0) > 0) continue;
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
 * `previous` is the scan before `current` for the same theme: X's findings
 * there name the categories X's leftovers live in. If `previous` had none
 * (its own view of X was incomplete) or `current` did not audit any of them
 * (scope revoked, cap, file size-skipped), X's count is unknown and nothing
 * changes. Otherwise, with ignores applied and SCRIPT_TAG_SUNSET
 * excluded:
 *   - 0 findings and X's embed is enabled -> REINSTALLED (a live app's own-file
 *     findings are dropped by the scanner, so its code no longer shows);
 *   - 0 findings -> CLEANED;
 *   - otherwise the leftover count is refreshed (null when unchanged).
 * `enabledEmbedApps` null (not known for this run) leaves a 0-count record
 * unchanged. An APP-ignored app is left unchanged: hiding its findings is not
 * cleaning them. No `previous` (baseline pruned) means X's categories are
 * unknown: unchanged.
 */
export function nextRemovalState(
  record: OpenRemoval,
  current: RemovalScan,
  previous: RemovalScan | null,
  opts: { ignores: ShopIgnores; enabledEmbedApps: ReadonlySet<string> | null },
): RemovalUpdate | null {
  if (!previous || opts.ignores.appNames.has(record.appName)) return null;
  const currentCoverage = coverageOf(current);

  const priorOfApp = filterIgnoredFindings([...previous.findings], opts.ignores).kept.filter(
    (f) => f.appName === record.appName && !REMOVAL_EXCLUDED_TYPES.has(f.findingType),
  );
  // No prior finding: the last evaluation could not see X's leftovers (its
  // categories were un-audited then), so they are still unknown.
  if (
    priorOfApp.length === 0 ||
    priorOfApp.some((f) => !auditedIn(f, currentCoverage.unaudited, currentCoverage.skippedFiles))
  ) {
    return null;
  }

  const count = countByApp(current.findings, opts.ignores, [currentCoverage]).get(record.appName);
  if (count === undefined) {
    if (!opts.enabledEmbedApps) return null;
    return {
      id: record.id,
      leftoverCount: 0,
      state: opts.enabledEmbedApps.has(record.appName)
        ? AppRemovalState.REINSTALLED
        : AppRemovalState.CLEANED,
    };
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
  enabledEmbedApps: ReadonlySet<string> | null;
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
