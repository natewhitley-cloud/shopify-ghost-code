import { describe, it, expect } from "vitest";

import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromHrefLang,
  identifyAppFromJsonLd,
  identifyAppFromTextFragment,
  identifyAppFromFilename,
  resolveAttribution,
  isTrackerApp,
} from "../../app/services/app-lookup.server";

// ---------------------------------------------------------------------------
// identifyAppFromUrl
// ---------------------------------------------------------------------------

describe("identifyAppFromUrl", () => {
  it("identifies app from exact CDN domain in URL", () => {
    expect(identifyAppFromUrl("https://static.klaviyo.com/onsite/js/klaviyo.js")).toBe("Klaviyo");
  });

  it("identifies app from subdomain of a CDN domain", () => {
    // cdn.judge.me is a direct domain; check that hostname matching works
    expect(identifyAppFromUrl("https://cdn.judge.me/assets/v4/loader.js")).toBe("Judge.me");
  });

  it("does not match a different domain that contains the keyword as a substring", () => {
    // "notaklaviyo.com" should NOT match Klaviyo
    expect(identifyAppFromUrl("https://notaklaviyo.com/script.js")).toBeNull();
  });

  it("falls back to scriptPatterns when hostname does not match CDN list", () => {
    // The UA pattern matches the script path / inline content
    expect(identifyAppFromUrl("https://example.com/analytics.js?UA-12345-1")).toBe(
      "Google Analytics (UA)",
    );
  });

  it("returns null for completely unknown URLs", () => {
    expect(identifyAppFromUrl("https://example.com/totally-unknown.js")).toBeNull();
  });

  it("returns null for malformed URLs without throwing", () => {
    expect(identifyAppFromUrl("not-a-url")).toBeNull();
  });

  it("identifies app from a protocol-relative CDN URL", () => {
    // Regression: protocol-relative URLs previously threw in new URL(), so
    // cdnDomains matching was skipped and the app went unattributed.
    expect(identifyAppFromUrl("//static.klaviyo.com/onsite/js/klaviyo.js")).toBe("Klaviyo");
  });

  it("identifies Hotjar from its CDN domain", () => {
    expect(identifyAppFromUrl("https://static.hotjar.com/c/hotjar.js")).toBe("Hotjar");
  });

  it("identifies Recharge from its CDN domain", () => {
    expect(identifyAppFromUrl("https://cdn.rechargeapps.com/v/rechargejs.js")).toBe("Recharge");
  });

  it("identifies GTM by pattern in URL path", () => {
    expect(identifyAppFromUrl("https://www.googletagmanager.com/gtm.js?id=GTM-ABC123")).toBe(
      "Google Tag Manager",
    );
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromCode
// ---------------------------------------------------------------------------

describe("identifyAppFromCode", () => {
  it("identifies Klaviyo from inline JS identifier", () => {
    expect(identifyAppFromCode("window._klOnsite = window._klOnsite || [];")).toBe("Klaviyo");
  });

  it("identifies Hotjar from inline script block", () => {
    expect(
      identifyAppFromCode(
        "(function(h,o,t,j,a,r){ h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)}; h.hjid=1234567 })",
      ),
    ).toBe("Hotjar");
  });

  it("identifies Facebook Pixel from fbq init call", () => {
    expect(identifyAppFromCode("fbq('init', '123456789');")).toBe("Facebook Pixel (legacy)");
  });

  it("identifies Yotpo from inline script", () => {
    expect(identifyAppFromCode("window.yotpo = window.yotpo || {};")).toBe("Yotpo");
  });

  it("identifies Smile.io from sweetTooth identifier", () => {
    expect(identifyAppFromCode("var sweetTooth = {};")).toBe("Smile.io");
  });

  it("returns null for unknown code", () => {
    expect(identifyAppFromCode("console.log('hello world');")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(identifyAppFromCode("")).toBeNull();
  });

  it("identifies Judge.me from jdgm CSS pattern", () => {
    // cssPatterns are checked after scriptPatterns
    expect(identifyAppFromCode(".jdgm-star { color: gold; }")).toBe("Judge.me");
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromSnippetName
// ---------------------------------------------------------------------------

describe("identifyAppFromSnippetName", () => {
  it("identifies Klaviyo from snippet name", () => {
    expect(identifyAppFromSnippetName("klaviyo-onsite")).toBe("Klaviyo");
  });

  it("is case-insensitive", () => {
    expect(identifyAppFromSnippetName("Klaviyo-Onsite")).toBe("Klaviyo");
    expect(identifyAppFromSnippetName("KLAVIYO-ONSITE")).toBe("Klaviyo");
  });

  it("identifies Recharge from snippet name", () => {
    expect(identifyAppFromSnippetName("recharge-checkout-option")).toBe("Recharge");
  });

  it("identifies PageFly from snippet name", () => {
    expect(identifyAppFromSnippetName("pagefly-head")).toBe("PageFly");
  });

  it("identifies Shogun from snippet name", () => {
    expect(identifyAppFromSnippetName("shogun-head")).toBe("Shogun");
  });

  it("identifies Yotpo from underscored variant", () => {
    expect(identifyAppFromSnippetName("yotpo_reviews")).toBe("Yotpo");
  });

  it("returns null for an unknown snippet name", () => {
    expect(identifyAppFromSnippetName("totally-unknown-snippet")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(identifyAppFromSnippetName("")).toBeNull();
  });

  it("does not match partial snippet names", () => {
    // "klaviyo" alone should NOT match "klaviyo-onsite"
    expect(identifyAppFromSnippetName("klaviyo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromHrefLang
// ---------------------------------------------------------------------------

describe("identifyAppFromHrefLang", () => {
  it("identifies Weglot from weglot.com domain in href", () => {
    expect(identifyAppFromHrefLang("https://cdn.weglot.com/fr/products")).toBe("Weglot");
  });

  it("identifies Weglot from subdomain pattern (fr.example.com)", () => {
    expect(identifyAppFromHrefLang("https://fr.example.com/products")).toBe("Weglot");
  });

  it("identifies Transcy from transcy.io domain", () => {
    expect(identifyAppFromHrefLang("https://cdn.transcy.io/de/products")).toBe("Transcy");
  });

  it("identifies Langify from langify-app.com domain", () => {
    expect(identifyAppFromHrefLang("https://cdn.langify-app.com/es/page")).toBe("Langify");
  });

  it("identifies LangShop from langshop.app domain", () => {
    expect(identifyAppFromHrefLang("https://cdn.langshop.app/ja/page")).toBe("LangShop");
  });

  it("identifies Hextom Translate from hextom.com domain", () => {
    expect(identifyAppFromHrefLang("https://cdn.hextom.com/translate/fr")).toBe("Hextom Translate");
  });

  it("returns null for URLs with no matching translation app pattern", () => {
    expect(identifyAppFromHrefLang("https://example.com/")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(identifyAppFromHrefLang("")).toBeNull();
  });

  it("skips signatures without hrefLangPatterns", () => {
    // Klaviyo has no hrefLangPatterns — should not match even though it has CDN patterns
    expect(identifyAppFromHrefLang("https://static.klaviyo.com/something")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromJsonLd
// ---------------------------------------------------------------------------

describe("identifyAppFromJsonLd", () => {
  it("identifies Judge.me from judge.me URL in JSON-LD content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://judge.me/reviews"}')).toBe(
      "Judge.me",
    );
  });

  it("identifies Judge.me from jdgm reference in JSON-LD content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","provider":"jdgm-widget"}')).toBe("Judge.me");
  });

  it("identifies Loox from loox.io domain in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://loox.io/widget"}')).toBe(
      "Loox",
    );
  });

  it("identifies Yotpo from yotpo reference in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","provider":"yotpo.com/api"}')).toBe("Yotpo");
  });

  it("identifies Stamped.io from stamped reference in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","source":"stamped.io"}')).toBe("Stamped.io");
  });

  it("identifies Trustpilot from trustpilot reference in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://trustpilot.com/review"}')).toBe(
      "Trustpilot",
    );
  });

  it("returns null for content with no matching patterns", () => {
    expect(identifyAppFromJsonLd('{"@type":"Organization","name":"My Store"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(identifyAppFromJsonLd("")).toBeNull();
  });

  it("skips signatures without jsonLdPatterns", () => {
    // Klaviyo has no jsonLdPatterns — should not match
    expect(identifyAppFromJsonLd("klaviyo something")).toBeNull();
  });

  it("identifies Air Reviews from airreviews.io domain in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://airreviews.io/widget"}')).toBe(
      "Air Reviews",
    );
  });

  it("identifies Okendo from okendo.io domain in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://okendo.io/review"}')).toBe(
      "Okendo",
    );
  });

  it("identifies Growave from growave.io domain in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://growave.io/review"}')).toBe(
      "Growave",
    );
  });

  it("identifies Avada SEO Suite from avada.io domain in content", () => {
    expect(identifyAppFromJsonLd('{"@type":"Product","url":"https://avada.io/seo"}')).toBe(
      "Avada SEO Suite",
    );
  });
});

// ---------------------------------------------------------------------------
// New app signature tests
// ---------------------------------------------------------------------------

describe("new app signatures", () => {
  // Flywheel candidates from the 2026-09-22 prod scan.
  it("identifies 17TRACK from its external-call script (protocol-relative)", () => {
    expect(identifyAppFromUrl("//www.17track.net/externalcall.js")).toBe("17TRACK");
  });
  it("identifies CJ Dropshipping from its POD script", () => {
    expect(identifyAppFromUrl("https://frontend.cjdropshipping.com/egg/pod3.js")).toBe(
      "CJ Dropshipping",
    );
  });
  // Merchant Center widget is benign, NOT an app (no uninstall lifecycle), so it
  // must not be attributed: that would mint a false "safe-to-remove" finding.
  it("does NOT attribute the Google Merchant Center widget to any app", () => {
    const url = "https://www.gstatic.com/shopping/merchant/merchantwidget.js";
    expect(identifyAppFromCode(url)).toBeNull();
    expect(identifyAppFromUrl(url)).toBeNull();
  });
  it("does NOT attribute other gstatic assets to any app", () => {
    expect(
      identifyAppFromUrl("https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js"),
    ).toBeNull();
    expect(
      identifyAppFromCode("https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js"),
    ).toBeNull();
  });

  // Pop Convert
  it("identifies Pop Convert from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.popconvert.com/widget.js")).toBe("Pop Convert");
  });
  it("identifies Pop Convert from snippet name", () => {
    expect(identifyAppFromSnippetName("pop-convert")).toBe("Pop Convert");
  });

  // EcomSend
  it("identifies EcomSend from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.ecomsend.com/popup.js")).toBe("EcomSend");
  });
  it("identifies EcomSend from snippet name", () => {
    expect(identifyAppFromSnippetName("ecomsend-popup")).toBe("EcomSend");
  });

  // Avada SEO Suite
  it("identifies Avada SEO Suite from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.avada.io/seo.js")).toBe("Avada SEO Suite");
  });
  it("identifies Avada SEO Suite from snippet name", () => {
    expect(identifyAppFromSnippetName("avada-seo")).toBe("Avada SEO Suite");
  });

  // BOOSTER SEO
  it("identifies BOOSTER SEO from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.boosterapps.com/seo.js")).toBe("BOOSTER SEO");
  });
  it("identifies BOOSTER SEO from snippet name", () => {
    expect(identifyAppFromSnippetName("booster-seo")).toBe("BOOSTER SEO");
  });

  // Pandectes GDPR
  it("identifies Pandectes GDPR from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.pandectes.io/consent.js")).toBe("Pandectes GDPR");
  });
  it("identifies Pandectes GDPR from snippet name", () => {
    expect(identifyAppFromSnippetName("pandectes-consent")).toBe("Pandectes GDPR");
  });

  // Air Reviews
  it("identifies Air Reviews from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.airreviews.io/widget.js")).toBe("Air Reviews");
  });
  it("identifies Air Reviews from snippet name", () => {
    expect(identifyAppFromSnippetName("air-reviews")).toBe("Air Reviews");
  });

  // Okendo
  it("identifies Okendo from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.okendo.io/reviews.js")).toBe("Okendo");
  });
  it("identifies Okendo from snippet name", () => {
    expect(identifyAppFromSnippetName("okendo-reviews")).toBe("Okendo");
  });

  // Growave
  it("identifies Growave from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.growave.io/widget.js")).toBe("Growave");
  });
  it("identifies Growave from snippet name", () => {
    expect(identifyAppFromSnippetName("growave-init")).toBe("Growave");
  });

  // tawk.to
  it("identifies tawk.to from CDN URL", () => {
    expect(identifyAppFromUrl("https://embed.tawk.to/abc123/default")).toBe("tawk.to");
  });
  it("identifies tawk.to from snippet name", () => {
    expect(identifyAppFromSnippetName("tawk-to")).toBe("tawk.to");
  });

  // Microsoft Clarity
  it("identifies Microsoft Clarity from CDN URL", () => {
    expect(identifyAppFromUrl("https://clarity.ms/tag/abc123")).toBe("Microsoft Clarity");
  });
  it("identifies Microsoft Clarity from snippet name", () => {
    expect(identifyAppFromSnippetName("microsoft-clarity")).toBe("Microsoft Clarity");
  });

  // Rebuy — CDN domain match
  it("identifies Rebuy from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.rebuyengine.com/sdk.js")).toBe("Rebuy");
  });

  // Boost AI Search — script pattern match (3 generations)
  it("identifies Boost AI Search from bc-sf-filter script pattern", () => {
    expect(identifyAppFromCode("var bc-sf-filter = {};")).toBe("Boost AI Search");
  });
  it("identifies Boost AI Search from boost-pfs script pattern", () => {
    expect(identifyAppFromCode("boost-pfs.init();")).toBe("Boost AI Search");
  });
  it("identifies Boost AI Search from boost-sd script pattern", () => {
    expect(identifyAppFromCode("boost-sd.render();")).toBe("Boost AI Search");
  });

  // Sumo — CDN domain match
  it("identifies Sumo / BDOW! from CDN URL", () => {
    expect(identifyAppFromUrl("https://load.sumo.com/sumo.js")).toBe("Sumo / BDOW!");
  });

  // Elevar — snippet name match + isTracker
  it("identifies Elevar from snippet name", () => {
    expect(identifyAppFromSnippetName("elevar-head")).toBe("Elevar");
  });
  it("marks Elevar as tracker", () => {
    expect(isTrackerApp("Elevar")).toBe(true);
  });

  // CookieYes — CDN domain match
  it("identifies CookieYes from CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn-cookieyes.com/client_data.js")).toBe("CookieYes");
  });

  // Cookiebot — script pattern match
  it("identifies Cookiebot from script pattern", () => {
    expect(identifyAppFromCode("consent.cookiebot.com/uc.js")).toBe("Cookiebot");
  });

  // Pinterest Pixel — CDN domain match + isTracker
  it("identifies Pinterest Pixel from CDN URL", () => {
    expect(identifyAppFromUrl("https://s.pinimg.com/ct/core.js")).toBe("Pinterest Pixel");
  });
  it("marks Pinterest Pixel as tracker", () => {
    expect(isTrackerApp("Pinterest Pixel")).toBe(true);
  });

  // Frequently Bought Together — snippet name match
  it("identifies Frequently Bought Together from snippet name", () => {
    expect(identifyAppFromSnippetName("cbb-frequently-bought-together")).toBe(
      "Frequently Bought Together",
    );
  });

  // Triple Whale — script pattern match
  it("identifies Triple Whale from script pattern", () => {
    expect(identifyAppFromCode("window.TriplePixel('init');")).toBe("Triple Whale");
  });

  // Consentmo — snippet name match
  it("identifies Consentmo from snippet name", () => {
    expect(identifyAppFromSnippetName("gcm-integration-script")).toBe("Consentmo");
  });

  // GemPages — gemcommerce.com CDN host (subdomain of newly-added domain)
  it("identifies GemPages from assets.gemcommerce.com URL", () => {
    expect(identifyAppFromUrl("https://assets.gemcommerce.com/assets-v2/gp-lazyload.v2.js")).toBe(
      "GemPages",
    );
  });
  it("still identifies GemPages from its existing gempages.net CDN URL", () => {
    expect(identifyAppFromUrl("https://cdn.gempages.net/scripts/gp-global.js")).toBe("GemPages");
  });

  // Zooomy Wishlist
  it("identifies Zooomy Wishlist from CDN URL", () => {
    expect(identifyAppFromUrl("https://zooomyapps.com/wishlist/ListWishlist.js")).toBe(
      "Zooomy Wishlist",
    );
  });
  it("identifies Zooomy Wishlist from a section file path", () => {
    expect(identifyAppFromFilename("sections/zooomy-wishlist.liquid")?.appName).toBe(
      "Zooomy Wishlist",
    );
  });
  it("does not over-match the zooomy filePattern on an unrelated path", () => {
    expect(identifyAppFromFilename("sections/product.liquid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromTextFragment
// ---------------------------------------------------------------------------

describe("identifyAppFromTextFragment", () => {
  it("matches known Judge.me text pattern", () => {
    expect(identifyAppFromTextFragment('<div id="jdgm-widget">')).toBe("Judge.me");
  });

  it("matches Yotpo data attribute", () => {
    expect(identifyAppFromTextFragment('<div data-yotpo-product-id="123">')).toBe("Yotpo");
  });

  it("returns null for unknown text", () => {
    expect(identifyAppFromTextFragment('<div class="my-custom-widget">')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(identifyAppFromTextFragment("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isTrackerApp
// ---------------------------------------------------------------------------

describe("isTrackerApp", () => {
  it("returns true for Google Analytics (UA)", () => {
    expect(isTrackerApp("Google Analytics (UA)")).toBe(true);
  });

  it("returns true for Google Tag Manager", () => {
    expect(isTrackerApp("Google Tag Manager")).toBe(true);
  });

  it("returns true for Hotjar", () => {
    expect(isTrackerApp("Hotjar")).toBe(true);
  });

  it("returns true for Lucky Orange", () => {
    expect(isTrackerApp("Lucky Orange")).toBe(true);
  });

  it("returns true for Facebook Pixel (legacy)", () => {
    expect(isTrackerApp("Facebook Pixel (legacy)")).toBe(true);
  });

  it("returns true for TikTok Pixel", () => {
    expect(isTrackerApp("TikTok Pixel")).toBe(true);
  });

  it("returns true for Microsoft Clarity", () => {
    expect(isTrackerApp("Microsoft Clarity")).toBe(true);
  });

  it("returns false for Klaviyo", () => {
    expect(isTrackerApp("Klaviyo")).toBe(false);
  });

  it("returns false for Judge.me", () => {
    expect(isTrackerApp("Judge.me")).toBe(false);
  });

  it("returns false for unknown app name", () => {
    expect(isTrackerApp("Unknown App")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// identifyAppFromFilename
// ---------------------------------------------------------------------------

describe("identifyAppFromFilename", () => {
  it("matches a Spreadr snippet path", () => {
    expect(identifyAppFromFilename("snippets/spreadr.liquid")?.appName).toBe("Spreadr");
  });

  it("matches a hyphenated Spreadr snippet path", () => {
    expect(identifyAppFromFilename("snippets/spreadr-custom.liquid")?.appName).toBe("Spreadr");
  });

  it("matches a PageFly snippet path", () => {
    expect(identifyAppFromFilename("snippets/pagefly-main-js.liquid")?.appName).toBe("PageFly");
  });

  it("matches an EComposer section path", () => {
    expect(
      identifyAppFromFilename("sections/ecom-default-template-quickview.liquid")?.appName,
    ).toBe("EComposer");
  });

  it("matches a bare EComposer layout path", () => {
    expect(identifyAppFromFilename("layout/ecom.liquid")?.appName).toBe("EComposer");
  });

  it("returns the full signature so callers can read isTracker", () => {
    const sig = identifyAppFromFilename("snippets/spreadr.liquid");
    expect(sig?.isTracker).toBe(false);
    expect(sig?.scriptPatterns).toBeDefined();
  });

  it("does NOT match a near-miss substring in a longer word (spreadrnumors)", () => {
    // The anchored /(^|\/)spreadr[-.]/i requires a `-` or `.` immediately after
    // "spreadr", so "spreadrnumors" does not match.
    expect(identifyAppFromFilename("snippets/spreadrnumors.liquid")).toBeNull();
  });

  it("does NOT match when the app name is buried mid-word", () => {
    expect(identifyAppFromFilename("snippets/myspreadr.liquid")).toBeNull();
  });

  it("returns null for a plain theme file", () => {
    expect(identifyAppFromFilename("layout/theme.liquid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAttribution (precedence rule — spec 4.3)
// ---------------------------------------------------------------------------

describe("resolveAttribution", () => {
  it("null content + Spreadr file → Spreadr, no overridden tracker", () => {
    expect(resolveAttribution(null, "snippets/spreadr.liquid")).toEqual({
      appName: "Spreadr",
      overriddenTracker: null,
    });
  });

  it("tracker content (isTracker signature) + Spreadr file → Spreadr overrides", () => {
    // "Facebook Pixel (legacy)" is a genuine isTracker signature, so the derive
    // path (isTrackerApp) flags it and the file-owner (Spreadr) wins.
    expect(resolveAttribution("Facebook Pixel (legacy)", "snippets/spreadr.liquid")).toEqual({
      appName: "Spreadr",
      overriddenTracker: "Facebook Pixel (legacy)",
    });
  });

  it("tracker content (Google Tag Manager) + PageFly file → PageFly overrides", () => {
    // Exercises the isTrackerApp derive path with a known tracker signature name.
    expect(resolveAttribution("Google Tag Manager", "snippets/pagefly-main-js.liquid")).toEqual({
      appName: "PageFly",
      overriddenTracker: "Google Tag Manager",
    });
  });

  it("specific non-tracker content (Judge.me) + EComposer file → keep Judge.me", () => {
    expect(resolveAttribution("Judge.me", "sections/ecom-default-template.liquid")).toEqual({
      appName: "Judge.me",
      overriddenTracker: null,
    });
  });

  it("agreeing content + file (EComposer + EComposer file) → EComposer", () => {
    expect(resolveAttribution("EComposer", "sections/ecom-default-template.liquid")).toEqual({
      appName: "EComposer",
      overriddenTracker: null,
    });
  });

  it("tracker content + no file match → unchanged", () => {
    expect(resolveAttribution("Facebook Pixel", "layout/theme.liquid")).toEqual({
      appName: "Facebook Pixel",
      overriddenTracker: null,
    });
  });

  it("null content + no file match → null", () => {
    expect(resolveAttribution(null, "layout/theme.liquid")).toEqual({
      appName: null,
      overriddenTracker: null,
    });
  });

  it("honors an explicit contentIsTracker=true override (detectGhostPixels path)", () => {
    // Even if the content app is not in the tracker list, the caller can force
    // tracker semantics — as detectGhostPixels does for every TRACKING_PATTERN.
    expect(
      resolveAttribution("Facebook Pixel", "snippets/spreadr.liquid", { contentIsTracker: true }),
    ).toEqual({ appName: "Spreadr", overriddenTracker: "Facebook Pixel" });
  });
});
