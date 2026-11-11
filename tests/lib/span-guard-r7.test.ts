/**
 * gc-t44r audit r7 (guard): assign/capture targets named exactly as Ruby
 * Liquid names them (#1), names with no letters (`-`, `1-`, `9q`) in both
 * taint paths (#2), `date` / bare `join` making spaces (#3), and `json` /
 * `structured_data` making double quotes (#4). Plus red-team attacks on the
 * name tokenizing.
 */
import { describe, expect, it } from "vitest";

import { nonCodeRanges, removalSpanFor } from "../../app/lib/removal-span";

const LINK = "<link rel=stylesheet href=a>";

function at(content: string, needle = LINK, type = "GHOST_STYLE") {
  const i = content.indexOf(needle);
  if (i < 0) throw new Error("needle missing");
  return removalSpanFor(type, content, i);
}
const refused = (c: string) => expect(at(c).ok, JSON.stringify(c)).toBe(false);
const accepted = (c: string) => expect(at(c), JSON.stringify(c)).toMatchObject({ ok: true });

/** `v` printed in a double-quoted attribute: a printed `"` puts the link inside <textarea>. */
const D = (pre: string, v: string) => `${pre}<div title="${v}><textarea>"></div>${LINK}</textarea>`;
/** `v` printed in an unquoted attribute: a printed space or `=` changes the tag. */
const U = (pre: string, v: string) => `${pre}<div class=${v}='>${LINK}'>`;
/** A `<textarea>` printed in data state swallows the link. */
const T = (pre: string, v: string) => `${pre}<p>${v}</p>${LINK}</textarea>`;

describe("#1: the assign/capture target is the name Ruby's regex picks", () => {
  it("junk before the name: Ruby assigns the run just before '='", () => {
    refused(D(`{% assign junk q = '"' %}`, "{{ q }}")); // M2-01
    refused(D(`{% liquid\n  assign junk q = '"'\n%}`, "{{ q }}")); // M2-15
    refused(D(`{% assign ))q = '"' %}`, "{{ q }}"));
  });

  it("dotted, bracketed and parenthesised names are stored under that exact key", () => {
    refused(D(`{% assign x.y = '"' %}`, "{{ ['x.y'] }}")); // M2-02
    refused(D(`{% capture x.y %}"{% endcapture %}`, "{{ ['x.y'] }}")); // M2-03
    refused(D(`{% assign a[0] = '"' %}`, "{{ ['a[0]'] }}")); // M2-04
    refused(D(`{% capture (q) %}"{% endcapture %}`, "{{ ['(q)'] }}"));
    refused(D(`{% liquid\ncapture x.y\necho '"'\nendcapture\n%}`, "{{ ['x.y'] }}"));
  });

  it("a quoted capture name is the run inside the quotes", () => {
    refused(D(`{% capture 'q' %}"{% endcapture %}`, "{{ q }}"));
  });

  it("plain names keep working, and untainted odd names stay fine", () => {
    accepted(D(`{% assign x.y = 'a' %}`, "{{ ['x.y'] }}"));
    accepted(`{% assign junk q = '"' %}<p>{{ q }}</p>${LINK}`);
    accepted(D(`{% assign q = '"' %}`, "{{ junk }}"));
  });
});

describe("#2: names with no letters are names", () => {
  it("hard taint: `-`, `1-`, `--` and `9q` print the '<' value", () => {
    refused(T(`{% assign - = '<textarea>' %}`, "{{ - }}")); // H-01
    refused(T(`{% assign 1- = '<textarea>' %}`, "{{ 1- }}")); // H-02
    refused(T(`{% assign -- = '<textarea>' %}`, "{{ -- }}")); // H-03
    refused(T(`{% assign 9q = '<textarea>' %}`, "{{ 9q }}"));
  });

  it("soft taint: the same names carry quotes into an attribute", () => {
    refused(D(`{% assign - = '"' %}`, "{{ - }}")); // M2-56
    refused(D(`{% assign 1- = '"' %}`, "{{ 1- }}")); // M2-57
    refused(D(`{% assign 9q = '"' %}`, "{{ 9q }}")); // M2-05
    refused(D(`{% assign -q = '"' %}`, "{{ -q }}"));
    refused(D(``, `{% liquid\nassign - = '"'\necho -\n%}`));
  });

  it("pure numbers are literals, not names", () => {
    accepted(T(`{% assign q = '<b>' %}`, "{{ 1 }}{{ -2 }}{{ 3.5 }}"));
    accepted(D(`{% assign q = '"' %}`, "{{ -1 | plus: 2 }}"));
  });
});

describe("#3: filters that make spaces in an unquoted attribute", () => {
  it("date (any format) and join with no separator are refused", () => {
    refused(U(``, `{{ 'now' | date: '%c' }}`)); // W-01
    refused(U(`{% assign a = 'x,y' | split: ',' %}`, `{{ a | join }}`)); // W-02
    refused(U(``, `{{ '2026-11-05' | date: '%e' }}`)); // W-03
    refused(U(``, `{{ 'now' | date: '%Y' }}`));
    refused(U(`{% assign d = 'now' | date: '%c' %}`, `{{ d }}`));
  });

  it("join with a plain separator stays fine; date stays fine when quoted", () => {
    accepted(U(`{% assign a = 'x,y' | split: ',' %}`, `{{ a | join: '_' }}`));
    accepted(`<div class="{{ 'now' | date: '%c' }}"></div>${LINK}`);
  });
});

describe("#4: json and structured_data make double quotes", () => {
  it("in a double-quoted attribute they are refused", () => {
    refused(D(``, `{{ 'x' | json }}`)); // L1-01
    refused(D(`{% assign o = 'a,b' | split: ',' %}`, `{{ o | json }}`)); // L1-02
    refused(D(`{% assign o = 'a' | json %}`, `{{ o }}`)); // L1-03
    refused(D(``, `{{ product | structured_data }}`)); // L1-04
  });

  it("the usual idioms stay accepted", () => {
    accepted(`<div data-x='{{ 'a' | json }}'></div>${LINK}`); // L1-29
    accepted(`<div data-x='{{ product | json }}'></div>${LINK}`);
    accepted(`<script type="application/json">{{ product | json }}</script>${LINK}`);
    accepted(`<p>{{ product | structured_data }}</p>${LINK}`);
  });
});

describe("red team: name tokenizing", () => {
  it("a `?` suffix is part of a read name; Ruby cannot assign to one", () => {
    // capture.rb's regex stops at `?`: `capture q?` assigns q, which `{{ q? }}` does not read.
    refused(D(`{% capture q? %}"{% endcapture %}`, "{{ q }}"));
    accepted(D(`{% capture q? %}"{% endcapture %}`, "{{ q? }}"));
    refused(T(`{% assign q = '<textarea>' %}`, "{{ q? }}"));
    // `assign q? =` does not match assign.rb's regex: no name, so it is ambiguous.
    refused(D(`{% assign q? = '"' %}`, "{{ q }}"));
  });

  it("a range reads the name after '..'", () => {
    refused(
      `{% assign q = '"' | split: ',' %}{% for i in (1..q) %}<div title="{{ i }}><textarea>"></div>{% endfor %}${LINK}</textarea>`,
    );
    refused(T(`{% assign -q = '<textarea>' %}`, "{{ (1..-q) }}"));
  });

  it("a property after '.' is the value's, not a variable", () => {
    accepted(D(`{% assign q = '"' %}`, "{{ product.q }}"));
    refused(D(`{% assign q = '"' %}`, "{{ q.size }}"));
  });

  it("a name next to a filter, comma or colon is still read", () => {
    refused(D(`{% assign - = '"' %}`, "{{ 'a' | append:- }}"));
    refused(D(`{% assign 1- = '"' %}`, "{{ 'a' | append: 'b',1- }}"));
  });

  it("full-width and accented letters are not Ruby word chars (no name, no match)", () => {
    // Ruby \\w is ASCII: `assign ｑ = ...` has no name and fails to parse.
    accepted(D(`{% assign q = '"' %}`, "{{ 'ｑ' }}{{ 'é' }}"));
    refused(D(`{% assign éq = '"' %}`, "{{ q }}"));
  });

  it("an assign with no name Ruby can match carries its quotes to every print", () => {
    refused(D(`{% assign ((= '"' %}`, "{{ x }}"));
    refused(D(`{% assign a() = '"' %}`, "{{ a }}"));
  });

  it("a weird capture name with a quote body refuses even when printed under another name", () => {
    refused(D(`{% capture x.y %}"{% endcapture %}`, "{{ x }}"));
  });

  it("the '=' inside a quoted name is the one Ruby uses", () => {
    refused(D(`{% assign 'q' = 'a=b"' %}`, "{{ a }}"));
  });

  it("a '<' in junk before the name still counts as hard taint", () => {
    refused(T(`{% assign '<' q = 'a' %}`, "{{ x }}"));
  });

  it("a dash joins one name (`q-1` is not q)", () => {
    accepted(D(`{% assign q = '"' %}`, "{{ q-1 }}"));
    refused(D(`{% assign q-1 = '"' %}`, "{{ q-1 }}"));
  });

  it("1 MB of name characters in an assign, capture and print runs under 1 s", () => {
    const big = "a".repeat(1_000_000);
    const parens = "a)(".repeat(330_000);
    for (const c of [
      `{% assign ${big} %}${LINK}`,
      `{% assign ${parens} %}${LINK}`,
      `{% assign x = '"' %}{% assign ${"-".repeat(1_000_000)} = x %}${LINK}`,
      `{% capture ${"((".repeat(500_000)} %}x{% endcapture %}${LINK}`,
      `{% assign q = '"' %}{{ ${"9-".repeat(500_000)} }}${LINK}`,
    ]) {
      const t = performance.now();
      nonCodeRanges(c);
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});
