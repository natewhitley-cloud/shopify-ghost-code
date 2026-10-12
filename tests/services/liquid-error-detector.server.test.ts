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

import {
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
  return detectLiquidErrors(extractRenderedLiquidErrors(html), buildMissingSnippetIndex(files));
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
    expect(buildMissingSnippetIndex([file("sections/header.liquid", `<div>${tag}</div>`)])).toEqual(
      [{ snippet: "foo", renderedIn: ["sections/header"], more: false }],
    );
  });

  it("a snippet that exists is not listed", () => {
    expect(
      buildMissingSnippetIndex([
        file("layout/theme.liquid", "{% render 'foo' %}{% render 'bar' %}"),
        file("snippets/foo.liquid", "hi"),
      ]),
    ).toEqual([{ snippet: "bar", renderedIn: ["layout/theme"], more: false }]);
  });

  it("lists every file that renders it, sorted, across the Liquid folders", () => {
    const index = buildMissingSnippetIndex([
      file("templates/customers/login.liquid", "{% render 'foo' %}"),
      file("snippets/menu.liquid", "{% render 'foo' %}"),
      file("layout/theme.liquid", "{% render 'foo' %}{% render 'foo' %}"),
      file("blocks/group.liquid", "{% render 'foo' %}"),
    ]);
    expect(index).toEqual([
      {
        snippet: "foo",
        renderedIn: ["blocks/group", "layout/theme", "snippets/menu", "templates/customers/login"],
        more: false,
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
    expect(buildMissingSnippetIndex(files)).toEqual([]);
  });

  it("a file over the size cap is not searched (bounded work)", () => {
    const big = `${" ".repeat(MAX_RENDER_SCAN_FILE_CHARS)}{% render 'foo' %}`;
    expect(buildMissingSnippetIndex([file("layout/theme.liquid", big)])).toEqual([]);
  });

  it(`keeps at most ${MAX_MISSING_SNIPPETS} snippets (sorted) and ${MAX_RENDERING_FILES} files each`, () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `{% render 's${String(i).padStart(2, "0")}' %}`,
    );
    const index = buildMissingSnippetIndex([file("layout/theme.liquid", many.join("\n"))]);
    expect(index).toHaveLength(MAX_MISSING_SNIPPETS);
    expect(index[0].snippet).toBe("s00");
    expect(index.at(-1)!.snippet).toBe("s49");

    const renderers = Array.from({ length: 15 }, (_, i) =>
      file(`sections/s${String(i).padStart(2, "0")}.liquid`, "{% render 'foo' %}"),
    );
    const [entry] = buildMissingSnippetIndex(renderers);
    expect(entry.renderedIn).toHaveLength(MAX_RENDERING_FILES);
    expect(entry.more).toBe(true);
    // Small enough to cross an Inngest step boundary many times over.
    expect(
      JSON.stringify(
        buildMissingSnippetIndex([...renderers, file("layout/theme.liquid", many.join("\n"))]),
      ).length,
    ).toBeLessThan(20_000);
  });

  it("a flood of whitespace after {% cannot make the search slow (bounded runs)", () => {
    const content = `{%${" ".repeat(5000)}`.repeat(150);
    const calls = vi.fn();
    const started = Date.now();
    expect(buildMissingSnippetIndex([file("layout/theme.liquid", content)])).toEqual([]);
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
    more: false,
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

  it("a cut-short list of rendering files does not reject the named file", () => {
    expect(
      detectLiquidErrors(
        [error({ template: "sections/zz-last" })],
        [entry({ renderedIn: ["sections/a"], more: true })],
      ),
    ).toHaveLength(1);
    expect(
      detectLiquidErrors(
        [error({ template: "sections/zz-last" })],
        [entry({ renderedIn: ["sections/a"], more: false })],
      ),
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
