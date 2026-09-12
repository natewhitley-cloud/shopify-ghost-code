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

import { buildSnippet, type ThemeFile } from "./scan-engine.server";
import type { CreateFindingInput } from "../models/finding.server";

/** The single legacy checkout layout file the sunset hard-block targets. */
const CHECKOUT_LIQUID_PATH = "layout/checkout.liquid";

/** Human-facing sunset date used in copy. */
const SUNSET_DATE = "around August 13, 2026";

// Blank out Liquid comment blocks and HTML comments so commented-out code counts
// as neither content (trivial-check) nor a customization signal (depth-check).
// Comment bodies are replaced with spaces while NEWLINES ARE PRESERVED, so the
// stripped view keeps a 1:1 line-number mapping to the original file — the
// evidence anchor (firstSignalLine) can scan the stripped view and its line
// numbers still point at the right line in the file the merchant will open.
const LIQUID_COMMENT_RE = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Replace every non-newline character in a match with a space. */
function blankKeepingNewlines(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

function stripComments(content: string): string {
  return content
    .replace(LIQUID_COMMENT_RE, blankKeepingNewlines)
    .replace(HTML_COMMENT_RE, blankKeepingNewlines);
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

/** Subtype used when the file is non-trivial but carries no recognized signal. */
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
 */
export function detectCheckoutSunset(files: ThemeFile[]): CreateFindingInput[] {
  const checkoutFile = files.find((f) => f.filename === CHECKOUT_LIQUID_PATH);
  if (!checkoutFile) return [];

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
      : `Your theme still includes checkout.liquid to customize checkout. Shopify hard-blocks ` +
        `checkout.liquid for Plus stores ${SUNSET_DATE}; after that this file no longer ` +
        `renders. Migrate any checkout customization to Checkout Extensibility.`;

  return [
    {
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
    },
  ];
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
