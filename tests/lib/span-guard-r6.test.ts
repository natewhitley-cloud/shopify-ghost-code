/**
 * gc-t44r audit r6 (guard): X9 bracket lookups (M1), quote/markup taint per
 * variable (M2), unclosed literals on `{% liquid %}` lines (M3), markup-making
 * filters (L1), `#`/comment lines in the quote count (L2, gc-pb12), and
 * whitespace-control dashes (L4). Plus red-team attacks on the taint and the
 * line splitting.
 */
import { describe, expect, it } from "vitest";

import { nonCodeRanges, removalSpanFor } from "../../app/lib/removal-span";

const LINK = "<link rel=stylesheet href=a>";

function at(content: string, needle = LINK, type = "GHOST_STYLE") {
  const i = content.indexOf(needle);
  if (i < 0) throw new Error("needle missing");
  return removalSpanFor(type, content, i);
}
const refused = (c: string, needle?: string, type?: string) =>
  expect(at(c, needle, type).ok, JSON.stringify(c)).toBe(false);
const accepted = (c: string, needle?: string, type?: string) =>
  expect(at(c, needle, type), JSON.stringify(c)).toMatchObject({ ok: true });

describe("M1: a bracket lookup after a '<'/'>' assign is a print", () => {
  it("['x'], [\"x\"] and [ 'x' ] are refused (Ruby variable_lookup resolves them to x)", () => {
    refused(`{% assign x = '<textarea>' %}<p>{{ ['x'] }}</p>${LINK}</textarea>`); // S6
    refused(`{% assign x = '<textarea>' %}<p>{{ ["x"] }}</p>${LINK}</textarea>`); // S7
    refused(`{% assign x = '<textarea>' %}<p>{{ [ 'x' ] }}</p>${LINK}</textarea>`); // S19
    refused(`{% liquid\nassign x = 'a'\n%}{% assign y = '<textarea>' %}{{ ['y'] }}<p>x</p>${LINK}`); // X3q
  });

  it("with nothing tainted a bracket lookup is ordinary", () => {
    accepted(`{% assign x = 'a' %}<p>{{ ['x'] }}{{ product.images[0] }}</p>${LINK}`);
  });
});

describe("M2: quote, '=' and markup taint follows the variable to where it prints", () => {
  it("an assigned or captured quote printed in a quoted attribute is refused", () => {
    refused(`{% assign q = '"' %}<div title="{{ q }}><textarea>"></div>${LINK}</textarea>`); // S1
    refused(`{% assign q = "'" %}<div title='{{ q }}><textarea>'></div>${LINK}</textarea>`); // S2
    refused(
      `{% capture q %}"{% endcapture %}<div title="{{ q }}><textarea>"></div>${LINK}</textarea>`,
    ); // S3
    refused(
      `{% liquid\nassign q = '"'\n%}<div title="{{ q }}><textarea>"></div>${LINK}</textarea>`,
    ); // S9
    refused(
      `{% if c %}{% assign q = '"' %}{% endif %}<div title="{{ q }}><textarea>"></div>${LINK}</textarea>`,
    ); // S17
  });

  it("the same values printed in data state, or other variables in attributes, are fine", () => {
    accepted(`{% assign q = '"' %}<p>{{ q }}</p>${LINK}`);
    accepted(`{% assign q = '"' %}<div title="{{ other }}"></div>${LINK}`);
    accepted(`{% assign q = 'a b' %}<div class="{{ q }}"></div>${LINK}`);
  });

  it("a capture body with balanced markup may print in data state (Horizon's accordion pattern)", () => {
    accepted(
      `{% capture kids %}<details class="menu"><summary>x</summary></details>{% endcapture %}` +
        `{% render 'accordion', children: kids %}<div class="{{ section.id }}"></div>${LINK}`,
    );
    accepted(`{% capture kids %}<b>x</b>{% endcapture %}<div>{{ kids }}</div>${LINK}`);
  });

  it("captured markup printed in a tag, a comment, a text body or svg is refused", () => {
    const cap = `{% capture kids %}<b class="a">x</b>{% endcapture %}`;
    refused(`${cap}<div title="{{ kids }}"></div>${LINK}`);
    refused(`${cap}<!-- {{ kids }} -->${LINK}`);
    refused(`${cap}<textarea>{{ kids }}</textarea>${LINK}`);
    refused(`${cap}<svg>{{ kids }}</svg>${LINK}`);
  });

  it("a capture body that does not leave the tokenizer as it found it is refused", () => {
    refused(`{% capture c %}<textarea>{% endcapture %}<p>{{ c }}</p>${LINK}</textarea>`);
    refused(`{% capture c %}<div title="{% endcapture %}<p>{{ c }}</p>${LINK}`);
    refused(`{% capture c %}<!--{% endcapture %}<p>{{ c }}</p>${LINK}`);
  });

  it("taint passes through assign, for and include", () => {
    refused(`{% assign q = '"' %}{% assign r = q %}<div title="{{ r }}"></div>${LINK}`);
    refused(
      `{% assign qs = '"' | split: ',' %}{% for q in qs %}<div title="{{ q }}"></div>{% endfor %}${LINK}`,
    );
    refused(`{% assign q = '"' %}<div title="{% include 'x' %}"></div>${LINK}`);
  });

  it("inside a loop, a taint after the variable was read in the loop is ambiguous", () => {
    refused(
      `{% for i in (1..2) %}<div title="{{ q }}"></div>{% assign q = '"' %}{% endfor %}${LINK}`,
    );
    accepted(
      `{% for i in (1..2) %}{% assign c = 'a b' %}<div class="{{ c }}"></div>{% endfor %}${LINK}`,
    );
  });
});

describe("M3: an unclosed literal on a {% liquid %} line", () => {
  it("makes the tag ambiguous instead of hiding the lines after it", () => {
    refused(`{% liquid\nincrement it's\necho '<textarea>'\n%}<p>x</p>${LINK}</textarea>`); // X3u
    refused(`{% liquid\ndecrement a"\necho '<!--'\n%}<p>x</p>${LINK}<p>--></p>`); // X3v
    refused(
      `{% for i in (1..2) %}<textarea>{% liquid\nincrement it's\nbreak\n%}</textarea>{% endfor %}<p>x</p>${LINK}`,
    ); // X3x
    refused(`{% liquid\nassign a = 'x\necho '<textarea>'\n%}<p>x</p>${LINK}</textarea>`); // X3r
  });

  it("quotes in # lines and comment bodies are not literals", () => {
    accepted(`{% liquid\n# it's fine\ncomment\n don't\nendcomment\necho 'b'\n%}<p>x</p>${LINK}`);
  });
});

describe("L1: markup-making filters", () => {
  it("their output in a tag is refused", () => {
    refused(`<div title={{ "\\n" | newline_to_br }}'<textarea>'>${LINK}</textarea>`); // S20
    refused(`<div title="{{ 'a' | link_to: 'b' }}" data-z='<textarea>'></div>${LINK}</textarea>`); // S21
    refused(`<img alt="{{ image | image_tag }}">${LINK}`);
    refused(`<div title="{{ x | some_future_tag }}">${LINK}`);
  });

  it("their output in a script body is refused", () => {
    refused(`<script>{{ 'a.js' | asset_url | script_tag }}</script>${LINK}`);
  });

  it("their output in data state is fine (Dawn's image_tag, link_to)", () => {
    accepted(
      `<div>{{ image | image_url: width: 600 | image_tag: loading: 'lazy', class: 'a b' }}</div>${LINK}`,
    );
    accepted(`<p>{{ 'Home' | link_to: '/' }}</p>${LINK}`);
  });
});

describe("L2 (gc-pb12): # lines and comment bodies don't count in a bare render line's block", () => {
  it("gc-pb12: an apostrophe in a # line keeps the bare render line fixable", () => {
    const c = "<div>{% liquid\n  # don't\n  render 'app'\n%}</div>";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("  render"))).toMatchObject({ ok: true });
  });
  it("gc-pb12: an apostrophe in a comment body keeps the bare render line fixable", () => {
    const c = "<div>{% liquid\n  comment\n  it's\n  endcomment\n  render 'app'\n%}</div>";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("  render"))).toMatchObject({ ok: true });
  });
  it("gc-pb12: an unclosed literal on a code line still refuses the block", () => {
    const c = "<div>{% liquid\n  assign a = 'x\n  render 'app'\n%}</div>";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("  render")).ok).toBe(false);
  });
});

describe("L4: whitespace-control dashes are not markup", () => {
  it("{%- liquid -%}, {%- echo -%} and {{- -}} keep the remove allowlist", () => {
    accepted(`{%- liquid\n  echo x | remove: '<br>' -%}<p>x</p>${LINK}`);
    accepted(`{%- echo x | remove: '<b>' -%}<p>x</p>${LINK}`);
    accepted(`{{- x | remove: '<b>' -}}<p>x</p>${LINK}`);
  });
});

describe("red-team r6: taint and line splitting", () => {
  it("1. a capture named by a string literal", () => {
    refused(`{% capture 'q' %}"{% endcapture %}<div title="{{ q }}"></div>${LINK}`);
  });
  it("2. a hyphenated variable name", () => {
    refused(`{% assign my-q = '"' %}<div title="{{ my-q }}"></div>${LINK}`);
  });
  it("3. a property of a tainted variable", () => {
    refused(`{% assign q = '"' %}<div title="{{ q.first }}"></div>${LINK}`);
  });
  it("4. reassigning a clean value never clears a taint (branches)", () => {
    refused(`{% assign q = '"' %}{% assign q = 'a' %}<div title="{{ q }}"></div>${LINK}`);
  });
  it("5. a tainted variable as a filter argument", () => {
    refused(`{% assign q = '"' %}<div title="{{ 'a' | append: q }}"></div>${LINK}`);
  });
  it("6. echo and cycle of a tainted variable in an attribute", () => {
    refused(`{% assign q = '"' %}<div title="{% echo q %}"></div>${LINK}`);
    refused(`{% assign q = '"' %}<div title="{% cycle q, 'b' %}"></div>${LINK}`);
  });
  it("7. a capture inside a {% liquid %} tag", () => {
    refused(`{% liquid\ncapture q\necho '"'\nendcapture\n%}<div title="{{ q }}"></div>${LINK}`);
  });
  it("8. nested captures: the inner body is not the outer's output", () => {
    const c = `{% capture o %}{% capture i %}"{% endcapture %}{% endcapture %}`;
    accepted(`${c}<div title="{{ o }}"></div>${LINK}`);
    refused(`${c}<div title="{{ i }}"></div>${LINK}`);
  });
  it("9. a top-level dynamic lookup reads every taint; indexing a value does not", () => {
    refused(`{% assign q = '"' %}<div title="{{ [k] }}"></div>${LINK}`);
    refused(`{% assign q = '"' %}<div title="{{ [ k ] | upcase }}"></div>${LINK}`);
    accepted(`{% assign q = '"' %}<div title="{{ settings[k] }}"></div>${LINK}`);
  });
  it("10. CR before the newline does not split a {% liquid %} line", () => {
    refused(`{% liquid\nincrement a'\r\necho '<textarea>'\n%}<p>x</p>${LINK}</textarea>`);
  });
  it("11. a taint inside a loop reaching a name read earlier through assign", () => {
    refused(
      `{% for i in (1..2) %}{% assign r = q %}<div title="{{ r }}"></div>{% assign q = '"' %}{% endfor %}${LINK}`,
    );
  });
  it("12. a taint inside a {% liquid %} loop after a read in the same tag", () => {
    refused(
      `{% liquid\nfor i in (1..2)\necho q\nassign q = '"'\nendfor\n%}<div title="{{ q }}"></div>${LINK}`,
    );
  });
  it("13. an unclosed comment inside a {% liquid %} tag is ambiguous", () => {
    refused(`{% liquid\ncomment\n%}<p>x</p>${LINK}`);
  });
  it("14. a markup filter's output assigned, then printed in an attribute", () => {
    refused(`{% assign t = 'x' | link_to: '/' %}<div title="{{ t }}"></div>${LINK}`);
  });
  it("15. 1 MB of assigns and prints stays linear", () => {
    const c = `{% assign q = '"' %}` + `{% assign a = 'b c' %}<p>{{ a }}</p>`.repeat(20_000) + LINK;
    const t = performance.now();
    nonCodeRanges(c);
    accepted(c);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
