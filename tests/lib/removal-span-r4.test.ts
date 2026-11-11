/**
 * gc-t44r: span guard redesign (two phases: Liquid map first, then an HTML
 * tokenizer on a copy with every Liquid token masked). Every audit r3 HIGH and
 * MEDIUM input must be non-code; ordinary theme markup must still get spans.
 */
import { describe, expect, it } from "vitest";

import { inRanges, nonCodeRanges, removalSpanFor } from "../../app/lib/removal-span";

const LINK = '<link rel="stylesheet" href="//e.css">';
const SCRIPT = '<script src="//e.js"></script>';

/** The element at the LAST occurrence of `needle` is in a non-code region. */
function nonCode(content: string, needle = LINK): void {
  const at = content.lastIndexOf(needle);
  if (at === -1) throw new Error(`needle not found: ${needle}`);
  expect(inRanges(nonCodeRanges(content), at), JSON.stringify(content)).toBe(true);
  const type = needle.startsWith("<link") ? "GHOST_STYLE" : "GHOST_SCRIPT";
  expect(removalSpanFor(type, content, at).ok).toBe(false);
}

/** The element at the LAST occurrence of `needle` gets a span. */
function fixable(content: string, needle: string, type = "GHOST_SCRIPT"): void {
  const at = content.lastIndexOf(needle);
  if (at === -1) throw new Error(`needle not found: ${needle}`);
  const r = removalSpanFor(type, content, at);
  expect(r, JSON.stringify(content)).toMatchObject({ ok: true });
}

describe("audit r3 HIGH: Liquid in or as a body element's tag name", () => {
  it("Liquid after a body element name", () => {
    nonCode(`<script{% if x %} async{% endif %}>w('a')${LINK}</script>`);
    nonCode(`<style{{ x }}>${LINK}</style>`);
    nonCode(`<textarea{%- if x -%} a{%- endif -%}>${LINK}</textarea>`);
  });

  it("Liquid as the whole tag name or inside it", () => {
    nonCode(`<{{ "script" }}>${LINK}</script>`);
    nonCode(`<scr{{ x }}ipt>${LINK}</script>`);
    nonCode(`</{{ x }}>${LINK}`);
  });
});

describe("audit r3 HIGH: HTML ends inside Liquid", () => {
  it("a script end inside a Liquid comment or a Liquid string", () => {
    nonCode(`<script>{% comment %}</script>{% endcomment %}${LINK}</script>`);
    nonCode(`<script>{% assign a = "</script>" %}${LINK}</script>`);
  });

  it("an HTML comment end inside a Liquid comment", () => {
    nonCode(`<!-- {% comment %} --> {% endcomment %}${LINK} -->`);
  });

  it("a bogus comment end inside an inline Liquid comment", () => {
    nonCode(`<!x {%# > %}${LINK}`);
  });
});

describe("audit r3 HIGH: Liquid control flow changes a tag's structure", () => {
  it("a tag end inside a branch", () => {
    nonCode(`<div {% if false %}>{% endif %}${SCRIPT}`, SCRIPT);
    nonCode(`<div {% unless x %}>{% endunless %}${SCRIPT}`, SCRIPT);
    nonCode(`<div {% case x %}{% when 1 %}>{% endcase %}${SCRIPT}`, SCRIPT);
  });

  it("a tag end inside a capture (never rendered there)", () => {
    nonCode(`<div {% capture x %}>{% endcapture %}${SCRIPT}`, SCRIPT);
  });

  it("a value's closing quote inside a branch", () => {
    nonCode(`<div a="{% if x %}"{% endif %}>${SCRIPT}">`, SCRIPT);
  });
});

describe("audit r3 MEDIUM", () => {
  it("Liquid end tags are case-sensitive", () => {
    nonCode(`{% comment %}{% ENDCOMMENT %}${LINK}{% endcomment %}`);
    nonCode(`{% raw %}{% ENDRAW %}${LINK}{% endraw %}`);
    nonCode(`{% doc %}{% ENDDOC %}${LINK}{% enddoc %}`);
  });

  it("'%' in comment arguments", () => {
    nonCode(`{% comment 50% off %}${LINK}{% endcomment %}`);
  });

  it("raw inside a comment is skipped", () => {
    nonCode(`{% comment %}{% raw %}{% endcomment %}{% endraw %}${LINK}{% endcomment %}`);
    fixable(
      `{% comment %}{% raw %}{% endcomment %}{% endraw %}{% endcomment %}\n${LINK}`,
      LINK,
      "GHOST_STYLE",
    );
  });

  it("a {% style %} body is not code, and a </style> in it can't end anything early", () => {
    nonCode(`{% style %}${LINK}{% endstyle %}`);
    nonCode(`{% style %}</style><!--{% endstyle %}${LINK}-->`);
  });

  it("script double escape after a second '<!--'", () => {
    nonCode(`<script><!-- a --><!--<script></script>${LINK}--></script>`);
  });

  it("Liquid output and echo literals that emit '<' or '>'", () => {
    nonCode(`{{ '<!--' }}${LINK}-->`);
    nonCode(`{% echo '<!--' %}${LINK}-->`);
    nonCode(`{% liquid\n  echo '<!--'\n%}${LINK}-->`);
    nonCode(`{% cycle '<!--', 'a' %}${LINK}-->`);
  });

  it("Liquid literals that emit quotes, '=' or whitespace inside a tag", () => {
    nonCode(`<div a={{ '"' }}> ${LINK} ">`);
    nonCode(`<div a={{ ' ' }}"> ${LINK} ">`);
    nonCode(`<div x{{ '=' }}"> ${LINK} ">`);
    nonCode(`<div title="{{ '"' }}"> ${LINK} ">`);
  });

  it("CDATA in svg runs to ']]>'", () => {
    nonCode(`<svg><![CDATA[ x > ${LINK} ]]></svg>`);
  });

  it("an unclosed string in a {% liquid %} line makes the rest of the tag text", () => {
    const c = "{% liquid\n  echo 'a\n  render 'app-widget'\n  b'\n%}";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("  render")).ok).toBe(false);
    expect(inRanges(nonCodeRanges(c), c.indexOf("  render"))).toBe(true);
  });
});

describe("audit r3 LOW: nested <template>", () => {
  it("the body runs to the matching </template>", () => {
    nonCode(`<template><template></template>${LINK}</template>`);
    fixable(`<template><template></template></template>\n${LINK}`, LINK, "GHOST_STYLE");
  });
});

describe("usefulness: ordinary theme markup still gets spans", () => {
  it.each([
    ["Liquid if inside a quoted value", `<div class="{% if x %}a{% endif %}">\n${SCRIPT}`],
    ["if/else inside a quoted value", `<div class="{% if x %}a{% else %}b{% endif %}">\n${SCRIPT}`],
    ["output as an unquoted value", `<input value={{ id }} class={{ c }}>\n${SCRIPT}`],
    ["if around a bare attribute", `<div {% if x %}hidden{% endif %} class="a">\n${SCRIPT}`],
    ["output between attributes", `<div {{ block.shopify_attributes }} id="a">\n${SCRIPT}`],
    ["script inside an if, same branch", `{% if x %}\n  ${SCRIPT}\n{% endif %}`],
    ["script in one branch of if/else", `{% if x %}${SCRIPT}{% else %}<p>no</p>{% endif %}`],
    [
      "script inside for/case",
      `{% for b in bs %}{% case b %}{% when 1 %}${SCRIPT}{% endcase %}{% endfor %}`,
    ],
    [
      "break inside a loop",
      `{% for b in bs %}{% if b %}{% break %}{% endif %}{% endfor %}\n${SCRIPT}`,
    ],
    ["style block before", `{%- style -%}\n.a { color: {{ c }}; }\n{%- endstyle -%}\n${SCRIPT}`],
    ["Liquid inside a script body", `<script>var p = {{ product | json }};</script>\n${SCRIPT}`],
    ["output in an HTML comment", `<!-- {{ section.id }} -->\n${SCRIPT}`],
    ["output in a script src", `<script src="{{ 'a.js' | asset_url }}" defer="defer"></script>`],
    [
      "whitespace control everywhere",
      `{%- if x -%}\n  <div class="a {{- b -}}">{{- c -}}</div>\n{%- endif -%}\n${SCRIPT}`,
    ],
    ["capture with markup", `{% capture h %}<p class="x">{{ y }}</p>{% endcapture %}\n${SCRIPT}`],
    ["form block", `{% form 'product', product %}<input name="id">{% endform %}\n${SCRIPT}`],
    ["svg icon with style", `<svg><style>.a{fill:red}</style><path d="M0"/></svg>\n${SCRIPT}`],
  ])("%s", (_label, content) => {
    fixable(content, "<script");
  });

  it("render tags and bare render lines inside control flow", () => {
    fixable(`{% if x %}{% render 'app-widget' %}{% endif %}`, "{% render", "GHOST_SNIPPET");
    const c = "{% liquid\n  if x\n    render 'app-widget'\n  endif\n%}";
    expect(removalSpanFor("GHOST_SNIPPET", c, c.indexOf("    render"))).toMatchObject({ ok: true });
  });

  it("a span never splits a Liquid token or swallows control flow", () => {
    // An element-shaped string inside a {% liquid %} tag is not HTML.
    const c = "{% liquid\n<script src=x></script>\n%}";
    expect(removalSpanFor("GHOST_SCRIPT", c, c.indexOf("<script")).ok).toBe(false);
  });
});

describe("gc-t44r self red-team", () => {
  it("1: full-width '＜' is text, not a construct (both directions)", () => {
    fixable(`＜!-- x\n${LINK}`, LINK, "GHOST_STYLE");
    fixable(`＜script>\n${LINK}`, LINK, "GHOST_STYLE");
  });

  it("2: NUL after </script does not end the body", () => {
    nonCode(`<script>a</script\0>${LINK}</script>`);
  });

  it("3: CRLF counts as whitespace in end tags and comments", () => {
    fixable(`<script>a</script\r\n>\r\n${LINK}`, LINK, "GHOST_STYLE");
    nonCode(`<!--\r\n${LINK}\r\n-->`);
  });

  it("4: upper-case HTML tags count; upper-case Liquid tags are ambiguous", () => {
    nonCode(`<SCRIPT>${LINK}</SCRIPT>`);
    nonCode(`{% COMMENT %}${LINK}{% ENDCOMMENT %}`);
    nonCode(`{% IF x %}{% endif %}${LINK}`);
  });

  it("5: whitespace control joins text across a tag", () => {
    nonCode(`< {%- if x -%} script>${LINK}</script>`);
    nonCode(`<!-- a - {%- if x -%}{%- endif -%} -> ${LINK} -->`);
    nonCode(`<!-- a -- {%- if x -%}{%- endif -%} > ${LINK} -->`);
  });

  it("6: a tag that renders empty joins a comment end", () => {
    nonCode(`<!-- -{% if x %}{% endif %}-> ${LINK} -->`);
    nonCode(`<!--{{ x }}>${LINK}-->`);
    nonCode(`<!-{{ x }}- ${LINK} -->`);
    nonCode(`<!-- {% if x %}-{% else %}a{% endif %}-> ${LINK} -->`);
  });

  it("7: filler collisions (text that looks like the mask)", () => {
    fixable(`xxxxxxxx{{ x }}xxxxxxxx\n${LINK}`, LINK, "GHOST_STYLE");
    nonCode(`<script>xx{{ a }}xx</scriptxx>${LINK}</script>`);
  });

  it("8: unclosed tokens and blocks at EOF", () => {
    fixable(`${LINK}\n{{ x`, LINK, "GHOST_STYLE");
    nonCode(`{% if x %}${LINK}`);
    nonCode(`{% raw %}${LINK}`);
    nonCode(`{% comment %}${LINK}`);
  });

  it("9: huge adversarial inputs stay linear", () => {
    for (const content of [
      "{% if a %}<div ".repeat(100_000),
      "<!--{{x}}".repeat(100_000),
      "<svg><style>".repeat(100_000),
      "{% comment %}{% raw %}".repeat(50_000),
      "<script><!--<script>{{ x }}".repeat(50_000),
      `<div ${"{% if a %}x{% endif %}".repeat(50_000)}>`,
      "{% for i in x %}{% break %}".repeat(50_000),
      `{% liquid\n${"  echo 'a'\n".repeat(100_000)}%}`,
    ]) {
      const t = performance.now();
      nonCodeRanges(content);
      expect(performance.now() - t).toBeLessThan(1500);
    }
  });

  it("10: an output that ends at a single '}' is ambiguous", () => {
    nonCode(`{{ x } <!-- }}${LINK}`);
  });

  it("11: tokens that may render empty split a value", () => {
    nonCode(`<div {{ a }}={{ b }}"> ${LINK} ">`);
    nonCode(`<div {% if x %}a{% endif %}="> ${LINK} ">`);
    nonCode(`<div a={{ b }}"> ${LINK} ">`);
  });

  it("12: a loop body that changes tag state is ambiguous", () => {
    nonCode(`<div {% for i in x %}a="{% endfor %}> ${LINK} ">`);
  });

  it("13: break/continue skip the rest of the loop body", () => {
    nonCode(`{% for i in x %}<!-- {% if a %}{% break %}{% endif %} -->{% endfor %}${LINK}`);
    nonCode(`{% break %}${LINK}`);
    nonCode(`{% for i in x %}<!-- {% liquid\n if a\n continue\n endif %} -->{% endfor %}${LINK}`);
  });

  it("14: select and foreign content: raw-text rules may not apply", () => {
    nonCode(`<select><title><!--</title>${LINK}--></select>`);
    nonCode(`<svg><script><!--</script>${LINK}--></script></svg>`);
    nonCode(`<math><style><!--</style>${LINK}--></style></math>`);
  });

  it("15: abrupt and odd comment ends", () => {
    fixable(`<!-->\n${LINK}`, LINK, "GHOST_STYLE");
    fixable(`<!--->\n${LINK}`, LINK, "GHOST_STYLE");
    nonCode(`<!--!>${LINK}-->`);
  });

  it("16: raw ends only at a whole endraw tag (last '{%' in a token)", () => {
    nonCode(`{% raw %}{% endraw {% x %}${LINK}{% endraw %}`);
  });

  it("17: dash literals inside an HTML comment", () => {
    nonCode(`<!-- {{ '--' }}> ${LINK} -->`);
  });

  it("18: mismatched or stray Liquid block tags", () => {
    nonCode(`{% if x %}{% endfor %}${LINK}`);
    nonCode(`{% endif %}${LINK}`);
    nonCode(`{% for x in y %}{% elsif z %}{% endfor %}${LINK}`);
  });

  it("19: a branch that opens a template or svg and closes it in another", () => {
    nonCode(`{% if x %}<template>{% endif %}</template>${LINK}`);
    nonCode(`{% if x %}<svg>{% endif %}</svg><svg><script><!--</script>${LINK}--></script>`);
  });

  it("20: tablerow and form emit markup: not inside a tag or a bogus comment", () => {
    nonCode(`<!x {% form 'a' %}{% endform %}${LINK}`);
    nonCode(`<div {% tablerow i in x %}{% endtablerow %}>${SCRIPT}`, SCRIPT);
  });
});
