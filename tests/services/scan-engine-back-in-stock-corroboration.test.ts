/**
 * gc-c4k: the generic `back-in-stock` snippet name names Back in Stock (Appikon)
 * only when the theme also mentions Appikon.
 *
 * paw-naturals-llc (paying) got a GHOST_SNIPPET "Back in Stock (Appikon)" on
 * every scan from 2026-10-04: its Avone theme renders its own built-in
 * `back-in-stock` snippet behind a block setting, and nothing on the live
 * storefront is Appikon. `bis-notification` stays a plain snippet name.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  findCorroboratedApps,
  identifyAppFromSnippetName,
} from "../../app/services/app-lookup.server";
import {
  detectGhostSections,
  detectGhostSnippets,
  detectSettingsDrift,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

const APP = "Back in Stock (Appikon)";

// The exact render line from paw-naturals' blocks/_product-buy-buttons.liquid:115.
const PAW_NATURALS_BLOCK: ThemeFile = {
  filename: "blocks/_product-buy-buttons.liquid",
  content: [
    '<div class="product-form__buttons">',
    "  {%- if block_st.bis and is_backinstock -%} {%- render 'back-in-stock', block_st: block_st, product: product -%} {%- endif -%}",
    "</div>",
  ].join("\n"),
};

// A theme's own back-in-stock snippet: no Appikon anywhere.
const THEME_NATIVE_SNIPPET: ThemeFile = {
  filename: "snippets/back-in-stock.liquid",
  content:
    '<form class="back-in-stock-form" action="/contact#back-in-stock">{{ "products.notify" | t }}</form>',
};

const APPIKON_SCRIPT: ThemeFile = {
  filename: "layout/theme.liquid",
  content: '<script src="https://cdn.appikon.com/bis/app.js" defer></script>',
};

function appikonFindings(files: ThemeFile[]) {
  return scanThemeFiles(files).findings.filter((f) => f.appName === APP);
}

describe("identifyAppFromSnippetName: corroborated names (gc-c4k)", () => {
  it("does not name Appikon for back-in-stock without corroboration", () => {
    expect(identifyAppFromSnippetName("back-in-stock")).toBeNull();
    expect(identifyAppFromSnippetName("back-in-stock", new Set())).toBeNull();
  });

  it("names Appikon for back-in-stock when Appikon is corroborated (case-insensitive)", () => {
    const corroborated = new Set([APP]);
    expect(identifyAppFromSnippetName("back-in-stock", corroborated)).toBe(APP);
    expect(identifyAppFromSnippetName("Back-In-Stock", corroborated)).toBe(APP);
  });

  it("corroborating a different app does not unlock back-in-stock", () => {
    expect(identifyAppFromSnippetName("back-in-stock", new Set(["Klaviyo"]))).toBeNull();
  });

  it("bis-notification still names Appikon with no corroboration", () => {
    expect(identifyAppFromSnippetName("bis-notification")).toBe(APP);
  });

  it("other apps' plain snippet names are unaffected", () => {
    expect(identifyAppFromSnippetName("klaviyo-onsite")).toBe("Klaviyo");
  });
});

describe("findCorroboratedApps (gc-c4k)", () => {
  it("is empty for a theme with no Appikon mention", () => {
    expect(findCorroboratedApps([PAW_NATURALS_BLOCK, THEME_NATIVE_SNIPPET])).toEqual(new Set());
    expect(findCorroboratedApps([])).toEqual(new Set());
  });

  it("finds Appikon from any file, case-insensitively", () => {
    expect(findCorroboratedApps([PAW_NATURALS_BLOCK, APPIKON_SCRIPT])).toEqual(new Set([APP]));
    expect(findCorroboratedApps([{ content: "<!-- APPIKON back in stock -->" }])).toEqual(
      new Set([APP]),
    );
  });

  it("does not treat Appikon's generic script patterns as corroboration", () => {
    // /BackInStock/ is in Appikon's scriptPatterns but themes use it too.
    expect(findCorroboratedApps([{ content: "window.BackInStock = {};" }])).toEqual(new Set());
  });
});

describe("scanThemeFiles: paw-naturals' theme-native back-in-stock (gc-c4k)", () => {
  it("flags nothing as Appikon for the paw-naturals render line and its native snippet", () => {
    expect(appikonFindings([PAW_NATURALS_BLOCK, THEME_NATIVE_SNIPPET])).toEqual([]);
  });

  it("flags nothing as Appikon when the rendered snippet file is missing", () => {
    expect(appikonFindings([PAW_NATURALS_BLOCK])).toEqual([]);
  });

  it("still flags the render as GHOST_SNIPPET when another theme file mentions Appikon", () => {
    const findings = appikonFindings([PAW_NATURALS_BLOCK, THEME_NATIVE_SNIPPET, APPIKON_SCRIPT]);
    const snippet = findings.filter((f) => f.findingType === FindingType.GHOST_SNIPPET);
    expect(snippet).toHaveLength(1);
    expect(snippet[0]).toMatchObject({ filename: PAW_NATURALS_BLOCK.filename, lineNumber: 2 });
  });

  it("still flags the render when the snippet file itself is Appikon's", () => {
    const appikonSnippet: ThemeFile = {
      filename: "snippets/back-in-stock.liquid",
      content: '<div id="appikon-bis-widget" data-shop="{{ shop.permanent_domain }}"></div>',
    };
    const snippet = appikonFindings([PAW_NATURALS_BLOCK, appikonSnippet]).filter(
      (f) => f.findingType === FindingType.GHOST_SNIPPET,
    );
    expect(snippet).toHaveLength(1);
  });

  it("an orphaned theme-native back-in-stock snippet is not an Appikon ORPHAN_ASSET", () => {
    expect(appikonFindings([THEME_NATIVE_SNIPPET])).toEqual([]);
  });

  it("an orphaned Appikon back-in-stock snippet is still an ORPHAN_ASSET", () => {
    const orphan: ThemeFile = {
      filename: "snippets/back-in-stock.liquid",
      content: '<script src="https://cdn.appikon.com/bis/app.js"></script>',
    };
    const orphans = appikonFindings([orphan]).filter(
      (f) => f.findingType === FindingType.ORPHAN_ASSET,
    );
    expect(orphans).toHaveLength(1);
  });
});

describe("detector defaults look at the file alone (gc-c4k)", () => {
  it("detectGhostSnippets: not flagged without corroboration, flagged with a passed set", () => {
    expect(detectGhostSnippets(PAW_NATURALS_BLOCK)).toEqual([]);
    expect(detectGhostSnippets(PAW_NATURALS_BLOCK, new Set([APP]))).toHaveLength(1);
  });

  it("detectGhostSnippets: an Appikon mention in the same file corroborates", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: "<!-- appikon -->\n{% render 'back-in-stock' %}",
    };
    expect(detectGhostSnippets(file)).toHaveLength(1);
  });

  it("detectGhostSections: back-in-stock section only with corroboration", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% section 'back-in-stock' %}",
    };
    expect(detectGhostSections(file)).toEqual([]);
    expect(detectGhostSections(file, new Set([APP]))).toHaveLength(1);
  });

  it("detectSettingsDrift: a stale back-in-stock section is reported, named Appikon only with corroboration", () => {
    const settings: ThemeFile = {
      filename: "config/settings_data.json",
      content: JSON.stringify({ current: { sections: { bis: { type: "back-in-stock" } } } }),
    };
    const plain = detectSettingsDrift([settings]);
    expect(plain).toHaveLength(1);
    expect(plain[0].appName).toBeUndefined();

    const named = detectSettingsDrift([settings, APPIKON_SCRIPT]);
    expect(named).toHaveLength(1);
    expect(named[0].appName).toBe(APP);
  });
});
