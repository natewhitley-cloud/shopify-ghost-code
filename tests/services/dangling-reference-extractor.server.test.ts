/**
 * Unit tests for the static DANGLING_REFERENCE extractor (gc-m4h.3).
 *
 * FP-critical: the whole point of this extractor is to flag ONLY fully-literal
 * references and never a Liquid-interpolated URL or a variable/filter bracket
 * key. Every dynamic form below is a hard negative.
 */

import { describe, it, expect } from "vitest";

import {
  extractDanglingReferences,
  type DanglingRefOccurrence,
} from "../../app/services/dangling-reference-extractor.server";
import type { ThemeFile } from "../../app/services/scan-engine.server";

function file(content: string, filename = "templates/index.liquid"): ThemeFile {
  return { filename, content };
}

/** Convenience: run the extractor over a single file's content. */
function scan(content: string, filename?: string): DanglingRefOccurrence[] {
  return extractDanglingReferences([file(content, filename)]).occurrences;
}

describe("extractDanglingReferences — positive patterns", () => {
  it("P1 flags a hardcoded product href", () => {
    const [occ, ...rest] = scan('<a href="/products/old-widget">Buy</a>');
    expect(rest).toHaveLength(0);
    expect(occ).toMatchObject({ entityType: "product", handle: "old-widget" });
  });

  it("P2 flags a hardcoded collection href", () => {
    const occ = scan('<a href="/collections/summer-sale">Shop</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "collection", handle: "summer-sale" });
  });

  it("P3 flags a hardcoded page href", () => {
    const occ = scan('<a href="/pages/about-us">About</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "page", handle: "about-us" });
  });

  it("P4 flags all_products['handle']", () => {
    const occ = scan("{{ all_products['old-widget'].title }}");
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "product", handle: "old-widget" });
  });

  it("P5 flags collections['handle']", () => {
    const occ = scan("{% assign c = collections['summer-sale'] %}");
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "collection", handle: "summer-sale" });
  });

  it("P6 flags pages['handle'] (double-quoted)", () => {
    const occ = scan('{{ pages["about-us"].content }}');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "page", handle: "about-us" });
  });

  it("captures filename, 1-based lineNumber, and a snippet", () => {
    const occ = scan('\n\n<a href="/products/widget">x</a>', "sections/header.liquid");
    expect(occ).toHaveLength(1);
    expect(occ[0].filename).toBe("sections/header.liquid");
    expect(occ[0].lineNumber).toBe(3);
    expect(occ[0].snippet).toContain("/products/widget");
  });

  it("lower-cases captured handles (normalized before validation)", () => {
    const occ = scan('<a href="/products/Old-Widget">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0].handle).toBe("old-widget");
  });

  it("strips a Shopify AJAX suffix (/products/x.js → x)", () => {
    const occ = scan('<a href="/products/blue-shirt.js">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0].handle).toBe("blue-shirt");
  });
});

describe("extractDanglingReferences — dynamic forms are NEVER flagged (FP-critical)", () => {
  it("rejects a Liquid-interpolated product URL", () => {
    expect(scan('<a href="/products/{{ product.handle }}">x</a>')).toEqual([]);
  });

  it("rejects a Liquid-interpolated collection URL", () => {
    expect(scan('<a href="/collections/{{ collection.handle }}">x</a>')).toEqual([]);
  });

  it("rejects a fully dynamic href ({{ product.url }})", () => {
    expect(scan('<a href="{{ product.url }}">x</a>')).toEqual([]);
  });

  it("rejects a routes-object href ({{ routes.* }})", () => {
    expect(scan('<a href="{{ routes.all_products_collection_url }}">x</a>')).toEqual([]);
  });

  it("rejects a filter-built href", () => {
    expect(scan("<a href=\"{{ '/products/x' | append: y }}\">x</a>")).toEqual([]);
  });

  it("rejects a variable bracket key (collections[section.settings.collection])", () => {
    expect(scan("{% assign c = collections[section.settings.collection] %}")).toEqual([]);
  });

  it("rejects all_products[product.handle]", () => {
    expect(scan("{{ all_products[product.handle].title }}")).toEqual([]);
  });

  it("rejects the Dawn-standard pages[template.suffix]", () => {
    expect(scan("{{ pages[template.suffix] }}")).toEqual([]);
  });

  it("rejects a bare variable bracket key (collections[some_var])", () => {
    expect(scan("{{ collections[some_var] }}")).toEqual([]);
  });

  it("rejects a handle with a leading hyphen in a bracket key", () => {
    expect(scan("{{ collections['-bad'] }}")).toEqual([]);
  });
});

describe("extractDanglingReferences — P2 URL edge cases", () => {
  it("ignores the reserved /collections/all", () => {
    expect(scan('<a href="/collections/all">All</a>')).toEqual([]);
  });

  it("still ignores /collections/all with a trailing slash", () => {
    expect(scan('<a href="/collections/all/">All</a>')).toEqual([]);
  });

  it("parses the collection segment only from /collections/{c}/products/{p}", () => {
    const occ = scan('<a href="/collections/summer/products/blue-shirt">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "collection", handle: "summer" });
  });

  it("drops query and anchor suffixes", () => {
    const occ = scan('<a href="/products/widget?variant=42#reviews">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0].handle).toBe("widget");
  });
});

describe("extractDanglingReferences — locale prefix handling", () => {
  it("strips a 2-letter locale prefix (/en/products/x)", () => {
    const occ = scan('<a href="/en/products/widget">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "product", handle: "widget" });
  });

  it("strips a lang-region locale prefix (/fr-ca/collections/y)", () => {
    const occ = scan('<a href="/fr-ca/collections/soldes">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "collection", handle: "soldes" });
  });

  it("does not treat a real handle as a locale (/products/en is a product)", () => {
    const occ = scan('<a href="/products/en">x</a>');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "product", handle: "en" });
  });
});

describe("extractDanglingReferences — comments, occurrences, file scope", () => {
  it("still extracts refs inside a Liquid comment (severity downgrade is elsewhere)", () => {
    const occ = scan('{% comment %}<a href="/products/old-widget">x</a>{% endcomment %}');
    // The line contains {% comment %} but the href value itself is a pure literal,
    // so it is extracted here. classifySeverity downgrades comment-line severity
    // downstream — not this extractor's job.
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ entityType: "product", handle: "old-widget" });
  });

  it("preserves multiple occurrences of the same handle across lines", () => {
    const content = [
      '<a href="/products/widget">one</a>',
      '<a href="/products/widget">two</a>',
    ].join("\n");
    const result = extractDanglingReferences([file(content)]);
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences[0].lineNumber).toBe(1);
    expect(result.occurrences[1].lineNumber).toBe(2);
    // ...but the distinct view collapses them to one.
    expect(result.distinctHandles).toEqual([{ entityType: "product", handle: "widget" }]);
  });

  it("captures multiple refs on a single line", () => {
    const occ = scan('<a href="/products/a">a</a> <a href="/pages/b">b</a>');
    expect(occ).toHaveLength(2);
    expect(occ.map((o) => o.handle).sort()).toEqual(["a", "b"]);
  });

  it("skips non-scannable files (assets/, config/, locales/, non-liquid)", () => {
    const link = '<a href="/products/widget">x</a>';
    expect(scan(link, "assets/theme.js")).toEqual([]);
    expect(scan(link, "config/settings_data.json")).toEqual([]);
    expect(scan(link, "locales/en.default.json")).toEqual([]);
    expect(scan(link, "templates/index.json")).toEqual([]);
  });
});

describe("extractDanglingReferences — mixed file + distinct view", () => {
  it("extracts all entity types and de-dupes distinct handles", () => {
    const content = [
      '<a href="/products/widget-a">p</a>',
      '<a href="/collections/summer">c</a>',
      '<a href="/pages/about">pg</a>',
      "{{ all_products['widget-a'].title }}", // dup of the product above
      "{{ pages['contact'] }}",
      '<a href="/collections/{{ c.handle }}">dynamic — skip</a>',
    ].join("\n");

    const result = extractDanglingReferences([file(content)]);

    // 5 literal occurrences (the dynamic collection href is dropped).
    expect(result.occurrences).toHaveLength(5);

    // widget-a appears twice (P1 + P4) → collapses to one distinct product.
    expect(result.distinctHandles).toEqual([
      { entityType: "product", handle: "widget-a" },
      { entityType: "collection", handle: "summer" },
      { entityType: "page", handle: "about" },
      { entityType: "page", handle: "contact" },
    ]);
  });

  it("aggregates occurrences across multiple files", () => {
    const result = extractDanglingReferences([
      file('<a href="/products/a">x</a>', "templates/index.liquid"),
      file('<a href="/products/a">x</a>', "sections/footer.liquid"),
    ]);
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.map((o) => o.filename)).toEqual([
      "templates/index.liquid",
      "sections/footer.liquid",
    ]);
    expect(result.distinctHandles).toEqual([{ entityType: "product", handle: "a" }]);
  });
});
