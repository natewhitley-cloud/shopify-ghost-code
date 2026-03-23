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
  scanThemeFiles,
} from "../../app/services/scan-engine.server";

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
