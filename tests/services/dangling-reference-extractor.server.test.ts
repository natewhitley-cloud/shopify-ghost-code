/**
 * Unit tests for the static DANGLING_REFERENCE extractor (gc-m4h.3).
 *
 * FP-critical: the whole point of this extractor is to flag ONLY fully-literal
 * references and never a Liquid-interpolated URL or a variable/filter bracket
 * key. Every dynamic form below is a hard negative.
 */

import { describe, it, expect } from "vitest";

import {
  CORE_STEP_OUTPUT_BUDGET_BYTES,
  DANGLING_LOOKUP_CAP,
  DANGLING_MAX_OCCURRENCES_PER_HANDLE,
} from "../../app/lib/scan-limits";
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
    expect(result.distinctHandles).toEqual([
      { entityType: "product", handle: "widget", occurrenceCount: 2 },
    ]);
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

  it("extracts refs from OS 2.0 theme blocks (blocks/*.liquid, gc-zfl)", () => {
    const refs = scan('<a href="/products/widget">x</a>', "blocks/promo.liquid");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      entityType: "product",
      handle: "widget",
      filename: "blocks/promo.liquid",
    });
    expect(scan('<a href="/products/widget">x</a>', "blocks/readme.md")).toEqual([]);
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
      { entityType: "product", handle: "widget-a", occurrenceCount: 2 },
      { entityType: "collection", handle: "summer", occurrenceCount: 1 },
      { entityType: "page", handle: "about", occurrenceCount: 1 },
      { entityType: "page", handle: "contact", occurrenceCount: 1 },
    ]);
    expect(result.capped).toBe(false);
  });

  it("aggregates occurrences across multiple files, ordered by filename then line", () => {
    const result = extractDanglingReferences([
      file('<a href="/products/a">x</a>', "templates/index.liquid"),
      file('<a href="/products/a">x</a>', "sections/footer.liquid"),
    ]);
    expect(result.occurrences).toHaveLength(2);
    // Deterministic (gc-4ce): sorted by filename, independent of fetch order.
    expect(result.occurrences.map((o) => o.filename)).toEqual([
      "sections/footer.liquid",
      "templates/index.liquid",
    ]);
    expect(result.distinctHandles).toEqual([
      { entityType: "product", handle: "a", occurrenceCount: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Payload bounds (gc-4ce): the result crosses the Inngest step boundary, whose
// output limit is 4 MB. Uncapped, 1 MB of `pages['a']` produced ~39 MB.
// ---------------------------------------------------------------------------

const ONE_MB = 1_000_000;

/** Byte size of a value as Inngest would serialize it. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A ~1 MB file where every line is packed with the same `pages['a']` lookup. */
function denseSameHandleFile(filename = "sections/dense.liquid"): ThemeFile {
  const line = "{{ pages['a'] }}".repeat(40); // 640 chars, 40 refs per line
  return file(
    Array.from({ length: Math.ceil(ONE_MB / line.length) }, () => line).join("\n"),
    filename,
  );
}

/** A ~1 MB file where every line references many DISTINCT handles, lines > 300 chars. */
function denseDistinctHandlesFile(filename = "sections/distinct.liquid"): ThemeFile {
  const lines: string[] = [];
  let n = 0;
  let size = 0;
  while (size < ONE_MB) {
    const refs = Array.from({ length: 20 }, () => `<a href="/products/h${n++}">x</a>`).join(" ");
    lines.push(refs);
    size += refs.length + 1;
  }
  return file(lines.join("\n"), filename);
}

describe("extractDanglingReferences — payload caps (gc-4ce)", () => {
  it("keeps at most DANGLING_MAX_OCCURRENCES_PER_HANDLE per handle but reports the true count", () => {
    const content = Array.from({ length: 30 }, (_, i) => `{{ pages['about'] }} line ${i}`).join(
      "\n",
    );
    const result = extractDanglingReferences([file(content)]);

    expect(result.occurrences).toHaveLength(DANGLING_MAX_OCCURRENCES_PER_HANDLE);
    expect(result.distinctHandles).toEqual([
      { entityType: "page", handle: "about", occurrenceCount: 30 },
    ]);
    // The per-handle occurrence cap alone does NOT set `capped`: extra
    // occurrences never change WHICH handles are missing, and the worker decides
    // the skip after resolution from `occurrenceCount` (only a MISSING handle
    // over the cap loses findings).
    expect(result.capped).toBe(false);
    // The FIRST N by line are kept, in order.
    expect(result.occurrences.map((o) => o.lineNumber)).toEqual(
      Array.from({ length: DANGLING_MAX_OCCURRENCES_PER_HANDLE }, (_, i) => i + 1),
    );
  });

  it("keeps the same occurrences regardless of the order files are supplied in", () => {
    const files = [
      file(Array.from({ length: 15 }, () => "{{ pages['x'] }}").join("\n"), "templates/b.liquid"),
      file(Array.from({ length: 15 }, () => "{{ pages['x'] }}").join("\n"), "sections/a.liquid"),
      file(Array.from({ length: 15 }, () => "{{ pages['x'] }}").join("\n"), "snippets/c.liquid"),
    ];
    const forward = extractDanglingReferences(files);
    const reversed = extractDanglingReferences([...files].reverse());

    expect(reversed).toEqual(forward);
    // Sorted by filename then line before truncation: all 15 of sections/a,
    // then the first 5 of snippets/c; templates/b is beyond the cap.
    expect(forward.occurrences.map((o) => `${o.filename}:${o.lineNumber}`)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `sections/a.liquid:${i + 1}`),
      ...Array.from({ length: 5 }, (_, i) => `snippets/c.liquid:${i + 1}`),
    ]);
    expect(forward.distinctHandles[0].occurrenceCount).toBe(45);
  });

  it("keeps at most DANGLING_LOOKUP_CAP distinct handles and drops the rest's occurrences", () => {
    const content = Array.from({ length: 60 }, (_, i) => `<a href="/pages/p${i}">x</a>`).join("\n");
    const result = extractDanglingReferences([file(content)]);

    expect(result.distinctHandles).toHaveLength(DANGLING_LOOKUP_CAP);
    // First-seen (filename, line) order: p0..p49 kept, p50..p59 dropped.
    expect(result.distinctHandles.map((h) => h.handle)).toEqual(
      Array.from({ length: DANGLING_LOOKUP_CAP }, (_, i) => `p${i}`),
    );
    const kept = new Set(result.distinctHandles.map((h) => h.handle));
    expect(result.occurrences.every((o) => kept.has(o.handle))).toBe(true);
    expect(result.occurrences).toHaveLength(DANGLING_LOOKUP_CAP);
    expect(result.capped).toBe(true);
  });

  it("caps distinct handles per scope group so absent-scope types cannot starve the other", () => {
    // 60 product handles sort first (sections/ < templates/), then 1 page. The
    // resolver skips product/collection handles when read_products is absent,
    // so a single shared cap would have dropped the page before it was checked.
    const products = Array.from({ length: 60 }, (_, i) => `<a href="/products/p${i}">x</a>`);
    const result = extractDanglingReferences([
      file(products.join("\n"), "sections/a.liquid"),
      file('<a href="/pages/gone">x</a>', "templates/z.liquid"),
    ]);

    const productHandles = result.distinctHandles.filter((h) => h.entityType === "product");
    expect(productHandles).toHaveLength(DANGLING_LOOKUP_CAP);
    expect(result.distinctHandles.at(-1)).toEqual({
      entityType: "page",
      handle: "gone",
      occurrenceCount: 1,
    });
    expect(result.occurrences.some((o) => o.handle === "gone")).toBe(true);
    // Product handles were dropped, so the category is not fully audited.
    expect(result.capped).toBe(true);
  });

  it("counts products and collections against one scope-group cap (read_products)", () => {
    const refs = [
      ...Array.from({ length: 30 }, (_, i) => `<a href="/products/p${i}">x</a>`),
      ...Array.from({ length: 30 }, (_, i) => `<a href="/collections/c${i}">x</a>`),
    ];
    const result = extractDanglingReferences([file(refs.join("\n"))]);
    expect(result.distinctHandles).toHaveLength(DANGLING_LOOKUP_CAP);
    expect(result.capped).toBe(true);
  });

  it("truncates an over-long handle to Shopify's 255-char maximum", () => {
    const long = "a".repeat(1000);
    const result = extractDanglingReferences([
      file(`<a href="/products/${long}">x</a>\n{{ pages['${long}'] }}`),
    ]);
    expect(result.distinctHandles.map((h) => h.handle.length)).toEqual([255, 255]);
    expect(result.occurrences.every((o) => o.handle.length === 255)).toBe(true);
  });

  it("is not capped for an ordinary theme", () => {
    const result = extractDanglingReferences([
      file('<a href="/products/a">x</a>\n<a href="/pages/b">y</a>'),
    ]);
    expect(result.capped).toBe(false);
    expect(result.occurrences).toHaveLength(2);
  });

  it("returns an empty, uncapped result for no files", () => {
    expect(extractDanglingReferences([])).toEqual({
      occurrences: [],
      distinctHandles: [],
      capped: false,
    });
  });

  it("keeps a 1 MB file dense with one handle far under the step-output budget", () => {
    const result = extractDanglingReferences([denseSameHandleFile()]);

    expect(result.occurrences).toHaveLength(DANGLING_MAX_OCCURRENCES_PER_HANDLE);
    // ~62.5k refs on the page, all counted.
    expect(result.distinctHandles[0].occurrenceCount).toBeGreaterThan(60_000);
    expect(jsonBytes(result)).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
  });

  it("keeps the worst case (dense distinct handles + dense repeats, long lines) under budget", () => {
    const result = extractDanglingReferences([
      denseDistinctHandlesFile(),
      denseSameHandleFile(),
      denseSameHandleFile("snippets/dense-2.liquid"),
    ]);

    // Max carried = 2 scope groups * DANGLING_LOOKUP_CAP * DANGLING_MAX_OCCURRENCES_PER_HANDLE.
    expect(result.occurrences.length).toBeLessThanOrEqual(
      2 * DANGLING_LOOKUP_CAP * DANGLING_MAX_OCCURRENCES_PER_HANDLE,
    );
    // 50 product handles (capped) + the one dense page handle.
    expect(result.distinctHandles).toHaveLength(DANGLING_LOOKUP_CAP + 1);
    const bytes = jsonBytes(result);
    expect(JSON.stringify(result).length).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES);
    // Headroom: well under a third of the budget.
    expect(bytes).toBeLessThan(CORE_STEP_OUTPUT_BUDGET_BYTES / 3);
  });
});
