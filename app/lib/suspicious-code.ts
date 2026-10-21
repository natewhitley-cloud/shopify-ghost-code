/**
 * Suspicious-code detector (gc-dcyh Phase 0): a DARK signal, ops telemetry
 * only. Flags theme asset JavaScript that was written to be unreadable
 * (obfuscated) or whose file name carries a pirated-theme marker
 * (`shrine.null.js`). Obfuscation is how hidden malicious code is usually
 * disguised, but some vendors obfuscate to protect licensed code, so this is a
 * "needs a look" likelihood, never a verdict. Phase 0 only counts hits into the
 * per-scan `scan_signal` OpsEvent to measure the false-positive rate on real
 * stores (spike: docs/spikes/gc-dcyh-nulled-theme-spike.md). It creates no
 * Finding rows and nothing reaches merchants.
 *
 * Pure and linear-time: every regex below is either a fixed literal prefix
 * followed by bounded character classes, or `\s*` runs separated by literals
 * that `\s` cannot match, so none can backtrack catastrophically. Pinned by a
 * 5 MB input under a time bound in tests/lib/suspicious-code.test.ts.
 */

export type SuspiciousCodeReason =
  | "filename_marker"
  | "packer"
  | "obfuscator_identifiers"
  | "hex_escape_density"
  | "charcode_eval";

export type SuspiciousCodeResult = { suspicious: boolean; reasons: SuspiciousCodeReason[] };

/** Per-scan aggregate written to scan_signal metadata (`suspiciousCode`). */
export type SuspiciousCodeSummary = {
  /** Every flagged file this scan (not capped). */
  fileCount: number;
  /** The first SUSPICIOUS_CODE_FILES_CAP flagged files, sorted by path. */
  files: Array<{ path: string; reasons: SuspiciousCodeReason[] }>;
  /** Flagged files per reason (a file with two reasons counts under both). */
  reasonCounts: Partial<Record<SuspiciousCodeReason, number>>;
};

export const SUSPICIOUS_CODE_FILES_CAP = 20;

/** javascript-obfuscator `_0x` identifiers needed to flag a file. */
export const OBFUSCATOR_IDENTIFIER_THRESHOLD = 20;
/** `\xNN` escapes per 1,000 characters needed to flag a file. */
export const HEX_ESCAPE_DENSITY_PER_1000 = 5;
/**
 * Minimum absolute `\xNN` count before density is considered, so a tiny file
 * with one escaped character (e.g. a 150-char helper with "\x20") is not
 * flagged on density alone. Obfuscated payloads carry hundreds.
 */
export const HEX_ESCAPE_MIN_COUNT = 20;

/**
 * Filename markers. Rule: take the LAST path segment (the file name), lower-case
 * it and split it into tokens on `.`, `-` and `_`.
 *   - `null` counts only as a dot-separated segment with a non-empty name
 *     before it (`shrine.null.js`, `theme.null.min.js`), the form pirated
 *     builds use. A bare `null.js`, `null-safe.js` and `is_null.js` are
 *     ordinary names and are NOT flagged.
 *   - `nulled` and `warez` count as any whole token (`theme-nulled.js`,
 *     `warez_loader.js`).
 * `crack` / `cracked` are not markers: theme effects use them (`crack-effect.js`,
 * `cracked_slider.js`, `no-crack.js`). Substrings of ordinary words never
 * count: `nullable-helper.js` and `annulled.js` are single tokens.
 */
const MARKER_TOKENS = new Set(["nulled", "warez"]);

export function hasFilenameMarker(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const segments = name.split(".");
  if (segments.some((seg, i) => seg === "null" && segments.slice(0, i).some(Boolean))) return true;
  return name.split(/[.\-_]/).some((token) => MARKER_TOKENS.has(token));
}

// Dean Edwards packer: `eval(function(p,a,c,k,e,r)` / `...e,d)` / `...e)`.
const PACKER_RE = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*[,)]/;
// javascript-obfuscator identifiers: `_0x` + 4 to 6 hex digits, not longer.
const OBFUSCATOR_ID_RE = /_0x[0-9a-f]{4,6}(?![0-9a-f])/g;
const HEX_ESCAPE_RE = /\\x[0-9a-fA-F]{2}/g;
// `fromCharCode(` with at least three numeric (decimal or hex) arguments.
const CHARCODE_RE =
  /fromCharCode\s*\(\s*(?:0x[0-9a-fA-F]+|\d+)\s*,\s*(?:0x[0-9a-fA-F]+|\d+)\s*,\s*(?:0x[0-9a-fA-F]+|\d+)/;
const EVAL_OR_ATOB_RE = /\b(?:eval|atob)\s*\(/;

/** Count matches of a global regex, stopping once `stopAt` is reached. */
function countMatches(re: RegExp, content: string, stopAt = Infinity): number {
  re.lastIndex = 0;
  let n = 0;
  while (n < stopAt && re.exec(content) !== null) n++;
  re.lastIndex = 0;
  return n;
}

/**
 * Whether a theme file gets this check: asset JavaScript only (`assets/*.js`,
 * `*.mjs`, `*.js.liquid`), a subset of the files the MALICIOUS_SCRIPT asset
 * pass already reads (isMaliciousScanOnlyFile). Asset files are never
 * size-skipped, so files over 1 MB are checked too.
 */
export function isSuspiciousCodeCandidate(path: string): boolean {
  if (!path.startsWith("assets/")) return false;
  return path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".js.liquid");
}

export function detectSuspiciousCode(path: string, content: string): SuspiciousCodeResult {
  const reasons: SuspiciousCodeReason[] = [];
  if (hasFilenameMarker(path)) reasons.push("filename_marker");
  if (PACKER_RE.test(content)) reasons.push("packer");
  if (
    countMatches(OBFUSCATOR_ID_RE, content, OBFUSCATOR_IDENTIFIER_THRESHOLD) >=
    OBFUSCATOR_IDENTIFIER_THRESHOLD
  ) {
    reasons.push("obfuscator_identifiers");
  }
  if (content.length > 0) {
    const hex = countMatches(HEX_ESCAPE_RE, content);
    if (
      hex >= HEX_ESCAPE_MIN_COUNT &&
      (hex * 1000) / content.length >= HEX_ESCAPE_DENSITY_PER_1000
    ) {
      reasons.push("hex_escape_density");
    }
  }
  if (CHARCODE_RE.test(content) && EVAL_OR_ATOB_RE.test(content)) reasons.push("charcode_eval");
  return { suspicious: reasons.length > 0, reasons };
}

/** Roll per-file hits up into the scan_signal shape (files sorted by path, capped). */
export function summarizeSuspiciousCode(
  hits: Array<{ path: string; reasons: SuspiciousCodeReason[] }>,
): SuspiciousCodeSummary {
  const reasonCounts: Partial<Record<SuspiciousCodeReason, number>> = {};
  for (const hit of hits) {
    for (const r of hit.reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  }
  const files = [...hits]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, SUSPICIOUS_CODE_FILES_CAP);
  return { fileCount: hits.length, files, reasonCounts };
}
