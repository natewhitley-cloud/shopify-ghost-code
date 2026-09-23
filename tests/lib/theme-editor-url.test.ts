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

  it("builds the editor URL from a domain, GID, and theme file path", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "sections/foo.liquid")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789/editor?key=sections%2Ffoo.liquid",
    );
  });

  it("accepts an already-numeric theme id", () => {
    expect(buildThemeEditorUrl(SHOP, "123456789", "assets/bar.js")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789/editor?key=assets%2Fbar.js",
    );
  });

  it("strips the .myshopify.com suffix case-insensitively for the store handle", () => {
    expect(buildThemeEditorUrl("My-Store.MyShopify.com", GID, "snippets/x.liquid")).toContain(
      "/store/My-Store/themes/",
    );
  });

  it("deep-links an OS 2.0 theme block file (blocks/, gc-zfl)", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "blocks/group.liquid")).toBe(
      "https://admin.shopify.com/store/my-store/themes/123456789/editor?key=blocks%2Fgroup.liquid",
    );
  });

  it("URL-encodes the filename (path separators and special chars)", () => {
    const url = buildThemeEditorUrl(SHOP, GID, "config/settings_data.json");
    expect(url).toContain("key=config%2Fsettings_data.json");
  });

  it("returns null when the theme id is null / undefined / malformed", () => {
    expect(buildThemeEditorUrl(SHOP, null, "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, undefined, "sections/foo.liquid")).toBeNull();
    expect(buildThemeEditorUrl(SHOP, "gid://shopify/Product/1", "sections/foo.liquid")).toBeNull();
  });

  it("returns null when the shop domain is blank", () => {
    expect(buildThemeEditorUrl("", GID, "sections/foo.liquid")).toBeNull();
  });

  it("returns null when the filename is blank", () => {
    expect(buildThemeEditorUrl(SHOP, GID, "")).toBeNull();
  });
});
