import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  isScannableFile,
  detectGhostScripts,
  detectGhostStyles,
  detectGhostSnippets,
  detectGhostSections,
  scanThemeFiles,
} from "../../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter findings by type for cleaner assertions. */
function findingsOfType(
  findings: ReturnType<typeof scanThemeFiles>,
  type: FindingType,
) {
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
      content: "{% comment %}\n<script src=\"https://static.klaviyo.com/onsite/js/klaviyo.js\"></script>\n{% endcomment %}",
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
      content: "<link rel=\"stylesheet\" href=\"{{ 'theme.css' | asset_url }}\">",
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
// scanThemeFiles (integration)
// ---------------------------------------------------------------------------

describe("scanThemeFiles", () => {
  it("processes only scannable liquid files", () => {
    const files = [
      { filename: "assets/theme.js", content: '<script src="https://static.klaviyo.com/j.js"></script>' },
      { filename: "config/settings.json", content: '{% render "klaviyo-onsite" %}' },
      { filename: "layout/theme.liquid", content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>' },
    ];
    const findings = scanThemeFiles(files);
    // Only layout/theme.liquid should be scanned
    expect(findings.every((f) => f.filename === "layout/theme.liquid")).toBe(true);
  });

  it("returns empty array for files with no ghost code", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
    ];
    expect(scanThemeFiles(files)).toHaveLength(0);
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
    const findings = scanThemeFiles(files);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const types = new Set(findings.map((f) => f.findingType));
    expect(types.has(FindingType.GHOST_SCRIPT)).toBe(true);
    expect(types.has(FindingType.GHOST_SNIPPET)).toBe(true);
    expect(types.has(FindingType.GHOST_STYLE)).toBe(true);
  });

  it("returns empty array for empty files array", () => {
    expect(scanThemeFiles([])).toHaveLength(0);
  });

  it("returns empty array for files with no content", () => {
    const files = [{ filename: "layout/theme.liquid", content: "" }];
    expect(scanThemeFiles(files)).toHaveLength(0);
  });

  it("produces finding inputs that satisfy the CreateFindingInput shape", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
    ];
    const findings = scanThemeFiles(files);
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
  it("flags a snippet file that is never referenced by any other file", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/abandoned-widget.liquid", content: "<div>old widget</div>" },
    ];
    const findings = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].filename).toBe("snippets/abandoned-widget.liquid");
    expect(orphans[0].findingType).toBe(FindingType.ORPHAN_ASSET);
    expect(orphans[0].severity).toBe(Severity.LOW);
    expect(orphans[0].description).toContain("abandoned-widget");
  });

  it("does not flag a snippet that is rendered by another file", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: "{% render 'my-widget' %}",
      },
      { filename: "snippets/my-widget.liquid", content: "<div>widget</div>" },
    ];
    const findings = scanThemeFiles(files);
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
    const findings = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("flags multiple orphan snippets in one scan", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/orphan-a.liquid", content: "<div>a</div>" },
      { filename: "snippets/orphan-b.liquid", content: "<div>b</div>" },
    ];
    const findings = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(2);
    const filenames = orphans.map((f) => f.filename).sort();
    expect(filenames).toEqual([
      "snippets/orphan-a.liquid",
      "snippets/orphan-b.liquid",
    ]);
  });

  it("does not produce any ORPHAN_ASSET findings when there are no snippet files", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "sections/header.liquid", content: "<header></header>" },
    ];
    const findings = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });

  it("produces ORPHAN_ASSET findings concurrently with ghost code findings", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
      },
      { filename: "snippets/leftover-app.liquid", content: "<div>unused</div>" },
    ];
    const findings = scanThemeFiles(files);
    const ghostScripts = findingsOfType(findings, FindingType.GHOST_SCRIPT);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(ghostScripts).toHaveLength(1);
    expect(orphans).toHaveLength(1);
  });

  it("produces ORPHAN_ASSET findings with valid CreateFindingInput shape", () => {
    const files = [
      { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
      { filename: "snippets/orphan-snippet.liquid", content: "<div>orphan</div>" },
    ];
    const findings = scanThemeFiles(files);
    const orphan = findingsOfType(findings, FindingType.ORPHAN_ASSET)[0];
    expect(orphan).toBeDefined();
    expect(typeof orphan.filename).toBe("string");
    expect(typeof orphan.lineNumber).toBe("number");
    expect(typeof orphan.codeSnippet).toBe("string");
    expect(typeof orphan.description).toBe("string");
    expect(orphan.appName).toBeUndefined();
  });

  it("handles a snippet file referenced via include tag (not just render)", () => {
    const files = [
      {
        filename: "layout/theme.liquid",
        content: "{% include 'legacy-widget' %}",
      },
      { filename: "snippets/legacy-widget.liquid", content: "<div>legacy</div>" },
    ];
    const findings = scanThemeFiles(files);
    const orphans = findingsOfType(findings, FindingType.ORPHAN_ASSET);
    expect(orphans).toHaveLength(0);
  });
});
