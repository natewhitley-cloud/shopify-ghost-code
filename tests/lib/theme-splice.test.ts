import { describe, expect, it } from "vitest";

import { removalSpanFor, type FixableFindingType } from "../../app/lib/removal-span";
import { spliceSpans } from "../../app/lib/theme-splice";
import {
  detectGhostPreconnect,
  detectGhostScripts,
  detectGhostSnippets,
  detectGhostStyles,
} from "../../app/services/scan-engine.server";

const KLAVIYO_SCRIPT = `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>`;
const JUDGEME_RENDER = `{% render 'judgeme_widgets' %}`;

function spanOf(type: FixableFindingType, content: string, at: number) {
  const r = removalSpanFor(type, content, at);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.span;
}

function nthIndex(content: string, needle: string, n: number): number {
  let at = -1;
  for (let i = 0; i <= n; i++) at = content.indexOf(needle, at + 1);
  return at;
}

describe("spliceSpans", () => {
  it("removes a tag on its own line and drops the emptied line", () => {
    const c = `<head>\n  ${KLAVIYO_SCRIPT}\n  <title>x</title>\n</head>\n`;
    const r = spliceSpans(c, [spanOf("GHOST_SCRIPT", c, c.indexOf("<script"))]);
    expect(r.content).toBe(`<head>\n  <title>x</title>\n</head>\n`);
    expect(r.refused).toEqual([]);
  });

  it("keeps the line when other content shares it", () => {
    const c = `<div>${KLAVIYO_SCRIPT}</div>\n`;
    const r = spliceSpans(c, [spanOf("GHOST_SCRIPT", c, c.indexOf("<script"))]);
    expect(r.content).toBe(`<div></div>\n`);
  });

  it("removes one of two identical tags by offset; the other stays", () => {
    const c = `a\n${KLAVIYO_SCRIPT}\nb\n${KLAVIYO_SCRIPT}\nc`;
    const second = nthIndex(c, "<script", 1);
    const r = spliceSpans(c, [spanOf("GHOST_SCRIPT", c, second)]);
    expect(r.content).toBe(`a\n${KLAVIYO_SCRIPT}\nb\nc`);
  });

  it("removes two spans on one line and drops the line", () => {
    const c = `x\n${KLAVIYO_SCRIPT} ${JUDGEME_RENDER}\ny`;
    const r = spliceSpans(c, [
      spanOf("GHOST_SCRIPT", c, c.indexOf("<script")),
      spanOf("GHOST_SNIPPET", c, c.indexOf("{%")),
    ]);
    expect(r.content).toBe(`x\ny`);
    expect(r.removed).toHaveLength(2);
  });

  it("handles CRLF line endings and the last line without a terminator", () => {
    const c = `a\r\n  ${JUDGEME_RENDER}\r\nb\r\n${JUDGEME_RENDER}`;
    const r = spliceSpans(c, [
      spanOf("GHOST_SNIPPET", c, c.indexOf("{%")),
      spanOf("GHOST_SNIPPET", c, nthIndex(c, "{%", 1)),
    ]);
    expect(r.content).toBe(`a\r\nb`);
  });

  it("empties a file whose only content was the tag", () => {
    expect(spliceSpans(JUDGEME_RENDER, [{ start: 0, end: JUDGEME_RENDER.length }]).content).toBe(
      "",
    );
  });

  it("removes a multi-line element and its now-blank line", () => {
    const tag = `<link\n  rel="preconnect"\n  href="https://static.klaviyo.com"\n>`;
    const c = `<head>\n  ${tag}\n</head>`;
    const r = spliceSpans(c, [spanOf("GHOST_PRECONNECT", c, c.indexOf("<link"))]);
    expect(r.content).toBe(`<head>\n</head>`);
  });

  it("removes a bare render line inside {% liquid %} and keeps the block valid", () => {
    const c = `{% liquid\n  assign x = 1\n  render 'judgeme_widgets'\n  echo x\n%}`;
    const r = spliceSpans(c, [spanOf("GHOST_SNIPPET", c, c.indexOf("  render"))]);
    expect(r.content).toBe(`{% liquid\n  assign x = 1\n  echo x\n%}`);
  });

  it("leaves an empty {% if %} branch (allowed)", () => {
    const c = `{% if a %}\n  ${JUDGEME_RENDER}\n{% endif %}`;
    const r = spliceSpans(c, [spanOf("GHOST_SNIPPET", c, c.indexOf("{% render"))]);
    expect(r.content).toBe(`{% if a %}\n{% endif %}`);
  });

  it("documents whitespace-control: removing {%- -%} un-strips neighbor whitespace", () => {
    const c = `<p>a</p>  {%- render 'judgeme_widgets' -%}  <p>b</p>`;
    const r = spliceSpans(c, [spanOf("GHOST_SNIPPET", c, c.indexOf("{%"))]);
    // The tag used to trim both runs of spaces; now they render (insignificant in HTML).
    expect(r.content).toBe(`<p>a</p>    <p>b</p>`);
  });

  it("refuses overlapping and duplicate spans (all of them)", () => {
    const c = `0123456789`;
    const r = spliceSpans(c, [
      { start: 1, end: 4 },
      { start: 3, end: 6 },
      { start: 8, end: 9 },
      { start: 8, end: 9 },
    ]);
    expect(r.content).toBe(c);
    expect(r.refused.map((x) => x.reason)).toEqual([
      "OVERLAPPING_SPANS",
      "OVERLAPPING_SPANS",
      "OVERLAPPING_SPANS",
      "OVERLAPPING_SPANS",
    ]);
  });

  it("refuses a span contained inside a longer span", () => {
    const r = spliceSpans("0123456789", [
      { start: 1, end: 8 },
      { start: 3, end: 4 },
    ]);
    expect(r.removed).toEqual([]);
    expect(r.refused).toHaveLength(2);
  });

  it("refuses out-of-bounds, empty, inverted and non-integer spans", () => {
    const r = spliceSpans("abc", [
      { start: -1, end: 1 },
      { start: 1, end: 9 },
      { start: 2, end: 2 },
      { start: 2, end: 1 },
      { start: 0.5, end: 2 },
    ]);
    expect(r.content).toBe("abc");
    expect(r.refused.every((x) => x.reason === "OUT_OF_BOUNDS")).toBe(true);
    expect(r.refused).toHaveLength(5);
  });

  it("refuses a span inside comment / doc / raw / inline comment regions", () => {
    for (const c of [
      `{% comment %}\n${JUDGEME_RENDER}\n{% endcomment %}`,
      `{% doc %}${JUDGEME_RENDER}{% enddoc %}`,
      `{% raw %}${JUDGEME_RENDER}{% endraw %}`,
      `<!-- ${KLAVIYO_SCRIPT} -->`,
    ]) {
      const at = c.indexOf(c.includes("{% render") ? "{% render" : "<script");
      const end = c.indexOf(c.includes("{% render") ? "%}" : "</script>", at) + 2;
      const r = spliceSpans(c, [{ start: at, end }]);
      expect(r.content, c).toBe(c);
      expect(r.refused[0].reason).toBe("IN_NON_CODE_REGION");
    }
  });

  it("refuses a span with unbalanced Liquid delimiters", () => {
    const c = `{% if a %}x{% endif %}`;
    const r = spliceSpans(c, [{ start: 0, end: 5 }]);
    expect(r.refused[0].reason).toBe("UNBALANCED_LIQUID");
    expect(r.content).toBe(c);
  });

  it("applies the good spans when others are refused", () => {
    const c = `x\n${JUDGEME_RENDER}\n{% if a %}y{% endif %}`;
    const r = spliceSpans(c, [
      spanOf("GHOST_SNIPPET", c, c.indexOf("{% render")),
      { start: c.indexOf("{% if"), end: c.indexOf("{% if") + 4 },
    ]);
    expect(r.content).toBe(`x\n{% if a %}y{% endif %}`);
    expect(r.refused).toHaveLength(1);
  });

  it("is a no-op with no spans", () => {
    const c = `anything\r\n  \n`;
    expect(spliceSpans(c, []).content).toBe(c);
  });

  it("property: bytes outside the removed spans never change (random spans)", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = "ab<>{}%'\" \t\n\r";
    for (let iter = 0; iter < 300; iter++) {
      const len = 5 + rand(60);
      let c = "";
      for (let i = 0; i < len; i++) c += alphabet[rand(alphabet.length)];
      const start = rand(len - 1);
      const end = start + 1 + rand(len - start);
      const r = spliceSpans(c, [{ start, end }]);
      if (r.removed.length === 0) {
        expect(r.content).toBe(c);
        continue;
      }
      // Output = prefix (maybe minus a blank-line head) + suffix (maybe minus
      // its line end). Every kept char must appear in order from the original.
      const before = c.slice(0, start);
      const after = c.slice(end);
      const out = r.content;
      expect(out.length).toBeLessThanOrEqual(before.length + after.length);
      // Prefix up to the start of the cut line is untouched.
      const lineStart = before.lastIndexOf("\n") + 1;
      const safePrefix = before.slice(0, Math.max(0, lineStart - 2));
      expect(out.startsWith(safePrefix)).toBe(true);
      // Suffix after the cut line's end is untouched.
      const nl = after.indexOf("\n");
      const safeSuffix = nl === -1 ? "" : after.slice(nl + 1);
      expect(out.endsWith(safeSuffix)).toBe(true);
    }
  });
});

describe("spliceSpans + real detectors (end to end)", () => {
  const theme = [
    "<!doctype html>",
    "<html>",
    "<head>",
    `  <link rel="preconnect" href="https://static.klaviyo.com">`,
    `  <link rel="stylesheet" href="https://static.klaviyo.com/onsite/css/a.css">`,
    `  ${KLAVIYO_SCRIPT}`,
    "  {{ content_for_header }}",
    "</head>",
    "<body>",
    `  ${JUDGEME_RENDER}`,
    "  {% liquid",
    "    assign x = 1",
    "    render 'judgeme_widgets'",
    "  %}",
    "  {{ content_for_layout }}",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const file = { filename: "layout/theme.liquid", content: theme };

  const detectAll = (f: { filename: string; content: string }) => [
    ...detectGhostScripts(f),
    ...detectGhostStyles(f),
    ...detectGhostPreconnect(f),
    ...detectGhostSnippets(f),
  ];

  it("removes every flagged element and the re-scan finds nothing new", () => {
    expect(detectAll(file).length).toBeGreaterThanOrEqual(5);
    const spans = [
      spanOf("GHOST_PRECONNECT", theme, theme.indexOf(`<link rel="preconnect"`)),
      spanOf("GHOST_STYLE", theme, theme.indexOf(`<link rel="stylesheet"`)),
      spanOf("GHOST_SCRIPT", theme, theme.indexOf("<script")),
      spanOf("GHOST_SNIPPET", theme, theme.indexOf("{% render")),
      spanOf("GHOST_SNIPPET", theme, theme.indexOf("    render")),
    ];
    const r = spliceSpans(theme, spans);
    expect(r.refused).toEqual([]);
    expect(detectAll({ ...file, content: r.content })).toEqual([]);
    expect(r.content).toBe(
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        "  {{ content_for_header }}",
        "</head>",
        "<body>",
        "  {% liquid",
        "    assign x = 1",
        "  %}",
        "  {{ content_for_layout }}",
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent: a second pass finds no spans and changes nothing", () => {
    const once = spliceSpans(theme, [spanOf("GHOST_SCRIPT", theme, theme.indexOf("<script"))]);
    expect(detectGhostScripts({ ...file, content: once.content })).toEqual([]);
    expect(spliceSpans(once.content, []).content).toBe(once.content);
  });
});
