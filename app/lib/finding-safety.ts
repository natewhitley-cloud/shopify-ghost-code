/**
 * Removal-SAFETY axis for findings.
 *
 * This answers a different question from the other finding-* maps:
 *   - finding-classification.ts  → "how was this detected / can a shopper see it"
 *   - finding-consequence.ts     → "so what does it cost me, how urgently"
 *   - finding-safety.ts (HERE)   → "is it safe for ME to just delete this?"
 *
 * It is DISTINCT from both severity and detection-confidence. A finding can be
 * high-severity yet safe to remove, or low-severity yet something you must NOT
 * delete (fix the data / migrate instead). Because a wrong "safe-to-remove"
 * could break a merchant's live store, this map is deliberately CONSERVATIVE:
 * the default is "verify-first", and "safe-to-remove" is reserved for the
 * clearest orphan cases where deletion is genuinely inert.
 *
 * Pure, client-safe module (no .server suffix, no dependencies beyond a sibling
 * pure lib), mirroring app/lib/finding-classification.ts.
 */

/**
 * How safe it is for a merchant to remove the flagged code/resource themselves:
 *   - "safe-to-remove": the clearest orphan case — once the source app is
 *     confirmed uninstalled, deleting this is inert (nothing live depends on it).
 *   - "verify-first":   the conservative DEFAULT. Could be load-bearing, dynamic,
 *     shopper-visible, or false-positive-prone; check before deleting.
 *   - "leave-alone":    removal is the WRONG action. The right move is to migrate
 *     or fix the data, not delete (sunset mechanisms, conflict/invalid data,
 *     broken references, settings mismatches).
 */
export type RemovalSafety = "safe-to-remove" | "verify-first" | "leave-alone";

/**
 * Removal-safety per FindingType. EVERY enum member is listed explicitly so the
 * assignment is a deliberate, reviewable call (an exhaustiveness test guards the
 * coverage as the enum grows).
 *
 * Rationale per type / grouped block is inline. When in doubt: verify-first.
 */
const REMOVAL_SAFETY: Record<string, RemovalSafety> = {
  // ---- safe-to-remove: signature-matched orphan code that is inert once the
  // source app is gone. Deleting the tag/reference cannot break anything live. --
  // External app-CDN <script> — 404s / does nothing once the app is uninstalled.
  GHOST_SCRIPT: "safe-to-remove",
  // External app-CDN stylesheet <link> — its styles are already gone with the app.
  GHOST_STYLE: "safe-to-remove",
  // {% render %} of an app snippet — renders nothing/errors once the app is gone;
  // the orphaned snippet file is unreferenced.
  GHOST_SNIPPET: "safe-to-remove",
  // <link rel="preconnect"> to an app CDN — a pure network hint; removing it is
  // the most inert change of all (opens one fewer dead connection).
  GHOST_PRECONNECT: "safe-to-remove",

  // ---- leave-alone: removal is the wrong action; migrate or fix the data. ----
  // Two JSON-LD blocks disagree — fix/keep the correct one, don't blindly delete.
  JSON_LD_CONFLICT: "leave-alone",
  // Static JSON-LD price disagrees with live product — fix the data (or let
  // Shopify generate it), not a straight delete.
  JSON_LD_PRICE_CONFLICT: "leave-alone",
  // Malformed JSON-LD — the fix is to repair the JSON (or let an active app
  // regenerate it), not delete structured data outright.
  JSON_LD_INVALID: "leave-alone",
  // Theme references a deleted product/collection/page — repoint the link, don't
  // just remove it (a settings/data mismatch, not orphan clutter).
  DANGLING_REFERENCE: "leave-alone",
  // Sunset checkout.liquid — migrate to Checkout Extensibility, deletion loses
  // the customization entirely.
  CHECKOUT_SUNSET: "leave-alone",
  // settings_data.json references a missing section — safe to leave; never
  // hand-edit the JSON.
  SETTINGS_DRIFT: "leave-alone",

  // ---- verify-first (the conservative default) ----
  // Tracking pixel — could still be an active Google/Meta tag you rely on.
  GHOST_PIXEL: "verify-first",
  // AJAX call to an app endpoint — dependent inline JS may break if removed.
  GHOST_AJAX: "verify-first",
  // Font tied to an app CDN — the font may still be referenced elsewhere.
  GHOST_FONT: "verify-first",
  // Section reference — may still be placed in the theme customizer; shopper-visible.
  GHOST_SECTION: "verify-first",
  // Widget markup — shopper-visible content the merchant may want to keep.
  GHOST_TEXT: "verify-first",
  // Non-standard layout file — confirm no template still references it.
  GHOST_LAYOUT: "verify-first",
  // Unreferenced asset — the cross-file check misses dynamic {% render var %}.
  ORPHAN_ASSET: "verify-first",
  // hreflang tag — may still matter for a live Markets/translation setup.
  GHOST_HREFLANG: "verify-first",
  // Canonical tag — load-bearing SEO; confirm no active SEO app owns it.
  GHOST_CANONICAL: "verify-first",
  // Title override — confirm before letting Shopify's native title take over.
  GHOST_TITLE: "verify-first",
  // Open Graph tag — confirm the source app is gone before removing.
  GHOST_OG: "verify-first",
  // Robots directive — a noindex may be intentional; confirm first.
  GHOST_ROBOTS: "verify-first",
  // App-authored JSON-LD — may be the only structured data on the page.
  GHOST_JSON_LD: "verify-first",
  // Duplicate meta tag — decide which copy to keep before removing one.
  DUPLICATE_META: "verify-first",
  // Same JS library at two versions — consolidate to one, not a blind delete.
  DUPLICATE_LIBRARY: "verify-first",
  // Same analytics platform with two IDs — decide which ID is correct first.
  DUPLICATE_TRACKER: "verify-first",
  // Two chat widgets — pick the one to keep before removing the other.
  OVERLAPPING_CHAT_WIDGET: "verify-first",
  // Admin resources: reviewed and edited in Admin, not deleted as theme code, and
  // each can still be in use (driving a collection/automation, a menu link, a
  // live language, an active sale). Verify before acting.
  GHOST_PAGE: "verify-first",
  GHOST_TAG: "verify-first",
  GHOST_PRICE: "verify-first",
  GHOST_METAFIELD: "verify-first",
  GHOST_REDIRECT: "verify-first",
  GHOST_TRANSLATION: "verify-first",
};

/**
 * Conservative fallback for any unmapped/unknown type: never assume a new type
 * is safe to delete. Mirrors the "under-claim, never over-claim" default in
 * finding-classification.ts.
 */
const DEFAULT_REMOVAL_SAFETY: RemovalSafety = "verify-first";

/**
 * Short merchant-facing label per safety level. Kept here (not in the route) so
 * the label stays in sync with the level and is unit-testable.
 */
export const REMOVAL_SAFETY_LABELS: Record<RemovalSafety, string> = {
  "safe-to-remove": "Safe to remove",
  "verify-first": "Verify first",
  "leave-alone": "Leave in place",
};

/**
 * Returns the removal-safety level for a finding type. Unknown/unmapped types
 * fall back to the conservative default ("verify-first") — never "safe-to-remove".
 *
 * Pure function of findingType — no database lookup required.
 */
export function getRemovalSafety(findingType: string): RemovalSafety {
  return REMOVAL_SAFETY[findingType] ?? DEFAULT_REMOVAL_SAFETY;
}

/**
 * Exposed for the exhaustiveness / drift-guard test: the raw per-type map. Not
 * for rendering — use getRemovalSafety() there so the default is applied.
 */
export const REMOVAL_SAFETY_MAP = REMOVAL_SAFETY;
