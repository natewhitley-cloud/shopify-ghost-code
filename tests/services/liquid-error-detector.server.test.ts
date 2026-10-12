/**
 * Tests for app/services/liquid-error-detector.server.ts (gc-i6du): reading
 * rendered Liquid errors from storefront homepage HTML, and turning them into
 * LIQUID_ERROR_RENDERED findings. Pure: no network, no DB.
 */
import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  detectLiquidErrors,
  extractRenderedLiquidErrors,
  LIQUID_ERROR_FINDING_FILENAME,
  MAX_LIQUID_ERROR_MATCHES,
  MAX_LIQUID_ERROR_TEXT_CHARS,
  MAX_LIQUID_ERRORS,
  PROSE_LEAD_WORDS,
  type RenderedLiquidError,
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

describe("extractRenderedLiquidErrors: what Shopify prints", () => {
  it("a missing snippet with a location (the classic app leftover)", () => {
    expect(extractRenderedLiquidErrors(page(`<div class="banner">\n  ${MISSING}\n</div>`))).toEqual(
      [
        {
          text: MISSING,
          kind: "error",
          template: "layout/theme",
          missingSnippet: "preloaderapp",
        },
      ],
    );
  });

  it("a missing snippet without a location (older output)", () => {
    const html = page("Liquid error: Could not find asset snippets/wlm-head.liquid");
    expect(extractRenderedLiquidErrors(html)).toEqual([
      {
        text: "Liquid error: Could not find asset snippets/wlm-head.liquid",
        kind: "error",
        template: null,
        missingSnippet: "wlm-head",
      },
    ]);
  });

  it("a missing snippet named without the .liquid extension", () => {
    const [e] = extractRenderedLiquidErrors(
      page(
        "Liquid error (sections/header line 16): Could not find asset snippets/opinew_review_stars",
      ),
    );
    expect(e.missingSnippet).toBe("opinew_review_stars");
    expect(e.template).toBe("sections/header");
  });

  it("a located error with any other message", () => {
    const html = page(
      `<span class="price">Liquid error (snippets/price line 42): comparison of String with 0 failed</span>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([
      {
        text: "Liquid error (snippets/price line 42): comparison of String with 0 failed",
        kind: "error",
        template: "snippets/price",
        missingSnippet: null,
      },
    ]);
  });

  it("a located error with only a line number (no template name)", () => {
    const [e] = extractRenderedLiquidErrors(page("Liquid error (line 7): invalid url input"));
    expect(e).toMatchObject({ template: null, kind: "error", missingSnippet: null });
    expect(e.text).toBe("Liquid error (line 7): invalid url input");
  });

  it("a syntax error", () => {
    const html = page(
      "Liquid syntax error (sections/featured-app line 12): Unknown tag &#39;endschema&#39;",
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([
      {
        text: "Liquid syntax error (sections/featured-app line 12): Unknown tag 'endschema'",
        kind: "syntax",
        template: "sections/featured-app",
        missingSnippet: null,
      },
    ]);
  });

  it("several different errors on one page, in page order", () => {
    const html = page(
      `<div>${MISSING}</div>
       <div>Liquid error (sections/hero line 3): Could not find asset snippets/klaviyo-form.liquid</div>
       <p>Liquid syntax error (templates/index line 2): Unexpected character</p>`,
    );
    expect(extractRenderedLiquidErrors(html).map((e) => e.template)).toEqual([
      "layout/theme",
      "sections/hero",
      "templates/index",
    ]);
  });

  it("the message stops at the next tag and at the end of the line", () => {
    const html = page(
      `<p>Liquid error (snippets/card line 9): undefined method<strong>Add to cart</strong></p>
       Liquid error (snippets/badge line 2): bad value\n<p>Free shipping over $50</p>`,
    );
    expect(extractRenderedLiquidErrors(html).map((e) => e.text)).toEqual([
      "Liquid error (snippets/card line 9): undefined method",
      "Liquid error (snippets/badge line 2): bad value",
    ]);
  });

  it("a missing-snippet message ends at the snippet path: page text after it is not kept", () => {
    const [e] = extractRenderedLiquidErrors(
      page(`<p>${MISSING} Welcome back, Jane Doe (jane@example.com)</p>`),
    );
    expect(e.text).toBe(MISSING);
    expect(JSON.stringify(e)).not.toContain("jane@example.com");
  });
});

describe("extractRenderedLiquidErrors: empty and clean input", () => {
  it.each([
    ["an empty string", ""],
    ["a clean homepage", page(`<h2>New arrivals</h2><p>Grain-free treats, made in Colorado.</p>`)],
    ["text with no markup", "just some words"],
    ["an unclosed tag", "<div class='a"],
    ["an unclosed comment", "<!-- Liquid error (layout/theme line 1): x"],
    ["an unclosed script", "<script>var e = 'Liquid error (layout/theme line 1): x'"],
  ])("%s: nothing", (_name, html) => {
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });
});

describe("extractRenderedLiquidErrors: false-positive guards", () => {
  it("inside a script string", () => {
    const html = page(
      `<script>window.themeStrings = { err: "Liquid error (layout/theme line 309): Could not find asset snippets/x.liquid" };</script>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("inside a JSON data island (product / section data)", () => {
    const html = page(
      `<script type="application/json" id="ProductJson">{"title":"Liquid error soap","description":"<p>Liquid error (sections/main line 3): Could not find asset snippets/y.liquid<\\/p>"}</script>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("inside JSON-LD", () => {
    const html = page(
      "",
      `<script type="application/ld+json">{"@type":"Article","headline":"Liquid error: Could not find asset snippets/foo.liquid"}</script>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("inside a style block or an HTML comment", () => {
    const html = page(
      `<style>.x::after{content:"Liquid error (layout/theme line 1): Could not find asset snippets/a.liquid"}</style>
       <!-- Liquid error (layout/theme line 2): Could not find asset snippets/b.liquid -->`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("inside an attribute value, even one containing '>'", () => {
    const html = page(
      `<img alt="Liquid error (snippets/img line 4): Could not find asset snippets/c.liquid" src="/a.png">
       <a title='x > Liquid error (layout/theme line 9): Could not find asset snippets/d.liquid' href="/">Home</a>
       <input value="Liquid error: Could not find asset snippets/e.liquid">`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("a product description that mentions the words", () => {
    const html = page(
      `<div class="product__description rte">
         <p>Our Liquid error-free cleanser: no residue, no fuss.</p>
         <p>Liquid errors in your routine? Try the 3-step kit.</p>
         <p>Liquid error: none. That is our promise.</p>
       </div>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("a blog post about Liquid (prose, lower case, inline code, a code block, a quote)", () => {
    const html = page(
      `<article class="article-template">
         <h2>How to fix a Liquid error in your Shopify theme</h2>
         <p>A liquid error (layout/theme line 12): could not find asset message means a snippet is gone.</p>
         <p>You will usually see <code>Liquid error (layout/theme line 309): Could not find asset snippets/app.liquid</code> on the page.</p>
         <pre>Liquid error (sections/header line 4): Could not find asset snippets/app.liquid
Liquid syntax error (line 3): Unknown tag</pre>
         <p>Merchants often report &ldquo;Liquid error (layout/theme line 20): Could not find asset snippets/reviews.liquid&rdquo; after removing an app.</p>
         <p>Or the shorter "Liquid error: Could not find asset snippets/reviews.liquid" form.</p>
         <p>The phrase Liquid error: something went wrong is not specific enough to act on.</p>
         <p>After removing a reviews app, merchants often report Liquid error (layout/theme line 20): Could not find asset snippets/reviews.liquid on every page.</p>
         <p>A common one is the message Liquid error: Could not find asset snippets/reviews.liquid in the footer.</p>
         <textarea>Liquid error (layout/theme line 1): Could not find asset snippets/t.liquid</textarea>
       </article>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("a short label before the error is still an error (only a run of words is prose)", () => {
    const html = page(
      `<p>Reviews: Liquid error (sections/product line 8): Could not find asset snippets/stars.liquid</p>
       <p>From Liquid error (snippets/price line 2): comparison of String with 0 failed</p>`,
    );
    expect(extractRenderedLiquidErrors(html).map((e) => e.template)).toEqual([
      "sections/product",
      "snippets/price",
    ]);
  });

  it("words on EARLIER lines of the same text run do not make it prose", () => {
    const html = page(`Welcome to the Paw Naturals online store\n${MISSING}`);
    expect(extractRenderedLiquidErrors(html)).toHaveLength(1);
  });

  it(`${PROSE_LEAD_WORDS} words before it on the same line: prose; one fewer: an error`, () => {
    expect(extractRenderedLiquidErrors(page(`<p>one two three four ${MISSING}</p>`))).toEqual([]);
    expect(extractRenderedLiquidErrors(page(`<p>one two three ${MISSING}</p>`))).toHaveLength(1);
  });

  it("a bare 'Liquid error:' with any message other than a missing snippet", () => {
    const html = page(
      `<p>Liquid error: Memory limits exceeded</p><p>Liquid syntax error: Unknown tag</p>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("a missing asset that is not a snippet, without a location", () => {
    expect(
      extractRenderedLiquidErrors(page("Liquid error: Could not find asset assets/app.js")),
    ).toEqual([]);
  });

  it("a malformed location is not a location", () => {
    const html = page(
      `<p>Liquid error (see line twelve): oops</p><p>Liquid error (layout/theme): oops</p>`,
    );
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
  });

  it("a real error is still found right next to the skipped content", () => {
    const html = page(
      `<script>var s = "Liquid error (layout/theme line 1): Could not find asset snippets/in-js.liquid";</script>
       ${MISSING}
       <code>Liquid error (layout/theme line 2): Could not find asset snippets/in-code.liquid</code>`,
    );
    expect(extractRenderedLiquidErrors(html).map((e) => e.missingSnippet)).toEqual([
      "preloaderapp",
    ]);
  });

  it("'a < b' in text does not swallow what follows", () => {
    const html = page(`<p>1 < 2 then ${MISSING}</p>`);
    expect(extractRenderedLiquidErrors(html)).toHaveLength(1);
  });
});

describe("extractRenderedLiquidErrors: dedupe, caps and bounds", () => {
  it("the same error printed many times is one error", () => {
    const html = page(Array.from({ length: 30 }, () => `<div>${MISSING}</div>`).join("\n"));
    expect(extractRenderedLiquidErrors(html)).toHaveLength(1);
  });

  it("the same broken line at a different line number is the same error (first text kept)", () => {
    const html = page(`<div>${MISSING}</div><div>${MISSING.replace("line 309", "line 314")}</div>`);
    const errors = extractRenderedLiquidErrors(html);
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("line 309");
  });

  it("the same message from two different files is two errors", () => {
    const html = page(
      `<div>${MISSING}</div><div>${MISSING.replace("layout/theme", "sections/footer")}</div>`,
    );
    expect(extractRenderedLiquidErrors(html)).toHaveLength(2);
  });

  it(`keeps at most ${MAX_LIQUID_ERRORS} distinct errors, the first in page order`, () => {
    const html = page(
      Array.from(
        { length: 40 },
        (_, i) =>
          `<div>Liquid error (sections/s${i} line 1): Could not find asset snippets/app-${i}.liquid</div>`,
      ).join("\n"),
    );
    const errors = extractRenderedLiquidErrors(html);
    expect(errors).toHaveLength(MAX_LIQUID_ERRORS);
    expect(errors[0].missingSnippet).toBe("app-0");
    expect(errors.at(-1)!.missingSnippet).toBe(`app-${MAX_LIQUID_ERRORS - 1}`);
  });

  it(`stops examining after ${MAX_LIQUID_ERROR_MATCHES} "Liquid " occurrences`, () => {
    const noise = "Liquid soap. ".repeat(MAX_LIQUID_ERROR_MATCHES + 5);
    expect(extractRenderedLiquidErrors(page(`<p>${noise}</p><p>${MISSING}</p>`))).toEqual([]);
    // Under the cap the real error is found.
    expect(extractRenderedLiquidErrors(page(`<p>Liquid soap.</p><p>${MISSING}</p>`))).toHaveLength(
      1,
    );
  });

  it(`stores at most ${MAX_LIQUID_ERROR_TEXT_CHARS} characters of an error`, () => {
    const long = `Liquid error (sections/hero line 5): ${"x".repeat(5000)}`;
    const [e] = extractRenderedLiquidErrors(page(long));
    expect(e.text).toHaveLength(MAX_LIQUID_ERROR_TEXT_CHARS);
  });

  it("a 2 MB page of lookalikes finishes quickly (linear walk)", () => {
    const chunk = `<div class="a" data-x='>'>Liquid <b>error</b> <form action="/cart"><script>Liquid error (x/y line 1): z</script>`;
    const html = page(chunk.repeat(Math.ceil(2_000_000 / chunk.length)));
    const started = Date.now();
    expect(extractRenderedLiquidErrors(html)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("detectLiquidErrors", () => {
  const missing = (
    snippet: string,
    template: string | null = "layout/theme",
  ): RenderedLiquidError => ({
    text: `Liquid error (${template ?? "x"} line 3): Could not find asset snippets/${snippet}.liquid`,
    kind: "error",
    template,
    missingSnippet: snippet,
  });

  it("no errors: no findings", () => {
    expect(detectLiquidErrors([])).toEqual([]);
  });

  it("one HIGH storefront finding per error, with the error text only", () => {
    const [f] = detectLiquidErrors([missing("preloaderapp")]);
    expect(f).toMatchObject({
      filename: LIQUID_ERROR_FINDING_FILENAME,
      lineNumber: 1,
      findingType: FindingType.LIQUID_ERROR_RENDERED,
      severity: Severity.HIGH,
    });
    expect(f.appName).toBeUndefined();
    expect(f.codeSnippet.split("\n")).toEqual([
      "Liquid error in layout/theme: Could not find asset snippets/preloaderapp.liquid",
      "Liquid error (layout/theme line 3): Could not find asset snippets/preloaderapp.liquid",
    ]);
    expect(f.description).toBe(
      'Shoppers see a Liquid error on your homepage. Your theme tries to load the snippet "preloaderapp", which no longer exists, so Shopify prints the error in its place. This often happens after an app that added the snippet is removed. The line is in layout/theme.liquid.',
    );
  });

  it("a missing snippet that matches an app signature is attributed to that app", () => {
    const [f] = detectLiquidErrors([missing("klaviyo-form", "sections/footer")]);
    expect(f.appName).toBe("Klaviyo");
    expect(f.description).toBe(
      'Shoppers see a Liquid error on your homepage. Your theme still tries to load Klaviyo\'s snippet "klaviyo-form", which no longer exists, so Shopify prints the error where the snippet used to be. The line is in sections/footer.liquid.',
    );
  });

  it("signature matching is case-insensitive, like the theme scanner's", () => {
    expect(detectLiquidErrors([missing("Klaviyo-Form")])[0].appName).toBe("Klaviyo");
  });

  it("an error INSIDE an app's own snippet is attributed to that app", () => {
    const [f] = detectLiquidErrors([
      {
        text: "Liquid error (snippets/klaviyo-form line 8): undefined method",
        kind: "error",
        template: "snippets/klaviyo-form",
        missingSnippet: null,
      },
    ]);
    expect(f.appName).toBe("Klaviyo");
    expect(f.description).toBe(
      "Shoppers see a Liquid error on your homepage. It comes from Klaviyo's code in your theme. The line is in snippets/klaviyo-form.liquid.",
    );
  });

  it("any other error names no app and says where it is", () => {
    const [f] = detectLiquidErrors([
      {
        text: "Liquid syntax error (sections/hero line 12): Unknown tag 'endschema'",
        kind: "syntax",
        template: "sections/hero",
        missingSnippet: null,
      },
    ]);
    expect(f.appName).toBeUndefined();
    expect(f.codeSnippet.split("\n")[0]).toBe(
      "Liquid syntax error in sections/hero: Unknown tag 'endschema'",
    );
    expect(f.description).toBe(
      "Shoppers see a Liquid error on your homepage. Shopify prints it where a piece of theme code failed. The line is in sections/hero.liquid.",
    );
  });

  it("the first snippet line (what the scan page shows) reads as the error, without a line number", () => {
    const [f] = detectLiquidErrors([missing("preloaderapp")]);
    const first = f.codeSnippet.split("\n")[0];
    expect(first).toBe(
      "Liquid error in layout/theme: Could not find asset snippets/preloaderapp.liquid",
    );
    expect(first).not.toMatch(/line \d/);
  });

  it("no template: the copy does not invent a file", () => {
    const [f] = detectLiquidErrors([missing("wlm-head", null)]);
    expect(f.description).not.toContain("The line is in");
    expect(f.codeSnippet.split("\n")[0]).toBe(
      "Liquid error: Could not find asset snippets/wlm-head.liquid",
    );
  });

  it("copy has no em dashes", () => {
    for (const f of detectLiquidErrors([missing("a"), missing("klaviyo-form")])) {
      expect(f.description).not.toContain("—");
    }
  });

  it("the fingerprint ignores the line number (an edit above the line is not fixed + new)", () => {
    const at = (line: number) =>
      detectLiquidErrors(
        extractRenderedLiquidErrors(page(MISSING.replace("line 309", `line ${line}`))),
      )[0];
    const a = at(309);
    const b = at(420);
    expect(a.codeSnippet).not.toBe(b.codeSnippet);
    expect(fingerprintFinding(a.filename, a.findingType, a.codeSnippet, a.lineNumber)).toBe(
      fingerprintFinding(b.filename, b.findingType, b.codeSnippet, b.lineNumber),
    );
  });

  it("two different errors have different fingerprints", () => {
    const [a, b] = detectLiquidErrors([missing("one"), missing("two")]);
    expect(fingerprintFinding(a.filename, a.findingType, a.codeSnippet, 1)).not.toBe(
      fingerprintFinding(b.filename, b.findingType, b.codeSnippet, 1),
    );
  });

  it(`never emits more than ${MAX_LIQUID_ERRORS} findings`, () => {
    const many = Array.from({ length: 50 }, (_, i) => missing(`s${i}`));
    expect(detectLiquidErrors(many)).toHaveLength(MAX_LIQUID_ERRORS);
  });

  it("end to end from HTML: nothing but the error text is stored", () => {
    const html = page(
      `<p>Hi Jane Doe, your order #1042 shipped.</p><div>${MISSING}</div><p>jane@example.com</p>`,
    );
    const findings = detectLiquidErrors(extractRenderedLiquidErrors(html));
    expect(findings).toHaveLength(1);
    const stored = JSON.stringify(findings);
    for (const leak of ["Jane", "1042", "jane@example.com", "<div", "MainContent"]) {
      expect(stored).not.toContain(leak);
    }
  });
});
