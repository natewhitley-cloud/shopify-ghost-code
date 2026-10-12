/**
 * Tests for app/lib/theme-info.ts (theme health, gc-i6du): the theme's name,
 * version and author from config/settings_schema.json, and vintage vs Online
 * Store 2.0 from the template file names. Pure.
 */
import { describe, it, expect } from "vitest";

import {
  MAX_THEME_INFO_CHARS,
  parseThemeInfo,
  readThemeInfo,
  SETTINGS_SCHEMA_PATH,
} from "../../app/lib/theme-info";

const DAWN_SCHEMA = JSON.stringify([
  {
    name: "theme_info",
    theme_name: "Dawn",
    theme_version: "15.2.0",
    theme_author: "Shopify",
    theme_documentation_url: "https://help.shopify.com/manual/online-store/themes",
    theme_support_url: "https://support.shopify.com/",
  },
  { name: "t:settings_schema.logo.name", settings: [] },
]);

const file = (filename: string, content = "") => ({ filename, content });
const schema = (content: string) => file(SETTINGS_SCHEMA_PATH, content);

describe("readThemeInfo: name, version, author", () => {
  it("reads theme_info from settings_schema.json", () => {
    expect(readThemeInfo([schema(DAWN_SCHEMA), file("templates/index.json", "{}")])).toEqual({
      name: "Dawn",
      version: "15.2.0",
      author: "Shopify",
      architecture: "os2",
    });
  });

  it("finds theme_info wherever it sits in the array", () => {
    const content = JSON.stringify([
      { name: "Colors", settings: [] },
      { name: "theme_info", theme_name: "Debut", theme_version: "17.14.0" },
    ]);
    expect(readThemeInfo([schema(content)])).toMatchObject({
      name: "Debut",
      version: "17.14.0",
      author: null,
    });
  });

  it("tolerates Shopify's leading auto-generated comment", () => {
    const content = `/*\n * IMPORTANT: The contents of this file are auto-generated.\n */\n${DAWN_SCHEMA}`;
    expect(readThemeInfo([schema(content)]).name).toBe("Dawn");
  });

  it.each([
    ["no settings_schema.json", []],
    ["an empty file", [schema("")]],
    ["malformed JSON", [schema("[{ name: theme_info")]],
    ["a root that is not an array", [schema('{"name":"theme_info","theme_name":"X"}')]],
    ["no theme_info entry", [schema('[{"name":"Colors"}]')]],
    ["null and scalar entries", [schema('[null, 3, "theme_info"]')]],
  ])("%s: the three strings are null (never throws)", (_name, files) => {
    expect(readThemeInfo(files)).toEqual({
      name: null,
      version: null,
      author: null,
      architecture: "unknown",
    });
  });

  it("non-string and blank fields are null", () => {
    const content = JSON.stringify([
      { name: "theme_info", theme_name: 42, theme_version: "   ", theme_author: null },
    ]);
    expect(readThemeInfo([schema(content)])).toMatchObject({
      name: null,
      version: null,
      author: null,
    });
  });

  it(`bounds each string to ${MAX_THEME_INFO_CHARS} characters and strips control characters`, () => {
    const content = JSON.stringify([
      {
        name: "theme_info",
        theme_name: "A".repeat(500),
        theme_version: "1.0\u0000\n\t.0",
        theme_author: "  Out   of  the\u0007 Sandbox ",
      },
    ]);
    const info = readThemeInfo([schema(content)]);
    expect(info.name).toHaveLength(MAX_THEME_INFO_CHARS);
    expect(info.version).toBe("1.0 .0");
    expect(info.author).toBe("Out of the Sandbox");
  });

  it("the cap counts code points: an emoji at the boundary is never cut in half", () => {
    // 79 letters + one emoji (2 code units) + more: the 80th character is the emoji.
    const name = `${"a".repeat(79)}\u{1F43E}tail`;
    const info = readThemeInfo([
      schema(JSON.stringify([{ name: "theme_info", theme_name: name }])),
    ]);
    expect(Array.from(info.name!)).toHaveLength(MAX_THEME_INFO_CHARS);
    expect(info.name!.endsWith("\u{1F43E}")).toBe(true);
    // Well-formed: no lone surrogate (which Postgres JSONB would reject).
    expect(() => encodeURIComponent(info.name!)).not.toThrow();
  });

  it("80 emoji stay 80 emoji; lone surrogates in the source are dropped", () => {
    const emoji = "\u{1F43E}".repeat(200);
    const lone = `Dawn\uD83D copy \uDC3E!`;
    const info = readThemeInfo([
      schema(JSON.stringify([{ name: "theme_info", theme_name: emoji, theme_version: lone }])),
    ]);
    expect(Array.from(info.name!)).toHaveLength(MAX_THEME_INFO_CHARS);
    expect(info.name).toBe("\u{1F43E}".repeat(MAX_THEME_INFO_CHARS));
    expect(info.version).toBe("Dawn copy !");
    expect(parseThemeInfo({ name: "x\uD83D", architecture: "os2" })!.name).toBe("x");
  });

  it("markup in a field is kept as plain text (React escapes it on render)", () => {
    const content = JSON.stringify([{ name: "theme_info", theme_name: "<img src=x onerror=1>" }]);
    expect(readThemeInfo([schema(content)]).name).toBe("<img src=x onerror=1>");
  });
});

describe("readThemeInfo: vintage vs Online Store 2.0", () => {
  it("a JSON template makes it Online Store 2.0", () => {
    const files = [file("templates/index.json"), file("templates/page.contact.liquid")];
    expect(readThemeInfo(files).architecture).toBe("os2");
  });

  it("a nested JSON template counts (customers, metaobject)", () => {
    expect(readThemeInfo([file("templates/customers/login.json")]).architecture).toBe("os2");
    expect(readThemeInfo([file("templates/metaobject/lookbook.json")]).architecture).toBe("os2");
  });

  it("only Liquid templates: vintage", () => {
    const files = [
      file("layout/theme.liquid"),
      file("templates/index.liquid"),
      file("templates/product.liquid"),
      file("templates/customers/account.liquid"),
      file("config/settings_data.json", "{}"),
      file("sections/header.liquid"),
    ];
    expect(readThemeInfo(files).architecture).toBe("vintage");
  });

  it("JSON files outside templates/ do not make a theme Online Store 2.0", () => {
    const files = [
      file("templates/index.liquid"),
      file("config/settings_data.json"),
      file("locales/en.default.json"),
      file("sections/footer-group.json"),
      file("assets/templates/x.json"),
    ];
    expect(readThemeInfo(files).architecture).toBe("vintage");
  });

  it("no template files at all: unknown (nothing is claimed)", () => {
    expect(readThemeInfo([]).architecture).toBe("unknown");
    expect(readThemeInfo([file("layout/theme.liquid"), file("assets/app.js")]).architecture).toBe(
      "unknown",
    );
  });
});

describe("parseThemeInfo (Scan.themeInfo)", () => {
  it("round-trips what readThemeInfo produced", () => {
    const info = readThemeInfo([schema(DAWN_SCHEMA), file("templates/index.json")]);
    expect(parseThemeInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
  });

  it.each([
    ["null (legacy scan)", null],
    ["undefined", undefined],
    ["a string", "Dawn"],
    ["an array", ["Dawn"]],
    ["an unknown architecture", { name: "Dawn", architecture: "os3" }],
    ["no architecture", { name: "Dawn" }],
  ])("%s: null", (_name, raw) => {
    expect(parseThemeInfo(raw)).toBeNull();
  });

  it("re-bounds strings and drops non-strings from a hand-edited row", () => {
    expect(
      parseThemeInfo({
        name: "B".repeat(300),
        version: 7,
        author: "x\u0000y",
        architecture: "vintage",
        extra: "ignored",
      }),
    ).toEqual({
      name: "B".repeat(MAX_THEME_INFO_CHARS),
      version: null,
      author: "x y",
      architecture: "vintage",
    });
  });
});
