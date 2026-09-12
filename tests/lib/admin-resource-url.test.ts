/**
 * Tests for app/lib/admin-resource-url.ts (gc-7h9).
 *
 * Strategy:
 *   - Pure functions with no dependencies — test directly.
 *   - numericIdFromGidLocator: GID-embedded-in-locator parsing + null cases.
 *   - buildAdminResourceUrl: the expected URL for every ADMIN_RESOURCE type
 *     (precise-link types with a valid locator, section-level fallback types),
 *     plus the null cases (blank shop, unknown type, unparseable/absent id).
 *   - adminResourceLinkLabel: a label per Admin-resource type.
 *   - Drift guard: every member of ADMIN_RESOURCE_FINDING_TYPES must yield a
 *     non-null URL for a representative valid locator, so a newly-added
 *     Admin-resource type cannot silently get no link.
 */

import { describe, it, expect } from "vitest";

import {
  adminResourceLinkLabel,
  adminResourceLocatorLabel,
  buildAdminResourceUrl,
  numericIdFromGidLocator,
} from "../../app/lib/admin-resource-url";
import { THEME_FILE_TYPE_SETS } from "../../app/lib/finding-classification";

const SHOP = "my-store.myshopify.com";
const ADMIN_BASE = "https://admin.shopify.com/store/my-store";

// A representative valid locator per Admin-resource type — the exact synthetic
// formats the detectors emit (see finding-classification.ts).
const VALID_LOCATOR: Record<string, string> = {
  GHOST_TAG: "products/gid://shopify/Product/123",
  GHOST_PRICE: "products/gid://shopify/Product/123",
  GHOST_METAFIELD: "products/gid://shopify/Product/123/metafields",
  GHOST_PAGE: "pages/summer-sale",
  GHOST_REDIRECT: "redirects/gid://shopify/UrlRedirect/456",
  GHOST_TRANSLATION: "translations/fr/PRODUCT",
};

describe("numericIdFromGidLocator", () => {
  it("extracts the id from a product locator", () => {
    expect(numericIdFromGidLocator("products/gid://shopify/Product/123")).toBe("123");
  });

  it("extracts the id when the GID has a trailing suffix (metafields)", () => {
    expect(numericIdFromGidLocator("products/gid://shopify/Product/123/metafields")).toBe("123");
  });

  it("extracts the id from a redirect locator (different resource type)", () => {
    expect(numericIdFromGidLocator("redirects/gid://shopify/UrlRedirect/456")).toBe("456");
  });

  it("returns null for a handle-only locator (no GID)", () => {
    expect(numericIdFromGidLocator("pages/summer-sale")).toBeNull();
  });

  it("returns null for null / undefined / empty", () => {
    expect(numericIdFromGidLocator(null)).toBeNull();
    expect(numericIdFromGidLocator(undefined)).toBeNull();
    expect(numericIdFromGidLocator("")).toBeNull();
  });

  it("returns null for a malformed GID with no numeric id", () => {
    expect(numericIdFromGidLocator("products/gid://shopify/Product/abc")).toBeNull();
  });
});

describe("buildAdminResourceUrl", () => {
  // ---- precise-link (id / handle-derived) types --------------------------

  it("links GHOST_TAG to the product detail page", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_TAG", VALID_LOCATOR.GHOST_TAG)).toBe(
      `${ADMIN_BASE}/products/123`,
    );
  });

  it("links GHOST_PRICE to the product detail page", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_PRICE", VALID_LOCATOR.GHOST_PRICE)).toBe(
      `${ADMIN_BASE}/products/123`,
    );
  });

  it("links GHOST_METAFIELD to the product detail page (fallback from /metafields)", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_METAFIELD", VALID_LOCATOR.GHOST_METAFIELD)).toBe(
      `${ADMIN_BASE}/products/123`,
    );
  });

  it("links GHOST_PAGE to the storefront page view", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_PAGE", VALID_LOCATOR.GHOST_PAGE)).toBe(
      "https://my-store.myshopify.com/pages/summer-sale",
    );
  });

  it("URL-encodes a page handle with unsafe characters", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_PAGE", "pages/summer sale")).toBe(
      "https://my-store.myshopify.com/pages/summer%20sale",
    );
  });

  // ---- section-level fallback types --------------------------------------

  it("links a single GHOST_REDIRECT to the URL redirects list", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_REDIRECT", VALID_LOCATOR.GHOST_REDIRECT)).toBe(
      `${ADMIN_BASE}/content/redirects`,
    );
  });

  it("links a bulk GHOST_REDIRECT to the URL redirects list", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_REDIRECT", "redirects/bulk/klaviyo-")).toBe(
      `${ADMIN_BASE}/content/redirects`,
    );
  });

  it("links GHOST_TRANSLATION to Settings > Languages", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_TRANSLATION", VALID_LOCATOR.GHOST_TRANSLATION)).toBe(
      `${ADMIN_BASE}/settings/languages`,
    );
  });

  it("still links redirect/translation surfaces when the locator is absent (section-level)", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_REDIRECT", null)).toBe(
      `${ADMIN_BASE}/content/redirects`,
    );
    expect(buildAdminResourceUrl(SHOP, "GHOST_TRANSLATION", "")).toBe(
      `${ADMIN_BASE}/settings/languages`,
    );
  });

  // ---- null cases --------------------------------------------------------

  it("returns null for a blank shop domain", () => {
    expect(buildAdminResourceUrl("", "GHOST_TAG", VALID_LOCATOR.GHOST_TAG)).toBeNull();
  });

  it("returns null for a non-Admin-resource / unknown type", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_SCRIPT", "assets/foo.js")).toBeNull();
    expect(buildAdminResourceUrl(SHOP, "UNKNOWN_TYPE", "whatever")).toBeNull();
  });

  it("returns null for a product type whose locator carries no numeric id", () => {
    expect(
      buildAdminResourceUrl(SHOP, "GHOST_TAG", "products/gid://shopify/Product/abc"),
    ).toBeNull();
    expect(buildAdminResourceUrl(SHOP, "GHOST_TAG", null)).toBeNull();
  });

  it("returns null for a GHOST_PAGE locator with no handle", () => {
    expect(buildAdminResourceUrl(SHOP, "GHOST_PAGE", "pages/")).toBeNull();
    expect(buildAdminResourceUrl(SHOP, "GHOST_PAGE", null)).toBeNull();
  });

  // ---- drift guard -------------------------------------------------------
  // Every Admin-resource type must produce a non-null URL for its representative
  // valid locator. A newly-added ADMIN_RESOURCE_FINDING_TYPES member with no
  // handler (falls through the switch to null) fails here — forcing a deliberate
  // "which surface does this link to?" decision.
  it("produces a non-null URL for every ADMIN_RESOURCE type (drift guard)", () => {
    for (const type of THEME_FILE_TYPE_SETS.adminResource) {
      const locator = VALID_LOCATOR[type];
      expect(locator, `${type} needs a representative locator in this test`).toBeDefined();
      expect(
        buildAdminResourceUrl(SHOP, type, locator),
        `${type} must map to a non-null admin/storefront URL`,
      ).not.toBeNull();
    }
  });
});

describe("adminResourceLinkLabel", () => {
  it.each([
    ["GHOST_TAG", "View product"],
    ["GHOST_PRICE", "View product"],
    ["GHOST_METAFIELD", "View product"],
    ["GHOST_PAGE", "View page"],
    ["GHOST_REDIRECT", "Manage URL redirects"],
    ["GHOST_TRANSLATION", "Open translations"],
  ])("labels %s as %s", (type, label) => {
    expect(adminResourceLinkLabel(type)).toBe(label);
  });

  it("returns a non-empty label for every ADMIN_RESOURCE type (no missing labels)", () => {
    for (const type of THEME_FILE_TYPE_SETS.adminResource) {
      expect(adminResourceLinkLabel(type).length, `${type} must have a label`).toBeGreaterThan(0);
    }
  });
});

describe("adminResourceLocatorLabel", () => {
  // ---- product-backed types (fixed label, locator ignored) ---------------

  it("labels GHOST_TAG as Product", () => {
    expect(adminResourceLocatorLabel("GHOST_TAG", VALID_LOCATOR.GHOST_TAG)).toBe("Product");
  });

  it("labels GHOST_PRICE as Product", () => {
    expect(adminResourceLocatorLabel("GHOST_PRICE", VALID_LOCATOR.GHOST_PRICE)).toBe("Product");
  });

  it("labels GHOST_METAFIELD as Product metafield", () => {
    expect(adminResourceLocatorLabel("GHOST_METAFIELD", VALID_LOCATOR.GHOST_METAFIELD)).toBe(
      "Product metafield",
    );
  });

  // ---- GHOST_PAGE: surface the handle path -------------------------------

  it("labels GHOST_PAGE with its handle path", () => {
    expect(adminResourceLocatorLabel("GHOST_PAGE", "pages/summer-sale")).toBe(
      "Page: /pages/summer-sale",
    );
  });

  it("falls back to the raw locator for a GHOST_PAGE with no handle", () => {
    expect(adminResourceLocatorLabel("GHOST_PAGE", "pages/")).toBe("pages/");
  });

  // ---- GHOST_REDIRECT: single vs bulk ------------------------------------

  it("labels a single GHOST_REDIRECT as URL redirect", () => {
    expect(adminResourceLocatorLabel("GHOST_REDIRECT", VALID_LOCATOR.GHOST_REDIRECT)).toBe(
      "URL redirect",
    );
  });

  it("labels a bulk GHOST_REDIRECT with its prefix", () => {
    expect(adminResourceLocatorLabel("GHOST_REDIRECT", "redirects/bulk/klaviyo-")).toBe(
      "URL redirects: klaviyo-",
    );
  });

  it("restores `/` (stored as `_`) in a bulk GHOST_REDIRECT prefix", () => {
    expect(adminResourceLocatorLabel("GHOST_REDIRECT", "redirects/bulk/collections_summer")).toBe(
      "URL redirects: collections/summer",
    );
  });

  it("labels a bulk GHOST_REDIRECT with an empty prefix as URL redirects", () => {
    expect(adminResourceLocatorLabel("GHOST_REDIRECT", "redirects/bulk/")).toBe("URL redirects");
  });

  // ---- GHOST_TRANSLATION -------------------------------------------------

  it("labels GHOST_TRANSLATION with its locale and resource", () => {
    expect(adminResourceLocatorLabel("GHOST_TRANSLATION", "translations/fr/product")).toBe(
      "Translation: fr / product",
    );
  });

  it("falls back to the raw locator for an unparseable GHOST_TRANSLATION", () => {
    expect(adminResourceLocatorLabel("GHOST_TRANSLATION", "translations/fr")).toBe(
      "translations/fr",
    );
  });

  // ---- unknown / fallback ------------------------------------------------

  it("falls back to the raw locator for an unknown type", () => {
    expect(adminResourceLocatorLabel("GHOST_SCRIPT", "assets/foo.js")).toBe("assets/foo.js");
  });

  it("falls back to the finding type when the locator is blank", () => {
    expect(adminResourceLocatorLabel("SOME_NEW_TYPE", "")).toBe("SOME_NEW_TYPE");
    expect(adminResourceLocatorLabel("SOME_NEW_TYPE", null)).toBe("SOME_NEW_TYPE");
  });

  // ---- drift guard: never blank for a real Admin-resource type -----------
  it("returns a non-empty label for every ADMIN_RESOURCE type", () => {
    for (const type of THEME_FILE_TYPE_SETS.adminResource) {
      const label = adminResourceLocatorLabel(type, VALID_LOCATOR[type]);
      expect(label.length, `${type} must have a non-blank locator label`).toBeGreaterThan(0);
    }
  });
});
