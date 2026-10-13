/**
 * Tests for app/services/liquid-error-detector.server.ts (gc-i6du): a
 * missing-snippet Liquid error printed on the homepage is a finding ONLY when
 * the theme's own files confirm it (the snippet is absent and a file renders
 * it). Pure: no network, no DB.
 *
 * The audit sets under tests/fixtures/liquid-error-audit were written by a
 * tester who never saw the detector (blind.json) and then against it
 * (adversarial.json). Every FALSE case there must yield nothing; see the
 * "audit sets" block at the end for the measured precision and recall.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect, vi } from "vitest";

import { CORE_STEP_OUTPUT_BUDGET_BYTES } from "../../app/lib/scan-limits";
import {
  BLANKED_LIQUID,
  blankNonExecutingLiquid,
  buildMissingSnippetIndex,
  detectLiquidErrors,
  extractRenderedLiquidErrors,
  LIQUID_ERROR_FINDING_FILENAME,
  liquidErrorText,
  MAX_LIQUID_ERROR_CANDIDATES,
  MAX_LIQUID_ERROR_MATCHES,
  MAX_LIQUID_ERROR_SNIPPET_CHARS,
  MAX_LIQUID_ERRORS,
  MAX_MISSING_SNIPPETS,
  MAX_RENDER_SCAN_FILE_CHARS,
  MAX_RENDERING_FILES,
  type MissingSnippetRender,
  type RenderedLiquidError,
  stripUnsafeChars,
} from "../../app/services/liquid-error-detector.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";

/** A Dawn-like homepage with `body` dropped into the main content area. */
function page(body: string, head = ""): string {
  return `<!doctype html>
<html class="no-js" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Paw Naturals</title>
    <script>var Shopify = Shopify || {};
Shopify.shop = "paw-naturals-llc.myshopify.com";</script>
    ${head}
  </head>
  <body class="gradient template-index">
    <a class="skip-to-content-link" href="#MainContent">Skip to content</a>
    <div id="shopify-section-header" class="shopify-section section-header">
      <header class="header"><h1 class="header__heading">Paw Naturals</h1></header>
    </div>
    <main id="MainContent" class="content-for-layout" role="main" tabindex="-1">
      ${body}
    </main>
    <div id="shopify-section-footer" class="shopify-section"><footer>© 2026</footer></div>
  </body>
</html>`;
}

const MISSING =
  "Liquid error (layout/theme line 309): Could not find asset snippets/preloaderapp.liquid";

const file = (filename: string, content = "") => ({ filename, content });

/** A theme where `renderer` renders `snippet` and the snippet file is absent. */
function themeRendering(snippet: string, renderer = "layout/theme.liquid") {
  return [
    file(renderer, `<div>{% render '${snippet}' %}</div>`),
    file("sections/header.liquid", "<header>{{ shop.name }}</header>"),
    file("snippets/icon-cart.liquid", "<svg></svg>"),
  ];
}

/** Run the whole detector: page + theme files -> findings. */
function findingsFor(html: string, files: ReturnType<typeof themeRendering>) {
  return detectLiquidErrors(
    extractRenderedLiquidErrors(html),
    buildMissingSnippetIndex(files).renders,
  );
}

// ---------------------------------------------------------------------------
// Theme side
// ---------------------------------------------------------------------------

describe("buildMissingSnippetIndex: snippets the theme renders but does not contain", () => {
  it.each([
    ["{% render 'foo' %}"],
    ['{% render "foo" %}'],
    ["{%- render 'foo' -%}"],
    ["{%-render 'foo'-%}"],
    ["{% include 'foo' %}"],
    ['{%- include "foo" -%}'],
    ["{% render 'foo', product: product, show: true %}"],
    ["{% include 'foo' with product %}"],
    ["{% render\n  'foo',\n  a: 1\n%}"],
    ["{% liquid\n  assign x = 1\n  render 'foo'\n%}"],
    ["{% RENDER 'foo' %}"],
    ["{% render 'foo.liquid' %}"],
  ])("%s", (tag) => {
    expect(
      buildMissingSnippetIndex([file("sections/header.liquid", `<div>${tag}</div>`)]).renders,
    ).toEqual([{ snippet: "foo", renderedIn: ["sections/header"] }]);
  });

  it("a snippet that exists is not listed", () => {
    expect(
      buildMissingSnippetIndex([
        file("layout/theme.liquid", "{% render 'foo' %}{% render 'bar' %}"),
        file("snippets/foo.liquid", "hi"),
      ]).renders,
    ).toEqual([{ snippet: "bar", renderedIn: ["layout/theme"] }]);
  });

  it("lists every file that renders it, sorted, across the Liquid folders", () => {
    const index = buildMissingSnippetIndex([
      file("templates/customers/login.liquid", "{% render 'foo' %}"),
      file("snippets/menu.liquid", "{% render 'foo' %}"),
      file("layout/theme.liquid", "{% render 'foo' %}{% render 'foo' %}"),
      file("blocks/group.liquid", "{% render 'foo' %}"),
    ]).renders;
    expect(index).toEqual([
      {
        snippet: "foo",
        renderedIn: ["blocks/group", "layout/theme", "snippets/menu", "templates/customers/login"],
      },
    ]);
  });

  it.each([
    ["no files", []],
    ["no render tags", [file("layout/theme.liquid", "<html>{{ content_for_layout }}</html>")]],
    ["a variable, not a literal name", [file("layout/theme.liquid", "{% render snippet_name %}")]],
    ["the word in prose", [file("layout/theme.liquid", "<p>We render 'foo' beautifully</p>")]],
    ["a name outside the allowed characters", [file("layout/theme.liquid", "{% render 'fo o' %}")]],
    ["a JSON template", [file("templates/index.json", `{"x":"{% render 'foo' %}"}`)]],
    ["an asset", [file("assets/app.js", "var t = \"{% render 'foo' %}\";")]],
    ["a config file", [file("config/settings_data.json", "{% render 'foo' %}")]],
  ])("%s: nothing", (_name, files) => {
    expect(buildMissingSnippetIndex(files).renders).toEqual([]);
  });

  it("a file over the size cap is not searched (bounded work)", () => {
    const big = `${" ".repeat(MAX_RENDER_SCAN_FILE_CHARS)}{% render 'foo' %}`;
    expect(buildMissingSnippetIndex([file("layout/theme.liquid", big)]).renders).toEqual([]);
  });

  it(`keeps at most ${MAX_MISSING_SNIPPETS} snippets (sorted) and ${MAX_RENDERING_FILES} files each`, () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `{% render 's${String(i).padStart(2, "0")}' %}`,
    );
    const index = buildMissingSnippetIndex([file("layout/theme.liquid", many.join("\n"))]).renders;
    expect(index).toHaveLength(MAX_MISSING_SNIPPETS);
    expect(index[0].snippet).toBe("s00");
    expect(index.at(-1)!.snippet).toBe("s49");

    const renderers = Array.from({ length: 60 }, (_, i) =>
      file(`sections/s${String(i).padStart(2, "0")}.liquid`, "{% render 'foo' %}"),
    );
    const [entry] = buildMissingSnippetIndex(renderers).renders;
    expect(entry.renderedIn).toHaveLength(MAX_RENDERING_FILES);
    // Small enough to cross an Inngest step boundary many times over.
    expect(
      JSON.stringify(
        buildMissingSnippetIndex([...renderers, file("layout/theme.liquid", many.join("\n"))])
          .renders,
      ).length,
    ).toBeLessThan(20_000);
  });

  it("a flood of whitespace after {% cannot make the search slow (bounded runs)", () => {
    const content = `{%${" ".repeat(5000)}`.repeat(150);
    const calls = vi.fn();
    const started = Date.now();
    expect(buildMissingSnippetIndex([file("layout/theme.liquid", content)]).renders).toEqual([]);
    calls(Date.now() - started);
    // A wide budget on purpose (about 10 ms; unbounded backtracking takes minutes).
    expect(calls.mock.calls[0][0]).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

describe("extractRenderedLiquidErrors: missing-snippet errors only, as parsed parts", () => {
  it("the located form", () => {
    expect(extractRenderedLiquidErrors(page(`<div class="banner">\n  ${MISSING}\n</div>`))).toEqual(
      [{ template: "layout/theme", line: 309, snippet: "preloaderapp" }],
    );
  });

  it("the bare form (no location)", () => {
    expect(
      extractRenderedLiquidErrors(
        page("Liquid error: Could not find asset snippets/wlm-head.liquid"),
      ),
    ).toEqual([{ template: null, line: null, snippet: "wlm-head" }]);
  });

  it("a line number with no template", () => {
    expect(
      extractRenderedLiquidErrors(
        page("Liquid error (line 7): Could not find asset snippets/foo.liquid"),
      ),
    ).toEqual([{ template: null, line: 7, snippet: "foo" }]);
  });

  it("a snippet named without .liquid, and a template named with it", () => {
    expect(
      extractRenderedLiquidErrors(
        page(
          `<p>Liquid error (sections/header line 16): Could not find asset snippets/opinew_review_stars</p>
           <p>Liquid error (sections/announcement-bar.liquid line 7): Could not find asset snippets/icon-arrow.liquid</p>
           <p>Liquid error (templates/customers/login line 3): Could not find asset snippets/x.liquid</p>`,
        ),
      ),
    ).toEqual([
      { template: "sections/header", line: 16, snippet: "opinew_review_stars" },
      { template: "sections/announcement-bar", line: 7, snippet: "icon-arrow" },
      { template: "templates/customers/login", line: 3, snippet: "x" },
    ]);
  });

  it("text after the error on the same line is never part of what is read", () => {
    const [e] = extractRenderedLiquidErrors(
      page(`<p>${MISSING} Welcome back, Jane Doe (jane@example.com)</p>`),
    );
    expect(e).toEqual({ template: "layout/theme", line: 309, snippet: "preloaderapp" });
    expect(JSON.stringify(e)).not.toMatch(/Jane|example\.com|Welcome/);
  });

  it.each([
    ["a syntax error", "Liquid syntax error (snippets/x line 3): Unknown tag 'foo'"],
    ["an arithmetic error", "Liquid error (snippets/price line 8): divided by 0"],
    ["memory limits", "Liquid error (sections/main-product line 45): Memory limits exceeded"],
    ["nesting too deep", "Liquid error (line 12): Nesting too deep"],
    ["an internal error", "Liquid error (sections/announcement-bar line 2): internal"],
    [
      "an app-block path",
      "Liquid error (shopify://apps/judge-me/blocks/preview_badge/61ccd3b1 line 12): Could not find asset snippets/x.liquid",
    ],
    ["a missing asset that is not a snippet", "Liquid error: Could not find asset assets/app.js"],
    ["a bare error with another message", "Liquid error: Memory limits exceeded"],
    [
      "a malformed location",
      "Liquid error (see line twelve): Could not find asset snippets/a.liquid",
    ],
    ["lower case", "liquid error (layout/theme line 2): could not find asset snippets/a.liquid"],
    ["upper case", "LIQUID ERROR (LAYOUT/THEME LINE 2): COULD NOT FIND ASSET SNIPPETS/A.LIQUID"],
    [
      "a template with odd characters",
      "Liquid error (sections/he ader line 2): Could not find asset snippets/a.liquid",
    ],
    [
      "a name with odd characters",
      "Liquid error (layout/theme line 2): Could not find asset snippets/<b>.liquid",
    ],
  ])("%s: not read", (_name, text) => {
    expect(extractRenderedLiquidErrors(page(`<div>${text}</div>`))).toEqual([]);
  });

  it.each([
    ["an empty string", ""],
    ["a clean homepage", page(`<h2>New arrivals</h2><p>Grain-free treats, made in Colorado.</p>`)],
    ["text with no markup", "just some words"],
    ["an unclosed tag", "<div class='a"],
    ["an unclosed comment", `<!-- ${MISSING}`],
    ["an unclosed script", `<script>var e = '${MISSING}'`],
  ])("%s: nothing", (_name, html) => {
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });
});

describe("extractRenderedLiquidErrors: where a match is read", () => {
  it.each([
    ["script", `<script>window.s = "${MISSING}";</script>`],
    ["a JSON island", `<script type="application/json">{"d":"<p>${MISSING}<\\/p>"}</script>`],
    [
      "a text/template script closed by </script >",
      `<script type=text/template><div>${MISSING}</div></script ><p>ok</p>`,
    ],
    ["style", `<style>.x::after{content:"${MISSING}"}</style>`],
    ["an HTML comment", `<!--\n${MISSING}\n-->`],
    ["textarea", `<textarea name="body">${MISSING}</textarea>`],
    ["title", `<title>${MISSING} | Dev Blog</title>`],
    ["iframe fallback content", `<iframe src="/x">${MISSING}</iframe>`],
    ["noscript", `<noscript><div>${MISSING}</div></noscript>`],
    ["template", `<template id="t"><div>${MISSING}</div></template>`],
    ["code", `<p>You will see <code>${MISSING}</code></p>`],
    ["pre + code", `<pre class="l"><code class="l">${MISSING}\n</code></pre>`],
    ["samp", `<p>Shopify prints <samp>${MISSING}</samp></p>`],
    ["kbd", `<kbd>${MISSING}</kbd>`],
    ["blockquote", `<blockquote>\n<p>${MISSING}</p>\n</blockquote>`],
    ["q", `<p>The message <q>${MISSING}</q></p>`],
    ["del", `<li><del>${MISSING}</del> fixed in v2</li>`],
    ["svg text", `<svg viewBox="0 0 1 1"><text>${MISSING}</text></svg>`],
    ["CDATA inside svg", `<svg><desc><![CDATA[${MISSING}]]></desc></svg>`],
    ["select / option", `<select><option>${MISSING}</option></select>`],
    ["an attribute", `<img alt="${MISSING}" src="/a.png">`],
    ["a single-quoted attribute containing >", `<div data-m='a > b ${MISSING}' class="x">ok</div>`],
    ["an input value", `<input value="${MISSING}">`],
    ["an iframe srcdoc", `<iframe srcdoc="&lt;p&gt;${MISSING}&lt;/p&gt;"></iframe>`],
    ["upper-case tags", `<CODE CLASS=x>${MISSING}</CODE >`],
  ])("inside %s: not read", (_name, html) => {
    expect(extractRenderedLiquidErrors(page(html))).toEqual([]);
  });

  it("nested <code>: the inner closing tag does not end the outer one", () => {
    expect(
      extractRenderedLiquidErrors(page(`<code><code>a</code>\n${MISSING}</code><p>after</p>`)),
    ).toEqual([]);
  });

  it("</code-block> does not close <code> (a tag-name boundary is required)", () => {
    expect(
      extractRenderedLiquidErrors(page(`<code>x</code-block> ${MISSING}</code><p>after</p>`)),
    ).toEqual([]);
  });

  it("a custom element named like a skipped one IS read (code-block is not code)", () => {
    expect(
      extractRenderedLiquidErrors(
        page(`<code-block><div>${MISSING}</div></code-block><template-list>x</template-list>`),
      ),
    ).toEqual([{ template: "layout/theme", line: 309, snippet: "preloaderapp" }]);
  });

  it("a stray extra quote in a tag does not swallow the tags after it", () => {
    // class="hero"" : the second quote does not follow an "=", so it opens nothing.
    const html = `<div class="hero""></div><script type="application/json">{"body":"<p>${MISSING}<\\/p>"}</script>`;
    expect(extractRenderedLiquidErrors(page(html))).toEqual([]);
    // And a real error after such a tag is still read.
    expect(extractRenderedLiquidErrors(page(`<div class="hero""></div><p>${MISSING}</p>`))).toEqual(
      [{ template: "layout/theme", line: 309, snippet: "preloaderapp" }],
    );
  });

  it("offsets never drift on characters that change length when lower-cased ('İ')", () => {
    // 'İ' lower-cases to TWO code units. Finding closing tags on a lower-cased
    // copy and using those offsets on the original string lands 30 characters
    // late here: inside the second script, whose string then reads as page text.
    expect("İ".toLowerCase()).toHaveLength(2);
    // Verified against the previous extractor: it landed inside the second
    // script, took the ">" of "1 > 0" as the end of a tag and read this error.
    const html = `<p>${"İ".repeat(30)}</p><script>var a = 1;</script><script>var pad = 1234567890123456; if (1 > 0) { go(); }\n${MISSING}\n</script><p>ok</p>`;
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
    // The same page with the error as real text after the scripts is read.
    expect(
      extractRenderedLiquidErrors(
        `<p>${"İ".repeat(30)}</p><script>var a = 1;</script><script>var b = 2;</script><div>${MISSING}</div>`,
      ),
    ).toEqual([{ template: "layout/theme", line: 309, snippet: "preloaderapp" }]);
  });

  it("an element that is never closed hides everything after it (a missed error, never a false one)", () => {
    expect(
      extractRenderedLiquidErrors(`<p>Use <code>SAVE10 at checkout</p><footer>${MISSING}</footer>`),
    ).toEqual([]);
  });

  it("'a < b' in text does not swallow what follows", () => {
    expect(extractRenderedLiquidErrors(page(`<p>1 < 2 then ${MISSING}</p>`))).toHaveLength(1);
  });

  it("a real error is still read right next to skipped content", () => {
    const html = page(
      `<script>var s = "Liquid error (layout/theme line 1): Could not find asset snippets/in-js.liquid";</script>
       ${MISSING}
       <code>Liquid error (layout/theme line 2): Could not find asset snippets/in-code.liquid</code>`,
    );
    expect(extractRenderedLiquidErrors(html).map((e) => e.snippet)).toEqual(["preloaderapp"]);
  });
});

describe("extractRenderedLiquidErrors: dedupe, caps and bounds", () => {
  it("the same error printed many times, or at another line number, is one candidate", () => {
    const html = page(
      `${`<div>${MISSING}</div>`.repeat(30)}<div>${MISSING.replace("line 309", "line 314")}</div>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([
      { template: "layout/theme", line: 309, snippet: "preloaderapp" },
    ]);
  });

  it("the same snippet missing from two files is two candidates", () => {
    const html = page(
      `<div>${MISSING}</div><div>${MISSING.replace("layout/theme", "sections/footer")}</div>`,
    );
    expect(extractRenderedLiquidErrors(html)).toHaveLength(2);
  });

  it(`keeps at most ${MAX_LIQUID_ERROR_CANDIDATES} candidates, the first in page order`, () => {
    const html = page(
      Array.from(
        { length: 80 },
        (_, i) =>
          `<div>Liquid error (sections/s${i} line 1): Could not find asset snippets/app-${i}.liquid</div>`,
      ).join("\n"),
    );
    const errors = extractRenderedLiquidErrors(html);
    expect(errors).toHaveLength(MAX_LIQUID_ERROR_CANDIDATES);
    expect(errors[0].snippet).toBe("app-0");
  });

  it(`stops examining after ${MAX_LIQUID_ERROR_MATCHES} occurrences`, () => {
    const noise = "Liquid error free. ".repeat(MAX_LIQUID_ERROR_MATCHES + 5);
    expect(extractRenderedLiquidErrors(page(`<p>${noise}</p><p>${MISSING}</p>`))).toEqual([]);
    expect(
      extractRenderedLiquidErrors(page(`<p>Liquid error free.</p><p>${MISSING}</p>`)),
    ).toHaveLength(1);
  });

  it("a name or path longer than its bound is not read", () => {
    const longName = `Liquid error: Could not find asset snippets/${"a".repeat(101)}.liquid`;
    const longPath = `Liquid error (sections/${"a".repeat(130)} line 1): Could not find asset snippets/a.liquid`;
    expect(extractRenderedLiquidErrors(page(`<p>${longName}</p><p>${longPath}</p>`))).toEqual([]);
  });

  // Linearity is asserted on WORK DONE (how often the page is searched), not on
  // wall-clock time, so these cannot flake on a loaded machine.
  describe("one forward pass over the page", () => {
    function countSearches<T>(fn: () => T): { result: T; calls: Array<[string, number]> } {
      const calls: Array<[string, number]> = [];
      const original = String.prototype.indexOf;
      const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
        this: string,
        ...args: [string, number?]
      ) {
        calls.push([args[0], this.length]);
        return original.apply(this, args);
      });
      try {
        return { result: fn(), calls };
      } finally {
        spy.mockRestore();
      }
    }
    const needleSearches = (calls: Array<[string, number]>) =>
      calls.filter(([needle]) => needle === "Liquid error").length;

    it("many text runs before a single late match: the page is not searched once per run", () => {
      const html = page(`${"<i>a</i>".repeat(5000)}<div>${MISSING}</div>`);
      const { result, calls } = countSearches(() => extractRenderedLiquidErrors(html));
      expect(result).toHaveLength(1);
      expect(needleSearches(calls)).toBeLessThanOrEqual(3);
    });

    it("many text runs and no match at all: one search, and the page is not walked", () => {
      const html = page("<i>a</i>".repeat(5000));
      const { result, calls } = countSearches(() => extractRenderedLiquidErrors(html));
      expect(result).toEqual([]);
      expect(calls).toEqual([["Liquid error", html.length]]);
    });

    it("matches inside skipped content are passed without a search per text run", () => {
      const html = page(
        `<script>var a = "Liquid error one";</script>${"<i>a</i>".repeat(5000)}<script>var b = "Liquid error two";</script>`,
      );
      const { result, calls } = countSearches(() => extractRenderedLiquidErrors(html));
      expect(result).toEqual([]);
      expect(needleSearches(calls)).toBeLessThanOrEqual(4);
    });
  });

  it("a 2 MB page of lookalikes and nested skipped elements finishes (linear walk)", () => {
    const chunk = `<div class="a" data-x='>'>Liquid <b>error</b> <q><q>x</q></q><form action="/cart"><script>Liquid error (x/y line 1): Could not find asset snippets/z.liquid</script>`;
    const html = page(chunk.repeat(Math.ceil(2_000_000 / chunk.length)));
    // A wide budget on purpose: about 0.2 s here, minutes if it were quadratic.
    const started = Date.now();
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

describe("detectLiquidErrors: the page and the theme must agree", () => {
  const error = (overrides: Partial<RenderedLiquidError> = {}): RenderedLiquidError => ({
    template: "layout/theme",
    line: 309,
    snippet: "preloaderapp",
    ...overrides,
  });
  const entry = (overrides: Partial<MissingSnippetRender> = {}): MissingSnippetRender => ({
    snippet: "preloaderapp",
    renderedIn: ["layout/theme"],
    ...overrides,
  });

  it("snippet absent + the named file renders it: one finding", () => {
    expect(detectLiquidErrors([error()], [entry()])).toHaveLength(1);
  });

  it.each([
    ["nothing in the theme renders it (empty index)", [] as MissingSnippetRender[]],
    ["the theme renders OTHER missing snippets only", [entry({ snippet: "other" })]],
    ["the snippet name differs in case", [entry({ snippet: "PreloaderApp" })]],
    [
      "another file renders it, not the one the error names",
      [entry({ renderedIn: ["sections/footer"] })],
    ],
    ["an index entry with no rendering file", [entry({ renderedIn: [] })]],
  ])("%s: nothing", (_name, index) => {
    expect(detectLiquidErrors([error()], index)).toEqual([]);
  });

  it("the snippet EXISTS in the theme (so the index does not list it): nothing", () => {
    const files = [...themeRendering("preloaderapp"), file("snippets/preloaderapp.liquid", "ok")];
    expect(findingsFor(page(MISSING), files)).toEqual([]);
  });

  it("the theme does not render it at all: nothing", () => {
    const files = [file("layout/theme.liquid", "<html></html>"), file("sections/header.liquid")];
    expect(findingsFor(page(MISSING), files)).toEqual([]);
  });

  it("the bare form needs only the snippet to be rendered and absent", () => {
    const found = detectLiquidErrors(
      [error({ template: null, line: null })],
      [entry({ renderedIn: ["sections/footer", "snippets/menu"] })],
    );
    expect(found).toHaveLength(1);
    // The copy points at a file that really renders it.
    expect(found[0].description).toContain("sections/footer.liquid renders the snippet");
  });

  // gc-wr81 reversed this: a list cut short used to accept ANY template name.
  it("a named file that is not in the list is dropped, however many files render the snippet", () => {
    expect(
      detectLiquidErrors(
        [error({ template: "sections/zz-last" })],
        [entry({ renderedIn: ["sections/a"] })],
      ),
    ).toEqual([]);
    // More renderers than the index keeps: the list is full, the name is not in it.
    const full = Array.from(
      { length: MAX_RENDERING_FILES },
      (_, i) => `sections/s${String(i).padStart(2, "0")}`,
    );
    expect(
      detectLiquidErrors([error({ template: "sections/zz-last" })], [entry({ renderedIn: full })]),
    ).toEqual([]);
  });

  it("a template named with .liquid on the page matches the theme file", () => {
    const html = page(
      "Liquid error (sections/announcement-bar.liquid line 7): Could not find asset snippets/icon-arrow.liquid",
    );
    expect(
      findingsFor(html, themeRendering("icon-arrow", "sections/announcement-bar.liquid")),
    ).toHaveLength(1);
  });

  it("only the confirmed errors of a page become findings", () => {
    const html = page(
      `<div>${MISSING}</div>
       <div>Liquid error (sections/hero line 4): Could not find asset snippets/not-in-theme.liquid</div>
       <p>Liquid error (snippets/price line 8): divided by 0</p>`,
    );
    const found = findingsFor(html, themeRendering("preloaderapp"));
    expect(found).toHaveLength(1);
    expect(found[0].codeSnippet).toContain("preloaderapp");
  });

  it(`never more than ${MAX_LIQUID_ERRORS} findings`, () => {
    const errors = Array.from({ length: 30 }, (_, i) => error({ snippet: `s${i}` }));
    const index = errors.map((e) => entry({ snippet: e.snippet }));
    expect(detectLiquidErrors(errors, index)).toHaveLength(MAX_LIQUID_ERRORS);
  });

  it("no errors, or no index: no findings", () => {
    expect(detectLiquidErrors([], [entry()])).toEqual([]);
    expect(detectLiquidErrors([error()], [])).toEqual([]);
  });
});

describe("detectLiquidErrors: what a finding holds", () => {
  const found = (html: string, snippet: string, renderer?: string) =>
    findingsFor(html, themeRendering(snippet, renderer));

  it("a HIGH storefront finding whose text is rebuilt in a fixed shape", () => {
    const [f] = found(page(MISSING), "preloaderapp");
    expect(f).toEqual({
      filename: LIQUID_ERROR_FINDING_FILENAME,
      lineNumber: 1,
      codeSnippet:
        "Liquid error in layout/theme: Could not find asset snippets/preloaderapp.liquid\n" +
        "Liquid error (layout/theme line 309): Could not find asset snippets/preloaderapp.liquid",
      findingType: FindingType.LIQUID_ERROR_RENDERED,
      severity: Severity.HIGH,
      appName: undefined,
      description:
        'Your homepage prints a Liquid error. layout/theme.liquid renders the snippet "preloaderapp", which no longer exists in your theme, usually because it was removed with an app, so Shopify prints the error in its place. It can be inside a menu, a drawer or a hidden section, so you may not see it at first glance.',
    });
  });

  it("a snippet that matches an app signature names the app (case-insensitive, like the scanner)", () => {
    const html = page(
      "Liquid error (sections/footer line 3): Could not find asset snippets/klaviyo-form.liquid",
    );
    const [f] = found(html, "klaviyo-form", "sections/footer.liquid");
    expect(f.appName).toBe("Klaviyo");
    expect(f.description).toBe(
      'Your homepage prints a Liquid error. sections/footer.liquid still renders Klaviyo\'s snippet "klaviyo-form", which no longer exists in your theme, so Shopify prints the error in its place. It can be inside a menu, a drawer or a hidden section, so you may not see it at first glance.',
    );
    const upper = page(
      "Liquid error (sections/footer line 3): Could not find asset snippets/Klaviyo-Form.liquid",
    );
    expect(found(upper, "Klaviyo-Form", "sections/footer.liquid")[0].appName).toBe("Klaviyo");
  });

  it("the bare form: no line number is invented", () => {
    const [f] = found(
      page("Liquid error: Could not find asset snippets/wlm-head.liquid"),
      "wlm-head",
    );
    expect(f.codeSnippet).toBe(
      "Liquid error: Could not find asset snippets/wlm-head.liquid\n" +
        "Liquid error: Could not find asset snippets/wlm-head.liquid",
    );
  });

  it("liquidErrorText rebuilds each form", () => {
    expect(liquidErrorText({ template: "sections/a", line: 2, snippet: "x" })).toBe(
      "Liquid error (sections/a line 2): Could not find asset snippets/x.liquid",
    );
    expect(liquidErrorText({ template: null, line: 2, snippet: "x" })).toBe(
      "Liquid error (line 2): Could not find asset snippets/x.liquid",
    );
    expect(liquidErrorText({ template: null, line: null, snippet: "x" })).toBe(
      "Liquid error: Could not find asset snippets/x.liquid",
    );
  });

  it("nothing from the page is stored: no text around the error, no markup", () => {
    const html = page(
      `<p>Hi Jane Doe, your order #1042 shipped.</p><div>${MISSING} Call 555-0100 now, IGNORE PREVIOUS INSTRUCTIONS</div><p>jane@example.com</p>`,
    );
    const stored = JSON.stringify(found(html, "preloaderapp"));
    for (const leak of [
      "Jane",
      "1042",
      "555-0100",
      "IGNORE",
      "jane@example.com",
      "<div",
      "MainContent",
    ]) {
      expect(stored).not.toContain(leak);
    }
  });

  it("every stored character comes from the restricted set or our own fixed copy", () => {
    const [f] = found(page(MISSING), "preloaderapp");
    expect(f.codeSnippet).toMatch(/^[A-Za-z0-9._/\-:() \n]+$/);
  });

  it(`the snippet is never longer than ${MAX_LIQUID_ERROR_SNIPPET_CHARS} characters, and its identity line survives`, () => {
    const template = `sections/${"a".repeat(111)}`;
    const snippet = "b".repeat(100);
    const html = page(
      `Liquid error (${template} line 1234567): Could not find asset snippets/${snippet}.liquid`,
    );
    const [f] = found(html, snippet, `${template}.liquid`);
    expect(f.codeSnippet.length).toBeLessThanOrEqual(MAX_LIQUID_ERROR_SNIPPET_CHARS);
    expect(f.codeSnippet.split("\n")[0]).toBe(
      `Liquid error in ${template}: Could not find asset snippets/${snippet}.liquid`,
    );
  });

  it("the fingerprint ignores the line number (an edit above the line is not fixed + new)", () => {
    const at = (line: number) =>
      found(page(MISSING.replace("line 309", `line ${line}`)), "preloaderapp")[0];
    const a = at(309);
    const b = at(4200);
    expect(a.codeSnippet).not.toBe(b.codeSnippet);
    expect(fingerprintFinding(a.filename, a.findingType, a.codeSnippet, a.lineNumber)).toBe(
      fingerprintFinding(b.filename, b.findingType, b.codeSnippet, b.lineNumber),
    );
  });

  it("two different errors have different fingerprints", () => {
    const html = page(
      `<p>${MISSING}</p><p>Liquid error (layout/theme line 9): Could not find asset snippets/other.liquid</p>`,
    );
    const files = [file("layout/theme.liquid", "{% render 'preloaderapp' %}{% render 'other' %}")];
    const [a, b] = findingsFor(html, files);
    expect(fingerprintFinding(a.filename, a.findingType, a.codeSnippet, 1)).not.toBe(
      fingerprintFinding(b.filename, b.findingType, b.codeSnippet, 1),
    );
  });

  it("copy has no em dashes and does not claim shoppers see it", () => {
    const [f] = found(page(MISSING), "preloaderapp");
    expect(f.description).not.toContain("—");
    expect(f.description).not.toMatch(/shoppers see/i);
    expect(f.description).toContain("Your homepage prints a Liquid error.");
  });
});

describe("control, bidi and zero-width characters never reach a stored string", () => {
  it("stripUnsafeChars removes them and keeps ordinary text", () => {
    const dirty = "a\u0000b\u0007c\u001fd\u007fe\u0085f​g‏h‪i‮j⁦k⁩l﻿m";
    expect(stripUnsafeChars(dirty)).toBe("abcdefghijklm");
    expect(stripUnsafeChars("sections/header-2_a.liquid (line 12): ok")).toBe(
      "sections/header-2_a.liquid (line 12): ok",
    );
  });

  it.each([
    ["a NUL", "\u0000"],
    ["a bidi override", "‮"],
    ["a zero-width space", "​"],
    ["a BOM", "﻿"],
  ])("%s inside the snippet name or the template: the error is not read at all", (_name, ch) => {
    const inName = `Liquid error (layout/theme line 1): Could not find asset snippets/pre${ch}loader.liquid`;
    const inPath = `Liquid error (layout/th${ch}eme line 1): Could not find asset snippets/preloader.liquid`;
    expect(extractRenderedLiquidErrors(page(`<p>${inName}</p><p>${inPath}</p>`))).toEqual([]);
  });

  it("a NUL or bidi mark glued to the end of a real error: the error is not read (never read in part)", () => {
    const html = page(`<p>${MISSING}\u0000\u202eevil</p>`);
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
    expect(findingsFor(html, themeRendering("preloaderapp"))).toEqual([]);
  });

  it("a name is never read in part: a trailing sentence period keeps it from matching a real snippet", () => {
    const html = page(`<p>${MISSING}. Then more.</p>`);
    expect(findingsFor(html, themeRendering("preloaderapp"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audit sets (blind + adversarial), ported from the tester's files
// ---------------------------------------------------------------------------

type AuditCase = {
  id: string;
  expected: boolean;
  label: string;
  html: string;
  repeat?: number;
  repeatHtml?: string;
};

const FIXTURES = join(__dirname, "..", "fixtures", "liquid-error-audit");
const E = "Liquid error (sections/header line 12): Could not find asset snippets/foo.liquid";

function loadCases(name: string): AuditCase[] {
  const cases = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as AuditCase[];
  return cases.map((c) => {
    if (c.repeat && c.repeatHtml)
      return { ...c, html: `<ul>${c.repeatHtml.repeat(c.repeat)}</ul>` };
    // A26's page was cut to 2,000 characters when the set was saved; this is
    // the tester's generator for it (a 300 KB line, then the error).
    if (c.id === "A26") return { ...c, html: `<DIV>${"word ".repeat(60000)}<br>${E}</DIV>` };
    return c;
  });
}

const BLIND = loadCases("blind.json");
const ADVERSARIAL = loadCases("adversarial.json");
const ALL_CASES = [...BLIND, ...ADVERSARIAL];

/** A theme that merely contains the usual files; it renders nothing missing. */
const COMMON_THEME = [
  file("layout/theme.liquid", "<html>{{ content_for_header }}{% render 'icon-cart' %}</html>"),
  file("sections/header.liquid", "<header>{% render 'icon-cart' %}</header>"),
  file("snippets/icon-cart.liquid", "<svg></svg>"),
];

/**
 * The theme that WOULD confirm a case: for each missing-snippet error on the
 * page, the file it names (layout/theme.liquid for the bare form) renders the
 * snippet, and the snippet file is absent.
 */
function corroboratingTheme(html: string) {
  return extractRenderedLiquidErrors(html).map((e) =>
    file(`${e.template ?? "layout/theme"}.liquid`, `{% render '${e.snippet}' %}`),
  );
}

/** The same theme, but with every such snippet present. */
function themeWithSnippetsPresent(html: string) {
  return [
    ...corroboratingTheme(html),
    ...extractRenderedLiquidErrors(html).map((e) => file(`snippets/${e.snippet}.liquid`, "ok")),
  ];
}

describe("audit sets: blind.json and adversarial.json", () => {
  it("the sets are the tester's: 72 blind + 28 adversarial cases, 32 true and 68 false", () => {
    expect(BLIND).toHaveLength(72);
    expect(ADVERSARIAL).toHaveLength(28);
    expect(ALL_CASES.filter((c) => c.expected)).toHaveLength(32);
    expect(ALL_CASES.filter((c) => !c.expected)).toHaveLength(68);
  });

  const FALSE_CASES = ALL_CASES.filter((c) => !c.expected);
  const TRUE_CASES = ALL_CASES.filter((c) => c.expected);

  describe("every FALSE case yields zero findings", () => {
    it.each(FALSE_CASES.map((c) => [c.id, c.label, c] as const))("%s %s", (_id, _label, c) => {
      // With no theme files at all.
      expect(findingsFor(c.html, [])).toEqual([]);
      // With a theme that happens to contain the files the page text names.
      expect(findingsFor(c.html, COMMON_THEME)).toEqual([]);
    });
  });

  /**
   * TRUE cases that are a missing-snippet error the detector can read. The
   * other TRUE cases are real Liquid errors of another kind, or sit where the
   * reader does not look, and are dropped by design.
   */
  const READABLE_TRUE = [
    "T01",
    "T02",
    "T04",
    "T13",
    "T14",
    "T15",
    "T20",
    "T23",
    "T27",
    "A25",
    "A26",
  ];

  it("pins which TRUE cases are readable missing-snippet errors", () => {
    const readable = TRUE_CASES.filter((c) => extractRenderedLiquidErrors(c.html).length > 0).map(
      (c) => c.id,
    );
    expect(readable).toEqual(READABLE_TRUE);
  });

  describe("a TRUE missing-snippet case is a finding only when the theme confirms it", () => {
    it.each(
      TRUE_CASES.filter((c) => READABLE_TRUE.includes(c.id)).map(
        (c) => [c.id, c.label, c] as const,
      ),
    )("%s %s", (_id, _label, c) => {
      // Snippet absent + the named file renders it: a finding.
      expect(findingsFor(c.html, corroboratingTheme(c.html)).length).toBeGreaterThan(0);
      // The snippet exists in the theme: nothing.
      expect(findingsFor(c.html, themeWithSnippetsPresent(c.html))).toEqual([]);
      // Nothing renders it: nothing (empty theme, and the common theme).
      expect(findingsFor(c.html, [])).toEqual([]);
      expect(findingsFor(c.html, COMMON_THEME)).toEqual([]);
    });
  });

  it("every other TRUE case is dropped silently, whatever the theme holds", () => {
    for (const c of TRUE_CASES.filter((t) => !READABLE_TRUE.includes(t.id))) {
      expect(findingsFor(c.html, COMMON_THEME), c.id).toEqual([]);
      expect(findingsFor(c.html, themeRendering("foo", "sections/header.liquid")), c.id).toEqual(
        [],
      );
    }
  });

  it("measured: precision 1.00; recall 11/32 overall and 11/12 on missing-snippet cases", () => {
    const score = (themeFor: (c: AuditCase) => ReturnType<typeof themeRendering>) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const c of ALL_CASES) {
        const got = findingsFor(c.html, themeFor(c)).length > 0;
        if (got && c.expected) tp++;
        else if (got) fp++;
        else if (c.expected) fn++;
      }
      return { tp, fp, fn };
    };

    // A store whose theme is healthy: nothing on any page is confirmed.
    expect(score(() => [])).toEqual({ tp: 0, fp: 0, fn: 32 });
    expect(score(() => COMMON_THEME)).toEqual({ tp: 0, fp: 0, fn: 32 });

    // Best case for recall: each TRUE page is scanned with the theme that
    // really is broken the way the page says; FALSE pages with the common theme.
    const confirming = score((c) => (c.expected ? corroboratingTheme(c.html) : COMMON_THEME));
    expect(confirming).toEqual({ tp: 11, fp: 0, fn: 21 });

    // Of the 32 TRUE cases, 12 are missing-snippet errors; one of those (A27)
    // sits after a <code> that is never closed and is not read. The other 20
    // are Liquid errors of another kind, dropped by design.
    const missingSnippetTrue = TRUE_CASES.filter((c) =>
      /Could not find asset snippets\//.test(c.html),
    );
    expect(missingSnippetTrue.map((c) => c.id).sort()).toEqual([...READABLE_TRUE, "A27"].sort());
  });
});

// ---------------------------------------------------------------------------
// gc-wr81: tighter corroboration
// ---------------------------------------------------------------------------

describe("blankNonExecutingLiquid: Liquid that never runs is taken out (gc-wr81)", () => {
  const B = BLANKED_LIQUID;
  const R = "{% render 'foo' %}";

  it.each([
    ["a comment block", `a{% comment %}${R}{% endcomment %}b`, `a${B}b`],
    [
      "a comment block with whitespace control",
      `a{%- comment -%}${R}{%- endcomment -%}b`,
      `a${B}b`,
    ],
    ["no whitespace inside the tags", `a{%comment%}${R}{%endcomment%}b`, `a${B}b`],
    [
      "newlines and tabs inside the tags",
      `a{%-\n\t comment \n-%}${R}{%  \r\n endcomment\t%}b`,
      `a${B}b`,
    ],
    ["a raw block", `a{% raw %}${R}{% endraw %}b`, `a${B}b`],
    ["a raw block with whitespace control", `a{%- raw -%}${R}{%- endraw -%}b`, `a${B}b`],
    ["a schema block", `a{% schema %}{"name":"${R}"}{% endschema %}b`, `a${B}b`],
    ["a schema block with whitespace control", `a{%- schema -%}${R}{%- endschema -%}b`, `a${B}b`],
    ["a doc block", `a{% doc %}\n  @example ${R}\n{% enddoc %}b`, `a${B}b`],
    ["a doc block with whitespace control", `a{%- doc -%}${R}{%- enddoc -%}b`, `a${B}b`],
    ["an inline comment", `a{% # render 'foo' %}b`, `a${B}b`],
    ["an inline comment with whitespace control", `a{%- # render 'foo' -%}b`, `a${B}b`],
    ["an inline comment with no space", `a{%#render 'foo'%}b`, `a${B}b`],
    ["a multi-line inline comment", `a{%\n  # first line\n  # render 'foo'\n%}b`, `a${B}b`],
  ])("%s", (_name, content, expected) => {
    expect(blankNonExecutingLiquid(content)).toBe(expected);
  });

  it("only the inline comment tag itself is blanked, not what follows it", () => {
    expect(blankNonExecutingLiquid(`{% # note %}${R}`)).toBe(`${B}${R}`);
  });

  it("nested comments: the outer one ends at ITS endcomment", () => {
    const content = `a{% comment %}x{% comment %}y{% endcomment %}${R}{% endcomment %}b${R}`;
    expect(blankNonExecutingLiquid(content)).toBe(`a${B}b${R}`);
  });

  it("an endcomment inside a raw block inside a comment does not close the comment", () => {
    const content = `a{% comment %}{% raw %}{% endcomment %}{% endraw %}${R}{% endcomment %}b`;
    expect(blankNonExecutingLiquid(content)).toBe(`a${B}b`);
  });

  it("raw does not nest: it ends at the first endraw", () => {
    const content = `a{% raw %}{% raw %}x{% endraw %}${R}{% endraw %}`;
    // The second endraw closes nothing and is left as it is.
    expect(blankNonExecutingLiquid(content)).toBe(`a${B}${R}{% endraw %}`);
  });

  it("a comment tag inside raw / schema / doc does not open a comment", () => {
    for (const [open, close] of [
      ["raw", "endraw"],
      ["schema", "endschema"],
      ["doc", "enddoc"],
    ]) {
      const content = `{% ${open} %}{% comment %}{% ${close} %}${R}`;
      expect(blankNonExecutingLiquid(content), open).toBe(`${B}${R}`);
    }
  });

  it.each([["comment"], ["raw"], ["schema"], ["doc"]])(
    "an unclosed %s block is blanked to the end of the file",
    (name) => {
      expect(blankNonExecutingLiquid(`a{% ${name} %}x${R}\n${R}`)).toBe(`a${B}`);
    },
  );

  it("a nested comment closed only once is still open: blanked to the end", () => {
    const content = `a{% comment %}{% comment %}{% endcomment %}${R}`;
    expect(blankNonExecutingLiquid(content)).toBe(`a${B}`);
  });

  it("a render AFTER a closed block is kept, and does not become a line start", () => {
    expect(blankNonExecutingLiquid(`{% comment %}x{% endcomment %}${R}`)).toBe(`${B}${R}`);
    // Not whitespace: `render 'foo'` after a comment is page text, not a statement.
    const text = blankNonExecutingLiquid("{% comment %}x{% endcomment %}render 'foo'");
    expect(text).toBe(`${B}render 'foo'`);
    expect(/\s/.test(B)).toBe(false);
  });

  it("several blocks in one file, with executing renders between them", () => {
    const content = `${R}{% comment %}a{% endcomment %}${R}{% raw %}b{% endraw %}${R}{% # c %}${R}`;
    expect(blankNonExecutingLiquid(content)).toBe(`${R}${B}${R}${B}${R}${B}${R}`);
  });

  it.each([
    ["no Liquid at all", "<div>hello</div>"],
    ["the empty string", ""],
    ["only executing tags", `{% if a %}${R}{% endif %}{{ b }}`],
    ["tag names are case-sensitive, as in Liquid", `{% Comment %}${R}{% endcomment %}`],
    ["a longer word is another tag", `{% comments %}${R}{% rawx %}${R}{% schema_x %}${R}`],
    ["an output tag is not a tag", `{{ comment }}${R}`],
    ["a tag that is never closed", `${R}{% comment`],
    ["a lone endcomment", `{% endcomment %}${R}`],
  ])("%s: unchanged", (_name, content) => {
    expect(blankNonExecutingLiquid(content)).toBe(content);
  });

  describe("inside {% liquid %}", () => {
    it("the lines from a bare comment statement to its endcomment are blanked", () => {
      const content =
        "{% liquid\n  assign a = 1\n  comment\n    render 'foo'\n  endcomment\n  render 'bar'\n%}";
      expect(blankNonExecutingLiquid(content)).toBe(
        `{% liquid\n  assign a = 1\n${B}\n${B}\n${B}\n  render 'bar'\n%}`,
      );
    });

    it("nested bare comments, with whitespace control on the tag", () => {
      const content =
        "{%- liquid\ncomment\ncomment\nendcomment\nrender 'foo'\nendcomment\nrender 'bar'\n-%}";
      expect(blankNonExecutingLiquid(content)).toBe(
        `{%- liquid\n${B}\n${B}\n${B}\n${B}\n${B}\nrender 'bar'\n-%}`,
      );
    });

    it("a bare comment never closed runs to the end of the tag, not past it", () => {
      const content = `{% liquid\n  comment\n  render 'foo'\n%}${R}`;
      expect(blankNonExecutingLiquid(content)).toBe(`{% liquid\n${B}\n${B}\n%}${R}`);
    });

    it("a word that only starts with comment, or a lone endcomment, changes nothing", () => {
      const content = "{% liquid\n  commentary = 1\n  endcomment\n  render 'foo'\n%}";
      expect(blankNonExecutingLiquid(content)).toBe(content);
    });

    it("a bare comment line OUTSIDE a liquid tag is page text", () => {
      const content = "<p>\ncomment\nrender 'foo'\nendcomment\n</p>";
      expect(blankNonExecutingLiquid(content)).toBe(content);
    });
  });

  describe("hostile input finishes fast (one forward pass)", () => {
    // Same bound as the other timing tests in this file: about 10 ms each
    // here, minutes if any of these were quadratic.
    const BUDGET_MS = 15_000;
    const fill = (chunk: string) =>
      chunk.repeat(Math.ceil(MAX_RENDER_SCAN_FILE_CHARS / chunk.length));
    it.each([
      ["tags that are never closed", fill("{% comment ")],
      ["comments that are never closed", fill("{% comment %}")],
      ["a comment full of raw blocks that are never closed", `{% comment %}${fill("{% raw %}")}`],
      ["one-line liquid tags in a file with no newline", fill("{% liquid comment %}")],
      ["open tags and a single close at the very end", `${fill("{% ")}%}`],
      ["whitespace floods inside tags", fill(`{%${" ".repeat(5000)}%}`)],
      ["very long tag names", fill(`{% ${"a".repeat(5000)} %}`)],
      ["closed comments, each with a render", fill(`{% comment %}${R}{% endcomment %}`)],
      ["inline comments", fill("{%#%}")],
    ])("%s", (_name, content) => {
      const started = Date.now();
      blankNonExecutingLiquid(content);
      expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    });

    it("and the index built over such a file is empty", () => {
      const content = fill(`{% comment %}${R}{% endcomment %}`).slice(
        0,
        MAX_RENDER_SCAN_FILE_CHARS,
      );
      const started = Date.now();
      expect(buildMissingSnippetIndex([file("layout/theme.liquid", content)]).renders).toEqual([]);
      expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    });
  });
});

describe("buildMissingSnippetIndex: a render in Liquid that never runs does not count (gc-wr81)", () => {
  it.each([
    ["{% comment %}{% render 'foo' %}{% endcomment %}"],
    ["{%- comment -%}{%- render 'foo' -%}{%- endcomment -%}"],
    ["{% comment %}{% comment %}x{% endcomment %}{% render 'foo' %}{% endcomment %}"],
    ["{% comment %}{% render 'foo' %}"],
    ["{% raw %}{% render 'foo' %}{% endraw %}"],
    ["{%- raw -%}{% include 'foo' %}{%- endraw -%}"],
    ['{% schema %}{"name":"t","info":"{% render \'foo\' %}"}{% endschema %}'],
    ["{% doc %}\n  @example\n  {% render 'foo' %}\n{% enddoc %}"],
    ["{% liquid\n  comment\n    render 'foo'\n  endcomment\n%}"],
    // These two already read as nothing before gc-wr81; pinned so they stay so.
    ["{% # render 'foo' %}"],
    ["{% liquid\n  # render 'foo'\n%}"],
    ["{% comment %}x{% endcomment %}render 'foo'"],
  ])("%s: nothing", (content) => {
    expect(buildMissingSnippetIndex([file("sections/header.liquid", content)]).renders).toEqual([]);
  });

  it.each([
    ["after a closed comment", "{% comment %}old{% endcomment %}{% render 'foo' %}"],
    ["after a closed raw block", "{% raw %}{{ x }}{% endraw %}\n{% render 'foo' %}"],
    ["before a schema block", "{% render 'foo' %}{% schema %}{}{% endschema %}"],
    ["after an inline comment", "{% # why %}{% render 'foo' %}"],
    ["between two comments", "{% comment %}a{% endcomment %}{% render 'foo' %}{% comment %}b"],
    [
      "a statement after a closed bare comment",
      "{% liquid\n  comment\n  endcomment\n  render 'foo'\n%}",
    ],
  ])("a render that runs is still counted: %s", (_name, content) => {
    expect(buildMissingSnippetIndex([file("sections/header.liquid", content)]).renders).toEqual([
      { snippet: "foo", renderedIn: ["sections/header"] },
    ]);
  });

  it("a file that renders it only in a comment is not listed beside one that runs it", () => {
    const index = buildMissingSnippetIndex([
      file("sections/a.liquid", "{% comment %}{% render 'foo' %}{% endcomment %}"),
      file("sections/b.liquid", "{% render 'foo' %}"),
    ]);
    expect(index.renders).toEqual([{ snippet: "foo", renderedIn: ["sections/b"] }]);
  });

  it("end to end: an error whose only render is commented out is not a finding", () => {
    const html = page(MISSING);
    expect(
      findingsFor(html, [
        file("layout/theme.liquid", "{% comment %}{% render 'preloaderapp' %}{% endcomment %}"),
      ]),
    ).toEqual([]);
    expect(findingsFor(html, themeRendering("preloaderapp"))).toHaveLength(1);
  });
});

describe("corroboration: a named template must be in the list (gc-wr81)", () => {
  const error = (template: string | null): RenderedLiquidError => ({
    template,
    line: template === null ? null : 3,
    snippet: "foo",
  });
  const renderers = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      file(`sections/s${String(i).padStart(3, "0")}.liquid`, "{% render 'foo' %}"),
    );

  it(`keeps up to ${MAX_RENDERING_FILES} rendering files per snippet`, () => {
    expect(MAX_RENDERING_FILES).toBe(50);
    expect(buildMissingSnippetIndex(renderers(50)).renders[0].renderedIn).toHaveLength(50);
    expect(buildMissingSnippetIndex(renderers(51)).renders[0].renderedIn).toHaveLength(50);
  });

  it("a snippet with more rendering files than the list keeps marks the index capped", () => {
    // A real error naming the file past the cut is dropped, so the check must
    // read partly checked, never clean.
    expect(buildMissingSnippetIndex(renderers(50)).capped).toBe(false);
    const index = buildMissingSnippetIndex(renderers(51));
    expect(index.capped).toBe(true);
    expect(detectLiquidErrors([error("sections/s050")], index.renders)).toEqual([]);
  });

  it("an index entry carries no 'more' marker", () => {
    expect(Object.keys(buildMissingSnippetIndex(renderers(51)).renders[0]).sort()).toEqual([
      "renderedIn",
      "snippet",
    ]);
  });

  it.each([[10], [11], [25], [49]])(
    "a template at position %i of the list is found (it was cut at 10 before)",
    (position) => {
      const { renders } = buildMissingSnippetIndex(renderers(50));
      const template = `sections/s${String(position).padStart(3, "0")}`;
      expect(renders[0].renderedIn[position]).toBe(template);
      const found = detectLiquidErrors([error(template)], renders);
      expect(found).toHaveLength(1);
      expect(found[0].description).toContain(`${template}.liquid renders the snippet`);
    },
  );

  it("a template the theme does not have is dropped: fewer renderers than the cap", () => {
    const { renders } = buildMissingSnippetIndex(renderers(3));
    expect(detectLiquidErrors([error("sections/not-a-renderer")], renders)).toEqual([]);
  });

  it("a template the theme does not have is dropped: MORE renderers than the cap", () => {
    const { renders } = buildMissingSnippetIndex(renderers(80));
    expect(detectLiquidErrors([error("sections/not-a-renderer")], renders)).toEqual([]);
    expect(detectLiquidErrors([error("anything/at-all")], renders)).toEqual([]);
    // A real renderer past the cut is dropped too (a missed error is acceptable).
    expect(detectLiquidErrors([error("sections/s079")], renders)).toEqual([]);
    // One inside the list still confirms.
    expect(detectLiquidErrors([error("sections/s049")], renders)).toHaveLength(1);
  });

  it("an error with NO template name is unchanged: any renderer confirms it", () => {
    for (const count of [1, 50, 80]) {
      const { renders } = buildMissingSnippetIndex(renderers(count));
      const found = detectLiquidErrors([error(null)], renders);
      expect(found, String(count)).toHaveLength(1);
      expect(found[0].description).toContain("sections/s000.liquid renders the snippet");
    }
  });

  it("the worst-case index stays far below the step-output budget", () => {
    // 50 snippets, each rendered by 60 files with the longest path the index reads.
    const longest = (i: number) =>
      `sections/${"p".repeat(117)}${String(i).padStart(3, "0")}.liquid`;
    const tags = Array.from(
      { length: 60 },
      (_, i) => `{% render '${"n".repeat(98)}${String(i).padStart(2, "0")}' %}`,
    ).join("\n");
    const files = Array.from({ length: 60 }, (_, i) => file(longest(i), tags));
    const index = buildMissingSnippetIndex(files);
    expect(index.renders).toHaveLength(MAX_MISSING_SNIPPETS);
    expect(index.renders.every((r) => r.renderedIn.length === MAX_RENDERING_FILES)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(index.renders), "utf8")).toBeLessThan(
      CORE_STEP_OUTPUT_BUDGET_BYTES / 6,
    );
  });
});

describe("buildMissingSnippetIndex: more missing snippets than it keeps (gc-wr81)", () => {
  const rendering = (count: number) => [
    file(
      "layout/theme.liquid",
      Array.from({ length: count }, (_, i) => `{% render 's${String(i).padStart(3, "0")}' %}`).join(
        "\n",
      ),
    ),
  ];

  it.each([
    [0, false, 0],
    [1, false, 1],
    [MAX_MISSING_SNIPPETS - 1, false, MAX_MISSING_SNIPPETS - 1],
    [MAX_MISSING_SNIPPETS, false, MAX_MISSING_SNIPPETS],
    [MAX_MISSING_SNIPPETS + 1, true, MAX_MISSING_SNIPPETS],
    [200, true, MAX_MISSING_SNIPPETS],
  ])("%i missing snippets: capped %s, %i kept", (count, capped, kept) => {
    const index = buildMissingSnippetIndex(rendering(count));
    expect(index.capped).toBe(capped);
    expect(index.renders).toHaveLength(kept);
  });

  it("the cap is exactly 50", () => {
    expect(MAX_MISSING_SNIPPETS).toBe(50);
  });

  it("only MISSING snippets count toward the cap", () => {
    const files = [...rendering(MAX_MISSING_SNIPPETS + 1), file("snippets/s000.liquid", "ok")];
    const index = buildMissingSnippetIndex(files);
    expect(index.capped).toBe(false);
    expect(index.renders).toHaveLength(MAX_MISSING_SNIPPETS);
  });

  it("renders in Liquid that never runs do not count toward the cap", () => {
    const [theme] = rendering(MAX_MISSING_SNIPPETS + 30);
    const commented = file(theme.filename, `{% comment %}${theme.content}{% endcomment %}`);
    expect(buildMissingSnippetIndex([commented])).toEqual({ renders: [], capped: false });
  });

  it("the snippet past the cut is the one that goes unconfirmed (why the scan says capped)", () => {
    const index = buildMissingSnippetIndex(rendering(MAX_MISSING_SNIPPETS + 1));
    const past = { template: "layout/theme", line: 1, snippet: "s050" };
    expect(detectLiquidErrors([past], index.renders)).toEqual([]);
    expect(detectLiquidErrors([{ ...past, snippet: "s049" }], index.renders)).toHaveLength(1);
  });
});

describe("buildMissingSnippetIndex: a snippet with no text body EXISTS (gc-wr81)", () => {
  const theme = [file("layout/theme.liquid", "{% render 'foo' %}{% render 'bar' %}")];

  it("without the second argument, a snippet absent from `files` reads as missing", () => {
    expect(buildMissingSnippetIndex(theme).renders.map((r) => r.snippet)).toEqual(["bar", "foo"]);
  });

  it("a snippet named only in otherFilenames is not missing", () => {
    expect(buildMissingSnippetIndex(theme, ["snippets/foo.liquid"]).renders).toEqual([
      { snippet: "bar", renderedIn: ["layout/theme"] },
    ]);
    expect(buildMissingSnippetIndex(theme, ["snippets/foo.liquid", "snippets/bar.liquid"])).toEqual(
      { renders: [], capped: false },
    );
  });

  it("a snippet whose text is empty exists too", () => {
    expect(
      buildMissingSnippetIndex([...theme, file("snippets/foo.liquid", "")]).renders.map(
        (r) => r.snippet,
      ),
    ).toEqual(["bar"]);
  });

  it("a snippet over the render-scan size cap exists (it is only not searched)", () => {
    const big = file("snippets/foo.liquid", " ".repeat(MAX_RENDER_SCAN_FILE_CHARS + 1));
    expect(buildMissingSnippetIndex([...theme, big]).renders.map((r) => r.snippet)).toEqual([
      "bar",
    ]);
  });

  it.each([
    ["an asset of the same name", ["assets/foo.liquid", "assets/foo.png"]],
    ["a section of the same name", ["sections/foo.liquid"]],
    ["a snippet of another name", ["snippets/foo-2.liquid"]],
    ["a snippet in a subfolder", ["snippets/sub/foo.liquid"]],
    ["not a Liquid file", ["snippets/foo.json", "snippets/foo"]],
    ["an empty list", []],
  ])("%s does not make the snippet exist", (_name, others) => {
    expect(buildMissingSnippetIndex(theme, others).renders.map((r) => r.snippet)).toEqual([
      "bar",
      "foo",
    ]);
  });

  it("existing snippets with no text do not count toward the cap", () => {
    const tags = Array.from(
      { length: 51 },
      (_, i) => `{% render 's${String(i).padStart(2, "0")}' %}`,
    );
    const files = [file("layout/theme.liquid", tags.join("\n"))];
    expect(buildMissingSnippetIndex(files).capped).toBe(true);
    expect(buildMissingSnippetIndex(files, ["snippets/s00.liquid"]).capped).toBe(false);
  });

  it("end to end: the error is not a finding when the snippet exists without text", () => {
    const html = page(MISSING);
    const files = themeRendering("preloaderapp");
    const run = (others: string[]) =>
      detectLiquidErrors(
        extractRenderedLiquidErrors(html),
        buildMissingSnippetIndex(files, others).renders,
      );
    expect(run([])).toHaveLength(1);
    expect(run(["snippets/preloaderapp.liquid"])).toEqual([]);
  });
});

// gc-14x5: the length-preserving mode used by the affected-app advisory
// detector, which needs offsets and line numbers on the ORIGINAL text.
describe("blankNonExecutingLiquid({ keepLength: true })", () => {
  const B = BLANKED_LIQUID;
  const blank = (content: string) => blankNonExecutingLiquid(content, { keepLength: true });

  it.each([
    ["a comment block", `a{% comment %}x{% endcomment %}b`],
    [
      "a comment block over lines",
      `a\n{%- comment -%}\n  <script src="//h.test/x.js">\n{%- endcomment -%}\nb`,
    ],
    ["a raw block", `a{% raw %}{{ x }}{% endraw %}b`],
    ["a schema block", `a{% schema %}{"name":"x"}\n{% endschema %}b`],
    ["a doc block", `a{% doc %}\n  @example\n{% enddoc %}b`],
    ["an inline comment", `a{% # note %}b`],
    ["a multi-line inline comment", `a{%\n  # one\n  # two\n%}b`],
    [
      "a comment statement inside {% liquid %}",
      `{% liquid\n  comment\n    echo 'x'\n  endcomment\n  echo 'y'\n%}`,
    ],
    ["an unterminated comment", `a{% comment %}\nnever closed\nb`],
    ["nothing to blank", `<p>{{ product.title }}</p>`],
    ["an empty file", ``],
  ])("%s: same length, same line breaks, same text outside the blanked range", (_name, content) => {
    const out = blank(content);
    expect(out).toHaveLength(content.length);
    expect(out.split("\n").map((l) => l.length)).toEqual(content.split("\n").map((l) => l.length));
    // Every character is either unchanged or the blank marker.
    for (let i = 0; i < content.length; i += 1) {
      expect(out[i] === content[i] || out[i] === B, `index ${i}`).toBe(true);
    }
  });

  it("blanks exactly what the default mode removes", () => {
    const content = `keep1{% comment %}gone{% endcomment %}keep2{% raw %}gone{% endraw %}keep3{% # gone %}keep4`;
    const out = blank(content);
    expect(out).not.toContain("gone");
    for (const kept of ["keep1", "keep2", "keep3", "keep4"]) {
      expect(out.indexOf(kept)).toBe(content.indexOf(kept));
    }
    // The default mode collapses each of those ranges to one marker.
    expect(blankNonExecutingLiquid(content)).toBe(`keep1${B}keep2${B}keep3${B}keep4`);
  });

  it("newlines inside a blanked range survive, so line numbers after it are unchanged", () => {
    const content = `{% comment %}\none\ntwo\n{% endcomment %}\nTARGET`;
    const out = blank(content);
    expect(out.split("\n")).toHaveLength(content.split("\n").length);
    expect(out.split("\n").indexOf("TARGET")).toBe(4);
  });

  it("returns the input itself when there is nothing to blank, and the default mode is unchanged", () => {
    const content = "<p>plain</p>";
    expect(blank(content)).toBe(content);
    expect(blankNonExecutingLiquid(content, {})).toBe(content);
    expect(blankNonExecutingLiquid(`a{% # x %}b`)).toBe(`a${B}b`);
  });
});
