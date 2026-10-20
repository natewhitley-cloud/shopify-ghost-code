/**
 * "What changed" fixture (gc-rrh.4, spec 9): two real-shaped Dawn-like scans
 * of the same theme (~120 manifest entries each, Dawn's own file names) and a
 * third scan of another theme for the theme-switch case. Hashes are fake but
 * stable; there is no file content anywhere (the manifest never has any).
 *
 * Between BEFORE and AFTER:
 *   - Judge.me added: an embed hook appears and 3 Judge.me snippets are added;
 *   - PushOwl no longer active with 2 leftovers (an AppRemoval REMOVED row);
 *   - a new cdn.trustbadge.io unknown script in a changed layout/theme.liquid;
 *   - sections/header.liquid edited, no findings in it;
 *   - settings_data.json and 2 JSON templates resaved (editor data);
 *   - a locale resave;
 *   - an EComposer (contentBuilder, live embed) section rewrite;
 *   - a detector-only new finding in an unchanged file (sections/footer.liquid);
 *   - a newly live type (SETTINGS_DRIFT live only in AFTER).
 *
 * SWITCH is a different theme (Dawn 15.3.0, was 15.2.0) published after AFTER.
 */
import { FindingType } from "@prisma/client";

import type { ManifestEntry } from "../../app/lib/theme-manifest";
import type { RemovalNoticeRow } from "../../app/models/app-removal.server";
import { computeAppSignatureFingerprints } from "../../app/services/app-removal.server";
import type { ChangeLogScan } from "../../app/services/change-log.server";
import type { DiffableFinding } from "../../app/services/scan-differ.server";

export const THEME_ID = "gid://shopify/Theme/100";
export const OTHER_THEME_ID = "gid://shopify/Theme/200";
export const BEFORE_SCAN_ID = "scan-before";
export const AFTER_SCAN_ID = "scan-after";
export const SWITCH_SCAN_ID = "scan-switch";

/** A stable 32-hex fake checksum for (path, revision). */
export function fakeMd5(path: string, rev = 0): string {
  let out = "";
  let h = 5381 + rev * 7919;
  for (let round = 0; out.length < 32; round += 1) {
    for (const ch of `${round}:${path}`) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 32);
}

const T0 = 1_760_000_000; // epoch seconds
const T1 = T0 + 7 * 24 * 3600;

const SECTIONS = [
  "announcement-bar",
  "apps",
  "cart-drawer",
  "cart-icon-bubble",
  "cart-live-region-text",
  "cart-notification-button",
  "cart-notification-product",
  "collage",
  "collapsible-content",
  "collection-list",
  "contact-form",
  "custom-liquid",
  "email-signup-banner",
  "featured-blog",
  "featured-collection",
  "featured-product",
  "footer",
  "header",
  "image-banner",
  "image-with-text",
  "main-404",
  "main-article",
  "main-blog",
  "main-cart-footer",
  "main-cart-items",
  "main-collection-banner",
  "main-collection-product-grid",
  "main-list-collections",
  "main-page",
  "main-password-footer",
  "main-password-header",
  "main-product",
  "main-search",
  "multicolumn",
  "multirow",
  "newsletter",
  "page",
  "predictive-search",
  "related-products",
  "rich-text",
  "slideshow",
  "video",
];
const SNIPPETS = [
  "article-card",
  "buy-buttons",
  "card-collection",
  "card-product",
  "cart-drawer",
  "cart-notification",
  "country-localization",
  "facets",
  "header-drawer",
  "header-dropdown-menu",
  "header-mega-menu",
  "header-search",
  "icon-accordion",
  "icon-arrow",
  "icon-caret",
  "icon-cart",
  "icon-close",
  "language-localization",
  "loading-spinner",
  "meta-tags",
  "pagination",
  "price",
  "product-media",
  "product-media-gallery",
  "product-thumbnail",
  "product-variant-options",
  "product-variant-picker",
  "quantity-input",
  "share-button",
  "social-icons",
  "swatch",
  "swatch-input",
  // App leftovers present in both scans.
  "pushowl",
];
const ASSETS = [
  "base.css",
  "cart.js",
  "component-card.css",
  "component-cart-drawer.css",
  "component-facets.css",
  "component-price.css",
  "constants.js",
  "details-disclosure.js",
  "facets.js",
  "global.js",
  "media-gallery.js",
  "predictive-search.js",
  "product-form.js",
  "product-info.js",
  "pubsub.js",
  "quantity-popover.js",
  "search-form.js",
  "section-image-banner.css",
  "section-main-product.css",
  "share.js",
  "theme-editor.js",
  "variant-selects.js",
  "logo.png",
];
const TEMPLATES = [
  "404.json",
  "article.json",
  "blog.json",
  "cart.json",
  "collection.json",
  "index.json",
  "list-collections.json",
  "page.contact.json",
  "page.json",
  "password.json",
  "product.json",
  "search.json",
  "customers/account.json",
  "customers/login.json",
];
const LOCALES = ["en.default.json", "en.default.schema.json", "fr.json", "de.json", "es.json"];

/** Dawn-like paths both scans share (sorted later by the manifest order). */
const COMMON_PATHS: string[] = [
  "layout/theme.liquid",
  "layout/password.liquid",
  "config/settings_schema.json",
  "config/settings_data.json",
  "sections/header-group.json",
  "sections/footer-group.json",
  "sections/ecom-landing-hero.liquid",
  ...SECTIONS.map((s) => `sections/${s}.liquid`),
  ...SNIPPETS.map((s) => `snippets/${s}.liquid`),
  ...ASSETS.map((a) => `assets/${a}`),
  ...TEMPLATES.map((t) => `templates/${t}`),
  ...LOCALES.map((l) => `locales/${l}`),
];

const OWNER: Record<string, string> = {
  "snippets/pushowl.liquid": "PushOwl",
  "sections/ecom-landing-hero.liquid": "EComposer",
  "snippets/judgeme_widgets.liquid": "Judge.me",
  "snippets/jdgm-widget.liquid": "Judge.me",
  "snippets/jdgm-review.liquid": "Judge.me",
};

/** Paths whose content changes between BEFORE and AFTER. */
export const AFTER_CHANGED_PATHS = [
  "layout/theme.liquid",
  "sections/header.liquid",
  "config/settings_data.json",
  "templates/index.json",
  "templates/product.json",
  "locales/fr.json",
  "sections/ecom-landing-hero.liquid",
];
export const JUDGEME_FILES = [
  "snippets/jdgm-review.liquid",
  "snippets/jdgm-widget.liquid",
  "snippets/judgeme_widgets.liquid",
];

function entry(path: string, rev: number, at: number): ManifestEntry {
  return [path, fakeMd5(path, rev), 1000 + path.length, at, OWNER[path] ?? null];
}

function manifest(paths: readonly string[], revOf: (p: string) => number): ManifestEntry[] {
  return paths
    .map((p) => entry(p, revOf(p), revOf(p) === 0 ? T0 : T1))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export const BEFORE_MANIFEST: ManifestEntry[] = manifest(COMMON_PATHS, () => 0);
export const AFTER_MANIFEST: ManifestEntry[] = manifest([...COMMON_PATHS, ...JUDGEME_FILES], (p) =>
  AFTER_CHANGED_PATHS.includes(p) || JUDGEME_FILES.includes(p) ? 1 : 0,
);

const FINGERPRINTS = computeAppSignatureFingerprints();
const COVERAGE = {
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
  skippedFiles: [] as string[],
  walkCoverage: null,
};
const ALL_TYPES = Object.values(FindingType) as string[];
const LIVE_BEFORE = ALL_TYPES.filter(
  (t) => t !== FindingType.SETTINGS_DRIFT && t !== FindingType.APP_INCIDENT_ADVISORY,
);
const LIVE_AFTER = ALL_TYPES.filter((t) => t !== FindingType.APP_INCIDENT_ADVISORY);

export function finding(over: Partial<DiffableFinding> & { filename: string }): DiffableFinding {
  return {
    lineNumber: 4,
    codeSnippet: `<script src="https://cdn.example.com/${over.filename}.js"></script>`,
    findingType: FindingType.GHOST_SCRIPT,
    severity: "MEDIUM",
    appName: null,
    description: "fixture finding",
    ...over,
  };
}

/** PushOwl's two leftovers: in both scans, in an unchanged snippet. */
const PUSHOWL_LEFTOVERS = [
  finding({
    filename: "snippets/pushowl.liquid",
    appName: "PushOwl",
    lineNumber: 2,
    codeSnippet: '<script src="https://cdn.pushowl.com/sdks/pushowl-sdk.js"></script>',
  }),
  finding({
    filename: "snippets/pushowl.liquid",
    appName: "PushOwl",
    lineNumber: 9,
    codeSnippet: '<link rel="preconnect" href="https://cdn.pushowl.com">',
    findingType: FindingType.GHOST_PRECONNECT,
  }),
];

export const DETECTOR_ONLY_FINDING = finding({
  filename: "sections/footer.liquid",
  findingType: FindingType.GHOST_STYLE,
  appName: "Loox",
  severity: "HIGH",
  codeSnippet: '<link rel="stylesheet" href="https://loox.io/widget.css">',
});
export const NEWLY_LIVE_FINDING = finding({
  filename: "config/settings_data.json",
  findingType: FindingType.SETTINGS_DRIFT,
  lineNumber: 0,
  codeSnippet: "old_app_setting",
});

export function beforeScan(over: Partial<ChangeLogScan> = {}): ChangeLogScan {
  return {
    scanId: BEFORE_SCAN_ID,
    themeId: THEME_ID,
    themeName: "Dawn",
    coverage: { ...COVERAGE, liveFindingTypes: LIVE_BEFORE },
    findings: [...PUSHOWL_LEFTOVERS],
    liveAppHooks: { embedApps: ["EComposer", "PushOwl"], scriptTagApps: [] },
    appSignatureFingerprints: FINGERPRINTS,
    unknownScripts: [
      // Already there before: never "new".
      {
        filename: "layout/theme.liquid",
        lineNumber: 40,
        url: "https://cdn.oldhost.io/a.js",
        domain: "cdn.oldhost.io",
      },
    ],
    scanDomains: [],
    themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
    manifest: BEFORE_MANIFEST,
    ...over,
  };
}

export function afterScan(over: Partial<ChangeLogScan> = {}): ChangeLogScan {
  return {
    scanId: AFTER_SCAN_ID,
    themeId: THEME_ID,
    themeName: "Dawn",
    coverage: { ...COVERAGE, liveFindingTypes: LIVE_AFTER },
    findings: [...PUSHOWL_LEFTOVERS, DETECTOR_ONLY_FINDING, NEWLY_LIVE_FINDING],
    liveAppHooks: { embedApps: ["EComposer", "Judge.me"], scriptTagApps: [] },
    appSignatureFingerprints: FINGERPRINTS,
    unknownScripts: [
      {
        filename: "layout/theme.liquid",
        lineNumber: 40,
        url: "https://cdn.oldhost.io/a.js",
        domain: "cdn.oldhost.io",
      },
      {
        filename: "layout/theme.liquid",
        lineNumber: 57,
        url: "https://cdn.trustbadge.io/badge.js",
        domain: "cdn.trustbadge.io",
      },
    ],
    scanDomains: [
      { domain: "cdn.trustbadge.io", matched: false, benign: false },
      { domain: "cdn.oldhost.io", matched: false, benign: false },
    ],
    themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
    manifest: AFTER_MANIFEST,
    ...over,
  };
}

/** Another theme (Dawn 15.3.0) published after AFTER: a few files differ from AFTER's. */
export const SWITCH_CHANGED_PATHS = ["assets/base.css", "sections/main-product.liquid"];
export function switchScan(over: Partial<ChangeLogScan> = {}): ChangeLogScan {
  return afterScan({
    scanId: SWITCH_SCAN_ID,
    themeId: OTHER_THEME_ID,
    themeName: "Dawn 15.3",
    unknownScripts: afterScan().unknownScripts,
    themeInfo: { name: "Dawn", version: "15.3.0", author: "Shopify", architecture: "os2" },
    manifest: AFTER_MANIFEST.map((e) =>
      SWITCH_CHANGED_PATHS.includes(e[0]) ? [e[0], fakeMd5(e[0], 2), e[2], T1 + 60, e[4]] : e,
    ),
    ...over,
  });
}

export const PUSHOWL_REMOVED: RemovalNoticeRow = {
  appName: "PushOwl",
  leftoverCount: 2,
  state: "REMOVED",
};
