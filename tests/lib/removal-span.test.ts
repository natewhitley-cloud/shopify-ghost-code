import { describe, expect, it } from "vitest";

import { getFindingConfidence } from "../../app/lib/finding-classification";
import { getRemovalSafety } from "../../app/lib/finding-safety";
import {
  FIXABLE_FINDING_TYPES,
  inRanges,
  nonCodeRanges,
  removalSpanFor,
  type FixableFindingType,
  type SpanResult,
} from "../../app/lib/removal-span";

/** Span text for the element starting at the first occurrence of `marker`. */
function spanText(type: FixableFindingType, content: string, marker: string): string {
  const at = content.indexOf(marker);
  expect(at, `marker ${marker} not found`).toBeGreaterThanOrEqual(0);
  const r = removalSpanFor(type, content, at);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return content.slice(r.span.start, r.span.end);
}

function refusal(type: FixableFindingType, content: string, marker: string): string {
  const r: SpanResult = removalSpanFor(type, content, content.indexOf(marker));
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
}

describe("fixable allowlist", () => {
  it("is exactly safe-to-remove ∩ signature (a relabel cannot silently widen the fix path)", () => {
    for (const t of FIXABLE_FINDING_TYPES) {
      expect(getRemovalSafety(t)).toBe("safe-to-remove");
      expect(getFindingConfidence(t)).toBe("signature");
    }
    expect([...FIXABLE_FINDING_TYPES].sort()).toEqual(
      ["GHOST_PRECONNECT", "GHOST_SCRIPT", "GHOST_SNIPPET", "GHOST_STYLE"].sort(),
    );
  });
});

describe("GHOST_SCRIPT spans", () => {
  const S = "GHOST_SCRIPT" as const;

  it("covers <script src></script> on one line", () => {
    const c = `<div>\n  <script src="https://cdn.app.io/a.js" defer></script>\n</div>`;
    expect(spanText(S, c, "<script")).toBe(`<script src="https://cdn.app.io/a.js" defer></script>`);
  });

  it("covers a tag split across lines with attributes in either order", () => {
    const c = `<script\n  defer\n  src='//cdn.app.io/a.js'\n>\n</script >\nafter`;
    expect(spanText(S, c, "<script")).toBe(
      `<script\n  defer\n  src='//cdn.app.io/a.js'\n>\n</script >`,
    );
  });

  it("is case-insensitive on the tag names", () => {
    const c = `<SCRIPT src="https://cdn.app.io/a.js"></Script>`;
    expect(spanText(S, c, "<SCRIPT")).toBe(c);
  });

  it("follows Liquid output in an attribute, including a > inside it", () => {
    const c = `<script src="https://cdn.app.io/a.js?s={{ shop.permanent_domain }}&n={{ 2 > 1 }}"></script>`;
    expect(spanText(S, c, "<script")).toBe(c);
  });

  it("follows a > inside a quoted attribute value", () => {
    const c = `<script data-x="a>b" src="https://cdn.app.io/a.js"></script>`;
    expect(spanText(S, c, "<script")).toBe(c);
  });

  it("refuses a Liquid tag inside the element ({% if a > b %})", () => {
    const c = `<script {% if a > b %}async{% endif %} src="https://cdn.app.io/a.js"></script>`;
    expect(refusal(S, c, "<script")).toBe("LIQUID_TAG_IN_ELEMENT");
  });

  it("refuses a Liquid tag inside a quoted attribute", () => {
    const c = `<script src="https://cdn.app.io/{% if x %}a{% endif %}.js"></script>`;
    expect(refusal(S, c, "<script")).toBe("LIQUID_TAG_IN_ELEMENT");
  });

  it("refuses when there is no </script>", () => {
    const c = `<script src="https://cdn.app.io/a.js">\n<div>`;
    expect(refusal(S, c, "<script")).toBe("SCRIPT_BODY_NOT_EMPTY");
  });

  it("refuses inline content between the tags", () => {
    const c = `<script src="https://cdn.app.io/a.js">window.x=1</script>`;
    expect(refusal(S, c, "<script")).toBe("SCRIPT_BODY_NOT_EMPTY");
  });

  it("refuses self-closing <script ... />", () => {
    const c = `<script src="https://cdn.app.io/a.js" />\n<p>`;
    expect(refusal(S, c, "<script")).toBe("SELF_CLOSING_SCRIPT");
  });

  it("refuses an unterminated opening tag and unbalanced quotes", () => {
    // gc-tib.11 r2: an unclosed tag is ambiguous, so the rest of the file is
    // text before the element parser runs (still refused, safer reason).
    expect(refusal(S, `<script src="https://cdn.app.io/a.js`, "<script")).toBe(
      "IN_NON_CODE_REGION",
    );
    expect(refusal(S, `<script src="https://cdn.app.io/a.js></script>`, "<script")).toBe(
      "IN_NON_CODE_REGION",
    );
  });

  it("refuses unclosed Liquid output inside the tag", () => {
    const c = `<script src="https://cdn.app.io/a.js?{{ x"></script>`;
    // The quote opens inside {{ — the {{ is inside a quoted value, so the
    // quote rule ends the tag; nothing beyond the element is ever taken.
    const r = removalSpanFor(S, c, 0);
    if (r.ok) expect(c.slice(r.span.start, r.span.end)).toBe(c);
    const c2 = `<script src=https://cdn.app.io/a.js?{{ x ></script>`;
    expect(refusal(S, c2, "<script")).toBe("IN_NON_CODE_REGION");
  });

  it("refuses <script inside a JS string (document.write)", () => {
    const c = `<script>\n  document.write('<script src="https://cdn.app.io/a.js"></script>');\n</script>`;
    expect(refusal(S, c, `<script src`)).toBe("IN_NON_CODE_REGION");
  });

  it("refuses <script inside a Liquid comment, doc, raw, HTML comment or inline comment", () => {
    const tag = `<script src="https://cdn.app.io/a.js"></script>`;
    for (const c of [
      `{% comment %}\n${tag}\n{% endcomment %}`,
      `{%- comment -%}${tag}{%- endcomment -%}`,
      `{% doc %}\n${tag}\n{% enddoc %}`,
      `{% raw %}${tag}{% endraw %}`,
      `{% javascript %}\nvar s='${tag}';\n{% endjavascript %}`,
      `<!-- ${tag} -->`,
      `{%# ${tag} %}`,
    ]) {
      expect(refusal(S, c, "<script src"), c).toBe("IN_NON_CODE_REGION");
    }
  });

  it("allows the tag again after the comment closes", () => {
    const tag = `<script src="https://cdn.app.io/a.js"></script>`;
    const c = `{% comment %}x{% endcomment %}\n${tag}`;
    expect(spanText(S, c, "<script src")).toBe(tag);
  });

  it("works on a 100 KB minified single line", () => {
    const pad = "x".repeat(50_000);
    const tag = `<script src="https://cdn.app.io/a.js"></script>`;
    const c = `<p>${pad}</p>${tag}<p>${pad}</p>`;
    expect(spanText(S, c, "<script")).toBe(tag);
  });

  it("keeps UTF-16 offsets right after non-ASCII text, CRLF and a BOM", () => {
    const tag = `<script src="https://cdn.app.io/a.js"></script>`;
    const c = `\uFEFF<p>İstanbul 😀 café</p>\r\n${tag}\r\n`;
    expect(spanText(S, c, "<script")).toBe(tag);
  });

  it("never matches a full-width lookalike or a longer tag name", () => {
    expect(refusal(S, `＜script src="https://x"></script>`, "＜script")).toBe("NOT_AT_ELEMENT");
    expect(refusal(S, `<scripts src="https://x"></script>`, "<scripts")).toBe("NOT_AT_ELEMENT");
  });
});

describe("red-team: lookalikes and unknown types", () => {
  it("refuses every non-fixable type, including security types", () => {
    const c = `<script src="https://cdn.app.io/a.js"></script>`;
    for (const t of ["MALICIOUS_SCRIPT", "GHOST_SECTION", "ORPHAN_ASSET", "", "ghost_script"]) {
      expect(removalSpanFor(t, c, 0)).toEqual({ ok: false, reason: "NOT_FIXABLE_TYPE" });
    }
  });

  it("refuses <script/src=...> and a Kelvin-sign <lin\u212A (detector-only matches)", () => {
    expect(refusal("GHOST_SCRIPT", `<script/src="https://x"></script>`, "<script")).toBe(
      "NOT_AT_ELEMENT",
    );
    expect(
      refusal("GHOST_PRECONNECT", `<lin\u212A rel="preconnect" href="https://x">`, "<lin"),
    ).toBe("NOT_AT_ELEMENT");
  });

  it("refuses a <script> nested in a <script type=text/template> body", () => {
    const c = `<script type="text/template"><script src="https://x/a.js"></script></script>`;
    expect(refusal("GHOST_SCRIPT", c, `<script src`)).toBe("IN_NON_CODE_REGION");
  });
});

describe("GHOST_STYLE / GHOST_PRECONNECT spans", () => {
  it("covers a <link> and a self-closing <link/>", () => {
    const a = `<link rel="stylesheet" href="https://cdn.app.io/a.css">`;
    const b = `<link href="https://cdn.app.io/b.css" rel="stylesheet" />`;
    const c = `<head>\n  ${a}\n  ${b}\n</head>`;
    expect(spanText("GHOST_STYLE", c, a)).toBe(a);
    expect(spanText("GHOST_STYLE", c, b)).toBe(b);
  });

  it("covers a multi-line preconnect", () => {
    const tag = `<link\n  rel="preconnect"\n  href="https://cdn.app.io"\n  crossorigin\n>`;
    expect(spanText("GHOST_PRECONNECT", `x\n${tag}\ny`, "<link")).toBe(tag);
  });

  it("refuses a link with a Liquid tag inside", () => {
    const c = `<link rel="preload" href="https://cdn.app.io/a.js" {% if x %}as="script"{% endif %}>`;
    expect(refusal("GHOST_PRECONNECT", c, "<link")).toBe("LIQUID_TAG_IN_ELEMENT");
  });

  it("refuses a link inside an HTML comment", () => {
    const c = `<!--\n<link rel="preconnect" href="https://cdn.app.io">\n-->`;
    expect(refusal("GHOST_PRECONNECT", c, "<link")).toBe("IN_NON_CODE_REGION");
  });
});

describe("GHOST_SNIPPET spans", () => {
  const S = "GHOST_SNIPPET" as const;

  it("covers {% render %}, {%- render -%}, include, arguments and with/as", () => {
    for (const tag of [
      `{% render 'app-widget' %}`,
      `{%- render "app-widget" -%}`,
      `{% include 'app-widget' %}`,
      `{% render 'app-widget' with product as p %}`,
      `{%\n  render 'app-widget',\n  product: product\n%}`,
    ]) {
      expect(spanText(S, `<div>${tag}</div>`, "{%")).toBe(tag);
    }
  });

  it("ends a tag at the FIRST %} like Liquid does, so a %} inside quotes is refused (gc-tib audit M-b)", () => {
    // Liquid's tokenizer is not quote-aware: this tag really ends after 'a ,
    // leaving an unbalanced quote, so we must not remove it.
    expect(refusal(S, `{% render 'app-widget', label: 'a %} b' %}`, "{%")).toBe(
      "UNTERMINATED_LIQUID_TAG",
    );
    // The audit repro: a quoted %} would otherwise swallow <h1>KEEP</h1>.
    expect(
      refusal(S, `<div>\n{% render 'judgeme_widgets', label: '%}<h1>KEEP</h1>{%' %}\n</div>`, "{%"),
    ).toBe("UNTERMINATED_LIQUID_TAG");
  });

  it("refuses an unterminated render tag or one with a nested tag", () => {
    expect(refusal(S, `{% render 'app-widget' `, "{%")).toBe("UNTERMINATED_LIQUID_TAG");
    expect(refusal(S, `{% render 'app-widget', x: {{ y }} %}`, "{%")).toBe(
      "UNTERMINATED_LIQUID_TAG",
    );
  });

  it("covers a bare render line inside {% liquid %} (newline excluded)", () => {
    const c = `{% liquid\n  assign x = 1\n  render 'app-widget', product: product\n  echo x\n%}`;
    const at = c.indexOf("  render");
    const r = removalSpanFor(S, c, at);
    expect(r.ok && c.slice(r.span.start, r.span.end)).toBe(
      `  render 'app-widget', product: product`,
    );
  });

  it("handles CRLF for the bare form", () => {
    const c = `{%- liquid\r\n  render 'app-widget'\r\n-%}`;
    const r = removalSpanFor(S, c, c.indexOf("  render"));
    expect(r.ok && c.slice(r.span.start, r.span.end)).toBe(`  render 'app-widget'`);
  });

  it("refuses a bare line that is not inside a {% liquid %} block", () => {
    const c = `{% liquid\n  echo 1\n%}\nrender 'app-widget'\n`;
    expect(refusal(S, c, "render 'app")).toBe("NOT_IN_LIQUID_BLOCK");
    expect(refusal(S, `<p>\nrender 'app-widget'\n</p>`, "render")).toBe("NOT_IN_LIQUID_BLOCK");
  });

  it("refuses a bare line that also closes the block", () => {
    const c = `{% liquid\n  render 'app-widget' %}`;
    expect(refusal(S, c, "  render")).toBe("LIQUID_STATEMENT_SHARES_LINE");
  });

  it("refuses a bare render inside {% comment %} within liquid", () => {
    const c = `{% comment %}\n{% liquid\n  render 'app-widget'\n%}\n{% endcomment %}`;
    expect(refusal(S, c, "  render")).toBe("IN_NON_CODE_REGION");
  });

  it("refuses a render tag inside {% raw %}", () => {
    expect(refusal(S, `{% raw %}{% render 'app-widget' %}{% endraw %}`, "{% render")).toBe(
      "IN_NON_CODE_REGION",
    );
  });
});

describe("nonCodeRanges", () => {
  it("returns sorted, non-overlapping ranges and runs unterminated regions to EOF", () => {
    const c = `a<!-- X -->B{% comment %}C{% endcomment %}D<script>E</script>F<!-- G`;
    const r = nonCodeRanges(c);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThanOrEqual(r[i - 1][1]);
    expect(inRanges(r, c.indexOf("X"))).toBe(true);
    expect(inRanges(r, c.indexOf("B"))).toBe(false);
    expect(inRanges(r, c.indexOf("C{"))).toBe(true);
    expect(inRanges(r, c.indexOf("D"))).toBe(false);
    expect(inRanges(r, c.indexOf("E<"))).toBe(true);
    expect(inRanges(r, c.indexOf("F"))).toBe(false);
    expect(inRanges(r, c.length - 1)).toBe(true);
  });

  it("is fast on pathological input (many unterminated openers)", () => {
    const c = "<!--".repeat(20_000) + "<script".repeat(20_000) + "{% comment %}".repeat(5_000);
    const t0 = Date.now();
    nonCodeRanges(c);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
