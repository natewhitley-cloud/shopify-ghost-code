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
