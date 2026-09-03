/**
 * Per-finding-type guidance: the agentic "why it matters" and the safe next step.
 *
 * The scanner tells merchants WHERE ghost code lives (file, line, snippet).
 * This map adds two things:
 *   - `impact` (optional): the "so what" for AI shopping agents and answer
 *     engines, i.e. what this leftover signal does to how ChatGPT, Perplexity,
 *     Google AI Overviews, and shopping agents read the product. Only set for
 *     the finding types where an orphaned/conflicting signal actively misleads
 *     an agent (canonical, hreflang, meta robots, JSON-LD, Open Graph, duplicate
 *     meta).
 *   - `howTo`: how to remove it without breaking the store, written for a
 *     non-technical merchant, one to two sentences, accurate to what the
 *     finding actually represents.
 *
 * Two broad shapes of `howTo` guidance:
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

interface Remediation {
  /**
   * Optional agentic "so what": how this leftover signal misleads AI shopping
   * agents and answer engines. Rendered as a "Why it matters" line above the
   * removal step. Absent for types where there is no distinct agent-facing
   * consequence beyond the removal itself.
   */
  impact?: string;
  /** How to safely remove it. Always present. */
  howTo: string;
}

const REMEDIATION: Record<string, Remediation> = {
  // ---- Theme-file edits: injected scripts and network calls ----
  GHOST_SCRIPT: {
    howTo:
      "Once you have confirmed the app is uninstalled, this script tag can be removed from the theme file. Duplicate your live theme first (Online Store, Themes, Actions, Duplicate), then delete the tag in the theme code editor.",
  },
  GHOST_PIXEL: {
    howTo:
      "This is a tracking pixel injected into your theme. If it belongs to an app you have uninstalled, it may still be sending visitor data to a service you no longer use. Confirm this is not a pixel you still rely on (for example, an active Google or Meta tag) before removing its snippet from the theme file. Duplicate the theme first as a backup.",
  },
  GHOST_AJAX: {
    howTo:
      "This code still calls an uninstalled app's API on every page load, slowing the page for no benefit. Once you confirm the app is removed, delete the request from the theme file. Duplicate the theme first.",
  },
  GHOST_PRECONNECT: {
    howTo:
      "This preconnect hint opens a network connection to an app CDN you no longer use, adding needless overhead. Remove the link tag from the head in your theme code after duplicating the theme as a backup.",
  },
  GHOST_FONT: {
    howTo:
      "This font reference loads a file tied to an app you may have removed. Confirm the font is not used elsewhere, then delete the declaration from the theme file or stylesheet. Duplicate the theme first.",
  },
  GHOST_STYLE: {
    howTo:
      "This external stylesheet loads from an app you may have removed. Once confirmed, delete the link tag (or the orphaned CSS file) from the theme. Duplicate the theme first.",
  },

  // ---- Theme-file edits: SEO and meta markup in the head ----
  // These carry an agentic `impact`: canonical/hreflang/robots/JSON-LD/OG/meta
  // are exactly the signals AI shopping agents and answer engines read to
  // decide what a product is, where it lives, and whether to surface it.
  GHOST_CANONICAL: {
    impact:
      "AI answer engines and shopping agents follow this canonical tag to decide which URL is the real product page. Left by an uninstalled app, it can point them at a dead or wrong URL, so your product gets skipped or misattributed.",
    howTo:
      "After confirming no active SEO app owns it, remove the tag from the theme head. Duplicate the theme first and recheck your canonical URLs afterward.",
  },
  GHOST_TITLE: {
    howTo:
      "This title tag override was likely left by an SEO app. Remove it from the theme head so Shopify's native title logic takes over. Duplicate the theme as a backup first.",
  },
  GHOST_OG: {
    impact:
      "AI shopping agents and answer engines also read Open Graph tags like og:price and og:availability, not just social platforms. Left by an uninstalled app, this tag can hand them a stale price or availability status, so they quote the wrong price or mark your product out of stock when it isn't.",
    howTo:
      "Once you confirm the app that added it is gone, remove the tag from the theme head and let Shopify generate the defaults. Duplicate the theme first.",
  },
  GHOST_HREFLANG: {
    impact:
      "This hreflang tag tells search engines and AI agents which translated URL to show each shopper. If the translation app is gone, it points them at pages that no longer exist, so agents may surface a broken link or drop your product from localized answers.",
    howTo:
      "Once you confirm the translation app is uninstalled, remove the tag from the theme head. Duplicate the theme first.",
  },
  GHOST_JSON_LD: {
    impact:
      "AI shopping agents and answer engines read this JSON-LD block to learn your product's price, availability, and details. Left by an uninstalled app, it can feed them stale or wrong data, so they quote the wrong price or call your product out of stock.",
    howTo:
      "Remove the application/ld+json script block from the theme file after duplicating the theme as a backup.",
  },
  JSON_LD_CONFLICT: {
    impact:
      "Two JSON-LD blocks describe the same product with different details, so AI agents and search engines can't tell which is true and may ignore both or pick the wrong one.",
    howTo:
      "Keep the block Shopify or your active app generates and remove the conflicting one from the theme file. Duplicate the theme first.",
  },
  DUPLICATE_META: {
    impact:
      "This meta tag appears twice on the same page, so crawlers and AI agents may read the wrong copy or discount the signal entirely.",
    howTo: "Remove the redundant copy, keeping one. Duplicate the theme as a backup first.",
  },
  GHOST_ROBOTS: {
    impact:
      "This meta robots directive can tell AI crawlers and answer engines not to index the page, so your product never shows up in their results.",
    howTo:
      "Confirm the block is not intentional, then remove it from the theme file (duplicate the theme first) so the page can be indexed normally.",
  },

  // ---- Theme-file edits: snippets, sections, layouts, assets, widgets ----
  GHOST_SNIPPET: {
    howTo:
      "This Liquid render or include points at a snippet left by an app you may have removed. After confirming the app is uninstalled, delete the reference and the orphaned snippet file from the theme. Duplicate the theme first.",
  },
  GHOST_SECTION: {
    howTo:
      "This section reference belongs to an app you may no longer use. Once confirmed, remove the section (in Customize or the code editor) and delete the orphaned section file. Duplicate the theme first.",
  },
  GHOST_LAYOUT: {
    howTo:
      "This non-standard layout file was likely created by a page-builder app. If that app is uninstalled, confirm no template still references the layout, then delete the file. Duplicate the theme as a backup first.",
  },
  ORPHAN_ASSET: {
    howTo:
      "This asset file no longer appears to be referenced anywhere in the theme. After confirming nothing uses it, delete it from Assets in the theme code editor. Duplicate the theme as a backup first.",
  },
  GHOST_TEXT: {
    howTo:
      "This widget markup was likely left by an uninstalled app and may still show on your storefront. After confirming the app is gone, remove the markup from the theme file. Duplicate the theme first.",
  },

  // ---- Shopify Admin resources (not theme code) ----
  GHOST_PAGE: {
    howTo:
      "This page was likely created by an app you no longer use. If you do not need it, delete it in Online Store, Pages. Check your navigation menus for links to it first.",
  },
  GHOST_TAG: {
    howTo:
      "This product tag was likely added by an app you no longer use. Remove it from the affected product under Products, or in bulk, once you confirm it is not still driving a collection or automation.",
  },
  GHOST_PRICE: {
    howTo:
      "One or more variants still show a compare-at (strikethrough) price from an uninstalled discount app. Clear the compare-at price on the affected product's variants under Products once you confirm the sale has ended.",
  },
  GHOST_METAFIELD: {
    howTo:
      "These metafields sit in an app's namespace and may be orphaned data from an uninstalled app. Review them under the product's Metafields (or in bulk) and delete them only if no active app or template still reads them.",
  },
  GHOST_REDIRECT: {
    howTo:
      "This URL redirect was likely created by an SEO or URL app you no longer use. Review it under Online Store, Navigation, URL Redirects and delete it if the source path no longer needs to redirect.",
  },
  GHOST_TRANSLATION: {
    howTo:
      "This translated content may be left over from a translation app you removed. Review it in the Translate & Adapt app (or Markets) and remove the locale's content if you no longer offer that language.",
  },

  // ---- Theme settings ----
  SETTINGS_DRIFT: {
    howTo:
      "Your theme settings still reference a section that no longer exists, usually from a removed app or section. This is safe to leave, but you can clear it by removing the stale block in the theme editor. Avoid editing settings_data.json by hand, and duplicate the theme first.",
  },
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
  return REMEDIATION[findingType]?.howTo ?? DEFAULT_REMEDIATION;
}

/**
 * Returns the agentic "why it matters" line for a finding type, or null when
 * the type has no distinct agent-facing consequence beyond removal. Rendered
 * above the removal step in the finding row.
 */
export function getFindingImpact(findingType: string): string | null {
  return REMEDIATION[findingType]?.impact ?? null;
}
