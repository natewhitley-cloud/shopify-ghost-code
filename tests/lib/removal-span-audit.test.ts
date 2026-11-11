/**
 * gc-tib batch audit regressions for removal spans (security audit A1-A11,
 * sec 2, 4, 5, 6). Each case runs the real path the worker uses: detector
 * spans from scanThemeFiles, re-derived with removalSpanFor, then spliced.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  bareLiquidStatementSpan,
  linkElementSpan,
  liquidBlockRanges,
  MAX_SPAN_CHARS,
  nonCodeRanges,
  removalSpanFor,
  scriptElementSpan,
} from "../../app/lib/removal-span";
import { spliceSpans } from "../../app/lib/theme-splice";
import { scanThemeFiles } from "../../app/services/scan-engine.server";

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const FIX = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];
const KL = "https://static.klaviyo.com/onsite/js/klaviyo.js";
const TAG = `<script src="${KL}"></script>`;

/** Mirror writeCleanCopy: detector spans -> re-derive span -> splice. */
function clean(content: string, filename = "layout/theme.liquid") {
  const { findings } = scanThemeFiles([{ filename, content }]);
  const fx = findings.filter((f) => FIX.includes(f.findingType) && f.spanStart !== undefined);
  const ranges = nonCodeRanges(content);
  const located = fx.filter((f) => {
    if (sha(content.slice(f.spanStart!, f.spanEnd!)) !== f.spanSha256) return false;
    const r = removalSpanFor(f.findingType, content, f.spanStart!, ranges);
    return r.ok && r.span.start === f.spanStart && r.span.end === f.spanEnd;
  });
  const out = spliceSpans(
    content,
    located.map((f) => ({ start: f.spanStart!, end: f.spanEnd! })),
  );
  return { removed: out.removed.map((s) => content.slice(s.start, s.end)), content: out.content };
}

describe("span boundaries (audit A1-A11)", () => {
  it("A1: an unbalanced quote never swallows the markup after a <link>", () => {
    const c = `<head>\n<link rel="stylesheet" href="https://static.klaviyo.com/a.css" data-x='>\n<p>Don't miss our sale > 50% off</p>\n</head>`;
    const r = clean(c);
    expect(r.removed).toEqual([]);
    expect(r.content).toBe(c);
  });

  it("sec 4: a quoted value holding < or a line break is refused", () => {
    expect(linkElementSpan(`<link href="a<b" rel="stylesheet">`, 0)).toEqual({
      ok: false,
      reason: "MALFORMED_TAG",
    });
    expect(linkElementSpan(`<link href="a\nb" rel="stylesheet">`, 0)).toEqual({
      ok: false,
      reason: "MALFORMED_TAG",
    });
    expect(scriptElementSpan(`<script src="${KL}" data-a='x\r'></script>`, 0).ok).toBe(false);
  });

  it(`sec 4: spans longer than ${MAX_SPAN_CHARS} chars are refused`, () => {
    const long = `<link rel="stylesheet" href="https://static.klaviyo.com/a.css" data-x="${"x".repeat(MAX_SPAN_CHARS)}">`;
    expect(linkElementSpan(long, 0)).toEqual({ ok: false, reason: "SPAN_TOO_LONG" });
    const longRender = `{% render 'app-widget', a: '${"x".repeat(MAX_SPAN_CHARS)}' %}`;
    expect(removalSpanFor("GHOST_SNIPPET", longRender, 0).ok).toBe(false);
    const gap = `<script src="${KL}">${" ".repeat(MAX_SPAN_CHARS)}</script>`;
    expect(scriptElementSpan(gap, 0)).toEqual({ ok: false, reason: "SPAN_TOO_LONG" });
  });

  it("A2: a %} inside a quoted render argument never removes the markup after it", () => {
    const c = `<div>\n{% render 'judgeme_widgets', label: '%}<h1>KEEP</h1>{%' %}\n</div>`;
    const r = clean(c);
    expect(r.removed).toEqual([]);
    expect(r.content).toContain("<h1>KEEP</h1>");
  });

  it("A3: a bare render after a {% liquid %} block whose comment has an apostrophe is refused", () => {
    const c = `{% liquid\n  # don't show this on mobile\n%}\nrender 'judgeme_widgets'\n<p>it's 100%}</p>\n`;
    const r = clean(c);
    expect(r.removed).toEqual([]);
    expect(r.content).toBe(c);
  });

  it("A3b: an apostrophe in a # comment inside a real block refuses (fails safe)", () => {
    const c = `{% liquid\n  # don't show\n  render 'judgeme_widgets'\n  assign x = 1\n%}\n`;
    expect(clean(c).removed).toEqual([]);
  });

  it("M-b: block ends at the first %}, even inside quotes; a bare line holding %} is refused", () => {
    const c = `{% liquid\n  assign a = 'x %}'\n  render 'app-widget'\n%}`;
    // The block really ended on line 2, so line 3 is plain text.
    expect(bareLiquidStatementSpan(c, c.indexOf("  render"))).toEqual({
      ok: false,
      reason: "NOT_IN_LIQUID_BLOCK",
    });
    const c2 = `{% liquid\n  render 'app-widget', a: '%}'\n%}`;
    expect(bareLiquidStatementSpan(c2, c2.indexOf("  render"))).toEqual({
      ok: false,
      reason: "LIQUID_STATEMENT_SHARES_LINE",
    });
  });

  it("A4: UTF-16 offsets stay exact after BOM, surrogate pairs, dotted I and CRLF", () => {
    const c = `\uFEFF\u0130\u0130\u{1F600}\r\n<div>\u0130</div>\r\n${TAG}\r\n<p>KEEP</p>\r\n`;
    const r = clean(c);
    expect(r.removed).toEqual([TAG]);
    expect(r.content).toBe(`\uFEFF\u0130\u0130\u{1F600}\r\n<div>\u0130</div>\r\n<p>KEEP</p>\r\n`);
  });

  it("A5: Kelvin sign, long s and full-width lookalikes never get a span", () => {
    expect(
      clean(`<lin\u212A rel="stylesheet" href="https://static.klaviyo.com/a.css">\n`).removed,
    ).toEqual([]);
    expect(
      clean(`\uFF1Cscript src="${KL}"></script>\n<\u017Fcript src="${KL}"></script>\n`).removed,
    ).toEqual([]);
  });

  it("A6: duplicate identical tags on one minified line are each removed by offset", () => {
    expect(clean(`<head>${TAG}<meta a>${TAG}<b>KEEP</b></head>`).content).toBe(
      `<head><meta a><b>KEEP</b></head>`,
    );
  });

  it("A7 / sec 5: tags inside textarea, title, template, xmp, noscript bodies are not code", () => {
    for (const el of ["textarea", "title", "template", "xmp", "noscript"]) {
      const c = `<${el}>${TAG}</${el}>\n`;
      expect(removalSpanFor("GHOST_SCRIPT", c, c.indexOf("<script"))).toEqual({
        ok: false,
        reason: "IN_NON_CODE_REGION",
      });
    }
    // The element's own tag is not a body: <titles> is not <title>.
    expect(nonCodeRanges(`<titles>${TAG}`)).toEqual([]);
  });

  it("A8: comment, raw, doc, inline-comment and script-string copies are never removed", () => {
    const c = `<!-- ${TAG} -->\n{% raw %}${TAG}{% endraw %}\n{% doc %}${TAG}{% enddoc %}\n{%- comment -%}${TAG}{%- endcomment -%}\n{%# ${TAG} %}\n<script>document.write('${TAG.replace("</", "<\\/")}')</script>`;
    expect(clean(c).removed).toEqual([]);
  });

  it("A9: adjacent spans and line collapse never eat a neighbor line", () => {
    expect(clean(`A\n${TAG}${TAG}\nB\n  ${TAG}  \nC${TAG}\n${TAG}`).content).toBe("A\nB\nC");
  });

  it("A9b: a span at the start of the file drops its emptied line (sec 10)", () => {
    expect(clean(`${TAG}\nB`).content).toBe("B");
  });

  it("A10: {{ }} with > and quotes inside a tag keeps the right end", () => {
    const c = `<link rel="stylesheet" href="https://static.klaviyo.com/a.css" media="{{ a > b }}" title={{ "x>y" }}>\n<p>KEEP</p>`;
    const r = clean(c);
    for (const text of r.removed) expect(text.endsWith(">")).toBe(true);
    expect(r.content).toContain("<p>KEEP</p>");
  });

  it("A11: bare renders in nested ifs and CR-only line endings never remove more than one line", () => {
    const c = `{% liquid\n  if x\n    render 'judgeme_widgets'\n  endif\n%}\n{% liquid render 'judgeme_widgets' %}\n{% liquid\r  render 'judgeme_widgets'\r%}`;
    const r = clean(c);
    for (const text of r.removed) expect(text).not.toContain("\n");
    expect(r.content).toContain("endif");
  });
});

describe("cost: span location stays linear (audit sec 6, T1-T3)", () => {
  const MAX = 256 * 1024;
  const fill = (unit: string) => unit.repeat(Math.floor(MAX / unit.length));
  const time = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("T3: a 256 KB file of {% liquid %} blocks with bare renders scans in under 1s", () => {
    const c = fill(`{% liquid\nrender 'judgeme_widgets'\n%}\n`);
    expect(
      time(() => scanThemeFiles([{ filename: "layout/theme.liquid", content: c }])),
    ).toBeLessThan(1000);
  });

  it("T3 direct: locating every bare span with precomputed blocks is fast", () => {
    const c = fill(`{% liquid\nrender 'judgeme_widgets'\n%}\n`);
    const ranges = nonCodeRanges(c);
    const blocks = liquidBlockRanges(c);
    const ms = time(() => {
      for (let i = c.indexOf("render"); i !== -1; i = c.indexOf("render", i + 1)) {
        removalSpanFor("GHOST_SNIPPET", c, i, ranges, blocks);
      }
    });
    expect(ms).toBeLessThan(1000);
  });

  it("T1/T2: thousands of malformed attributed tags scan in under 1s", () => {
    for (const unit of [
      `<script src="https://static.klaviyo.com/a.js" {{>\n`,
      `<link rel="stylesheet" href="https://static.klaviyo.com/a.css" x=">\n`,
    ]) {
      const c = fill(unit);
      expect(
        time(() => scanThemeFiles([{ filename: "layout/theme.liquid", content: c }])),
      ).toBeLessThan(1000);
    }
  });

  it("findings past the per-file cap get no span work, and the scan output is unchanged", () => {
    const c = Array.from({ length: 250 }, () => TAG).join("\n");
    const { findings } = scanThemeFiles([{ filename: "layout/theme.liquid", content: c }]);
    const scripts = findings.filter((f) => f.findingType === "GHOST_SCRIPT");
    expect(scripts).toHaveLength(200);
    expect(scripts.every((f) => typeof f.spanStart === "number")).toBe(true);
    expect(scripts[0].spanSha256).toBe(sha(TAG));
  });
});
