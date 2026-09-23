// ---------------------------------------------------------------------------
// Detector: CHECKOUT_SUNSET — checkout-extensibility "what broke" auditor (gc-b3c)
// ---------------------------------------------------------------------------
//
// PURE, side-effect-free. Operates ONLY on theme files already fetched by the
// scan worker (scope `read_themes`; NOT scope-gated). No Admin API, DB, or
// network access.
//
// Background: Shopify sunset the legacy `checkout.liquid` customization
// mechanism. For Shopify Plus stores it is HARD-BLOCKED as of ~Aug 13, 2026 —
// after that date `layout/checkout.liquid` no longer renders, so every
// customization it carries (custom scripts, tracking/analytics pixels, injected
// snippets, theme-injected content) silently stops working at checkout, the most
// conversion-critical step.
//
// Two checks (v1 scope — nothing more):
//   1. PRESENCE: `layout/checkout.liquid` exists with non-trivial content →
//      emit one CHECKOUT_SUNSET finding. The file itself is what the hard-block
//      kills, so its mere presence (once it holds real content) is the defect.
//   2. CUSTOMIZATION DEPTH: within that file, detect customization signals
//      (`<script>` tags, tracking/analytics snippets, `{% render %}` /
//      `{% include %}`, `content_for_*`) to describe WHAT specifically will
//      break. This does NOT emit a second finding — it enriches the single
//      presence finding's `description` and sets the `appName` subtype tag
//      (mirroring how DANGLING_REFERENCE carries its subtype at runtime: ONE
//      FindingType, subtype in description + appName, no new DB column).
//
// Deliberately NOT built (intentionally out of v1 reach — false-positive-prone
// or unreachable at our scopes):
//   - `content_for_additional_scripts` residue in theme.liquid (standard in
//     nearly every theme layout → would flag almost everyone).
//   - ScriptTag-API detection (needs read_script_tags, which we do not request).
//   - Additional-Scripts / Order-Status detection (no GraphQL surface at any
//     scope).

import { FindingType, Severity } from "@prisma/client";

import { buildSnippet, MAX_SCANNABLE_FILE_BYTES, type ThemeFile } from "./scan-engine.server";
import type { CreateFindingInput } from "../models/finding.server";

/** The single legacy checkout layout file the sunset hard-block targets. */
export const CHECKOUT_LIQUID_PATH = "layout/checkout.liquid";

/** Human-facing sunset date used in copy. */
const SUNSET_DATE = "around August 13, 2026";

// Blank out Liquid comment blocks and HTML comments so commented-out code counts
// as neither content (trivial-check) nor a customization signal (depth-check).
// Comment bodies are replaced with spaces while NEWLINES ARE PRESERVED, so the
// stripped view keeps a 1:1 line-number mapping to the original file — the
// evidence anchor (firstSignalLine) can scan the stripped view and its line
// numbers still point at the right line in the file the merchant will open.
//
// The comments are located with separate opener/closer searches rather than a
// single lazy `OPEN[\s\S]*?CLOSE` regex (gc-4yg): with many openers and no
// closer, that regex rescans to EOF from every opener, which is quadratic
// (400 KB of `<!--` took ~23s). This detector runs on the MAIN thread in the
// scan-theme step, so that would stall every tenant, not just one scan worker.
const LIQUID_COMMENT_OPEN_RE = /\{%-?\s*comment\s*-?%\}/gi;
const LIQUID_COMMENT_CLOSE_RE = /\{%-?\s*endcomment\s*-?%\}/gi;
const HTML_COMMENT_OPEN_RE = /<!--/g;
const HTML_COMMENT_CLOSE_RE = /-->/g;

/** Replace every non-newline character in a match with a space. */
function blankKeepingNewlines(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

/**
 * Exactly `content.replace(/OPEN[\s\S]*?CLOSE/g, blankKeepingNewlines)`, in
 * linear time. Both regexes must carry the /g flag and match in only one way at
 * a given position (true of the delimiters above), so:
 *   - the regex's match starts at the first OPEN at or after the resume point
 *     that has a CLOSE after it, and its lazy body ends at the FIRST such CLOSE;
 *   - if the first OPEN has no CLOSE after it, no later OPEN does either, so
 *     the regex cannot match again: stop;
 *   - after a match, scanning resumes after the CLOSE, like the regex's
 *     lastIndex, so every searched span is visited once.
 */
function blankDelimited(content: string, openRe: RegExp, closeRe: RegExp): string {
  let out = "";
  let copied = 0;
  openRe.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(content)) !== null) {
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(content);
    if (close === null) break;
    const end = close.index + close[0].length;
    out += content.slice(copied, open.index) + blankKeepingNewlines(content.slice(open.index, end));
    copied = end;
    openRe.lastIndex = end;
  }
  return out + content.slice(copied);
}

/**
 * Blank Liquid comment blocks, then HTML comments, keeping newlines (and so
 * the length and every line number). Exported for tests.
 */
export function stripComments(content: string): string {
  const withoutLiquid = blankDelimited(content, LIQUID_COMMENT_OPEN_RE, LIQUID_COMMENT_CLOSE_RE);
  return blankDelimited(withoutLiquid, HTML_COMMENT_OPEN_RE, HTML_COMMENT_CLOSE_RE);
}

// ---------------------------------------------------------------------------
// Customization-depth signals
// ---------------------------------------------------------------------------
//
// Each signal maps a detection regex to (a) the subtype slug it contributes and
// (b) the merchant-facing "what breaks" clause. Ordered by impact: the FIRST
// matching signal (top-down) becomes the finding's subtype tag (`appName`), but
// EVERY matching signal's clause is listed in the description.

interface DepthSignal {
  /** Subtype slug carried in `appName` when this is the dominant signal. */
  subtype: string;
  /** Detection regex, run against comment-stripped content. */
  test: RegExp;
  /** Merchant-facing description of what this customization loses at cutover. */
  breaks: string;
}

// NOTE: order = impact priority. `<script>` (arbitrary custom JS) is the
// highest-impact break; a plain layout file with only the required injection
// objects is the lowest.
const DEPTH_SIGNALS: DepthSignal[] = [
  {
    subtype: "scripts",
    test: /<script[\s>]/i,
    breaks: "custom <script> code will stop executing at checkout",
  },
  {
    subtype: "tracking",
    // Common analytics/pixel identifiers merchants hand-place in checkout.liquid.
    // Specific tokens (not a bare "ga") to keep false positives low.
    test: /\b(?:gtag|fbq|dataLayer|_gaq|ttq\.|pintrk|snaptr|google-analytics|googletagmanager|analytics\.js)\b/i,
    breaks: "checkout tracking and analytics pixels will stop firing",
  },
  {
    subtype: "snippets",
    test: /\{%-?\s*(?:render|include)\s+/i,
    breaks: "custom snippets rendered into checkout will no longer load",
  },
  {
    subtype: "content-injection",
    test: /content_for_\w+/i,
    breaks: "theme-injected checkout content (content_for_*) will no longer render",
  },
];

/**
 * Subtype used when the file is non-trivial but carries no recognized signal,
 * or is too large to analyze (see the size guard in detectCheckoutSunset).
 */
const LAYOUT_SUBTYPE = "layout";

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Detect reliance on the sunset `checkout.liquid` mechanism across a set of
 * already-fetched theme files.
 *
 * Returns at most ONE finding: none when `layout/checkout.liquid` is absent or
 * trivial (empty / whitespace / comments only), otherwise a single
 * CHECKOUT_SUNSET finding whose `appName` is the dominant customization subtype
 * and whose `description` explains the dated hard-block plus every specific
 * customization that will break.
 *
 * A checkout.liquid over MAX_SCANNABLE_FILE_BYTES is not analyzed (this runs
 * on the main thread, and no real layout file is that large). It still gets
 * the presence finding: the file existing is itself the defect the hard-block
 * creates, and a file that large is certainly not an empty husk, so dropping
 * the finding would hide a real checkout breakage. The finding is the generic
 * "layout" one, claiming no specific customization. The scanner skips and
 * records the same file (ScanResult.skippedFiles), and the caller logs it.
 */
export function detectCheckoutSunset(files: ThemeFile[]): CreateFindingInput[] {
  const checkoutFile = files.find((f) => f.filename === CHECKOUT_LIQUID_PATH);
  if (!checkoutFile) return [];

  if (checkoutFile.content.length > MAX_SCANNABLE_FILE_BYTES) {
    return [sunsetFinding(checkoutFile, LAYOUT_SUBTYPE, 1, layoutDescription())];
  }

  // Check 1 — PRESENCE with non-trivial content. A file that is empty or holds
  // only comments/whitespace is a leftover husk, not a live customization, so it
  // is not flagged.
  const meaningful = stripComments(checkoutFile.content).trim();
  if (meaningful.length === 0) return [];

  // Check 2 — CUSTOMIZATION DEPTH. Detect against comment-stripped content so a
  // commented-out <script> is not counted as a live customization.
  const stripped = stripComments(checkoutFile.content);
  const matched = DEPTH_SIGNALS.filter((s) => s.test.test(stripped));

  const subtype = matched.length > 0 ? matched[0].subtype : LAYOUT_SUBTYPE;

  // Point the evidence at the first line carrying the DOMINANT (subtype)
  // signal, scanning the comment-stripped view so a commented-out occurrence is
  // never selected as the proof of a live-breakage claim; fall back to line 1
  // for a plain layout file with no signals.
  const lineNumber = matched.length > 0 ? (firstSignalLine(stripped, matched[0]) ?? 1) : 1;

  const description =
    matched.length > 0
      ? `Your theme relies on checkout.liquid to customize checkout. Shopify hard-blocks ` +
        `checkout.liquid for Plus stores ${SUNSET_DATE}; after that this file no longer ` +
        `renders. What breaks: ${joinClauses(matched.map((s) => s.breaks))}. Migrate these ` +
        `customizations to Checkout Extensibility.`
      : layoutDescription();

  return [sunsetFinding(checkoutFile, subtype, lineNumber, description)];
}

/** Description for a checkout.liquid with no recognized (or analyzed) signal. */
function layoutDescription(): string {
  return (
    `Your theme still includes checkout.liquid to customize checkout. Shopify hard-blocks ` +
    `checkout.liquid for Plus stores ${SUNSET_DATE}; after that this file no longer ` +
    `renders. Migrate any checkout customization to Checkout Extensibility.`
  );
}

function sunsetFinding(
  checkoutFile: ThemeFile,
  subtype: string,
  lineNumber: number,
  description: string,
): CreateFindingInput {
  return {
    filename: CHECKOUT_LIQUID_PATH,
    lineNumber,
    codeSnippet: buildSnippet(checkoutFile.content, lineNumber),
    findingType: FindingType.CHECKOUT_SUNSET,
    // HIGH: the file stops rendering entirely at the hard-block; there is no
    // higher tier than HIGH in this app.
    severity: Severity.HIGH,
    // Structured subtype tag (mirrors DANGLING_REFERENCE): the UI can badge the
    // customization depth without parsing the description.
    appName: subtype,
    description,
  };
}

/**
 * Line number (1-based) of the first line matching the given signal, or null
 * when no single line matches (e.g. a signal that only matches across a line
 * break). Callers pass the DOMINANT (subtype-determining) signal so the evidence
 * line corroborates the finding's subtype badge, and pass the comment-stripped
 * view (line-preserving) so a commented-out occurrence can never be selected.
 */
function firstSignalLine(content: string, signal: DepthSignal): number | null {
  const fileLines = content.split("\n");
  for (let i = 0; i < fileLines.length; i++) {
    if (signal.test.test(fileLines[i])) return i + 1;
  }
  return null;
}

/**
 * Join clauses into a readable list: "a", "a and b", "a, b, and c" (Oxford
 * comma), so the description reads as prose rather than a raw array.
 */
function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}
