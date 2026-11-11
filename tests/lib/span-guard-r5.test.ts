/**
 * gc-t44r audit r5: {% liquid %} line rules (X3), loops in text bodies (X4),
 * splice re-check cost (X8), assign/capture literals (X9), and red-team
 * attacks on those fixes.
 */
import { describe, expect, it } from "vitest";

import { nonCodeRanges, removalSpanFor } from "../../app/lib/removal-span";
import { spliceSpans } from "../../app/lib/theme-splice";

const LINK = "<link rel=stylesheet href=a>";

/** removalSpanFor for the first `needle` (default: the link). */
function at(content: string, needle = LINK, type = "GHOST_STYLE") {
  const i = content.indexOf(needle);
  if (i < 0) throw new Error("needle missing");
  return removalSpanFor(type, content, i);
}

const refused = (c: string, needle?: string, type?: string) =>
  expect(at(c, needle, type).ok, JSON.stringify(c)).toBe(false);
const accepted = (c: string, needle?: string, type?: string) =>
  expect(at(c, needle, type), JSON.stringify(c)).toMatchObject({ ok: true });

describe("X3: {% liquid %} lines follow Ruby's LiquidTagToken", () => {
  it("a tag name needs no space before its markup (echo'…', cycle'…', include'…', break'…')", () => {
    refused(`<div>{% liquid\necho'<textarea>'\n%}${LINK}</textarea></div>`); // A2
    refused(`<div>{% liquid\ncycle'<textarea>'\n%}${LINK}</textarea></div>`); // A4
    refused(`<div>{% liquid\necho"<!--"\n%}${LINK}{% liquid\necho"-->"\n%}</div>`); // A3
    refused(
      `{% for i in (1..2) %}<script>{% liquid\nbreak'x'\n%}</script>{% endfor %}\n${LINK}\n<script>init()</script>`,
    ); // B12
    refused(
      `{% for i in (1..2) %}<textarea>{% liquid\ninclude'x'\n%}</textarea>{% endfor %}\n${LINK}\n<textarea></textarea>`,
    ); // B14
  });

  it("a nested `liquid` line runs its rest as one more statement", () => {
    refused(`<div>{% liquid\nliquid echo '<textarea>'\n%}${LINK}</textarea></div>`); // A1
    refused(`<p>{% liquid\n  liquid   echo "<style>"\n%}${LINK}</style></p>`); // A7
    refused(`<p>{% liquid\nliquid liquid echo '<b>'\n%}${LINK}</p>`);
    refused(
      `{% for i in (1..2) %}<script>{% liquid\nliquid break\n%}</script>{% endfor %}\n${LINK}\n<script>init()</script>`,
    ); // B11
    refused(
      `{% for i in (1..2) %}<textarea>{% liquid\nliquid continue\n%}</textarea>{% endfor %}\n${LINK}\n<textarea></textarea>`,
    ); // B13
    // A nested block opener can never close inside its one-line tokenizer.
    refused(`<p>{% liquid\nliquid for i in (1..2)\nbreak\nendfor\n%}</p>${LINK}`);
    refused(`<p>{% liquid\nliquid comment\necho '<b>'\n%}</p>${LINK}`);
    // Harmless nested statements stay fine.
    accepted(`<p>{% liquid\n  liquid assign a = 1\n  liquid echo 'b'\n%}</p>${LINK}`);
  });

  it("inside a liquid-tag comment only comment/endcomment count (doc does not nest)", () => {
    refused(`<p>{% liquid\ncomment\ndoc\nendcomment\necho '<textarea>'\n%}${LINK}</textarea></p>`); // B1
    refused(`<p>{% liquid\ncomment\nendcomment'x'\necho '<textarea>'\n%}${LINK}</textarea></p>`); // B2
    accepted(`<p>{% liquid\ncomment\necho '<textarea>'\nendcomment\necho 'b'\n%}</p>${LINK}`);
    accepted(`<p>{% liquid\ncomment\ncomment\nendcomment\necho '<b>'\nendcomment\n%}</p>${LINK}`);
  });

  it("raw and doc never close inside a {% liquid %} tag: ambiguous", () => {
    refused(`<p>{% liquid\ncomment\nraw\nendcomment\n%}</p>${LINK}`);
    refused(`<p>{% liquid\nraw\nendraw\n%}</p>${LINK}`);
    refused(`<p>{% liquid\ndoc\nenddoc\n%}</p>${LINK}`);
  });

  it("names are \\w+ (ASCII), so `endcommentx` is not endcomment", () => {
    refused(`<p>{% liquid\ncomment\nendcommentx\n%}{% endif %}</p>${LINK}`);
    accepted(`<p>{% liquid\ncomment\nendcommentx\nendcomment\necho 'b'\n%}</p>${LINK}`);
  });
});

describe("X4: loops inside script/rawtext bodies", () => {
  const tail = `\n<link rel="stylesheet" href="a">`;
  const NEEDLE = '<link rel="stylesheet"';

  it("ordinary loops with '<' in script/style give spans again (c87175c parity)", () => {
    for (const body of [
      "<script>{% for p in products %}if (i < {{ forloop.index }}) {}{% endfor %}</script>", // U1
      "<script>{% for p in products %}if (i > 1) {}{% endfor %}</script>",
      "<style>{% for c in colors %}.a > .b { color: {{ c }} }{% endfor %}</style>",
      "<script>{% for p in products %}for (let i = 0; i < 3; i++) {}{% endfor %}</script>",
      '<script type="application/json">[{% for v in vs %}{"id": {{ v.id }}}{% unless forloop.last %},{% endunless %}{% endfor %}]</script>',
      "<textarea>{% for p in ps %}a < b{% endfor %}</textarea>",
    ]) {
      accepted(body + tail, NEEDLE);
    }
  });

  it("loop text that could complete or open a construct across iterations is ambiguous", () => {
    for (const body of [
      "<script>{% for p in ps %}x</scr{% endfor %}</script>", // </ in script
      "<script>{% for p in ps %}<!--{% endfor %}</script>",
      "<script>{% for p in ps %}<script{% endfor %}</script>",
      "<script>{% for p in ps %}<SCRIPT{% endfor %}</script>",
      "<script>{% for p in ps %}x-->{% endfor %}</script>",
      "<script>{% for p in ps %}/script>a <{% endfor %}</script>", // ends in '<'
      "<script>{% for p in ps %}->x-{% endfor %}</script>", // '-' + '->' across iterations
      "<style>{% for p in ps %}</st{% endfor %}</style>",
      "<style>{% for p in ps %}tyle>a</{% endfor %}</style>", // '</' + 'style>' across
      "<textarea>{% for p in ps %}</T{% endfor %}</textarea>",
      "<textarea>{% for p in ps %}a <  {%- endfor %}</textarea>", // '<' then stripped ws
      "<textarea>{% for p in ps %}a <{% if x %}{% endif %}{% endfor %}</textarea>",
    ]) {
      refused(body + tail, NEEDLE);
    }
  });

  it("a break whose text before it ends in '<' is ambiguous", () => {
    refused(`<script>{% for p in ps %}a <{% break %}{% endfor %}/script>x</script>${tail}`, NEEDLE);
    accepted(`<script>{% for p in ps %}a{% break %}{% endfor %}</script>${tail}`, NEEDLE);
  });

  it("rawtext bodies only refuse '</' + the element's first letter", () => {
    accepted(`<style>{% for c in cs %}a</b{% endfor %}</style>${tail}`, NEEDLE);
    accepted(`<textarea>{% for c in cs %}<b>x</b>{% endfor %}</textarea>${tail}`, NEEDLE);
  });

  it("nested loops in a 1 MB script body stay linear (< 1 s)", () => {
    const n = Math.floor(1e6 / 24);
    const c = LINK + "<script>" + "{%for a in b%}".repeat(n) + "{%endfor%}".repeat(n) + "</script>";
    const t = performance.now();
    nonCodeRanges(c);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("X8: splice re-check stays linear with many dropped lines", () => {
  it("70k one-line spans (2 MB) splice in under 1 s", () => {
    const line = `${LINK}\n`;
    const n = 70_000;
    const c = line.repeat(n);
    const spans = Array.from({ length: n }, (_, i) => ({
      start: i * line.length,
      end: i * line.length + LINK.length,
    }));
    const t = performance.now();
    const r = spliceSpans(c, spans);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.removed.length).toBe(n);
    expect(r.content).toBe("");
  });
});

describe("X9: assign/capture literals with '<' or '>' are ambiguous from the tag on", () => {
  it("a tag-form assign or capture: ambiguous from the first token that can output a variable", () => {
    refused(`{% assign x = '<textarea>' %}<p>{{ x }}${LINK}</p>`);
    refused(`{% assign x = "a" | append: '<b>' %}<p>{% render 'a', v: x %}${LINK}</p>`);
    refused(`{% capture '<b>' %}x{% endcapture %}<p>{% echo y %}${LINK}</p>`);
    // Before any such token (or after only literal outputs) nothing can have changed.
    accepted(`{% assign x = '<textarea>' %}<p>${LINK}{{ x }}</p>`);
    accepted(`{% assign x = '<textarea>' %}{% if a %}<p>{{ 'y' }}</p>{% endif %}${LINK}{{ x }}`);
    accepted(`{% assign x = 'a' %}<p>{{ x }}</p>${LINK}`);
    accepted(`{% assign parts = x | split: '<!-- split -->' %}<p>{{ parts[0] }}</p>${LINK}`); // U12
  });

  it("inside a loop the assign itself is ambiguous (an earlier output runs again)", () => {
    refused(`{% for i in (1..2) %}{{ x }}{% assign x = '<textarea>' %}{% endfor %}<p>${LINK}</p>`);
  });

  it("an assign line inside {% liquid %}", () => {
    refused(`{% liquid\n  assign x = '<textarea>'\n%}<p>${LINK}{{ x }}</p>`);
    refused(`<p>{% liquid\r  assign a = 1\r echo '<textarea>'\r%}${LINK}</textarea></p>`); // A8
    accepted(`{% liquid\n  assign x = 'a' | remove: '<'\n%}<p>${LINK}</p>`);
  });
});

describe("red-team r5: attacks on the X3/X4/X9 fixes", () => {
  it("1. tab, CR and form feed before a nested liquid line's name", () => {
    refused(`<p>{% liquid\n\t\r\fliquid\techo'<b>'\n%}</p>${LINK}`);
  });
  it("2. `#` comment line holding a nested liquid echo stays a comment", () => {
    accepted(`<p>{% liquid\n# liquid echo '<b>'\necho 'c'\n%}</p>${LINK}`);
  });
  it("3. a bare `liquid` line (empty rest) and a `liquid#` line are harmless", () => {
    accepted(`<p>{% liquid\n  liquid\n  liquid# echo '<b>'\n  echo 'b'\n%}</p>${LINK}`);
  });
  it("4. full-width '<' in an assign literal is not markup", () => {
    accepted(`{% assign x = '＜textarea＞' %}<p>${LINK}</p>`);
  });
  it("5. assign with the literal in a later filter argument, then a filter-only output", () => {
    refused(`{% assign x = 'a' | append: '<', 'b' %}<p>{{ 'y' | upcase }}${LINK}</p>`);
  });
  it("6. a loop in a script whose close is behind whitespace control after '<'", () => {
    refused(`<script>{% for p in ps %}x <\n{%- endfor %}/script>y</script>\n${LINK}`);
  });
  it("7. a loop in a script ending in '!' then '--' at the start", () => {
    refused(`<script>{% for p in ps %}--x<!{% endfor %}</script>\n${LINK}`);
  });
  it("8. a break nested two loops deep inside a script body", () => {
    refused(
      `{% for a in b %}<script>{% for c in d %}{% break %}{% endfor %}{% break %}</script>{% endfor %}\n${LINK}`,
    );
  });
  it("9. nested liquid break inside a liquid-tag loop is fine (data state)", () => {
    accepted(`{% liquid\nfor i in (1..2)\nliquid break\nendfor\n%}<p>x</p>${LINK}`);
  });
  it("10. a capture body loop with a break before its endfor in a textarea", () => {
    refused(
      `{% for i in (1..2) %}<textarea>{% liquid\nliquid liquid break\n%}</textarea>{% endfor %}${LINK}`,
    );
  });
  it("11. 1 MB of nested liquid lines stays linear", () => {
    const c = "{% liquid\n" + "liquid liquid assign a = 1\n".repeat(38_000) + "%}" + LINK;
    const t = performance.now();
    accepted(c);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it("12. a script-body loop whose text is all ordinary JS with many '<' stays linear", () => {
    const c =
      "<script>" +
      "{% for a in b %}if (a < b) {}{% endfor %}".repeat(25_000) +
      "</script>\n" +
      LINK;
    const t = performance.now();
    accepted(c);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
