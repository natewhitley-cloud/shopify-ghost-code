/**
 * Theme file manifests for the "What changed" log (gc-rrh.4, spec 1 and 2.2).
 *
 * Pure and client-safe. A manifest is one scan's list of theme files with
 * Shopify's checksum, size and last-updated time, plus the app that owns each
 * file (by filename or snippet name, never by content). Hashes and metadata
 * only: no file content is ever stored. Two manifests of the same theme (or
 * of two themes: hashes make that valid) are compared with `diffManifests`.
 */

import { classifyThemeFile } from "./theme-file-kind";

/** Entry encoding version, stored on each ScanManifest row. */
export const MANIFEST_VERSION = 1;

/** `[path, md5 | null, size | null, updatedAtEpochSec | null, ownerApp | null]`. */
export type ManifestEntry = [
  path: string,
  md5: string | null,
  size: number | null,
  updatedAtEpochSec: number | null,
  ownerApp: string | null,
];

/** One file's metadata as the theme fetcher reports it (ThemeFileMeta). */
export type ManifestFileMeta = {
  filename: string;
  checksumMd5: string | null;
  size: number | null;
  updatedAt: string | null;
};

/**
 * Build the sorted manifest entries for one scan.
 *
 * - Sorted by path (code-unit order), so equal themes give equal JSON.
 * - A path reported twice keeps its first report (Shopify never repeats one;
 *   this only keeps the diff well defined).
 * - `ownerAppOf` names the app that owns a path (filename / snippet name
 *   rules, applied by the caller); omitted = no owner recorded.
 */
export function buildManifestEntries(
  metas: readonly ManifestFileMeta[],
  ownerAppOf: (path: string) => string | null = () => null,
): ManifestEntry[] {
  const byPath = new Map<string, ManifestEntry>();
  for (const meta of metas) {
    if (byPath.has(meta.filename)) continue;
    byPath.set(meta.filename, [
      meta.filename,
      meta.checksumMd5,
      meta.size,
      toEpochSeconds(meta.updatedAt),
      ownerAppOf(meta.filename),
    ]);
  }
  return [...byPath.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function toEpochSeconds(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** UTF-8 size of the stored entries JSON (telemetry: manifestBytes). */
export function manifestBytes(entries: readonly ManifestEntry[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).length;
}

const isNullableString = (v: unknown) => v === null || typeof v === "string";
const isNullableNumber = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v));

/**
 * Read stored `ScanManifest.entries` back. Any malformed value means the whole
 * manifest is unusable (null), so a bad row can only make a check a baseline,
 * never invent changes.
 */
export function parseManifestEntries(raw: unknown): ManifestEntry[] | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 5 ||
      typeof entry[0] !== "string" ||
      !isNullableString(entry[1]) ||
      !isNullableNumber(entry[2]) ||
      !isNullableNumber(entry[3]) ||
      !isNullableString(entry[4])
    ) {
      return null;
    }
  }
  return raw as ManifestEntry[];
}

/**
 * Whether one path's file differs between two manifests. Checksums decide
 * when both sides have one. Otherwise size and updatedAt decide, each only
 * when both sides have it; with nothing comparable the file is treated as
 * unchanged (never a false change). The owner app is never compared: a
 * signature edit is not a file change (spec 2.7).
 */
export function entryChanged(before: ManifestEntry, after: ManifestEntry): boolean {
  if (before[1] !== null && after[1] !== null) return before[1] !== after[1];
  if (before[2] !== null && after[2] !== null && before[2] !== after[2]) return true;
  if (before[3] !== null && after[3] !== null && before[3] !== after[3]) return true;
  return false;
}

/** MD5 of zero bytes: unrelated empty files share it, so it never pairs a rename. */
const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

export type ManifestDiff = {
  added: ManifestEntry[];
  removed: ManifestEntry[];
  changed: Array<{ before: ManifestEntry; after: ManifestEntry }>;
  /** A removed and an added file with the same (non-empty) checksum. */
  renamed: Array<{ from: ManifestEntry; to: ManifestEntry }>;
};

/**
 * Compare a baseline manifest with the current one. Every list is in path
 * order. Renames pair removed and added files one to one by checksum, in path
 * order; a file in a rename is in neither `added` nor `removed`.
 */
export function diffManifests(
  baseline: readonly ManifestEntry[],
  current: readonly ManifestEntry[],
): ManifestDiff {
  const before = new Map(baseline.map((e) => [e[0], e]));
  const after = new Map(current.map((e) => [e[0], e]));
  const byPath = (a: ManifestEntry, b: ManifestEntry) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  const changed: ManifestDiff["changed"] = [];
  const addedAll: ManifestEntry[] = [];
  for (const entry of [...after.values()].sort(byPath)) {
    const prior = before.get(entry[0]);
    if (!prior) addedAll.push(entry);
    else if (entryChanged(prior, entry)) changed.push({ before: prior, after: entry });
  }
  const removedAll = [...before.values()].filter((e) => !after.has(e[0])).sort(byPath);

  const removedByMd5 = new Map<string, ManifestEntry[]>();
  for (const entry of removedAll) {
    if (entry[1] === null || entry[1] === EMPTY_MD5) continue;
    const list = removedByMd5.get(entry[1]) ?? [];
    list.push(entry);
    removedByMd5.set(entry[1], list);
  }
  const renamed: ManifestDiff["renamed"] = [];
  const pairedRemoved = new Set<string>();
  const added: ManifestEntry[] = [];
  for (const entry of addedAll) {
    const from = entry[1] === null ? undefined : removedByMd5.get(entry[1])?.shift();
    if (from) {
      renamed.push({ from, to: entry });
      pairedRemoved.add(from[0]);
    } else {
      added.push(entry);
    }
  }
  const removed = removedAll.filter((e) => !pairedRemoved.has(e[0]));
  return { added, removed, changed, renamed };
}

// ---------------------------------------------------------------------------
// App blocks (spec 2.9): captured now for phase 2, never compared in v1.
// ---------------------------------------------------------------------------

export type AppBlockRef = { handle: string; block: string; file: string };

/** Bound on stored refs per scan, so a pathological theme cannot bloat the row. */
export const MAX_APP_BLOCK_REFS = 500;

const APP_BLOCK_REF = /shopify:\/\/apps\/([A-Za-z0-9_-]{1,100})\/blocks\/([A-Za-z0-9_-]{1,100})\//g;

/**
 * App blocks and embeds referenced by the theme's editor data (JSON templates,
 * section groups, settings_data.json), as `shopify://apps/<handle>/blocks/
 * <block>/...` block types. Read from content already in memory; only the
 * handle, block name and file path are kept. Deduplicated, sorted by file then
 * handle then block, capped at MAX_APP_BLOCK_REFS. A JSON file with a comment
 * header is read the same way (no JSON parse).
 */
export function extractAppBlockRefs(
  files: ReadonlyArray<{ filename: string; content: string }>,
): AppBlockRef[] {
  const seen = new Set<string>();
  const refs: AppBlockRef[] = [];
  for (const file of files) {
    if (classifyThemeFile(file.filename) !== "editor_data") continue;
    for (const match of file.content.matchAll(APP_BLOCK_REF)) {
      const ref = { handle: match[1], block: match[2], file: file.filename };
      const key = `${ref.file}\n${ref.handle}\n${ref.block}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  refs.sort((a, b) => cmp(a.file, b.file) || cmp(a.handle, b.handle) || cmp(a.block, b.block));
  return refs.slice(0, MAX_APP_BLOCK_REFS);
}
