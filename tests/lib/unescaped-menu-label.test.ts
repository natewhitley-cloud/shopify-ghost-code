/**
 * Unescaped menu-label signal (gc-7gjj.2, spike gc-7gjj §1.5 Phase 0).
 * Golden fixtures: Dawn @ 05222537 escapes every menu title (0 hits); Horizon
 * 4.3.0 @ dfad90d prints them raw in three files (provenance in
 * tests/fixtures/README.md). Plus the alias / echo / attribute / `t:` cases.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  detectUnescapedMenuLabels,
  MENU_LABEL_FILES_CAP,
  MENU_LABEL_LINES_CAP,
  summarizeUnescapedMenuLabels,
} from "../../app/lib/unescaped-menu-label";
import { blankLiquidComments } from "../../app/services/scan-engine.server";

const FIXTURES = join(__dirname, "..", "fixtures", "menu-labels");
const read = (theme: string, path: string) => readFileSync(join(FIXTURES, theme, path), "utf8");
/** As the scan engine calls it: Liquid comments blanked first. */
const detect = (content: string) => detectUnescapedMenuLabels(blankLiquidComments(content)).lines;

const loop = (body: string, menu = "section.settings.menu") =>
  `{% for link in ${menu}.links %}\n${body}\n{% endfor %}`;

describe("golden fixtures", () => {
  it.each([
    "snippets/header-dropdown-menu.liquid",
    "snippets/header-mega-menu.liquid",
    "snippets/header-drawer.liquid",
    "sections/footer.liquid",
  ])("Dawn %s: 0 hits (every menu title is escaped)", (path) => {
    expect(detect(read("dawn", path))).toEqual([]);
  });

  it("Horizon blocks/_header-menu.liquid: the desktop header's two raw prints (the t: label is not counted)", () => {
    expect(detect(read("horizon", "blocks/_header-menu.liquid"))).toEqual([57, 114]);
  });

  it("Horizon snippets/mega-menu-list.liquid: link.title and childLink.title", () => {
    expect(detect(read("horizon", "snippets/mega-menu-list.liquid"))).toEqual([135, 156]);
  });

  it("Horizon blocks/menu.liquid: menu.title printed above its loop, and link.title", () => {
    // 50 and 52 print `heading | default: menu.title` before the
    // `for link in menu.links` loop on line 73; 68 escapes it.
    expect(detect(read("horizon", "blocks/menu.liquid"))).toEqual([50, 52, 76]);
  });

  it("Horizon snippets/header-drawer.liquid: 0 hits (the mobile drawer escapes)", () => {
    expect(detect(read("horizon", "snippets/header-drawer.liquid"))).toEqual([]);
  });

  it("Horizon totals: 7 prints in 3 files (5 link titles, the spike's count, plus 2 menu titles)", () => {
    const hits = [
      "blocks/_header-menu.liquid",
      "snippets/mega-menu-list.liquid",
      "blocks/menu.liquid",
      "snippets/header-drawer.liquid",
    ]
      .map((path) => ({ path, lines: detect(read("horizon", path)) }))
      .filter((h) => h.lines.length > 0);
    expect(summarizeUnescapedMenuLabels(hits)).toEqual({
      fileCount: 3,
      outputCount: 7,
      files: [
        { path: "blocks/_header-menu.liquid", lines: [57, 114] },
        { path: "blocks/menu.liquid", lines: [50, 52, 76] },
        { path: "snippets/mega-menu-list.liquid", lines: [135, 156] },
      ],
    });
  });
});

describe("what counts as an unescaped print", () => {
  it.each([
    ["{{ link.title }}", [2]],
    ["{{- link.title -}}", [2]],
    ["{{ link.title | upcase }}", [2]],
    ["{{ link.title | truncate: 20 | append: '!' }}", [2]],
    ["{{ link.title | link_to: link.url }}", [2]],
    ['<a title="{{ link.title }}">x</a>', [2]],
    ['<a aria-label="{{ link.title }}">x</a>', [2]],
    ["{% echo link.title %}", [2]],
    ["{{ 'Shop: ' | append: link.title }}", [2]],
  ])("counts %s", (body, lines) => {
    expect(detect(loop(body))).toEqual(lines);
  });

  it.each([
    "{{ link.title | escape }}",
    "{{ link.title | escape_once }}",
    "{{ link.title | strip_html }}",
    "{{ link.title | upcase | escape }}",
    "{{ 'accessibility.show_submenu' | t: title: link.title }}",
    "{{ link.title | handleize }}",
    "{{ link.title | url_encode }}",
    "{{ link.title | size }}",
    "{{ link.title.size }}",
    "{{ link.url }}",
    "{{ link.titles }}",
    "{% if link.title == 'Sale' %}x{% endif %}",
    "{{ product.title }}",
    "{{ 'link.title' }}",
  ])("does not count %s", (body) => {
    expect(detect(loop(body))).toEqual([]);
  });

  it("counts nested loops whatever the variable is called", () => {
    const content = [
      "{% for item in linklists.main-menu.links %}",
      "  {% for childLink in item.links %}",
      "    {% for grand in childLink.links %}",
      "      {{ grand.title }}",
      "    {% endfor %}",
      "    {{ childLink.title }}",
      "  {% endfor %}",
      "{% endfor %}",
    ].join("\n");
    expect(detect(content)).toEqual([4, 6]);
  });

  it("counts a menu's own title, including an indexed linklist", () => {
    const content = [
      "<h2>{{ linklists['main-menu'].title }}</h2>",
      "{% for link in linklists['main-menu'].links %}{{ link.title | escape }}{% endfor %}",
    ].join("\n");
    expect(detect(content)).toEqual([1]);
  });

  it("follows one level of assign, and an escaped assign is safe", () => {
    const content = loop(
      [
        "{% assign t = link.title %}",
        "{{ t }}",
        "{% assign safe = link.title | escape %}",
        "{{ safe }}",
        "{% assign t = 'reset' %}",
        "{{ t }}",
      ].join("\n"),
    );
    expect(detect(content)).toEqual([3]);
  });

  it("reads {% liquid %} blocks line by line (echo is an output too)", () => {
    const content = [
      "{%- liquid",
      "  for link in block.settings.menu.links",
      "    assign label = link.title | upcase",
      "    echo label",
      "    echo link.title | escape",
      "  endfor",
      "-%}",
    ].join("\n");
    expect(detect(content)).toEqual([4]);
  });

  it("ignores prints inside Liquid comments (the caller blanks them)", () => {
    expect(detect(loop("{% comment %}{{ link.title }}{% endcomment %}"))).toEqual([]);
    expect(detect(loop("{% # {{ link.title }} %}"))).toEqual([]);
  });

  it("a file with no menu loop counts nothing, even for a variable named link", () => {
    expect(detect("{{ link.title }}")).toEqual([]);
    expect(detect("")).toEqual([]);
  });

  it("an unterminated tag ends the walk without throwing", () => {
    expect(detect(`${loop("{{ link.title }}")}\n{{ link.title`)).toEqual([2]);
    expect(detect("{% for link in menu.links")).toEqual([]);
  });

  it("one line with two prints is reported once", () => {
    expect(detect(loop("{{ link.title }} {{ link.title }}"))).toEqual([2]);
  });
});

describe("summarizeUnescapedMenuLabels", () => {
  it("sorts files, caps files and lines, and counts every print", () => {
    const hits = Array.from({ length: MENU_LABEL_FILES_CAP + 5 }, (_, i) => ({
      path: `snippets/menu-${String(i).padStart(2, "0")}.liquid`,
      lines: Array.from({ length: MENU_LABEL_LINES_CAP + 3 }, (_, j) => j + 1),
    })).reverse();
    const summary = summarizeUnescapedMenuLabels(hits);
    expect(summary.fileCount).toBe(MENU_LABEL_FILES_CAP + 5);
    expect(summary.outputCount).toBe((MENU_LABEL_FILES_CAP + 5) * (MENU_LABEL_LINES_CAP + 3));
    expect(summary.files).toHaveLength(MENU_LABEL_FILES_CAP);
    expect(summary.files[0].path).toBe("snippets/menu-00.liquid");
    expect(summary.files[0].lines).toHaveLength(MENU_LABEL_LINES_CAP);
  });

  it("empty input: zero counts", () => {
    expect(summarizeUnescapedMenuLabels([])).toEqual({ fileCount: 0, outputCount: 0, files: [] });
  });
});

describe("linear time", () => {
  it.each([
    ["1 MB of unclosed outputs", `${loop("x")}\n${"{{ ".repeat(330_000)}`],
    ["1 MB of prints in a loop", loop("{{ link.title }}\n".repeat(60_000))],
    ["1 MB of loops", "{% for link in menu.links %}{% endfor %}".repeat(25_000)],
    ["1 MB of long indexed paths", loop(`{{ x${"[0]".repeat(300_000)} }}`)],
    ["1 MB of pipes", loop(`{{ link.title ${"| upcase ".repeat(110_000)}}}`)],
  ])("%s stays fast", (_label, content) => {
    const started = Date.now();
    detectUnescapedMenuLabels(content);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
