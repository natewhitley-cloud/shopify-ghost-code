/**
 * Tests for app/lib/theme-editor-url.ts
 *
 * Strategy:
 *   - Pure functions, no dependencies — test directly.
 *   - themeIdToNumeric: valid GID, already-numeric, malformed, null/undefined.
 *   - buildThemeEditorUrl: happy path, store-handle extraction, filename
 *     URL-encoding, and every null-returning failure mode (bad theme id, blank
 *     shop domain, blank filename).
 */

import { describe, it, expect } from "vitest";

import { buildThemeEditorUrl, themeIdToNumeric } from "../../app/lib/theme-editor-url";

describe("themeIdToNumeric", () => {
  it("extracts the numeric id from an OnlineStoreTheme GID", () => {
    expect(themeIdToNumeric("gid://shopify/OnlineStoreTheme/123456789")).toBe("123456789");
  });

  it("returns a bare numeric id unchanged", () => {
    expect(themeIdToNumeric("123456789")).toBe("123456789");
  });

  it("returns null for a GID of a different resource type", () => {
    expect(themeIdToNumeric("gid://shopify/Product/123")).toBeNull();
  });

  it("returns null for a malformed / non-numeric GID tail", () => {
    expect(themeIdToNumeric("gid://shopify/OnlineStoreTheme/abc")).toBeNull();
    expect(themeIdToNumeric("gid://shopify/OnlineStoreTheme/")).toBeNull();
    expect(themeIdToNumeric("not-a-gid")).toBeNull();
  });

  it("returns null for null / undefined / empty", () => {
    expect(themeIdToNumeric(null)).toBeNull();
    expect(themeIdToNumeric(undefined)).toBeNull();
    expect(themeIdToNumeric("")).toBeNull();
  });
});

describe("buildThemeEditorUrl", () => {
  const SHOP = "my-store.myshopify.com";
  const GID = "gid://shopify/OnlineStoreTheme/123456789";

  it("builds the code editor URL from a domain, GID, and theme file path", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "sections/foo.liquid")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789?key=sections%2Ffoo.liquid",
    );
  });

  it("accepts an already-numeric theme id", () => {
    expect(buildThemeEditorUrl(SHOP, "123456789", "assets/bar.js")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789?key=assets%2Fbar.js",
    );
  });

  it("strips the .myshopify.com suffix case-insensitively for the store handle", () => {
    expect(buildThemeEditorUrl("My-Store.MyShopify.com", GID, "snippets/x.liquid")).toContain(
      "/store/My-Store/themes/",
    );
  });

  it("deep-links an OS 2.0 theme block file (blocks/, gc-zfl)", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "blocks/group.liquid")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789?key=blocks%2Fgroup.liquid",
    );
  });

  it("URL-encodes the filename (path separators and special chars)", () => {
    const url = buildThemeEditorUrl(SHOP, GID, "config/settings_data.json");
    expect(url).toContain("key=config%2Fsettings_data.json");
  });

  // `/themes/{id}/editor` is the VISUAL customizer, which ignores `key`; the
  // code editor is `/themes/{id}?key=` (verified on a dev store 2026-10-12).
  it.each([
    ["layout/theme.liquid", "layout%2Ftheme.liquid"],
    ["sections/header group.liquid", "sections%2Fheader%20group.liquid"],
    ["templates/product.alt.json", "templates%2Fproduct.alt.json"],
    ["snippets/a&b=c?d#e.liquid", "snippets%2Fa%26b%3Dc%3Fd%23e.liquid"],
  ])("opens the code editor, not the visual customizer, for %s", (filename, encoded) => {
    const url = buildThemeEditorUrl(SHOP, GID, filename);
    expect(url).toBe(`https://admin.shopify.com/store/my-store/themes/123456789?key=${encoded}`);
    expect(url).not.toContain("/editor");
    expect(new URL(url!).pathname).toMatch(/^\/store\/my-store\/themes\/\d+$/);
    // The key round-trips to the exact filename (one query param, no fragment).
    expect([...new URL(url!).searchParams.entries()]).toEqual([["key", filename]]);
    expect(new URL(url!).hash).toBe("");
  });

  it("returns null when the theme id is null / undefined / malformed", () => {
    expect(buildThemeEditorUrl(SHOP, null, "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, undefined, "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, "gid://shopify/Product/1", "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, "", "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, "gid://shopify/OnlineStoreTheme/abc", "x.liquid")).toBeNull();
  });

  it("returns null when the shop domain is blank", () => {
    expect(buildThemeEditorUrl("", GID, "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(".myshopify.com", GID, "sections/foo.liquid")).toBeNull();
  });

  it("returns null when the filename is blank", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "")).toBeNull();
  });
});
