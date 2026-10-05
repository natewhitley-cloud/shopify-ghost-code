/**
 * Human-readable labels for each FindingType, shared by the scan-detail UI and
 * the merchant alert email so the two never drift. Unknown types fall back to
 * the raw enum with underscores replaced (see findingTypeLabel).
 */
export const FINDING_TYPE_LABELS: Record<string, string> = {
  GHOST_SCRIPT: "Scripts",
  GHOST_STYLE: "Styles",
  GHOST_SNIPPET: "Snippets",
  GHOST_SECTION: "Sections",
  GHOST_HREFLANG: "Hreflang Tags",
  ORPHAN_ASSET: "Orphan Assets",
  DUPLICATE_META: "Duplicate Meta Tags",
  GHOST_JSON_LD: "JSON-LD Schema",
  GHOST_TEXT: "Widget Text",
  GHOST_TRANSLATION: "Translations",
  SETTINGS_DRIFT: "Settings Drift",
  GHOST_PIXEL: "Tracking Pixels",
  JSON_LD_CONFLICT: "JSON-LD Conflicts",
  JSON_LD_PRICE_CONFLICT: "JSON-LD Price Mismatch",
  JSON_LD_INVALID: "Invalid JSON-LD",
  MALICIOUS_SCRIPT: "Malicious Scripts",
  GHOST_LAYOUT: "Layout Code",
  GHOST_TAG: "Product Tags",
  GHOST_PRICE: "Compare-at Prices",
  GHOST_PAGE: "Content Pages",
  GHOST_METAFIELD: "Metafields",
  GHOST_REDIRECT: "Redirects",
  GHOST_ROBOTS: "Robots Meta Tags",
  GHOST_CANONICAL: "Canonical Tags",
  GHOST_TITLE: "Title Tags",
  GHOST_OG: "Open Graph Tags",
  GHOST_PRECONNECT: "Preconnect Hints",
  GHOST_FONT: "Font References",
  GHOST_AJAX: "AJAX Requests",
  DUPLICATE_LIBRARY: "Duplicate Libraries",
  DANGLING_REFERENCE: "Broken Links",
  CHECKOUT_SUNSET: "Checkout Sunset",
  DUPLICATE_TRACKER: "Duplicate Tracking Tags",
  OVERLAPPING_CHAT_WIDGET: "Overlapping Chat Widgets",
  APP_EMBED_OFF: "App Embeds Turned Off",
  GHOST_APP_EMBED: "Leftover App Embeds",
  SCRIPT_TAG_SUNSET: "Script Tag Sunset",
};

/** Label for a finding type, falling back to the enum name with spaces. */
export function findingTypeLabel(findingType: string): string {
  return FINDING_TYPE_LABELS[findingType] ?? findingType.replace(/_/g, " ");
}
