import { describe, it, expect } from "vitest";

import {
  collectUnknownScripts,
  collectUnknownStylesheets,
} from "../../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// collectUnknownScripts
// ---------------------------------------------------------------------------

describe("collectUnknownScripts", () => {
  it("collects external scripts from unknown CDN domains", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.unknownapp.com/widget.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("https://cdn.unknownapp.com/widget.js");
    expect(unknowns[0].resourceType).toBe("script");
    expect(unknowns[0].filename).toBe("layout/theme.liquid");
    expect(unknowns[0].lineNumber).toBe(1);
  });

  it("skips scripts from known apps", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("skips Shopify CDN URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.shopify.com/s/files/theme.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("skips shopifycdn.com URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.shopifycdn.com/assets/app.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("skips shopifycdn.net URLs (first-party, .net TLD)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.shopifycdn.net/assets/app.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("still flags lookalike non-Shopify domains", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://notshopifycdn.net/x.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(1);
  });

  it("skips myshopify.com URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://store.myshopify.com/script.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("collects multiple unknown scripts from the same file", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script src="https://cdn.unknownapp1.com/a.js"></script>
<script src="https://cdn.unknownapp2.com/b.js"></script>`,
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(2);
    expect(unknowns[0].url).toBe("https://cdn.unknownapp1.com/a.js");
    expect(unknowns[1].url).toBe("https://cdn.unknownapp2.com/b.js");
  });

  it("includes a code snippet for context", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.unknownapp.com/widget.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns[0].codeSnippet).toContain("cdn.unknownapp.com");
    expect(unknowns[0].codeSnippet.length).toBeLessThanOrEqual(300);
  });

  it("skips protocol-relative URLs from Shopify domains", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="//cdn.shopify.com/s/files/theme.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });

  it("collects protocol-relative URLs from unknown third-party domains", () => {
    // Regression: a protocol-relative src previously threw in new URL() and was
    // silently dropped instead of collected as an unknown script.
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="//cdn.unknown-orphan.com/w.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("//cdn.unknown-orphan.com/w.js");
    expect(unknowns[0].resourceType).toBe("script");
  });

  it("skips genuinely malformed script URLs without throwing", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="ht!tp:// bad url"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectUnknownStylesheets
// ---------------------------------------------------------------------------

describe("collectUnknownStylesheets", () => {
  it("collects external stylesheets from unknown domains", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://cdn.unknownapp.com/styles.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("https://cdn.unknownapp.com/styles.css");
    expect(unknowns[0].resourceType).toBe("stylesheet");
  });

  it("skips stylesheets from known apps", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(0);
  });

  it("skips Shopify CDN stylesheet URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://cdn.shopify.com/theme.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(0);
  });

  it("skips shopifycdn.net stylesheet URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://cdn.shopifycdn.net/theme.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(0);
  });

  it("handles href-before-rel attribute order", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link href="https://cdn.unknownapp.com/styles.css" rel="stylesheet">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("https://cdn.unknownapp.com/styles.css");
  });

  it("skips myshopify.com stylesheet URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://store.myshopify.com/styles.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(0);
  });

  it("collects protocol-relative stylesheets from unknown third-party domains", () => {
    // Regression: a protocol-relative href previously threw in new URL() and
    // was silently dropped instead of collected as an unknown stylesheet.
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="//cdn.unknown-orphan.com/w.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("//cdn.unknown-orphan.com/w.css");
    expect(unknowns[0].resourceType).toBe("stylesheet");
  });

  it("skips protocol-relative Shopify stylesheet URLs", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="//cdn.shopify.com/theme.css">',
    };
    const unknowns = collectUnknownStylesheets(file);
    expect(unknowns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Theme-setting gate (gc-vb7): a resource the theme loads behind a theme-editor
// setting is a theme feature, so it must not reach the "name this app" flywheel.
// ---------------------------------------------------------------------------

describe.each([
  {
    name: "collectUnknownScripts",
    collect: collectUnknownScripts,
    tag: '<script src="https://upload-widget.cloudinary.com/global/all.js" defer></script>',
  },
  {
    name: "collectUnknownStylesheets",
    collect: collectUnknownStylesheets,
    tag: '<link rel="stylesheet" href="https://cdn.unknownapp.com/styles.css">',
  },
])("$name — theme-setting-gated resources (gc-vb7)", ({ collect, tag }) => {
  const scan = (...contentLines: string[]) =>
    collect({
      filename: "blocks/contact-form-file-upload.liquid",
      content: contentLines.join("\n"),
    });

  it.each([
    ["block.settings", "{%- if block.settings.upload_provider == 'uploadcare' -%}"],
    ["section.settings", "{% if section.settings.enable_upload %}"],
    ["global settings", "{% unless settings.disable_upload %}"],
  ])("skips a resource gated by %s", (_label, opener) => {
    const closer = opener.includes("unless") ? "{% endunless %}" : "{%- endif -%}";
    expect(scan(opener, `  ${tag}`, closer)).toHaveLength(0);
  });

  it("skips a resource in the else branch of a settings conditional (bad-hats shape)", () => {
    // bad-hats' Sugar file has `{%- else -%} <tag> {%- endif -%}` on one line;
    // the opener sits on an earlier line. When that opener reads a setting
    // (e.g. a provider choice) the else branch is merchant-toggled too.
    const unknowns = scan(
      "{%- if block.settings.upload_provider == 'uploadcare' -%}",
      '  <script src="https://ucarecdn.com/libs/widget/3.x/uploadcare.full.min.js"></script>',
      `{%- else -%} ${tag} {%- endif -%}`,
    );
    expect(unknowns).toHaveLength(0);
  });

  it("still collects the same resource with no conditional", () => {
    const unknowns = scan("<div>", tag, "</div>");
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].lineNumber).toBe(2);
  });

  it.each([
    ["a non-settings if", "{% if form.posted_successfully? %}"],
    ["a design-mode check", "{% if request.design_mode %}"],
  ])("still collects a resource inside %s (incl. its else branch)", (_label, opener) => {
    const unknowns = scan(opener, "<p>editor</p>", `{%- else -%} ${tag} {%- endif -%}`);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].lineNumber).toBe(3);
  });

  it("still collects a resource AFTER the endif of a settings conditional", () => {
    const unknowns = scan("{% if block.settings.show %}", "<div></div>", "{% endif %}", tag);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].lineNumber).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Benign library / web-font recognition (drop-at-collection)
// ---------------------------------------------------------------------------

describe("benign library recognition", () => {
  it("drops a jsdelivr /npm/<pkg>@ library script (swiper)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
    };
    expect(collectUnknownScripts(file)).toHaveLength(0);
  });

  it("drops an unpkg package-path library script", () => {
    const file = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://unpkg.com/vanilla-lazyload@17.8.3/dist/lazyload.min.js"></script>',
    };
    expect(collectUnknownScripts(file)).toHaveLength(0);
  });

  it("drops a Google Fonts stylesheet by host", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    };
    expect(collectUnknownStylesheets(file)).toHaveLength(0);
  });

  it("still emits an arbitrary script served from a shared CDN root", () => {
    // Negative case: jsdelivr serves arbitrary code, so a non-allowlisted path
    // must NOT be suppressed (proves we didn't over-suppress by host).
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.jsdelivr.net/npm/evil-tracker@1/x.js"></script>',
    };
    const unknowns = collectUnknownScripts(file);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("https://cdn.jsdelivr.net/npm/evil-tracker@1/x.js");
  });

  it("still emits an unknown third-party script (unaffected by the matcher)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.unknownapp.com/widget.js"></script>',
    };
    expect(collectUnknownScripts(file)).toHaveLength(1);
  });

  it("is deterministic across repeated calls (no lastIndex/state hazard)", () => {
    const file = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
    };
    const first = collectUnknownScripts(file);
    const second = collectUnknownScripts(file);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// Benign-skip telemetry counter (gc-tus A2) — collectors tally suppressions
// ---------------------------------------------------------------------------

describe("benign-skip counter", () => {
  it("counts each benign script suppression into the passed accumulator", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: `<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>
<script src="https://unpkg.com/lodash@4/lodash.min.js"></script>
<script src="https://cdn.unknownapp.com/widget.js"></script>`,
    };
    const benignSkips = { count: 0 };
    const unknowns = collectUnknownScripts(file, benignSkips);

    // The two benign libraries are dropped and tallied; the unknown one is emitted.
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].url).toBe("https://cdn.unknownapp.com/widget.js");
    expect(benignSkips.count).toBe(2);
  });

  it("counts benign stylesheet suppressions and shares the accumulator across collectors", () => {
    const scriptFile = {
      filename: "layout/theme.liquid",
      content:
        '<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
    };
    const styleFile = {
      filename: "layout/theme.liquid",
      content: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    };
    const benignSkips = { count: 0 };
    collectUnknownScripts(scriptFile, benignSkips);
    collectUnknownStylesheets(styleFile, benignSkips);

    expect(benignSkips.count).toBe(2);
  });

  it("does not increment for genuinely-unknown resources", () => {
    const file = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.unknownapp.com/widget.js"></script>',
    };
    const benignSkips = { count: 0 };
    collectUnknownScripts(file, benignSkips);

    expect(benignSkips.count).toBe(0);
  });
});
