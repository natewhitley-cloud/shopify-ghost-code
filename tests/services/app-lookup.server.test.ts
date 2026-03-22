import { describe, it, expect } from "vitest";

import {
  identifyAppFromUrl,
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromHrefLang,
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
