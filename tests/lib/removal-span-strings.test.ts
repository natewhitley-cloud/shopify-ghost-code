/**
 * gc-tib.11: markup inside a Liquid string literal or an HTML attribute value
 * is text, not an element: it must never get a removal span.
 */
import { describe, expect, it } from "vitest";

import { inRanges, nonCodeRanges, removalSpanFor } from "../../app/lib/removal-span";

const SCRIPT = '<script src="https://cdn.ghost.app/a.js"></script>';

/** The span result for the first occurrence of `needle` as `type`. */
function spanAt(content: string, needle: string, type = "GHOST_SCRIPT") {
  const at = content.indexOf(needle);
  if (at === -1) throw new Error(`needle not found: ${needle}`);
  return removalSpanFor(type, content, at);
}

describe("Liquid string literals are not code", () => {
  it.each([
    ["assign, single quotes", `{% assign x = '${SCRIPT}' %}`],
    [
      "assign, double quotes",
      `{%- assign x = "<script src='https://cdn.ghost.app/a.js'></script>" -%}`,
    ],
    ["output", `{{ '${SCRIPT}' }}`],
    ["output with a filter", `{{- '${SCRIPT}' | append: x -}}`],
    ["capture-free echo in a liquid block", `{% liquid\n  echo '${SCRIPT}'\n%}`],
    ["a filter argument", `{{ x | default: '${SCRIPT}' }}`],
  ])("%s: refused", (_label, content) => {
    expect(spanAt(content, "<script")).toEqual({ ok: false, reason: "IN_NON_CODE_REGION" });
  });

  it("the real element after the tag is still found", () => {
    const content = `{% assign x = '<script>' %}\n${SCRIPT}\n`;
    const at = content.indexOf(SCRIPT);
    expect(removalSpanFor("GHOST_SCRIPT", content, at)).toEqual({
      ok: true,
      span: { start: at, end: at + SCRIPT.length },
    });
  });

  it("a render tag and a bare render line keep their spans (the name is a string)", () => {
    const tag = "{% render 'klaviyo-form' %}";
    expect(spanAt(`<div>${tag}</div>`, tag, "GHOST_SNIPPET")).toMatchObject({ ok: true });
    const block = "{% liquid\n  render 'klaviyo-form'\n  assign y = 1\n%}";
    const line = block.indexOf("  render");
    expect(removalSpanFor("GHOST_SNIPPET", block, line)).toMatchObject({ ok: true });
  });

  it("Liquid ends a tag at the first %} even inside quotes", () => {
    // The string never closes inside the tag; text after %} is code again.
    const content = `{% assign x = 'a %}\n${SCRIPT}`;
    expect(spanAt(content, "<script")).toMatchObject({ ok: true });
  });

  it("an unterminated Liquid tag makes the rest of the file non-code (conservative)", () => {
    const content = `{% assign x = 'a'\n${SCRIPT}`;
    expect(spanAt(content, "<script")).toEqual({ ok: false, reason: "IN_NON_CODE_REGION" });
  });
});

describe("HTML attribute values are not code", () => {
  it.each([
    ["double-quoted", `<div data-html="${SCRIPT.replace(/"/g, "'")}"></div>`],
    ["single-quoted", `<div data-html='${SCRIPT}'></div>`],
    ["after Liquid in the tag", `<div {{ attrs }} data-html='${SCRIPT}'></div>`],
    [
      "Liquid with a quote inside the value",
      `<a title="{{ t | append: '"' }}" data-x='${SCRIPT}'>`,
    ],
  ])("%s: refused", (_label, content) => {
    expect(spanAt(content, "<script")).toEqual({ ok: false, reason: "IN_NON_CODE_REGION" });
  });

  it("a quoted '>' inside an attribute doesn't end the tag", () => {
    const content = `<div title="a > b" data-html='${SCRIPT}'></div>`;
    expect(spanAt(content, "<script")).toEqual({ ok: false, reason: "IN_NON_CODE_REGION" });
  });

  it("the element after a tag with attributes is still found", () => {
    const content = `<div class="x" data-y='1'>\n${SCRIPT}\n</div>`;
    expect(spanAt(content, "<script")).toMatchObject({ ok: true });
  });

  it("a fix-target element's own attributes don't hide it", () => {
    expect(spanAt(SCRIPT, "<script")).toMatchObject({ ok: true });
    const link = '<link rel="preconnect" href="https://cdn.ghost.app">';
    expect(spanAt(link, "<link", "GHOST_PRECONNECT")).toMatchObject({ ok: true });
  });

  it("a <script> body still counts as non-code when its start tag has a quoted '>'", () => {
    const content = `<script data-x="a>b">document.write('${SCRIPT}')</script>`;
    const inner = content.indexOf(SCRIPT);
    expect(inRanges(nonCodeRanges(content), inner)).toBe(true);
  });
});

describe("ranges stay usable by the binary search", () => {
  it("sorted and non-overlapping on a mixed file", () => {
    const content = [
      "<!-- c -->",
      `{% assign a = '<b>' %}`,
      `<div data-x='<i>'>{{ 'y' }}</div>`,
      `<script>var s = '<a href="x">';</script>`,
      "{% comment %}<script>{% endcomment %}",
      SCRIPT,
    ].join("\n");
    const ranges = nonCodeRanges(content);
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeLessThan(ranges[i][1]);
      if (i > 0) expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][1]);
    }
    expect(spanAt(content, SCRIPT)).toMatchObject({ ok: true });
  });
});

describe("gc-tib.11 self red-team", () => {
  it("Liquid between attributes is not code; an unclosed one makes the rest non-code", () => {
    expect(spanAt(`<div {{ '${SCRIPT}' }}></div>`, "<script")).toEqual({
      ok: false,
      reason: "IN_NON_CODE_REGION",
    });
    expect(spanAt(`<div {{ x \n${SCRIPT}`, "<script")).toEqual({
      ok: false,
      reason: "IN_NON_CODE_REGION",
    });
  });

  it("an unclosed render tag keeps its own refusal", () => {
    expect(spanAt("{% render 'app' ", "{%", "GHOST_SNIPPET")).toEqual({
      ok: false,
      reason: "UNTERMINATED_LIQUID_TAG",
    });
  });

  it("`{% if a < b %}` doesn't open a fake tag that swallows the real element", () => {
    const content = `{% if a <b %}x{% endif %}\n${SCRIPT}`;
    expect(spanAt(content, SCRIPT)).toMatchObject({ ok: true });
  });

  it("upper-case and full-width look-alikes: only real ASCII tags count", () => {
    expect(spanAt(`<DIV DATA-X='${SCRIPT}'>`, "<script")).toEqual({
      ok: false,
      reason: "IN_NON_CODE_REGION",
    });
    // A full-width quote is not a quote: the element after it is code.
    expect(spanAt(`<div title=＂x＂>\n${SCRIPT}`, "<script")).toMatchObject({ ok: true });
  });

  it("huge adversarial inputs stay linear (well under a second)", () => {
    const inputs = [
      "<a x='".repeat(200_000),
      "{{".repeat(300_000),
      "{{}}<a b='c'>".repeat(100_000),
      "<script>".repeat(100_000),
    ];
    for (const content of inputs) {
      const t = performance.now();
      nonCodeRanges(content);
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});

describe("gc-tib.11 audit r1: no span for text", () => {
  const INNER = "<script src=//e.js></script>";
  const refused = (content: string, needle = INNER) =>
    expect(spanAt(content, needle)).toEqual({ ok: false, reason: "IN_NON_CODE_REGION" });

  it("HIGH: a stray quote in a body element's start tag doesn't move the body", () => {
    refused(`<script data=it's>a="x";w('${INNER}')</script>`);
    refused(`<SCRIPT data=it's>a="x";w('${INNER}')</SCRIPT>`);
    refused(`<style data=it's>/*'*/ ${INNER}</style>`);
    refused(`<textarea x=it's>"' ${INNER}</textarea>`);
    refused(`<noscript a=b'c>' ${INNER}</noscript>`);
  });

  it("MEDIUM: a quote that doesn't follow '=' doesn't open a value", () => {
    refused(`<p title=it's>hi</p><div data-x='${INNER}'>`);
    refused(`<p it's>hi</p><div data-x='${INNER}'>`);
  });

  it("MEDIUM: a Liquid block opened inside a start tag still protects its body", () => {
    refused(`<div {% comment %}>${INNER}{% endcomment %}`);
    refused(`<div title="{% raw %}">${INNER}{% endraw %}`);
    refused(`<div {% javascript %}>${INNER}{% endjavascript %}`);
    refused(`<script {% comment %}>{% endcomment %}>w('${INNER}')</script>`);
  });

  it("MEDIUM: '#' and comment lines in {% liquid %} don't flip string pairing", () => {
    refused(`{% liquid\n  # it's\n  assign a = 'b'\n  echo '${INNER}'\n%}`);
    refused(`{% liquid\n  comment\n  it's\n  endcomment\n  assign a = 'b'\n  echo '${INNER}'\n%}`);
  });

  it("LOW: tag names with ':' '_' or non-ASCII letters are walked", () => {
    refused(`<x:y data='${INNER}'>`);
    refused(`<my_el data='${INNER}'>`);
    refused(`<dív data='${INNER}'>`);
  });

  it("LOW: an unquoted attribute value is not code", () => {
    refused(`<div data-x=${INNER}>`, INNER);
    refused(`<div data-x = ${INNER}>`, INNER);
  });

  it("LOW: a bare render line inside a comment in {% liquid %} gets no span", () => {
    const c = "{% liquid\n  comment\n  render 'app-widget'\n  endcomment\n%}";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("  render"))).toEqual({
      ok: false,
      reason: "IN_NON_CODE_REGION",
    });
    const hash = "{% liquid\n  # render 'app-widget'\n  render 'real'\n%}";
    expect(removalSpanFor("GHOST_SNIPPET", hash, hash.indexOf("  render 'real'"))).toMatchObject({
      ok: true,
    });
  });

  it("LOW: no empty range for a trailing '{{'", () => {
    for (const r of nonCodeRanges("abc{{")) expect(r[0]).toBeLessThan(r[1]);
  });

  it("still finds real elements: '=' quoted values, Liquid values, '>' in values", () => {
    for (const c of [
      `<div class="a" data-y='b' x={{ v }}>\n${SCRIPT}`,
      `<div title = "a > b">\n${SCRIPT}`,
      `<img alt=it's>\n${SCRIPT}`,
      `<div {% if x %}hidden{% endif %}>\n${SCRIPT}`,
    ]) {
      expect(spanAt(c, SCRIPT)).toMatchObject({ ok: true });
    }
  });
});
