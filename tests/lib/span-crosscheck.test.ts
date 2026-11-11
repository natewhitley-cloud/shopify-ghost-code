/**
 * gc-t44r 3A: every span is confirmed by parse5 on the Liquid-masked copy
 * before the UI offers it or the fix removes it.
 */
import { describe, expect, it } from "vitest";

import { removalSpanFor, type RemovalSpan } from "../../app/lib/removal-span";
import { createSpanCrossCheck } from "../../app/lib/span-crosscheck.server";

const SCRIPT = '<script src="https://cdn.app.io/a.js" defer></script>';
const LINK = '<link rel="stylesheet" href="{{ \'a.css\' | asset_url }}">';

/** Locate with removalSpanFor, then cross-check. */
function check(content: string, needle: string, type: string) {
  const at = content.indexOf(needle);
  const r = removalSpanFor(type, content, at);
  if (!r.ok) throw new Error(`removalSpanFor refused: ${r.reason}`);
  return createSpanCrossCheck(content)(type, r.span);
}

const span = (start: number, end: number): RemovalSpan => ({ start, end });

describe("parse5 confirms ordinary spans", () => {
  it.each([
    [
      "script in head",
      `<!doctype html><html><head>${SCRIPT}</head><body></body></html>`,
      "<script",
      "GHOST_SCRIPT",
    ],
    ["link in head", `<html><head>\n  ${LINK}\n</head></html>`, "<link", "GHOST_STYLE"],
    [
      "script in body after Liquid",
      `<body>{% if x %}<p>{{ y }}</p>{% endif %}\n${SCRIPT}</body>`,
      "<script",
      "GHOST_SCRIPT",
    ],
    ["fragment without html/body", `<div>a</div>\n${SCRIPT}\n${LINK}`, "<link", "GHOST_STYLE"],
    [
      "script inside a table (foster parenting)",
      `<table><tr><td>a</td></tr>${SCRIPT}</table>`,
      "<script",
      "GHOST_SCRIPT",
    ],
    ["CRLF line endings", `<head>\r\n${SCRIPT}\r\n${LINK}\r\n</head>`, "<link", "GHOST_STYLE"],
    [
      "BOM and non-ASCII before",
      `\uFEFF<p>İstanbul 😀</p>\r\n${SCRIPT}`,
      "<script",
      "GHOST_SCRIPT",
    ],
    ["multi-line script tag", `<script\n  src="//a.js"\n>\n</script >`, "<script", "GHOST_SCRIPT"],
    ["render tag in body", `<div>{% render 'app' %}</div>`, "{% render", "GHOST_SNIPPET"],
    ["render tag at top level", `{% render 'app' %}\n<p>x</p>`, "{% render", "GHOST_SNIPPET"],
    [
      "bare render line",
      `{% liquid\n  if x\n    render 'app'\n  endif\n%}`,
      "    render",
      "GHOST_SNIPPET",
    ],
  ])("%s", (_label, content, needle, type) => {
    expect(check(content, needle, type)).toMatchObject({ ok: true });
  });
});

describe("parse5 refuses what it does not see the same way", () => {
  const refused = { ok: false, reason: "PARSER_DISAGREES" };

  it("a span whose start is not an element start tag", () => {
    const c = `<p>${SCRIPT}</p>`;
    const at = c.indexOf("<script");
    expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at + 1, at + SCRIPT.length))).toEqual(
      refused,
    );
  });

  it("a span whose end is not the element end", () => {
    const c = `<p>${SCRIPT}</p>`;
    const at = c.indexOf("<script");
    expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at, at + SCRIPT.length - 1))).toEqual(
      refused,
    );
    const l = `<p>${LINK}x</p>`;
    const la = l.indexOf("<link");
    expect(createSpanCrossCheck(l)("GHOST_STYLE", span(la, la + LINK.length + 1))).toEqual(refused);
  });

  it("the wrong element name for the type", () => {
    const c = `<p>${SCRIPT}</p>`;
    const at = c.indexOf("<script");
    expect(createSpanCrossCheck(c)("GHOST_STYLE", span(at, at + SCRIPT.length))).toEqual(refused);
  });

  it("foreign (svg/math) and template-content elements", () => {
    for (const wrap of ["<svg>%</svg>", "<math>%</math>", "<template>%</template>"]) {
      const c = wrap.replace("%", SCRIPT);
      const at = c.indexOf("<script");
      expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at, at + SCRIPT.length)), c).toEqual(
        refused,
      );
    }
  });

  it("a script tag that is text (inside a textarea or a comment)", () => {
    for (const c of [
      `<textarea>${SCRIPT}</textarea>`,
      `<!-- ${SCRIPT} -->`,
      `<script>x='${SCRIPT}'</script>`,
    ]) {
      const at = c.indexOf("<script src");
      expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at, at + SCRIPT.length)), c).toEqual(
        refused,
      );
    }
  });

  it("a Liquid span inside a script/style/textarea/title body or a tag", () => {
    for (const c of [
      "<script>{% render 'a' %}</script>",
      "<style>{% render 'a' %}</style>",
      "<textarea>{% render 'a' %}</textarea>",
      "<title>{% render 'a' %}</title>",
      "<template>{% render 'a' %}</template>",
      "<svg>{% render 'a' %}</svg>",
      "<div {% render 'a' %}>x</div>",
      "<!-- {% render 'a' %} -->",
    ]) {
      const at = c.indexOf("{% render");
      const end = c.indexOf("%}", at) + 2;
      expect(createSpanCrossCheck(c)("GHOST_SNIPPET", span(at, end)), c).toEqual(refused);
    }
  });

  it("an unknown finding type", () => {
    expect(createSpanCrossCheck(SCRIPT)("GHOST_FOO", span(0, SCRIPT.length))).toEqual(refused);
  });
});

describe("red-team: parse5 location edge cases", () => {
  it("CR-only line endings and a BOM keep offsets exact", () => {
    for (const c of [`a\r\r${SCRIPT}\r`, `\uFEFF${SCRIPT}`, `\uFEFF\r\n\r\n${LINK}`]) {
      const needle = c.includes("<script") ? "<script" : "<link";
      const type = needle === "<script" ? "GHOST_SCRIPT" : "GHOST_STYLE";
      expect(check(c, needle, type), JSON.stringify(c)).toMatchObject({ ok: true });
    }
  });

  it("NUL and surrogate pairs before the tag", () => {
    expect(check(`\0x😀😀\n${SCRIPT}`, "<script", "GHOST_SCRIPT")).toMatchObject({ ok: true });
  });

  it("the same tag twice: each span matches its own element", () => {
    const c = `${SCRIPT}\n${SCRIPT}`;
    const second = c.lastIndexOf("<script");
    const cc = createSpanCrossCheck(c);
    expect(cc("GHOST_SCRIPT", span(0, SCRIPT.length))).toMatchObject({ ok: true });
    expect(cc("GHOST_SCRIPT", span(second, second + SCRIPT.length))).toMatchObject({ ok: true });
    expect(cc("GHOST_SCRIPT", span(0, second + SCRIPT.length))).toMatchObject({ ok: false });
  });

  it("a Liquid span that straddles two text nodes", () => {
    const c = "a{% render 'x' %}<b></b>";
    expect(createSpanCrossCheck(c)("GHOST_SNIPPET", span(1, 20))).toMatchObject({ ok: false });
  });

  it("a deeply nested document is refused fast (parse5 is quadratic in depth)", () => {
    const c = "<div>".repeat(50_000) + SCRIPT;
    const at = c.indexOf("<script");
    const t = performance.now();
    expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at, at + SCRIPT.length))).toEqual({
      ok: false,
      reason: "PARSER_DISAGREES",
    });
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("10,000 nested divs (the cap) still parse in under 2 s and confirm", () => {
    const c = "<div>".repeat(9_990) + SCRIPT;
    const at = c.indexOf("<script");
    const t = performance.now();
    expect(createSpanCrossCheck(c)("GHOST_SCRIPT", span(at, at + SCRIPT.length))).toMatchObject({
      ok: true,
    });
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
