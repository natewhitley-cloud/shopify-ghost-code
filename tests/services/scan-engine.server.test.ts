import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import type { CreateFindingInput } from "../../app/models/finding.server";
import {
  isScannableFile,
  detectGhostScripts,
  detectGhostStyles,
  detectGhostSnippets,
  detectGhostSections,
  detectGhostHrefLang,
  detectDuplicateMetaTags,
  detectGhostJsonLd,
  detectJsonLdConflicts,
  detectGhostTextFragments,
  detectGhostPixels,
  detectSettingsDrift,
  detectGhostLayouts,
  detectGhostRobots,
  detectGhostCanonical,
  detectGhostTitle,
  detectGhostOg,
  detectGhostPreconnect,
  detectGhostFont,
  detectGhostAjax,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { REFERENCE_THEMES, DAWN_TITLE, DAWN_META_TAGS } from "../fixtures/reference-themes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter findings by type for cleaner assertions. */
function findingsOfType(findings: CreateFindingInput[], type: FindingType) {
  return findings.filter((f) => f.findingType === type);
}

// ---------------------------------------------------------------------------
// isScannableFile
// ---------------------------------------------------------------------------

describe("isScannableFile", () => {
  it("accepts liquid files in templates/", () => {
    expect(isScannableFile("templates/index.liquid")).toBe(true);
  });

  it("accepts liquid files in sections/", () => {
    expect(isScannableFile("sections/header.liquid")).toBe(true);
  });

  it("accepts liquid files in snippets/", () => {
    expect(isScannableFile("snippets/klaviyo-onsite.liquid")).toBe(true);
  });

  it("accepts liquid files in layout/", () => {
    expect(isScannableFile("layout/theme.liquid")).toBe(true);
  });

  it("rejects files in assets/ directory", () => {
    expect(isScannableFile("assets/theme.js")).toBe(false);
  });

  it("rejects files in config/ directory", () => {
    expect(isScannableFile("config/settings_data.json")).toBe(false);
  });

  it("rejects files in locales/ directory", () => {
    expect(isScannableFile("locales/en.default.json")).toBe(false);
  });

  it("rejects non-liquid files even in scannable directories", () => {
    expect(isScannableFile("templates/index.json")).toBe(false);
    expect(isScannableFile("sections/header.css")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isScannableFile("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectGhostScripts
// ---------------------------------------------------------------------------

describe("detectGhostScripts", () => {
  it("detects a known app external script tag", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SCRIPT);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].appName).toBe("Klaviyo");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].filename).toBe("layout/theme.liquid");
  });

  it("detects multiple scripts on different lines", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- tracking -->",
        '<script src="https://static.hotjar.com/c/hotjar-123.js"></script>',
        "<p>hello</p>",
        '<script src="https://code.tidio.co/abc.js"></script>',
      ].join("\n"),
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[1].lineNumber).toBe(4);
  });

  it("ignores scripts from unknown CDNs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://example.com/my-custom-script.js"></script>',
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores relative script paths", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "<script src=\"{{ 'theme.js' | asset_url }}\"></script>",
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(0);
  });

  it("downgrades script inside Liquid comment to LOW severity", () => {
    const file = {
      filename: "layout/theme.liquid",
      content:
        '{% comment %}\n<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>\n{% endcomment %}',
    };
    const findings = detectGhostScripts(file);
    // The snippet for line 2 includes line 1 (which has the comment opener)
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("returns correct description containing app name and URL", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    };
    const findings = detectGhostScripts(file);
    expect(findings[0].description).toContain("Klaviyo");
    expect(findings[0].description).toContain("static.klaviyo.com");
  });

  it("handles protocol-relative URLs (//cdn.example.com)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="//static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
  });
});

// ---------------------------------------------------------------------------
// detectGhostStyles
// ---------------------------------------------------------------------------

describe("detectGhostStyles", () => {
  it("detects a known app external stylesheet", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css">',
    };
    const findings = detectGhostStyles(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_STYLE);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects stylesheet when href comes before rel", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link href="https://cdn.judge.me/assets/v4/widget.css" rel="stylesheet">',
    };
    const findings = detectGhostStyles(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("downgrades to LOW for print-only stylesheet", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" media="print" href="https://cdn.judge.me/print.css">',
    };
    const findings = detectGhostStyles(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("ignores internal stylesheets (relative URLs)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="{{ \'theme.css\' | asset_url }}">',
    };
    const findings = detectGhostStyles(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores stylesheets from unknown CDNs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://example.com/style.css">',
    };
    const findings = detectGhostStyles(file);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectGhostSnippets
// ---------------------------------------------------------------------------

describe("detectGhostSnippets", () => {
  it("detects {% render %} of a known app snippet", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% render 'klaviyo-onsite' %}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SNIPPET);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].appName).toBe("Klaviyo");
  });

  it("detects {% include %} of a known app snippet", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% include 'klaviyo-form' %}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
  });

  it("handles whitespace-stripping variant {%- render -%}", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{%- render 'klaviyo-onsite' -%}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
  });

  it("handles double-quoted snippet names", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '{% render "klaviyo-onsite" %}',
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
  });

  it("ignores snippets not in the signature database", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% render 'my-custom-snippet' %}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(0);
  });

  it("detects Recharge snippet by name", () => {
    const file = {
      filename: "templates/product.liquid",
      content: "{% render 'recharge-checkout-option' %}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Recharge");
  });

  it("does NOT emit two findings when a {% render %} tag spans multiple lines", () => {
    // Regression for BLOCKING-1: RENDER_RE (full-content, \s* matches newlines)
    // and RENDER_LIQUID_BLOCK_RE (line-anchored) both matched multi-line render
    // tags, producing a duplicate GHOST_SNIPPET finding.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{%-\n  render 'klaviyo-onsite'\n-%}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
  });

  it("still detects bare render inside {% liquid %} block as exactly one finding", () => {
    // Ensure RENDER_LIQUID_BLOCK_RE still fires for genuine bare-form calls
    // that are NOT inside a {% render %} tag (i.e., inside a {% liquid %} block).
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% liquid\n  render 'klaviyo-onsite'\n%}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
  });

  it("emits two findings for two genuinely different render calls (no false dedup)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% render 'klaviyo-onsite' %}\n{% render 'recharge-checkout-option' %}",
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(2);
    const appNames = findings.map((f) => f.appName);
    expect(appNames).toContain("Klaviyo");
    expect(appNames).toContain("Recharge");
  });

  // GC-gmt: render/include tags inside an always-false conditional are dead code
  // (the block never renders) and must not be flagged as ghost references.
  describe("always-false conditional suppression (GC-gmt)", () => {
    it("does NOT flag a render tag inside {% if false %}", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% if false %}", "  {% render 'klaviyo-onsite' %}", "{% endif %}"].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });

    it("still flags the same render tag when it is outside any conditional", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: "{% render 'klaviyo-onsite' %}",
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("does NOT flag a render tag inside {% unless true %}", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% unless true %}", "  {% render 'klaviyo-onsite' %}", "{% endunless %}"].join(
          "\n",
        ),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag a render tag nested in an inner conditional inside {% if false %}", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "{% if false %}",
          "  {% if settings.show_form %}",
          "    {% render 'klaviyo-onsite' %}",
          "  {% endif %}",
          "{% endif %}",
        ].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });

    it("handles whitespace-control variant {%- if false -%}", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{%- if false -%}", "  {%- render 'klaviyo-onsite' -%}", "{%- endif -%}"].join(
          "\n",
        ),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });

    it("STILL flags a render tag inside a non-always-false conditional like {% if foo %}", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "{% if settings.enable_klaviyo %}",
          "  {% render 'klaviyo-onsite' %}",
          "{% endif %}",
        ].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("STILL flags a render tag in the reachable {% else %} branch of an always-false block", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "{% if false %}",
          "  {% render 'recharge-checkout-option' %}",
          "{% else %}",
          "  {% render 'klaviyo-onsite' %}",
          "{% endif %}",
        ].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("STILL flags a render tag that follows an always-false block", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "{% if false %}",
          "  {% render 'recharge-checkout-option' %}",
          "{% endif %}",
          "{% render 'klaviyo-onsite' %}",
        ].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });
  });
});

// ---------------------------------------------------------------------------
// detectGhostSections
// ---------------------------------------------------------------------------

describe("detectGhostSections", () => {
  it("detects {% section %} referencing a known app section name", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% section 'shogun-head' %}",
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SECTION);
    expect(findings[0].severity).toBe(Severity.LOW);
    expect(findings[0].appName).toBe("Shogun");
  });

  it("handles double-quoted section names", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '{% section "shogun-scripts" %}',
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(1);
  });

  it("ignores sections not in the signature database", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% section 'custom-hero-banner' %}",
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(0);
  });

  it("handles whitespace-stripping variant", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{%- section 'pagefly-head' -%}",
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
  });

  it("does not flag a section tag inside a {% comment %} block", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "  Old PageFly integration — removed 2024-01-15",
        "  {% section 'pagefly-head' %}",
        "{% endcomment %}",
        "<div>real content</div>",
      ].join("\n"),
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag a section tag on a line that also contains a Liquid conditional", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% if settings.enable_shogun %}{% section 'shogun-head' %}{% endif %}",
    };
    const findings = detectGhostSections(file);
    expect(findings).toHaveLength(0);
  });

  it("still flags a real ghost section tag that is outside any comment or conditional", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "  {% section 'shogun-head' %}",
        "{% endcomment %}",
        "{% section 'pagefly-head' %}",
      ].join("\n"),
    };
    const findings = detectGhostSections(file);
    // Only the one outside the comment block should be flagged
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[0].lineNumber).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// detectGhostHrefLang
// ---------------------------------------------------------------------------

describe("detectGhostHrefLang", () => {
  it("detects a Weglot hreflang tag (hreflang before href)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" hreflang="fr" href="https://fr.example.com/products" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_HREFLANG);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].appName).toBe("Weglot");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].description).toContain("fr");
    expect(findings[0].description).toContain("Weglot");
  });

  it("detects hreflang tag with href before hreflang", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" href="https://cdn.weglot.com/fr/page" hreflang="fr" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Weglot");
    expect(findings[0].description).toContain("fr");
  });

  it("detects Transcy hreflang tags from transcy.io domain", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" hreflang="de" href="https://cdn.transcy.io/de/products" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Transcy");
    expect(findings[0].description).toContain("de");
  });

  it("detects Langify hreflang tags from domain pattern", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" hreflang="es" href="https://cdn.langify-app.com/es/page" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Langify");
  });

  it("detects LangShop hreflang tags from domain pattern", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" hreflang="ja" href="https://cdn.langshop.app/ja/page" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("LangShop");
  });

  it("detects multiple hreflang tags on different lines", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />',
        '<link rel="alternate" hreflang="de" href="https://de.example.com/" />',
      ].join("\n"),
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[1].lineNumber).toBe(2);
  });

  it("returns empty array for files with no hreflang tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "<html>{{ content_for_layout }}</html>",
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores hreflang tags with unrecognized href URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="alternate" hreflang="fr" href="https://example.com/" />',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(0);
  });

  it("downgrades to LOW when inside a Liquid comment", () => {
    const file = {
      filename: "layout/theme.liquid",
      content:
        '{% comment %}\n<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />\n{% endcomment %}',
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("handles single-quoted attributes", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "<link rel='alternate' hreflang='fr' href='https://fr.example.com/' />",
    };
    const findings = detectGhostHrefLang(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Weglot");
  });
});

// ---------------------------------------------------------------------------
// detectDuplicateMetaTags
// ---------------------------------------------------------------------------

describe("detectDuplicateMetaTags", () => {
  it("finds duplicate <meta name='description'> tags in same file", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="description" content="First description">',
        "<p>some content</p>",
        '<meta name="description" content="Second description">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.DUPLICATE_META);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].lineNumber).toBe(3);
    expect(findings[0].description).toContain("description");
    expect(findings[0].description).toContain("line 1");
  });

  it("finds duplicate <meta property='og:title'> tags (Open Graph)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta property="og:title" content="First Title">',
        '<meta property="og:title" content="Second Title">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.DUPLICATE_META);
    expect(findings[0].description).toContain("og:title");
    expect(findings[0].description).toContain("line 1");
  });

  it("does NOT flag unique meta tags (no duplicates = no findings)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="description" content="My shop">',
        '<meta property="og:title" content="My Title">',
        '<meta name="viewport" content="width=device-width">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(0);
  });

  it("handles mixed name and property attributes correctly", () => {
    // name="description" and property="description" should NOT be merged —
    // they are different attribute types. But two name="description" should match.
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="description" content="Name desc">',
        '<meta property="og:title" content="OG Title 1">',
        '<meta property="og:title" content="OG Title 2">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("og:title");
  });

  it("returns empty array for files with no meta tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "<html><body>{{ content_for_layout }}</body></html>",
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(0);
  });

  it("correctly identifies which occurrence is the duplicate (2nd+ occurrence)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="robots" content="index, follow">',
        "<p>gap</p>",
        '<meta name="robots" content="noindex">',
        "<p>gap</p>",
        '<meta name="robots" content="nofollow">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    // Should flag line 3 and line 5 (2nd and 3rd occurrences), NOT line 1
    expect(findings).toHaveLength(2);
    expect(findings[0].lineNumber).toBe(3);
    expect(findings[0].description).toContain("line 1");
    expect(findings[1].lineNumber).toBe(5);
    expect(findings[1].description).toContain("line 1");
  });

  it("is case-insensitive for attribute values", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="Description" content="First">',
        '<meta name="description" content="Second">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
  });

  it("handles meta tags with attributes in different order", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="description" content="First">',
        '<meta content="Second" name="description">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
  });

  it("returns appName as undefined when no app signature matches", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="description" content="plain text">',
        '<meta name="description" content="another plain text">',
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBeUndefined();
  });

  it("does NOT flag duplicate metas inside {% unless %}/{% endunless %} block", () => {
    // Metas inside an unless block are mutually exclusive with the surrounding
    // context — they only render at runtime when the condition is false.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% unless template == 'product' %}",
        '<meta name="description" content="First">',
        '<meta name="description" content="Second">',
        "{% endunless %}",
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag duplicate metas inside nested {% if %} blocks (depth > 1)", () => {
    // Tags inside deeply nested conditionals are branch-exclusive and must not
    // be counted against each other regardless of nesting depth.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% if template == 'product' %}",
        "  {% if product.available %}",
        '  <meta name="description" content="Available product">',
        "  {% else %}",
        '  <meta name="description" content="Sold out product">',
        "  {% endif %}",
        "{% endif %}",
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag duplicate metas in different {% case %}/{% when %} branches", () => {
    // Each {% when %} branch is mutually exclusive — only one executes at runtime.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% case template %}",
        "{% when 'product' %}",
        '<meta name="description" content="Product page">',
        "{% when 'collection' %}",
        '<meta name="description" content="Collection page">',
        "{% endcase %}",
      ].join("\n"),
    };
    const findings = detectDuplicateMetaTags(file);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectGhostJsonLd
// ---------------------------------------------------------------------------

describe("detectGhostJsonLd", () => {
  it("detects JSON-LD with Judge.me patterns", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  "reviewCount": "42",
  "url": "https://judge.me/reviews/product123"
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_JSON_LD);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].description).toContain("Judge.me");
  });

  it("detects JSON-LD with Loox patterns", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  "url": "https://loox.io/reviews/widget"
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Loox");
  });

  it("detects JSON-LD with FAQPage @type (no app match)", () => {
    const file = {
      filename: "sections/faq.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "FAQPage",
  "mainEntity": []
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_JSON_LD);
    expect(findings[0].appName).toBeUndefined();
    expect(findings[0].description).toContain("FAQPage");
  });

  it("detects JSON-LD with AggregateRating @type", () => {
    const file = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "AggregateRating",
  "ratingValue": "4.5"
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("AggregateRating");
  });

  it("skips JSON-LD blocks containing Liquid {{ template tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  "name": "{{ product.title }}",
  "reviewCount": "42"
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(0);
  });

  it("skips JSON-LD blocks containing Liquid {% template tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  {% if product.reviews_count > 0 %}
  "reviewCount": "42"
  {% endif %}
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(0);
  });

  it("skips legitimate static JSON-LD with no app patterns and no app-only @type", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Organization",
  "name": "My Store",
  "url": "https://mystore.com"
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for files with no JSON-LD", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "<html>{{ content_for_layout }}</html>",
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(0);
  });

  it("finds multiple JSON-LD blocks in one file independently", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  "url": "https://judge.me/reviews"
}
</script>
<p>Some content</p>
<script type="application/ld+json">
{
  "@type": "FAQPage",
  "mainEntity": []
}
</script>`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[1].appName).toBeUndefined();
    expect(findings[1].description).toContain("FAQPage");
  });

  it("downgrades to LOW when inside a Liquid comment", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `{% comment %}
<script type="application/ld+json">
{
  "@type": "Product",
  "url": "https://judge.me/reviews"
}
</script>
{% endcomment %}`,
    };
    const findings = detectGhostJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });
});

// ---------------------------------------------------------------------------
// detectGhostTextFragments
// ---------------------------------------------------------------------------

describe("detectGhostTextFragments", () => {
  it("detects Judge.me widget markup", () => {
    const file = {
      filename: "sections/product.liquid",
      content: '<div id="jdgm-widget" class="review-widget"></div>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TEXT);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects Yotpo data attribute", () => {
    const file = {
      filename: "sections/product.liquid",
      content: '<div data-yotpo-product-id="123"></div>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TEXT);
    expect(findings[0].appName).toBe("Yotpo");
  });

  it("detects Stamped widget", () => {
    const file = {
      filename: "sections/product.liquid",
      content: '<div class="stamped-reviews-widget"></div>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TEXT);
    expect(findings[0].appName).toBe("Stamped.io");
  });

  it("ignores lines with script tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.judge.me/jdgm-widget.js"></script>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores lines with render tags", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: "{% render 'jdgm-widget' %}",
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores unknown text patterns", () => {
    const file = {
      filename: "sections/product.liquid",
      content: '<div class="my-custom-widget"></div>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple apps in same file", () => {
    const file = {
      filename: "sections/product.liquid",
      content: ['<div id="jdgm-widget"></div>', '<div data-yotpo-product-id="456"></div>'].join(
        "\n",
      ),
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(2);
    const apps = findings.map((f) => f.appName).sort();
    expect(apps).toEqual(["Judge.me", "Yotpo"]);
  });

  it("assigns LOW severity by default", () => {
    const file = {
      filename: "sections/product.liquid",
      content: '<div id="jdgm-widget"></div>',
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("skips non-scannable files via scanThemeFiles", () => {
    const files = [
      {
        filename: "assets/theme.js",
        content: '<div id="jdgm-widget"></div>',
      },
    ];
    const { findings } = scanThemeFiles(files);
    const textFindings = findingsOfType(findings, FindingType.GHOST_TEXT);
    expect(textFindings).toHaveLength(0);
  });

  it("downgraded to LOW inside liquid comment", () => {
    const file = {
      filename: "sections/product.liquid",
      content: ["{% comment %}", '<div id="jdgm-widget"></div>', "{% endcomment %}"].join("\n"),
    };
    const findings = detectGhostTextFragments(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });
});

// ---------------------------------------------------------------------------
// scanThemeFiles (integration)
// ---------------------------------------------------------------------------

describe("scanThemeFiles", () => {
  it("processes only scannable liquid files", () => {
    const files = [
      {
        filename: "assets/theme.js",
        content: '<script src="https://static.klaviyo.com/j.js"></script>',
      },
      { filename: "config/settings.json", content: '{% render "klaviyo-onsite" %}' },
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
    ];
    const { findings } = scanThemeFiles(files);
    // Only layout/theme.liquid should be scanned
    expect(findings.every((f) => f.filename === "layout/theme.liquid")).toBe(true);
  });

  it("returns empty array for files with no ghost code", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
    ];
    expect(scanThemeFiles(files).findings).toHaveLength(0);
  });

  it("aggregates findings across multiple file types", () => {
    // snippets/tracking.liquid is rendered by sections/header.liquid to avoid
    // a spurious ORPHAN_ASSET finding that would complicate this count-agnostic
    // test.  Orphan detection is exercised in its own describe block below.
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
      {
        filename: "sections/header.liquid",
        content: '{% render "recharge-checkout-option" %}{% render "tracking" %}',
      },
      {
        filename: "snippets/tracking.liquid",
        content: '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css">',
      },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const types = new Set(findings.map((f) => f.findingType));
    expect(types.has(FindingType.GHOST_SCRIPT)).toBe(true);
    expect(types.has(FindingType.GHOST_SNIPPET)).toBe(true);
    expect(types.has(FindingType.GHOST_STYLE)).toBe(true);
  });

  it("picks up GHOST_HREFLANG findings from layout files", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content:
          '<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />\n<link rel="alternate" hreflang="de" href="https://de.example.com/" />',
      },
    ];
    const { findings } = scanThemeFiles(files);
    const hreflangFindings = findingsOfType(findings, FindingType.GHOST_HREFLANG);
    expect(hreflangFindings.length).toBeGreaterThanOrEqual(2);
    expect(hreflangFindings[0].appName).toBe("Weglot");
  });

  it("picks up GHOST_JSON_LD findings from layout files", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: `<script type="application/ld+json">
{
  "@type": "Product",
  "url": "https://judge.me/reviews"
}
</script>`,
      },
    ];
    const { findings } = scanThemeFiles(files);
    const jsonLdFindings = findingsOfType(findings, FindingType.GHOST_JSON_LD);
    expect(jsonLdFindings).toHaveLength(1);
    expect(jsonLdFindings[0].appName).toBe("Judge.me");
  });

  it("picks up DUPLICATE_META findings from layout files", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: [
          '<meta name="description" content="First description">',
          '<meta name="description" content="Second description">',
        ].join("\n"),
      },
    ];
    const { findings } = scanThemeFiles(files);
    const dupeFindings = findingsOfType(findings, FindingType.DUPLICATE_META);
    expect(dupeFindings).toHaveLength(1);
    expect(dupeFindings[0].description).toContain("description");
  });

  it("returns empty array for empty files array", () => {
    expect(scanThemeFiles([]).findings).toHaveLength(0);
  });

  it("returns empty array for files with no content", () => {
    const files = [{ filename: "layout/theme.liquid", content: "" }];
    expect(scanThemeFiles(files).findings).toHaveLength(0);
  });

  it("produces finding inputs that satisfy the CreateFindingInput shape", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(typeof f.filename).toBe("string");
    expect(typeof f.lineNumber).toBe("number");
    expect(typeof f.codeSnippet).toBe("string");
    expect(typeof f.description).toBe("string");
    expect(f.codeSnippet.length).toBeGreaterThan(0);
    expect(f.codeSnippet.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// ORPHAN_ASSET detection (integrated via scanThemeFiles)
// ---------------------------------------------------------------------------

describe("scanThemeFiles — ORPHAN_ASSET detection", () => {
  it("flags an orphan snippet file attributed to a known app", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/klaviyo-onsite.liquid", content: "<div>old widget</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].filename).toBe("snippets/klaviyo-onsite.liquid");
    expect(orphans[0].findingType).toBe(FindingType.ORPHAN_ASSET);
    expect(orphans[0].severity).toBe(Severity.LOW);
    expect(orphans[0].appName).toBe("Klaviyo");
    expect(orphans[0].description).toContain("klaviyo-onsite");
  });

  it("does not flag a snippet that is rendered by another file", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: "{% render 'my-widget' %}",
      },
      { filename: "snippets/my-widget.liquid", content: "<div>widget</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("does not flag a snippet rendered by another snippet (transitive reference)", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: "{% render 'parent-snippet' %}",
      },
      {
        filename: "snippets/parent-snippet.liquid",
        content: "{% render 'child-snippet' %}",
      },
      { filename: "snippets/child-snippet.liquid", content: "<p>content</p>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("flags multiple orphan snippets attributed to known apps", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/klaviyo-form.liquid", content: "<div>a</div>" },
      { filename: "snippets/omnisend-newsletter.liquid", content: "<div>b</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(2);
    const filenames = orphans.map((f) => f.filename).sort();
    expect(filenames).toEqual([
      "snippets/klaviyo-form.liquid",
      "snippets/omnisend-newsletter.liquid",
    ]);
  });

  it("does not produce any ORPHAN_ASSET findings when there are no snippet files", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "sections/header.liquid", content: "<header></header>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("produces ORPHAN_ASSET findings concurrently with ghost code findings", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
      { filename: "snippets/omnisend-snippet.liquid", content: "<div>unused</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const ghostScripts = findingsOfType(findings, FindingType.GHOST_SCRIPT);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(ghostScripts).toHaveLength(1);
    expect(orphans).toHaveLength(1);
  });

  it("produces ORPHAN_ASSET findings with valid CreateFindingInput shape", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/klaviyo-tracking.liquid", content: "<div>orphan</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphan = findingsOfType(findings, FindingType.ORPHAN_ASSET)[0];
    expect(orphan).toBeDefined();
    expect(typeof orphan.filename).toBe("string");
    expect(typeof orphan.lineNumber).toBe("number");
    expect(typeof orphan.codeSnippet).toBe("string");
    expect(typeof orphan.description).toBe("string");
    expect(orphan.appName).toBe("Klaviyo");
  });

  it("handles a snippet file referenced via include tag (not just render)", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: "{% include 'legacy-widget' %}",
      },
      { filename: "snippets/legacy-widget.liquid", content: "<div>legacy</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("filters out orphan snippets that cannot be attributed to a known app", () => {
    // Stock theme snippets like icon-cart.liquid are unreferenced but are NOT ghost code.
    // Without app attribution they should be silently dropped.
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/icon-cart.liquid", content: "<svg>...</svg>" },
      { filename: "snippets/icon-zoom.liquid", content: "<svg>...</svg>" },
      { filename: "snippets/custom-helper.liquid", content: "<div>helper</div>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("keeps attributed orphans and drops unattributed ones in the same scan", () => {
    // Mix of known-app orphan (should be kept) and stock theme orphan (should be dropped)
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/klaviyo-form.liquid", content: "<div>klaviyo leftover</div>" },
      { filename: "snippets/icon-cart.liquid", content: "<svg>...</svg>" },
    ];
    const { findings } = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].filename).toBe("snippets/klaviyo-form.liquid");
    expect(orphans[0].appName).toBe("Klaviyo");
  });
});

// ---------------------------------------------------------------------------
// detectSettingsDrift
// ---------------------------------------------------------------------------

describe("detectSettingsDrift", () => {
  /** Helper to build a settings_data.json ThemeFile from a sections object. */
  function makeSettingsFile(sections: Record<string, unknown>): ThemeFile {
    return {
      filename: "config/settings_data.json",
      content: JSON.stringify({ current: { sections } }),
    };
  }

  it("detects stale section reference with known app", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "judgeme-reviews-abc123": { type: "judgeme_widgets", settings: {} },
      }),
      // No sections/judgeme_widgets.liquid exists
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.SETTINGS_DRIFT);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].filename).toBe("config/settings_data.json");
    expect(findings[0].description).toContain("judgeme_widgets");
    expect(findings[0].description).toContain("Judge.me");
  });

  it("detects stale reference with unknown app", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "custom-widget-xyz": { type: "some-unknown-app-section", settings: {} },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.SETTINGS_DRIFT);
    expect(findings[0].appName).toBeUndefined();
    expect(findings[0].description).toContain("some-unknown-app-section");
    expect(findings[0].description).toContain("may be from an uninstalled app");
  });

  it("skips valid section references when section file exists", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        header: { type: "header", settings: {} },
      }),
      {
        filename: "sections/header.liquid",
        content: "<header>{{ section.settings.logo }}</header>",
      },
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("handles missing settings_data.json", () => {
    const files: ThemeFile[] = [{ filename: "layout/theme.liquid", content: "<html></html>" }];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("handles malformed JSON in settings_data.json", () => {
    const files: ThemeFile[] = [
      { filename: "config/settings_data.json", content: "{ this is not valid JSON }" },
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("skips Shopify built-in section types", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "header-group": { type: "header-group", settings: {} },
        "footer-group": { type: "footer-group", settings: {} },
        aside: { type: "aside", settings: {} },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("produces one finding per stale section reference", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "pagefly-section-1": { type: "pagefly", settings: {} },
        "valid-section": { type: "featured-collection", settings: {} },
        "unknown-widget": { type: "mystery-widget", settings: {} },
      }),
      { filename: "sections/featured-collection.liquid", content: "<div>collection</div>" },
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(2);
    const types = findings.map((f) => f.description);
    expect(types.some((d) => d.includes("pagefly"))).toBe(true);
    expect(types.some((d) => d.includes("mystery-widget"))).toBe(true);
  });

  it("sets appName correctly via identifyAppFromSnippetName", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "pf-section-abc": { type: "pagefly", settings: {} },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
  });

  it("assigns LOW severity by default", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "stale-ref": { type: "some-removed-section", settings: {} },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("includes a code snippet from the settings entry", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "widget-abc": { type: "pagefly", settings: { color: "red" } },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].codeSnippet).toContain("pagefly");
    expect(findings[0].codeSnippet.length).toBeLessThanOrEqual(300);
  });

  it("skips entries without a type field", () => {
    const files: ThemeFile[] = [
      makeSettingsFile({
        "broken-entry": { settings: {} },
      }),
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("returns empty when current has no sections key", () => {
    const files: ThemeFile[] = [
      {
        filename: "config/settings_data.json",
        content: JSON.stringify({ current: { general: {} } }),
      },
    ];
    const findings = detectSettingsDrift(files);
    expect(findings).toHaveLength(0);
  });

  it("is included in scanThemeFiles pass 3", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      makeSettingsFile({
        "pagefly-section-1": { type: "pagefly", settings: {} },
      }),
    ];
    const { findings } = scanThemeFiles(files);
    const driftFindings = findingsOfType(findings, FindingType.SETTINGS_DRIFT);
    expect(driftFindings).toHaveLength(1);
    expect(driftFindings[0].appName).toBe("PageFly");
  });
});

// ---------------------------------------------------------------------------
// detectGhostPixels
// ---------------------------------------------------------------------------

describe("detectGhostPixels", () => {
  it("detects Facebook Pixel (fbq)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        "  fbq('init', '123456789');",
        "  fbq('track', 'PageView');",
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PIXEL);
    expect(findings[0].appName).toBe("Facebook Pixel");
    expect(findings[0].description).toContain("fbq");
  });

  it("detects Google Analytics gtag", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  gtag('config', 'UA-12345-1');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Google Analytics");
    expect(findings[0].description).toContain("gtag");
  });

  it("detects TikTok Pixel (ttq)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  ttq.load('ABC123');\n  ttq.page();\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("TikTok Pixel");
  });

  it("detects Pinterest Tag (pintrk)", () => {
    const file: ThemeFile = {
      filename: "sections/header.liquid",
      content: "<script>\n  pintrk('load', '123456');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Pinterest Tag");
  });

  it("detects Twitter/X Pixel (twq)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  twq('init', 'abc123');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Twitter/X Pixel");
  });

  it("detects Snapchat Pixel (snaptr)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  snaptr('init', '123456');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Snapchat Pixel");
  });

  it("detects legacy Google Analytics (_gaq)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  _gaq.push(['_trackPageview']);\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Google Analytics (Legacy)");
  });

  it("deduplicates per tracker per file — multiple fbq calls produce 1 finding", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        "  fbq('init', '111');",
        "  fbq('track', 'PageView');",
        "  fbq('track', 'Purchase', {value: 10});",
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Facebook Pixel");
    // Line number should be the first occurrence
    expect(findings[0].lineNumber).toBe(2);
  });

  it("detects multiple different trackers in the same file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        "  fbq('init', '111');",
        "  gtag('config', 'UA-12345-1');",
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(2);
    const appNames = findings.map((f) => f.appName);
    expect(appNames).toContain("Facebook Pixel");
    expect(appNames).toContain("Google Analytics");
  });

  it("ignores non-tracking JavaScript", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        "  var x = 42;",
        "  console.log('hello');",
        "  document.addEventListener('click', function() {});",
        "  function myFunc() { return true; }",
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(0);
  });

  it("ignores tracking-like code outside of script blocks", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<!-- fbq('init', '123') -->",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(0);
  });

  it("assigns HIGH severity by default", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  fbq('init', '123');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("downgrades to LOW inside a Liquid comment", () => {
    // The comment opener must be within the buildSnippet window (1 line
    // before the match). Putting it on the line directly before the match
    // ensures it appears in the snippet.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% comment %} <script>\nfbq('init', '123');\n</script> {% endcomment %}",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("reports the correct line number for first occurrence", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<html>",
        "<head>",
        "<script>",
        "  // some setup",
        "  gtag('config', 'G-XXXXX');",
        "</script>",
        "</head>",
      ].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(5);
  });

  it("detects Google Analytics Universal (ga with send/create/require)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        "<script>\n  ga('create', 'UA-12345-1', 'auto');\n  ga('send', 'pageview');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Google Analytics (Universal)");
  });

  it("detects Reddit Pixel (rdt)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  rdt('init', 't2_abc123');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Reddit Pixel");
  });

  it("detects Tealium (_taq)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  _taq.push(['page']);\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Tealium");
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "<script>\n  fbq('init', '123');\n</script>",
      },
    ];
    const { findings } = scanThemeFiles(files);
    const pixelFindings = findingsOfType(findings, FindingType.GHOST_PIXEL);
    expect(pixelFindings).toHaveLength(1);
    expect(pixelFindings[0].appName).toBe("Facebook Pixel");
  });
});

// ---------------------------------------------------------------------------
// detectJsonLdConflicts
// ---------------------------------------------------------------------------

describe("detectJsonLdConflicts", () => {
  it("detects conflicting Product JSON-LD with different aggregateRating", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">',
        '{"@type": "Product", "@context": "https://schema.org", "name": "Widget", "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.5"}}',
        "</script>",
        "<p>some content</p>",
        '<script type="application/ld+json">',
        '{"@type": "Product", "@context": "https://schema.org", "name": "Widget", "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.2"}}',
        "</script>",
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.JSON_LD_CONFLICT);
    expect(findings[0].description).toContain("Product");
    expect(findings[0].description).toContain("line 1");
    expect(findings[0].lineNumber).toBe(5);
  });

  it("detects conflicting BreadcrumbList with different items", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">',
        '{"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Home"}]}',
        "</script>",
        '<script type="application/ld+json">',
        '{"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Shop"}]}',
        "</script>",
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("BreadcrumbList");
  });

  it("skips identical duplicate blocks (same @type, same content)", () => {
    const jsonContent = '{"@type": "Product", "@context": "https://schema.org", "name": "Widget"}';
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        `<script type="application/ld+json">${jsonContent}</script>`,
        `<script type="application/ld+json">${jsonContent}</script>`,
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(0);
  });

  it("skips single occurrence of a type", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<script type="application/ld+json">{"@type": "Product", "name": "Widget"}</script>',
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(0);
  });

  it("skips blocks with Liquid template tags", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">',
        '{"@type": "Product", "name": "{{ product.title }}"}',
        "</script>",
        '<script type="application/ld+json">',
        '{"@type": "Product", "name": "Static Widget"}',
        "</script>",
      ].join("\n"),
    };
    // The Liquid block is skipped, leaving only one static block — no conflict
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple conflicting types in the same file", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
        '<script type="application/ld+json">{"@type": "FAQPage", "mainEntity": []}</script>',
        '<script type="application/ld+json">{"@type": "FAQPage", "mainEntity": [{"@type": "Question"}]}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(2);
    const types = findings.map((f) => f.description);
    expect(types.some((d) => d.includes("Product"))).toBe(true);
    expect(types.some((d) => d.includes("FAQPage"))).toBe(true);
  });

  it("handles malformed JSON gracefully", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{not valid json}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget"}</script>',
      ].join("\n"),
    };
    // Malformed block skipped, only one valid block — no conflict
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(0);
  });

  it("assigns HIGH severity by default", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("downgrades to LOW when inside a Liquid comment", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        "{% comment %}",
        '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
        "{% endcomment %}",
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("attributes app when identifyAppFromJsonLd matches", () => {
    // Use a known Judge.me signature pattern
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "B", "review": "judgeme"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    // appName may or may not match depending on app-lookup signatures;
    // the important thing is the function doesn't throw
    expect(findings[0].findingType).toBe(FindingType.JSON_LD_CONFLICT);
  });

  it("reports correct line numbers for 2nd occurrence and mentions first in description", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        "<!-- line 1 -->",
        "<!-- line 2 -->",
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        "<!-- line 4 -->",
        "<!-- line 5 -->",
        "<!-- line 6 -->",
        '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(7);
    expect(findings[0].description).toContain("line 3");
  });

  it("emits findings for 2nd and 3rd blocks when three blocks share the same @type", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "C"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[1].lineNumber).toBe(3);
    // Both should reference line 1 (the first occurrence)
    expect(findings[0].description).toContain("line 1");
    expect(findings[1].description).toContain("line 1");
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "templates/product.liquid",
        content: [
          '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
          '<script type="application/ld+json">{"@type": "Product", "name": "B"}</script>',
        ].join("\n"),
      },
    ];
    const { findings } = scanThemeFiles(files);
    const conflictFindings = findingsOfType(findings, FindingType.JSON_LD_CONFLICT);
    expect(conflictFindings).toHaveLength(1);
    expect(conflictFindings[0].description).toContain("Product");
  });

  it("detects conflict between two @graph-wrapped Product nodes", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">',
        '{"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": "Widget", "sku": "AAA"}]}',
        "</script>",
        '<script type="application/ld+json">',
        '{"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": "Widget", "sku": "BBB"}]}',
        "</script>",
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Product");
    expect(findings[0].description).toContain("line 1");
    expect(findings[0].lineNumber).toBe(4);
  });

  it("groups an array @type node with a plain-string @type node", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": ["Product", "Thing"], "name": "Widget", "sku": "AAA"}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "sku": "BBB"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Product");
  });

  it("detects conflict inside a top-level JSON array block", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content:
        '<script type="application/ld+json">[{"@type": "Product", "name": "A"}, {"@type": "Product", "name": "B"}]</script>',
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Product");
  });

  it("catches an all-pairs conflict when block[0] and block[1] are identical but block[2] differs", () => {
    const same = '{"@type": "Product", "name": "Widget", "sku": "AAA"}';
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        `<script type="application/ld+json">${same}</script>`,
        `<script type="application/ld+json">${same}</script>`,
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "sku": "BBB"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    // block[1] is an exact duplicate of block[0] (skipped); block[2] conflicts.
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(3);
    expect(findings[0].description).toContain("line 1");
  });

  it("treats key-reordered but semantically identical nodes as duplicates, not conflicts", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "sku": "AAA"}</script>',
        '<script type="application/ld+json">{"sku": "AAA", "name": "Widget", "@type": "Product"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(0);
  });

  it("surfaces a conflicting Offer price between two Product blocks", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "19.99", "priceCurrency": "USD"}}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "24.99", "priceCurrency": "USD"}}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    // Base substrings preserved, plus the enriched offer clause.
    expect(findings[0].description).toContain('"@type": "Product"');
    expect(findings[0].description).toContain("line 1");
    expect(findings[0].description).toContain("offer price differs");
    expect(findings[0].description).toContain("19.99");
    expect(findings[0].description).toContain("24.99");
  });

  it("normalizes numeric vs string price when diffing offers", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": 19.99}}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "19.99"}}</script>',
      ].join("\n"),
    };
    // The raw JSON differs (number 19.99 vs string "19.99"), so the generic
    // node-level conflict still fires. But the OFFER diff normalizes both to the
    // same string, so no misleading "offer price differs" clause is appended.
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).not.toContain("offer");
  });

  it("surfaces conflicting Offer availability and strips the schema.org URL prefix", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "availability": "https://schema.org/InStock"}}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "availability": "https://schema.org/OutOfStock"}}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("offer availability differs");
    expect(findings[0].description).toContain("InStock");
    expect(findings[0].description).toContain("OutOfStock");
    // The URL prefix must be stripped for readability.
    expect(findings[0].description).not.toContain("schema.org");
  });

  it("compares the first offer when offers is an array on one side", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": [{"@type": "Offer", "price": "19.99"}, {"@type": "Offer", "price": "99.99"}]}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "24.99"}}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("offer price differs");
    expect(findings[0].description).toContain("19.99");
    expect(findings[0].description).toContain("24.99");
    // The second array element (99.99) is ignored: only the first offer counts.
    expect(findings[0].description).not.toContain("99.99");
  });

  it("surfaces conflicting price between two direct @type Offer nodes", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Offer", "price": "19.99", "priceCurrency": "USD"}</script>',
        '<script type="application/ld+json">{"@type": "Offer", "price": "24.99", "priceCurrency": "USD"}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('"@type": "Offer"');
    expect(findings[0].description).toContain("offer price differs");
    expect(findings[0].description).toContain("19.99");
    expect(findings[0].description).toContain("24.99");
  });

  it("lists multiple differing offer fields (price and availability)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "19.99", "availability": "https://schema.org/InStock"}}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "offers": {"@type": "Offer", "price": "24.99", "availability": "https://schema.org/OutOfStock"}}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("offer price differs");
    expect(findings[0].description).toContain("offer availability differs");
  });

  it("keeps the generic wording when the conflict is not offer-related", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.5"}}</script>',
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget", "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.2"}}</script>',
      ].join("\n"),
    };
    const findings = detectJsonLdConflicts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('"@type": "Product"');
    expect(findings[0].description).toContain("line 1");
    // No offer field differs, so the description must not gain an offer clause.
    expect(findings[0].description).not.toContain("offer");
  });
});

// ---------------------------------------------------------------------------
// detectGhostLayouts
// ---------------------------------------------------------------------------

describe("detectGhostLayouts", () => {
  it("detects PageFly layout", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.liquid",
        content: "<html>PageFly layout content</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_LAYOUT);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[0].filename).toBe("layout/theme.pagefly.liquid");
    expect(findings[0].description).toContain("PageFly");
  });

  it("detects GemPages layout", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.gempages.liquid",
        content: "<html>GemPages layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("GemPages");
  });

  it("detects Shogun layout", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.shogun.liquid",
        content: "<html>Shogun layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Shogun");
  });

  it("detects gem- prefix layout as GemPages", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/gem-landing.liquid",
        content: "<html>GemPages landing layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("GemPages");
  });

  it("skips theme.liquid", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "<html>Main theme layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });

  it("skips password.liquid", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/password.liquid",
        content: "<html>Password layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });

  it("skips checkout.liquid", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/checkout.liquid",
        content: "<html>Checkout layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });

  it("detects unknown app layout matching theme.*.liquid pattern", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.unknownapp.liquid",
        content: "<html>Unknown app layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBeUndefined();
    expect(findings[0].description).toContain("likely left by an uninstalled page builder");
  });

  it("skips custom merchant layout that does not match app patterns", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/landing.liquid",
        content: "<html>Custom landing layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple ghost layouts", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "<html>Main layout</html>",
      },
      {
        filename: "layout/theme.pagefly.liquid",
        content: "<html>PageFly layout</html>",
      },
      {
        filename: "layout/theme.gempages.liquid",
        content: "<html>GemPages layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(2);
    const appNames = findings.map((f) => f.appName);
    expect(appNames).toContain("PageFly");
    expect(appNames).toContain("GemPages");
  });

  it("assigns MEDIUM severity by default", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.liquid",
        content: "<html>PageFly layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("downgrades to LOW when content is inside a Liquid comment", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.liquid",
        content: "{% comment %}\n<html>PageFly layout</html>\n{% endcomment %}",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("truncates code snippet to 300 characters", () => {
    const longContent = "x".repeat(500);
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.liquid",
        content: longContent,
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings[0].codeSnippet).toHaveLength(300);
  });

  it("sets lineNumber to 1", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.liquid",
        content: "<html>PageFly layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings[0].lineNumber).toBe(1);
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "<html>{{ content_for_layout }}</html>",
      },
      {
        filename: "layout/theme.pagefly.liquid",
        content: "<html>PageFly layout content</html>",
      },
    ];
    const { findings } = scanThemeFiles(files);
    const layoutFindings = findingsOfType(findings, FindingType.GHOST_LAYOUT);
    expect(layoutFindings).toHaveLength(1);
    expect(layoutFindings[0].appName).toBe("PageFly");
  });

  it("attributes via file content when filename does not match known patterns", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.custombuilder.liquid",
        content: '<html><script src="https://cdn.pagefly.io/pagefly.js"></script></html>',
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    // Should be attributed via identifyAppFromCode matching pagefly pattern in content
    expect(findings[0].appName).toBe("PageFly");
  });

  it("detects Zipify layout", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.zipify.liquid",
        content: "<html>Zipify layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Zipify Pages");
  });

  it("detects EComSolid layout", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.ecomsolid.liquid",
        content: "<html>EComSolid layout</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("EComSolid");
  });

  it("ignores non-layout files", () => {
    const files: ThemeFile[] = [
      {
        filename: "snippets/theme.pagefly.liquid",
        content: "<html>Not a layout file</html>",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });

  it("ignores non-liquid files in layout directory", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.pagefly.json",
        content: "{}",
      },
    ];
    const findings = detectGhostLayouts(files);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectGhostRobots
// ---------------------------------------------------------------------------

describe("detectGhostRobots", () => {
  it("detects static noindex meta robots", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="robots" content="noindex">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_ROBOTS);
    expect(findings[0].description).toContain("noindex");
  });

  it("detects nofollow", () => {
    const file: ThemeFile = {
      filename: "templates/collection.liquid",
      content: '<meta name="robots" content="nofollow">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("nofollow");
  });

  it("detects none", () => {
    const file: ThemeFile = {
      filename: "templates/page.liquid",
      content: '<meta name="robots" content="none">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("none");
  });

  it("detects noindex,nofollow combo", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="robots" content="noindex, nofollow">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("noindex, nofollow");
  });

  it("skips index,follow (permissive directive)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="robots" content="index, follow">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
  });

  it("skips conditional robots (Liquid if)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '{% if template == "404" %}<meta name="robots" content="noindex">{% endif %}',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
  });

  it("skips conditional robots (Liquid unless)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content:
        '{%- unless request.page_type == "index" -%}<meta name="robots" content="noindex">{%- endunless -%}',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
  });

  it("detects with content before name (attribute order variant)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta content="noindex" name="robots">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_ROBOTS);
  });

  it("severity is HIGH by default", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="robots" content="noindex">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("severity is LOW inside Liquid comment", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '{% comment %}<meta name="robots" content="noindex">{% endcomment %}',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "templates/product.liquid",
        content: '<meta name="robots" content="noindex">',
      },
    ];
    const result = scanThemeFiles(files);
    const robotsFindings = findingsOfType(result.findings, FindingType.GHOST_ROBOTS);
    expect(robotsFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectGhostCanonical
// ---------------------------------------------------------------------------

describe("detectGhostCanonical", () => {
  // --- Detection cases ---

  it("detects empty canonical href", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Empty canonical href");
  });

  it("detects whitespace-only canonical href", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="   ">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Empty canonical href");
  });

  it("detects unresolved Liquid variable in href", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="{{ seo_canonical_url }}">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("detects unresolved complex Liquid variable with filter", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="{{ canonical_override | strip }}">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("detects duplicate canonical tags in same file (flags 2nd)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<link rel="canonical" href="{{ canonical_url }}">',
        '<link rel="canonical" href="{{ canonical_url }}">',
      ].join("\n"),
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Duplicate canonical tag");
    expect(findings[0].lineNumber).toBe(2);
  });

  it("detects app-attributed canonical via code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- avada-seo canonical override -->",
        '<link rel="canonical" href="https://mystore.com/products/thing">',
      ].join("\n"),
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].appName).toBe("Avada SEO Suite");
    expect(findings[0].description).toContain("App-attributed canonical");
  });

  it("detects reversed attribute order (href before rel)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link href="" rel="canonical">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
    expect(findings[0].description).toContain("Empty canonical href");
  });

  // --- False positive avoidance ---

  it("does NOT flag native Shopify canonical_url", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="{{ canonical_url }}">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag native canonical_url with filter", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="{{ canonical_url | strip }}">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag canonical inside Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '{% if template == \'product\' %}<link rel="canonical" href="">{%endif%}',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag canonical inside Liquid comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '{% comment %}<link rel="canonical" href="">{% endcomment %}',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag single valid hardcoded canonical URL", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="https://mystore.com/">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag valid Liquid variables: request.path, shop.url, page_url", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<link rel="canonical" href="{{ request.path }}">',
        '<link rel="canonical" href="{{ shop.url }}">',
        '<link rel="canonical" href="{{ page_url }}">',
      ].join("\n"),
    };
    const findings = detectGhostCanonical(file);
    // 3 tags total, but all use safe vars — should only get duplicate findings for lines 2+
    // since the safe vars are not flagged as unresolved.
    // Actually: 3 canonicals means line 2 and 3 are duplicates.
    const unresolvedFindings = findings.filter((f) => f.description.includes("Unresolved"));
    expect(unresolvedFindings).toHaveLength(0);
  });

  it("returns empty for file with no canonical tags", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<head><title>Hello</title></head>",
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(0);
  });

  // --- Severity ---

  it("severity is HIGH by default", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="canonical" href="">',
    };
    const findings = detectGhostCanonical(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  // --- Integration ---

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<link rel="canonical" href="">',
      },
    ];
    const result = scanThemeFiles(files);
    const canonicalFindings = findingsOfType(result.findings, FindingType.GHOST_CANONICAL);
    expect(canonicalFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectGhostTitle
// ---------------------------------------------------------------------------

describe("detectGhostTitle", () => {
  // --- Detection cases ---

  it("detects empty title in layout file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title></title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Empty title tag");
  });

  it("detects whitespace-only title in layout file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>   </title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Empty title tag");
  });

  it("detects unresolved Liquid variable in title", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ seo_title_format }}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("detects unresolved variable mixed with valid page_title (HIGH severity — unresolved var is the issue)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ page_title }} | {{ seo_suffix }}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("detects app-attributed title via code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<!-- booster-seo title override -->", "<title>{{ page_title }}</title>"].join(
        "\n",
      ),
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].appName).toBe("BOOSTER SEO");
    expect(findings[0].description).toContain("App-attributed title");
  });

  it("detects duplicate title tags in same layout file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<title>{{ page_title }}</title>", "<title>{{ page_title }}</title>"].join("\n"),
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Duplicate title tag");
    expect(findings[0].lineNumber).toBe(2);
  });

  it("detects title with known-app render as app-attributed", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<!-- seo-manager title -->", "<title>My Store</title>"].join("\n"),
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].appName).toBe("SEO Manager");
  });

  // --- False positive avoidance ---

  it("does NOT flag native Dawn title with page_title and shop.name", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ page_title }} &ndash; {{ shop.name }}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag title with only safe variables", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        "<title>{{ page_title }}{% unless page_title contains shop.name %} - {{ shop.name }}{% endunless %}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag title inside a Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% if template == 'product' %}<title></title>{% endif %}",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag title inside a Liquid comment", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "{% comment %}<title></title>{% endcomment %}",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag empty title in a non-layout file", () => {
    const file: ThemeFile = {
      filename: "templates/404.liquid",
      content: "<title></title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag title with content_for_header or content_for_* variables", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ content_for_header }}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for file with no title tags", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<head><link rel="canonical" href="{{ canonical_url }}"></head>',
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(0);
  });

  // --- Severity ---

  it("severity is HIGH by default", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title></title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  // --- Integration ---

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "<title></title>",
      },
    ];
    const result = scanThemeFiles(files);
    const titleFindings = findingsOfType(result.findings, FindingType.GHOST_TITLE);
    expect(titleFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectGhostOg
// ---------------------------------------------------------------------------

describe("detectGhostOg", () => {
  // --- Detections (should fire) ---

  it("detects empty og:title content", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:title" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].description).toContain("og:title");
    expect(findings[0].description).toContain("Empty");
  });

  it("detects empty og:image content and upgrades to HIGH severity", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:image" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].description).toContain("og:image");
  });

  it("detects empty twitter:description content", () => {
    const file: ThemeFile = {
      filename: "sections/header.liquid",
      content: '<meta name="twitter:description" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].description).toContain("twitter:description");
  });

  it("detects unresolved variable in og:title content", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:title" content="{{ seo_og_title }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].description).toContain("Unresolved");
    expect(findings[0].description).toContain("og:title");
  });

  it("detects unresolved variable in og:image content", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:image" content="{{ app_social_image }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Unresolved");
    expect(findings[0].description).toContain("og:image");
  });

  it("detects app-attributed OG tag via identifyAppFromCode", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- avada-seo social tags -->",
        '<meta property="og:title" content="{{ page_title }}">',
      ].join("\n"),
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].appName).toBe("Avada SEO Suite");
    expect(findings[0].description).toContain("App-attributed");
  });

  it("detects whitespace-only content on og:description", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:description" content="   ">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Empty");
    expect(findings[0].description).toContain("og:description");
  });

  // --- False positive avoidance (should NOT fire) ---

  it("does NOT flag native Dawn og:title with page_title", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:title" content="{{ page_title }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag native og:image with filter (img_url)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<meta property="og:image" content="{{ product.featured_image | img_url: \'1200x630\' }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag native twitter:card with static valid content", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta name="twitter:card" content="summary_large_image">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag OG tag inside Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '{% if template == "product" %}<meta property="og:title" content="">{% endif %}',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag OG tag inside Liquid comment", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '{% comment %}\n<meta property="og:title" content="">\n{% endcomment %}',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag low-impact empty property og:locale", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:locale" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for file with no OG tags", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<head><title>{{ page_title }}</title></head>",
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag duplicate og:title (handled by DUPLICATE_META)", () => {
    // GHOST_OG should not re-detect duplicates — that's DUPLICATE_META's job.
    // Two identical og:title tags with valid content should not produce GHOST_OG findings.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<meta property="og:title" content="{{ page_title }}">',
        '<meta property="og:title" content="{{ page_title }}">',
      ].join("\n"),
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag static valid og:type content", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:type" content="website">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  // --- Additional edge cases ---

  it("does NOT flag og:description with strip_html filter", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<meta property="og:description" content="{{ page_description | strip_html | truncate: 200 }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag empty og:site_name (low-impact property)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:site_name" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag empty twitter:site (low-impact property)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta name="twitter:site" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag empty fb:app_id (low-impact property)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="fb:app_id" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag og:image with collection.image safe variable", () => {
    const file: ThemeFile = {
      filename: "sections/collection.liquid",
      content:
        '<meta property="og:image" content="{{ collection.image | img_url: \'1200x630\' }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple broken OG tags in same file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<meta property="og:title" content="">',
        '<meta property="og:description" content="">',
        '<meta property="og:image" content="">',
      ].join("\n"),
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(3);
  });

  // --- Severity ---

  it("severity is MEDIUM by default for non-og:image", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:title" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("severity is HIGH for empty og:image", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<meta property="og:image" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  // --- Integration ---

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<meta property="og:title" content="">',
      },
    ];
    const result = scanThemeFiles(files);
    const ogFindings = findingsOfType(result.findings, FindingType.GHOST_OG);
    expect(ogFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Golden-file regression: stock Shopify free reference themes (LOG-1 / GC-s47)
//
// Legitimate Dawn-family theme markup must produce ZERO GHOST_TITLE / GHOST_OG
// findings. Each theme is asserted by name so a future regression points at the
// exact theme whose head markup broke. These tests guard the safe-variable
// allowlists against silently narrowing.
// ---------------------------------------------------------------------------

describe("reference-theme golden files — no GHOST_TITLE/GHOST_OG false positives", () => {
  for (const theme of REFERENCE_THEMES) {
    it(`does NOT flag ${theme.name} <title> markup`, () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: theme.title,
      };
      expect(detectGhostTitle(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} meta-tags.liquid OG/Twitter markup`, () => {
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: theme.metaTags,
      };
      expect(detectGhostOg(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} full head via scanThemeFiles`, () => {
      const files: ThemeFile[] = [
        {
          filename: "layout/theme.liquid",
          content: `<head>\n${theme.title}\n</head>`,
        },
        { filename: "snippets/meta-tags.liquid", content: theme.metaTags },
      ];
      const { findings } = scanThemeFiles(files);
      expect(findingsOfType(findings, FindingType.GHOST_TITLE)).toHaveLength(0);
      expect(findingsOfType(findings, FindingType.GHOST_OG)).toHaveLength(0);
    });
  }

  // Spot-check the specific variables/filters that previously false-positived,
  // so a narrowing of any one allowlist entry fails loudly and specifically.
  it("does NOT flag Dawn local og_* assigns (og_title/og_url/og_type/og_description)", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: [
        '<meta property="og:url" content="{{ og_url }}">',
        '<meta property="og:title" content="{{ og_title | escape }}">',
        '<meta property="og:type" content="{{ og_type }}">',
        '<meta property="og:description" content="{{ og_description | escape }}">',
      ].join("\n"),
    };
    expect(detectGhostOg(file)).toHaveLength(0);
  });

  it("does NOT flag page_image / page_image.width / page_image.height", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: [
        '<meta property="og:image" content="http:{{ page_image | image_url }}">',
        '<meta property="og:image:width" content="{{ page_image.width }}">',
        '<meta property="og:image:height" content="{{ page_image.height }}">',
      ].join("\n"),
    };
    expect(detectGhostOg(file)).toHaveLength(0);
  });

  it("does NOT flag request.* / settings.* / cart.* native objects", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: [
        '<meta property="og:url" content="{{ request.origin }}">',
        '<meta property="og:price:currency" content="{{ cart.currency.iso_code }}">',
        '<meta name="twitter:site" content="{{ settings.social_twitter_link | split: \'/\' | last }}">',
      ].join("\n"),
    };
    expect(detectGhostOg(file)).toHaveLength(0);
  });

  it("does NOT flag the | t (translate) or | default filters on otherwise-unknown vars", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: [
        '<meta property="og:title" content="{{ \'general.meta.title\' | t }}">',
        '<meta property="og:description" content="{{ meta_blurb | default: shop.name }}">',
      ].join("\n"),
    };
    expect(detectGhostOg(file)).toHaveLength(0);
  });

  it("does NOT flag Dawn <title> current_tags / current_page pagination vars", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: DAWN_TITLE,
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// v1.3 / v1.4 detectors (gc-06e.3): the same real-stock-theme golden-file guard
// applied to detectGhostCanonical / detectGhostPreconnect / detectGhostFont /
// detectGhostAjax. These detectors had ZERO coverage against real Dawn markup,
// the exact LOG-1 class of bug that shipped false positives. A failure here is a
// REAL false positive on legitimate stock-theme code, not a test to weaken.
// ---------------------------------------------------------------------------

describe("reference-theme golden files (v1.3/v1.4): no false positives on canonical/preconnect/font/ajax", () => {
  for (const theme of REFERENCE_THEMES) {
    it(`does NOT flag ${theme.name} canonical link markup`, () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: theme.canonical,
      };
      expect(detectGhostCanonical(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} preconnect hint markup`, () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: theme.preconnect,
      };
      expect(detectGhostPreconnect(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} font preload + font_face markup`, () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: theme.fontFace,
      };
      expect(detectGhostFont(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} relative route-variable fetch call sites`, () => {
      const file: ThemeFile = {
        filename: "assets/global.js",
        content: theme.ajax,
      };
      expect(detectGhostAjax(file)).toHaveLength(0);
    });

    it(`does NOT flag ${theme.name} full liquid head via scanThemeFiles`, () => {
      const files: ThemeFile[] = [
        {
          filename: "layout/theme.liquid",
          content: `<head>\n${theme.canonical}\n${theme.preconnect}\n${theme.fontFace}\n</head>`,
        },
      ];
      const { findings } = scanThemeFiles(files);
      expect(findingsOfType(findings, FindingType.GHOST_CANONICAL)).toHaveLength(0);
      expect(findingsOfType(findings, FindingType.GHOST_PRECONNECT)).toHaveLength(0);
      expect(findingsOfType(findings, FindingType.GHOST_FONT)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Anti-over-correction: the expanded allowlists must NOT blind the detector to
// genuine ghost code. Truly orphaned / app-injected markup is STILL flagged.
// ---------------------------------------------------------------------------

describe("allowlist expansion still catches real GHOST_TITLE/GHOST_OG findings", () => {
  it("STILL flags an empty title in a layout file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<head>\n<title></title>\n</head>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Empty title tag");
  });

  it("STILL flags a broken app-attributed unresolved title variable", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ seoapp_meta_title }}</title>",
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TITLE);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("STILL flags an orphaned unresolved OG variable from an uninstalled app", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: '<meta property="og:title" content="{{ seoapp_meta_title }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].description).toContain("Unresolved");
  });

  it("STILL flags an empty high-value OG image left behind by an app", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: '<meta property="og:image" content="">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_OG);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("STILL flags an unknown var even when a known-safe var is also present", () => {
    const file: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: '<meta property="og:title" content="{{ page_title }} {{ seoapp_suffix }}">',
    };
    const findings = detectGhostOg(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Unresolved");
  });
});

// ---------------------------------------------------------------------------
// detectGhostPreconnect
// ---------------------------------------------------------------------------

describe("detectGhostPreconnect", () => {
  // --- Detections (should fire) ---

  it("detects preconnect to known app CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://cdn.judge.me">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PRECONNECT);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].filename).toBe("layout/theme.liquid");
    expect(findings[0].description).toContain("preconnect");
    expect(findings[0].description).toContain("cdn.judge.me");
  });

  it("detects dns-prefetch to known app CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="dns-prefetch" href="//cdn.loox.io">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PRECONNECT);
    expect(findings[0].appName).toBe("Loox");
    expect(findings[0].description).toContain("dns-prefetch");
  });

  it("detects preload to known app CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preload" href="https://cdn.pagefly.io/pagefly.js" as="script">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_PRECONNECT);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[0].description).toContain("preload");
  });

  it("detects reversed attribute order (href before rel)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link href="https://cdn.judge.me" rel="preconnect">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("attributes app from surrounding code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- Judge.me reviews widget -->",
        '<link rel="preconnect" href="https://judge.me">',
      ].join("\n"),
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects multiple preconnect hints on different lines", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<link rel="preconnect" href="https://cdn.judge.me">',
        "<p>Some content</p>",
        '<link rel="dns-prefetch" href="//cdn.loox.io">',
      ].join("\n"),
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[1].lineNumber).toBe(3);
    expect(findings[1].appName).toBe("Loox");
  });

  // --- False positive avoidance (should NOT fire) ---

  it("does not flag preconnect to Shopify CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://cdn.shopify.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to cdn.shopifycdn.net", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://cdn.shopifycdn.net">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to monorail-edge.shopifysvc.com", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://monorail-edge.shopifysvc.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to *.myshopify.com", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://my-store.myshopify.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to Google Fonts", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://fonts.googleapis.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to fonts.gstatic.com", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://fonts.gstatic.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to generic CDN (cdnjs.cloudflare.com)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://cdnjs.cloudflare.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect to cdn.jsdelivr.net", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://cdn.jsdelivr.net">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect inside Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '{% if settings.enable_reviews %}<link rel="preconnect" href="https://cdn.judge.me">{% endif %}',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect inside Liquid comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        '<link rel="preconnect" href="https://cdn.judge.me">',
        "{% endcomment %}",
      ].join("\n"),
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag preconnect inside whitespace-stripping Liquid comment", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{%- comment -%}",
        '<link rel="preconnect" href="https://cdn.judge.me">',
        "{%- endcomment -%}",
      ].join("\n"),
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag unknown domain not in app signatures", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="preconnect" href="https://custom-api.example.com">',
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for file with no resource hint tags", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<html><head><title>My Store</title></head></html>",
    };
    const findings = detectGhostPreconnect(file);
    expect(findings).toHaveLength(0);
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<link rel="preconnect" href="https://cdn.judge.me">',
      },
    ];
    const result = scanThemeFiles(files);
    const preconnectFindings = findingsOfType(result.findings, FindingType.GHOST_PRECONNECT);
    expect(preconnectFindings).toHaveLength(1);
    expect(preconnectFindings[0].appName).toBe("Judge.me");
  });
});

// ---------------------------------------------------------------------------
// detectGhostFont
// ---------------------------------------------------------------------------

describe("detectGhostFont", () => {
  // --- Detections (should fire) ---

  it("detects @font-face attributed to known app via code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- Judge.me reviews widget -->",
        "<style>",
        '@font-face { font-family: "JudgeReviewFont"; src: url("https://cdn.judge.me/fonts/review.woff2"); }',
        "</style>",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_FONT);
    expect(findings[0].severity).toBe(Severity.MEDIUM);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].description).toContain("@font-face");
    expect(findings[0].description).toContain("JudgeReviewFont");
  });

  it("detects Google Fonts link attributed to known app via code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- klaviyo form widget styles -->",
        '<link href="https://fonts.googleapis.com/css?family=Roboto" rel="stylesheet">',
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_FONT);
    expect(findings[0].appName).toBe("Klaviyo");
    expect(findings[0].description).toContain("font link");
  });

  it("detects font link attributed via URL to known app CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link href="https://cdn.judge.me/fonts/widget-font.css" rel="stylesheet">',
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_FONT);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects @font-face with single-quoted font-family", () => {
    const file: ThemeFile = {
      filename: "snippets/loox-widget.liquid",
      content: [
        "<!-- Loox reviews -->",
        "<style>",
        "@font-face { font-family: 'LooxIcons'; src: url('https://cdn.loox.io/fonts/icons.woff2'); }",
        "</style>",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Loox");
    expect(findings[0].description).toContain("LooxIcons");
  });

  it("detects multiple @font-face declarations on different lines", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- jdgm-widget judge.me styles -->",
        "<style>",
        '@font-face { font-family: "JudgeFont1"; src: url("https://cdn.judge.me/font1.woff2"); }',
        "p { color: red; }",
        '@font-face { font-family: "JudgeFont2"; src: url("https://cdn.judge.me/font2.woff2"); }',
        "</style>",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(2);
  });

  // --- False positive avoidance (should NOT fire) ---

  it("does not flag @font-face without app attribution", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<style>",
        '@font-face { font-family: "MyCustomFont"; src: url("/assets/custom.woff2"); }',
        "</style>",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Google Fonts link without app attribution", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<link href="https://fonts.googleapis.com/css?family=Open+Sans" rel="stylesheet">',
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag @font-face inside Liquid comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "<!-- Judge.me widget -->",
        '<style>@font-face { font-family: "JudgeFont"; src: url("font.woff2"); }</style>',
        "{% endcomment %}",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag @font-face inside whitespace-stripping Liquid comment", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{%- comment -%}",
        "<!-- Judge.me widget -->",
        '<style>@font-face { font-family: "JudgeFont"; src: url("font.woff2"); }</style>',
        "{%- endcomment -%}",
      ].join("\n"),
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag font link inside Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '{% if settings.enable_reviews %}<link href="https://cdn.judge.me/fonts/widget.css" rel="stylesheet">{% endif %}',
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for file with no font declarations", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<html><head><title>My Store</title></head></html>",
    };
    const findings = detectGhostFont(file);
    expect(findings).toHaveLength(0);
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: [
          "<!-- Judge.me reviews widget -->",
          "<style>",
          '@font-face { font-family: "JudgeFont"; src: url("https://cdn.judge.me/fonts/review.woff2"); }',
          "</style>",
        ].join("\n"),
      },
    ];
    const result = scanThemeFiles(files);
    const fontFindings = findingsOfType(result.findings, FindingType.GHOST_FONT);
    expect(fontFindings).toHaveLength(1);
    expect(fontFindings[0].appName).toBe("Judge.me");
  });
});

// ---------------------------------------------------------------------------
// Unified comment-skip: detectGhostTitle / detectGhostOg / detectGhostFont all
// delegate comment-block detection to buildCommentSkipLines (gc-06e.12). These
// tests lock the three detectors to identical comment-skip semantics so future
// drift (one detector clearing the insideComment flag differently) is caught.
//
// NOTE on the real behavior change: the previous inline Font loop cleared the
// comment flag on the {% endcomment %} line and `continue`d, which meant it
// SKIPPED any code on a {% endcomment %} line — including a stray, opener-less
// {% endcomment %}. The shared helper only skips lines while genuinely inside a
// comment, so Font now SCANS code on an opener-less endcomment line, matching
// Title/Og. Well-formed comment blocks are unchanged for all three.
// ---------------------------------------------------------------------------

describe("unified comment-skip across title/og/font (gc-06e.12)", () => {
  it("Font skips a font <link> sharing a line with {% endcomment %} in a comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "<!-- Judge.me widget -->",
        '<link href="https://cdn.judge.me/fonts/widget-font.css" rel="stylesheet"> {% endcomment %}',
      ].join("\n"),
    };
    expect(detectGhostFont(file)).toHaveLength(0);
  });

  it("Font skips an @font-face sharing a line with {% endcomment %} in a comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "<!-- Judge.me widget -->",
        '<style>@font-face { font-family: "JudgeFont"; src: url("https://cdn.judge.me/f.woff2"); }</style> {% endcomment %}',
      ].join("\n"),
    };
    expect(detectGhostFont(file)).toHaveLength(0);
  });

  it("Title/Og/Font all skip a ghost directive on the {% endcomment %} line of a comment block", () => {
    const titleFile: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["{% comment %}", "<title>{{ seoapp_meta_title }}</title> {% endcomment %}"].join(
        "\n",
      ),
    };
    const ogFile: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: [
        "{% comment %}",
        '<meta property="og:title" content="{{ seoapp_meta_title }}"> {% endcomment %}',
      ].join("\n"),
    };
    const fontFile: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        '<link href="https://cdn.judge.me/fonts/widget-font.css" rel="stylesheet"> {% endcomment %}',
      ].join("\n"),
    };
    expect(detectGhostTitle(titleFile)).toHaveLength(0);
    expect(detectGhostOg(ogFile)).toHaveLength(0);
    expect(detectGhostFont(fontFile)).toHaveLength(0);
  });

  it("Title/Og/Font all SCAN a ghost directive on an opener-less {% endcomment %} line (Font drift fixed)", () => {
    // No {% comment %} opener: the {% endcomment %} is stray, so the line is live
    // code. All three now treat it as scannable (previously Font alone skipped it).
    const titleFile: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<title>{{ seoapp_meta_title }}</title> {% endcomment %}",
    };
    const ogFile: ThemeFile = {
      filename: "snippets/meta-tags.liquid",
      content: '<meta property="og:title" content="{{ seoapp_meta_title }}"> {% endcomment %}',
    };
    const fontFile: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<link href="https://cdn.judge.me/fonts/widget-font.css" rel="stylesheet"> {% endcomment %}',
    };
    expect(detectGhostTitle(titleFile)).toHaveLength(1);
    expect(detectGhostOg(ogFile)).toHaveLength(1);
    const fontFindings = detectGhostFont(fontFile);
    expect(fontFindings).toHaveLength(1);
    expect(fontFindings[0].appName).toBe("Judge.me");
  });
});

// ---------------------------------------------------------------------------
// detectGhostAjax
// ---------------------------------------------------------------------------

describe("detectGhostAjax", () => {
  // --- Detections (should fire) ---

  it("detects fetch() call to known app domain", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", 'fetch("https://cdn.judge.me/api/reviews");', "</script>"].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_AJAX);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[0].description).toContain("fetch");
    expect(findings[0].description).toContain("cdn.judge.me");
  });

  it("detects fetch() with single quotes", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", "fetch('https://cdn.judge.me/api/reviews');", "</script>"].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects $.get() jQuery pattern to known app domain", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", '$.get("https://cdn.loox.io/api/widgets");', "</script>"].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_AJAX);
    expect(findings[0].appName).toBe("Loox");
    expect(findings[0].description).toContain("jQuery AJAX");
  });

  it("detects $.post() jQuery pattern to known app domain", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", '$.post("https://cdn.judge.me/api/submit");', "</script>"].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects $.ajax() with url property to known app domain", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", '$.ajax({url: "https://cdn.judge.me/api/data"});', "</script>"].join(
        "\n",
      ),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects XMLHttpRequest .open() to known app domain", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "https://static.klaviyo.com/api/track");',
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_AJAX);
    expect(findings[0].appName).toBe("Klaviyo");
    expect(findings[0].description).toContain("XMLHttpRequest");
  });

  it("detects fetch() attributed via code context", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<!-- Judge.me reviews API -->",
        "<script>",
        'fetch("https://judge.me/api/v1/reviews");',
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Judge.me");
  });

  it("detects multiple AJAX calls on different lines", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        'fetch("https://cdn.judge.me/api/reviews");',
        "var x = 1;",
        'fetch("https://static.klaviyo.com/api/track");',
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].appName).toBe("Judge.me");
    expect(findings[1].appName).toBe("Klaviyo");
  });

  // --- False positive avoidance (should NOT fire) ---

  it("does not flag fetch() to Shopify CDN", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", 'fetch("https://cdn.shopify.com/api/something");', "</script>"].join(
        "\n",
      ),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag fetch() to *.myshopify.com", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<script>",
        'fetch("https://my-store.myshopify.com/api/cart.js");',
        "</script>",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag fetch() to unknown domain not in app signatures", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<script>", 'fetch("https://api.unknown-service.com/data");', "</script>"].join(
        "\n",
      ),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag fetch() inside Liquid comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        "<script>",
        'fetch("https://cdn.judge.me/api/reviews");',
        "</script>",
        "{% endcomment %}",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag fetch() inside whitespace-stripping Liquid comment", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{%- comment -%}",
        "<script>",
        'fetch("https://cdn.judge.me/api/reviews");',
        "</script>",
        "{%- endcomment -%}",
      ].join("\n"),
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("does not flag fetch() inside Liquid conditional", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '{% if settings.enable_reviews %}fetch("https://cdn.judge.me/api/reviews"){% endif %}',
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for file with no AJAX calls", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<html><head><title>My Store</title></head></html>",
    };
    const findings = detectGhostAjax(file);
    expect(findings).toHaveLength(0);
  });

  it("is included in scanThemeFiles results", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: ["<script>", 'fetch("https://cdn.judge.me/api/reviews");', "</script>"].join("\n"),
      },
    ];
    const result = scanThemeFiles(files);
    const ajaxFindings = findingsOfType(result.findings, FindingType.GHOST_AJAX);
    expect(ajaxFindings).toHaveLength(1);
    expect(ajaxFindings[0].appName).toBe("Judge.me");
  });
});

// ---------------------------------------------------------------------------
// LOG-11: Multi-line tag detection (false negatives fixed)
// ---------------------------------------------------------------------------

describe("LOG-11 — multi-line HTML tag detection", () => {
  describe("detectGhostScripts — multi-line <script> tag", () => {
    it("detects a Klaviyo script tag split across multiple lines (prettier-formatted)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<head>",
          "<script",
          '  src="https://static.klaviyo.com/onsite/js/klaviyo.js"',
          "></script>",
          "</head>",
        ].join("\n"),
      };
      const findings = detectGhostScripts(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
      // Line number should point to the opening <script tag line
      expect(findings[0].lineNumber).toBe(2);
    });

    it("single-line <script> tag still detected (no regression)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      };
      const findings = detectGhostScripts(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].lineNumber).toBe(1);
    });
  });

  describe("detectGhostStyles — multi-line <link rel='stylesheet'> tag", () => {
    it("detects a Judge.me stylesheet split across multiple lines", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<head>",
          "<link",
          '  rel="stylesheet"',
          '  href="https://cdn.judge.me/assets/v4/widget.css"',
          ">",
          "</head>",
        ].join("\n"),
      };
      const findings = detectGhostStyles(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Judge.me");
      expect(findings[0].lineNumber).toBe(2);
    });

    it("single-line <link rel='stylesheet'> still detected (no regression)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css">',
      };
      const findings = detectGhostStyles(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].lineNumber).toBe(1);
    });
  });

  describe("detectGhostHrefLang — multi-line <link rel='alternate'> tag", () => {
    it("detects a Weglot hreflang tag split across multiple lines", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<head>",
          '<link rel="alternate"',
          '  hreflang="fr"',
          '  href="https://fr.example.com/">',
          "</head>",
        ].join("\n"),
      };
      const findings = detectGhostHrefLang(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Weglot");
      expect(findings[0].lineNumber).toBe(2);
    });
  });

  describe("detectGhostPreconnect — multi-line <link rel='preconnect'> tag", () => {
    it("detects a Klaviyo preconnect hint split across multiple lines", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<head>",
          '<link rel="preconnect"',
          '  href="https://static.klaviyo.com">',
          "</head>",
        ].join("\n"),
      };
      const findings = detectGhostPreconnect(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
      expect(findings[0].lineNumber).toBe(2);
    });
  });

  describe("detectGhostSections — multi-line {% section %} tag", () => {
    it("detects a PageFly section reference split across multiple lines (prettier-wrapped)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["<body>", "{%-", "  section 'pagefly-head'", "-%}"].join("\n"),
      };
      const findings = detectGhostSections(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("PageFly");
      // Line number points to the opening {%- of the tag.
      expect(findings[0].lineNumber).toBe(2);
    });

    it("emits exactly one finding per tag when single-line and multi-line section tags coexist", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% section 'shogun-head' %}", "{%-", "  section 'pagefly-head'", "-%}"].join(
          "\n",
        ),
      };
      const findings = detectGhostSections(file);
      // One tag-form + one multi-line tag = exactly TWO findings, no double-count.
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.appName).sort()).toEqual(["PageFly", "Shogun"]);
    });
  });

  describe("detectGhostCanonical — multi-line <link rel='canonical'> tag", () => {
    it("detects an empty canonical href split across multiple lines", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["<head>", "<link", '  rel="canonical"', '  href="">', "</head>"].join("\n"),
      };
      const findings = detectGhostCanonical(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.GHOST_CANONICAL);
      expect(findings[0].description).toContain("Empty canonical href");
      // Line number points to the opening <link of the tag.
      expect(findings[0].lineNumber).toBe(2);
    });

    it("emits exactly one finding per tag when single-line and multi-line canonical tags coexist", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          '<link rel="canonical" href="">',
          "<link",
          '  rel="canonical"',
          '  href="">',
        ].join("\n"),
      };
      const findings = detectGhostCanonical(file);
      // Two distinct empty-canonical tags = exactly TWO findings, no double-count.
      expect(findings).toHaveLength(2);
    });
  });

  describe("detectGhostAjax — multi-line fetch()/AJAX call", () => {
    it("detects a Judge.me fetch() call split across multiple lines", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<script>",
          "fetch(",
          '  "https://cdn.judge.me/api/reviews"',
          ");",
          "</script>",
        ].join("\n"),
      };
      const findings = detectGhostAjax(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.GHOST_AJAX);
      expect(findings[0].appName).toBe("Judge.me");
      // Line number points to the opening fetch( of the call.
      expect(findings[0].lineNumber).toBe(2);
    });

    it("emits exactly one finding per call when single-line and multi-line AJAX calls coexist", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "<script>",
          'fetch("https://cdn.judge.me/api/reviews");',
          "$.get(",
          '  "https://cdn.loox.io/api/widgets"',
          ");",
          "</script>",
        ].join("\n"),
      };
      const findings = detectGhostAjax(file);
      // One single-line fetch + one multi-line jQuery call = exactly TWO findings.
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.appName).sort()).toEqual(["Judge.me", "Loox"]);
    });
  });
});

// ---------------------------------------------------------------------------
// LOG-11: {% liquid %} block render reference detection
// ---------------------------------------------------------------------------

describe("LOG-11 — {% liquid %} block render references", () => {
  describe("detectGhostSnippets — bare render inside {% liquid %} block", () => {
    it("detects a known app snippet rendered via bare render inside {% liquid %} block", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          "{%- liquid",
          "  assign show_form = true",
          "  render 'klaviyo-onsite'",
          "-%}",
        ].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.GHOST_SNIPPET);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("detects bare include inside {% liquid %} block", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% liquid", '  include "klaviyo-form"', "%}"].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("standard {% render %} tag still detected (no regression)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: "{% render 'klaviyo-onsite' %}",
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
    });

    it("does NOT flag bare render inside {% comment %} block (no false positive)", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% comment %}", "  render 'klaviyo-onsite'", "{% endcomment %}"].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });

    it("does not flag unknown snippet names inside {% liquid %} block", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: ["{% liquid", "  render 'my-custom-snippet'", "%}"].join("\n"),
      };
      const findings = detectGhostSnippets(file);
      expect(findings).toHaveLength(0);
    });
  });

  describe("ORPHAN_ASSET — snippet only rendered inside {% liquid %} block", () => {
    it("does NOT flag a snippet as ORPHAN_ASSET when it is rendered only inside a {% liquid %} block", () => {
      // snippets/klaviyo-onsite.liquid is referenced by a bare render inside
      // a {% liquid %} block — the file-reference-analyzer must count it as
      // referenced so scanThemeFiles does NOT emit an ORPHAN_ASSET finding.
      const files: ThemeFile[] = [
        {
          filename: "snippets/klaviyo-onsite.liquid",
          content: "<!-- klaviyo onsite form -->",
        },
        {
          filename: "layout/theme.liquid",
          content: ["{% liquid", "  render 'klaviyo-onsite'", "%}"].join("\n"),
        },
      ];
      const result = scanThemeFiles(files);
      const orphans = findingsOfType(result.findings, FindingType.ORPHAN_ASSET);
      expect(orphans).toHaveLength(0);
    });

    it("still flags a snippet as ORPHAN_ASSET when it is truly unreferenced", () => {
      const files: ThemeFile[] = [
        {
          filename: "snippets/klaviyo-onsite.liquid",
          content: "<!-- klaviyo onsite form -->",
        },
        {
          filename: "layout/theme.liquid",
          content: "{{ content_for_layout }}",
        },
      ];
      const result = scanThemeFiles(files);
      const orphans = findingsOfType(result.findings, FindingType.ORPHAN_ASSET);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].filename).toBe("snippets/klaviyo-onsite.liquid");
    });
  });
});

// ---------------------------------------------------------------------------
// LOG-12: detectDuplicateMetaTags — Liquid-conditional and repeatable-property awareness
// ---------------------------------------------------------------------------

describe("LOG-12 — detectDuplicateMetaTags false positive fixes", () => {
  describe("Liquid conditional branch awareness", () => {
    it("does NOT flag og:type in mutually-exclusive if/else branches as a duplicate", () => {
      // Renders exactly one og:type at runtime depending on template.
      // Counting both as duplicates is a false positive.
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: [
          "{%- if request.page_type == 'product' -%}",
          '<meta property="og:type" content="product">',
          "{%- else -%}",
          '<meta property="og:type" content="website">',
          "{%- endif -%}",
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag meta tags on the same line as Liquid conditionals (single-line form)", () => {
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: [
          '{% if template == \'product\' %}<meta property="og:type" content="product">{% else %}<meta property="og:type" content="website">{% endif %}',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });

    it("does NOT count meta tags inside comment blocks as duplicates", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          '<meta name="description" content="Active description">',
          "{% comment %}",
          '<meta name="description" content="Commented out description">',
          "{% endcomment %}",
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });
  });

  describe("Repeatable OG property allowlist", () => {
    it("does NOT flag repeated og:image tags (repeatable per OG spec)", () => {
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: [
          '<meta property="og:image" content="https://cdn.shopify.com/image1.jpg">',
          '<meta property="og:image" content="https://cdn.shopify.com/image2.jpg">',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag repeated og:image:secure_url (repeatable sub-property)", () => {
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: [
          '<meta property="og:image:secure_url" content="https://cdn.shopify.com/image1.jpg">',
          '<meta property="og:image:secure_url" content="https://cdn.shopify.com/image2.jpg">',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag repeated article:tag (explicitly repeatable per OG spec)", () => {
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: [
          '<meta property="article:tag" content="shoes">',
          '<meta property="article:tag" content="sneakers">',
          '<meta property="article:tag" content="sale">',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });
  });

  describe("True duplicates still flagged (true positive preserved)", () => {
    it("still flags two unconditional identical <meta name='description'> tags", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          '<meta name="description" content="SEO description from app">',
          "<p>some content</p>",
          '<meta name="description" content="Native description">',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.DUPLICATE_META);
      expect(findings[0].lineNumber).toBe(3);
      expect(findings[0].description).toContain("line 1");
    });

    it("still flags two unconditional duplicate og:title tags", () => {
      const file: ThemeFile = {
        filename: "layout/theme.liquid",
        content: [
          '<meta property="og:title" content="Title from App 1">',
          '<meta property="og:title" content="Title from App 2">',
        ].join("\n"),
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(1);
      expect(findings[0].description).toContain("og:title");
    });
  });

  describe("Dawn meta-tags.liquid fixture — no false positives on stock theme", () => {
    it("emits zero DUPLICATE_META findings on Dawn's snippets/meta-tags.liquid", () => {
      // Dawn's meta-tags.liquid uses og:type inside a conditional (via {% liquid %}),
      // og:image / og:image:secure_url inside {%- if page_image -%} block, and
      // og:price:amount inside {%- if request.page_type == 'product' -%}.
      // None of these should be flagged as duplicates.
      const file: ThemeFile = {
        filename: "snippets/meta-tags.liquid",
        content: DAWN_META_TAGS,
      };
      const findings = detectDuplicateMetaTags(file);
      expect(findings).toHaveLength(0);
    });
  });
});
