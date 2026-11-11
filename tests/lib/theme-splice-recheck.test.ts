/**
 * gc-t44r M4b: after splicing, the output must have exactly the original
 * non-code structure (ranges inside removed spans dropped, the rest shifted).
 * Otherwise the whole file is refused.
 */
import { describe, expect, it } from "vitest";

import { spliceSpans } from "../../app/lib/theme-splice";

describe("splice structure re-check", () => {
  it("refuses the whole file when removal glues neighbours into a comment", () => {
    const c = "<p>a <<script src=a></script>!-- b</p><div>live</div><script>live()</script>";
    const at = c.indexOf("<script src");
    const r = spliceSpans(c, [{ start: at, end: at + "<script src=a></script>".length }]);
    expect(r.content).toBe(c);
    expect(r.removed).toEqual([]);
    expect(r.refused.map((x) => x.reason)).toEqual(["STRUCTURE_CHANGED"]);
  });

  it("refuses the whole file when removal glues neighbours into a script", () => {
    const tag = "<link rel=stylesheet href=a>";
    const c = `<p>a <${tag}script> b</p><div>live</div>`;
    const at = c.indexOf("<link");
    const keep = c.indexOf("live");
    const r = spliceSpans(c, [
      { start: at, end: at + tag.length },
      { start: keep - 5, end: keep - 5 + 3 },
    ]);
    expect(r.content).toBe(c);
    expect(r.removed).toEqual([]);
    expect(r.refused.every((x) => x.reason === "STRUCTURE_CHANGED")).toBe(true);
  });

  it("accepts ordinary removals, including dropped lines and merged neighbours", () => {
    const s = '<script src="//a.js"></script>';
    for (const c of [
      `<head>\n  ${s}\n  <!-- c -->\n  <title>x</title>\n</head>`,
      `<!-- a -->${s}<!-- b -->`,
      `<div>{{ x }}${s}{% if y %}<p>z</p>{% endif %}</div>\n${s}`,
      `${s}\n<script>if (a < b) {}</script>\n${s}`,
      `{% comment %}x{% endcomment %}\r\n${s}\r\n{% raw %}<b>{% endraw %}`,
    ]) {
      const spans = [];
      for (let i = c.indexOf(s); i !== -1; i = c.indexOf(s, i + 1)) {
        spans.push({ start: i, end: i + s.length });
      }
      const r = spliceSpans(c, spans);
      expect(r.refused, JSON.stringify(c)).toEqual([]);
      expect(r.removed.length).toBe(spans.length);
      expect(r.content).not.toContain("//a.js");
    }
  });

  it("refuses a cut that turns '<' + following text into a new start tag", () => {
    // Only a bare '<' leaves the element's start in code ('<!' / '</' make it
    // part of a bogus comment, refused earlier as IN_NON_CODE_REGION).
    const tag = "<link rel=stylesheet href=a>";
    const c = `a <${tag}div class=x> b <p>z</p>`;
    const at = c.indexOf("<link");
    const r = spliceSpans(c, [{ start: at, end: at + tag.length }]);
    expect(r.content).toBe(c);
    expect(r.refused.map((x) => x.reason)).toEqual(["STRUCTURE_CHANGED"]);
  });

  it("a span inside a Liquid tag line keeps the rest of the tag intact", () => {
    const c = "{% liquid\n  render 'a'\n  echo 'b'\n%}\n<p>x</p>";
    const at = c.indexOf("  render");
    const r = spliceSpans(c, [{ start: at, end: at + "  render 'a'".length }]);
    expect(r.refused).toEqual([]);
    expect(r.content).toBe("{% liquid\n  echo 'b'\n%}\n<p>x</p>");
  });
});
