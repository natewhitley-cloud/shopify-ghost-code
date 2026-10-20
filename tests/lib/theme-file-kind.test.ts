import { describe, it, expect } from "vitest";

import { classifyThemeFile } from "../../app/lib/theme-file-kind";

describe("classifyThemeFile (gc-rrh.4, spec 2.4)", () => {
  it.each([
    "layout/theme.liquid",
    "layout/password.liquid",
    "snippets/klaviyo-onsite.liquid",
    "sections/header.liquid",
    "blocks/text.liquid",
    "templates/product.liquid",
    "templates/customers/account.liquid",
    "assets/theme.js",
    "assets/base.css",
    "assets/theme.js.liquid",
    "assets/theme.css.liquid",
    "assets/theme.scss.liquid",
    "assets/THEME.JS",
    "config/settings_schema.json",
  ])("code: %s", (path) => {
    expect(classifyThemeFile(path)).toBe("code");
  });

  it.each([
    "config/settings_data.json",
    "templates/index.json",
    "templates/product.special.json",
    "templates/customers/account.json",
    "sections/header-group.json",
    "sections/footer-group.json",
  ])("editor data (never counted): %s", (path) => {
    expect(classifyThemeFile(path)).toBe("editor_data");
  });

  it.each(["locales/en.default.json", "locales/fr.json", "locales/en.default.schema.json"])(
    "locale (never counted): %s",
    (path) => {
      expect(classifyThemeFile(path)).toBe("locale");
    },
  );

  it.each([
    "assets/logo.png",
    "assets/hero.webp",
    "assets/font.woff2",
    "assets/icon.svg",
    "assets/data.json",
    "assets/theme.js.map",
  ])("static (binary and other assets): %s", (path) => {
    expect(classifyThemeFile(path)).toBe("static");
  });

  it.each([
    "",
    "theme.liquid",
    "/layout/theme.liquid",
    "layout/",
    "config/markets.json",
    "blocks/group.json",
    "locales/readme.txt",
    "templates/page.html",
    "sections/notes.txt",
    "unknown/file.liquid",
  ])("other (never guessed into a counted kind): %j", (path) => {
    expect(classifyThemeFile(path)).toBe("other");
  });
});
