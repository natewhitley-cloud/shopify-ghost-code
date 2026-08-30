/**
 * Per-finding-type removal guidance.
 *
 * The scanner tells merchants WHERE ghost code lives (file, line, snippet).
 * This map adds the safe next step: how to remove it without breaking their
 * store. Each blurb is one to two sentences, written for a non-technical
 * merchant, and is accurate to what the finding actually represents.
 *
 * Two broad shapes of guidance:
 *   - Theme-file edits (scripts, tags, snippets, sections, assets, SEO/meta
 *     markup): always confirm the app is uninstalled, then duplicate the live
 *     theme as a backup before deleting code in the theme editor.
 *   - Shopify Admin resources (pages, product tags, metafields, URL redirects,
 *     compare-at prices, translations): these are NOT theme code, so guidance
 *     points at the correct Admin surface instead of the code editor.
 *
 * This is a pure, client-safe module (no .server suffix, no dependencies),
 * mirroring app/lib/finding-classification.ts.
 */

const REMEDIATION: Record<string, string> = {
  // ---- Theme-file edits: injected scripts and network calls ----
  GHOST_SCRIPT:
    "Once you have confirmed the app is uninstalled, this script tag can be removed from the theme file. Duplicate your live theme first (Online Store, Themes, Actions, Duplicate), then delete the tag in the theme code editor.",
  GHOST_PIXEL:
    "This is a tracking pixel injected into your theme. If it belongs to an app you have uninstalled, it may still be sending visitor data to a service you no longer use. Confirm this is not a pixel you still rely on (for example, an active Google or Meta tag) before removing its snippet from the theme file. Duplicate the theme first as a backup.",
  GHOST_AJAX:
    "This code still calls an uninstalled app's API on every page load, slowing the page for no benefit. Once you confirm the app is removed, delete the request from the theme file. Duplicate the theme first.",
  GHOST_PRECONNECT:
    "This preconnect hint opens a network connection to an app CDN you no longer use, adding needless overhead. Remove the link tag from the head in your theme code after duplicating the theme as a backup.",
  GHOST_FONT:
    "This font reference loads a file tied to an app you may have removed. Confirm the font is not used elsewhere, then delete the declaration from the theme file or stylesheet. Duplicate the theme first.",
  GHOST_STYLE:
    "This external stylesheet loads from an app you may have removed. Once confirmed, delete the link tag (or the orphaned CSS file) from the theme. Duplicate the theme first.",

  // ---- Theme-file edits: SEO and meta markup in the head ----
  GHOST_CANONICAL:
    "This canonical tag can override Shopify's own and point search engines at the wrong URL. After confirming no active SEO app owns it, remove the tag from the theme head. Duplicate the theme first and recheck your canonical URLs afterward.",
  GHOST_TITLE:
    "This title tag override was likely left by an SEO app. Remove it from the theme head so Shopify's native title logic takes over. Duplicate the theme as a backup first.",
  GHOST_OG:
    "This Open Graph tag controls how pages look when shared on social media. If the app that added it is gone, remove the tag from the theme head (duplicate the theme first) and let Shopify generate the defaults.",
  GHOST_HREFLANG:
    "This hreflang tag points search engines at translated URLs that may no longer exist. Once you confirm the translation app is uninstalled, remove the tag from the theme head. Duplicate the theme first.",
  GHOST_JSON_LD:
    "This JSON-LD structured-data block was likely left by an uninstalled app and can confuse search engines. Remove the application/ld+json script block from the theme file after duplicating the theme as a backup.",
  JSON_LD_CONFLICT:
    "Two JSON-LD blocks describe the same thing, which can make search engines ignore both. Keep the one Shopify or your active app generates and remove the conflicting block from the theme file. Duplicate the theme first.",
  DUPLICATE_META:
    "This meta tag is duplicated in the same file, which crawlers may handle unpredictably. Remove the redundant copy, keeping one. Duplicate the theme as a backup first.",
  GHOST_ROBOTS:
    "This meta robots directive may be blocking search engines from indexing pages. Confirm it is not intentional, then remove it from the theme file (duplicate the theme first) so pages can be indexed normally.",

  // ---- Theme-file edits: snippets, sections, layouts, assets, widgets ----
  GHOST_SNIPPET:
    "This Liquid render or include points at a snippet left by an app you may have removed. After confirming the app is uninstalled, delete the reference and the orphaned snippet file from the theme. Duplicate the theme first.",
  GHOST_SECTION:
    "This section reference belongs to an app you may no longer use. Once confirmed, remove the section (in Customize or the code editor) and delete the orphaned section file. Duplicate the theme first.",
  GHOST_LAYOUT:
    "This non-standard layout file was likely created by a page-builder app. If that app is uninstalled, confirm no template still references the layout, then delete the file. Duplicate the theme as a backup first.",
  ORPHAN_ASSET:
    "This asset file no longer appears to be referenced anywhere in the theme. After confirming nothing uses it, delete it from Assets in the theme code editor. Duplicate the theme as a backup first.",
  GHOST_TEXT:
    "This widget markup was likely left by an uninstalled app and may still show on your storefront. After confirming the app is gone, remove the markup from the theme file. Duplicate the theme first.",

  // ---- Shopify Admin resources (not theme code) ----
  GHOST_PAGE:
    "This page was likely created by an app you no longer use. If you do not need it, delete it in Online Store, Pages. Check your navigation menus for links to it first.",
  GHOST_TAG:
    "This product tag was likely added by an app you no longer use. Remove it from the affected product under Products, or in bulk, once you confirm it is not still driving a collection or automation.",
  GHOST_PRICE:
    "One or more variants still show a compare-at (strikethrough) price from an uninstalled discount app. Clear the compare-at price on the affected product's variants under Products once you confirm the sale has ended.",
  GHOST_METAFIELD:
    "These metafields sit in an app's namespace and may be orphaned data from an uninstalled app. Review them under the product's Metafields (or in bulk) and delete them only if no active app or template still reads them.",
  GHOST_REDIRECT:
    "This URL redirect was likely created by an SEO or URL app you no longer use. Review it under Online Store, Navigation, URL Redirects and delete it if the source path no longer needs to redirect.",
  GHOST_TRANSLATION:
    "This translated content may be left over from a translation app you removed. Review it in the Translate & Adapt app (or Markets) and remove the locale's content if you no longer offer that language.",

  // ---- Theme settings ----
  SETTINGS_DRIFT:
    "Your theme settings still reference a section that no longer exists, usually from a removed app or section. This is safe to leave, but you can clear it by removing the stale block in the theme editor. Avoid editing settings_data.json by hand, and duplicate the theme first.",
};

/**
 * Generic fallback used for any finding type without an explicit blurb. Kept
 * deliberately conservative: confirm the source app is gone and back up the
 * theme before changing anything.
 */
const DEFAULT_REMEDIATION =
  "Confirm the app that created this is uninstalled before removing anything. When editing theme code, duplicate your live theme first (Online Store, Themes, Actions, Duplicate) so you can roll back if needed.";

/**
 * Returns safe, actionable removal guidance for a finding type. Always returns
 * a non-empty string: unknown or unmapped types fall back to generic guidance.
 */
export function getFindingRemediation(findingType: string): string {
  return REMEDIATION[findingType] ?? DEFAULT_REMEDIATION;
}
