import type { LookupAddress } from "node:dns";

import { Agent, fetch as undiciFetch } from "undici";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { logger } from "../../app/lib/logger.server";
import {
  createGuardedLookup,
  fetchStorefrontScriptTags,
  isBareHostname,
  isBlockedAddress,
  isPasswordPageHtml,
  isShopifyStorefrontHtml,
  MAX_ASYNC_LOAD_CANDIDATES,
  parseScriptTagUrls,
  STOREFRONT_MAX_BODY_BYTES,
  type StorefrontFetch,
  STOREFRONT_USER_AGENT,
} from "../../app/services/storefront-fetcher.server";

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Real undici, with fetch + Agent wrapped in spies so the dark path can prove
// the default network stack is never touched.
vi.mock("undici", async (importOriginal) => {
  const real = await importOriginal<typeof import("undici")>();
  return {
    ...real,
    fetch: vi.fn((...args: Parameters<typeof real.fetch>) => real.fetch(...args)),
    Agent: vi.fn(function (this: unknown, opts: ConstructorParameters<typeof real.Agent>[0]) {
      return new real.Agent(opts);
    }),
  };
});

const SHOP_ID = "shop-1";
const PRIMARY = "pawnaturals.com";
const MYSHOPIFY = "paw-naturals-llc.myshopify.com";

// Verbatim shape of the real pawnaturals.com content_for_header block.
const REAL_BLOCK = `<script>(function() {
  var isLoaded = false;
  function asyncLoad() {
    if (isLoaded) return;
    isLoaded = true;
    var urls = ["https:\\/\\/www.magisto.com\\/media\\/shopify\\/magisto.js?shop=paw-naturals-llc.myshopify.com","https:\\/\\/str.rise-ai.com\\/?shop=paw-naturals-llc.myshopify.com","https:\\/\\/d5zu2f4xvqanl.cloudfront.net\\/42\\/fe\\/loader_2.js?shop=paw-naturals-llc.myshopify.com","https:\\/\\/static.klaviyo.com\\/onsite\\/js\\/klaviyo.js?company_id=MEqSVx&shop=paw-naturals-llc.myshopify.com","https:\\/\\/cdn.pushowl.com\\/latest\\/sdks\\/pushowl-shopify.js?subdomain=paw-naturals-llc&environment=production&guid=9ba1f5ec-5ec0-409b-b53c-d4820e1babb6&shop=paw-naturals-llc.myshopify.com"];
    for (var i = 0; i < urls.length; i++) {
      var s = document.createElement('script');
      s.src = urls[i];
    }
  };
  if(window.attachEvent) { window.attachEvent('onload', asyncLoad); } else { window.addEventListener('load', asyncLoad, false); }
})();</script>`;

const SHOPIFY_MARKERS = `<script>var Shopify = Shopify || {};\nShopify.shop = "${MYSHOPIFY}";\nwindow.ShopifyAnalytics = window.ShopifyAnalytics || {};</script>`;

function page(body: string): string {
  return `<!doctype html><html><head>${SHOPIFY_MARKERS}${body}</head><body class="template-index"></body></html>`;
}

// Shopify's wiring: the real block always hooks asyncLoad to window load.
const WIRING = `if(window.attachEvent) { window.attachEvent('onload', asyncLoad); } else { window.addEventListener('load', asyncLoad, false); }`;

function asyncLoadWith(arrayLiteral: string, wiring: string = WIRING): string {
  return `<script>(function() { function asyncLoad() { var urls = ${arrayLiteral}; }; ${wiring} })();</script>`;
}

/** A page with `before` ahead of the Shopify.shop marker and `after` behind it. */
function pageAround(before: string, after: string): string {
  return `<!doctype html><html><head>${before}${SHOPIFY_MARKERS}${after}</head><body></body></html>`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseScriptTagUrls", () => {
  it("parses the real block, unescaping \\/ and keeping & in queries", () => {
    const urls = parseScriptTagUrls(page(REAL_BLOCK));
    expect(urls).toHaveLength(5);
    expect(urls?.[0]).toBe(
      "https://www.magisto.com/media/shopify/magisto.js?shop=paw-naturals-llc.myshopify.com",
    );
    expect(urls?.[3]).toBe(
      "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=MEqSVx&shop=paw-naturals-llc.myshopify.com",
    );
  });

  it("parses a single URL", () => {
    expect(parseScriptTagUrls(page(asyncLoadWith('["https:\\/\\/a.example.com\\/x.js"]')))).toEqual(
      ["https://a.example.com/x.js"],
    );
  });

  it("returns [] for an empty array", () => {
    expect(parseScriptTagUrls(page(asyncLoadWith("[]")))).toEqual([]);
  });

  it("returns [] (zero ScriptTags) when there is no asyncLoad block", () => {
    expect(parseScriptTagUrls(page("<script>console.log(1)</script>"))).toEqual([]);
  });

  it("returns null for malformed JSON", () => {
    expect(parseScriptTagUrls(page(asyncLoadWith('["https://a.example.com/x.js",]')))).toBeNull();
    expect(parseScriptTagUrls(page(asyncLoadWith("['https://single-quoted.js']")))).toBeNull();
  });

  it("returns null when the array never closes", () => {
    expect(
      parseScriptTagUrls(
        page(`<script>function asyncLoad() { ${WIRING} var urls = ["https://a.js"`),
      ),
    ).toBeNull();
  });

  it("returns null for non-string entries", () => {
    expect(parseScriptTagUrls(page(asyncLoadWith('["https://a.js", 42]')))).toBeNull();
    expect(parseScriptTagUrls(page(asyncLoadWith('[{"src":"https://a.js"}]')))).toBeNull();
  });

  it("returns null when asyncLoad has no urls declaration (unknown format, never zero)", () => {
    expect(
      parseScriptTagUrls(page("<script>function asyncLoad() { doSomething(); }</script>")),
    ).toBeNull();
    expect(
      parseScriptTagUrls(
        page(`<script>function asyncLoad() { doSomething(); }; ${WIRING}</script>`),
      ),
    ).toBeNull();
  });

  it("handles brackets inside URL strings", () => {
    expect(parseScriptTagUrls(page(asyncLoadWith('["https://a.example.com/x.js?a=[1]"]')))).toEqual(
      ["https://a.example.com/x.js?a=[1]"],
    );
  });

  it("finds the block among other scripts", () => {
    const html = page(
      `<script>window.foo = [1,2,3];</script>${REAL_BLOCK}<script>var bar = {"a":[1]};</script>`,
    );
    expect(parseScriptTagUrls(html)).toHaveLength(5);
  });

  it("takes the asyncLoad urls, ignoring other `var urls` declarations before and after", () => {
    const html = page(
      `<script>var urls = ["https://theme-before.example.com/a.js"];</script>${asyncLoadWith(
        '["https://scripttag.example.com/b.js"]',
      )}<script>var urls = ["https://theme-after.example.com/c.js"];</script>`,
    );
    expect(parseScriptTagUrls(html)).toEqual(["https://scripttag.example.com/b.js"]);
  });

  it("does not read a `var urls` from a later script when asyncLoad's script lacks one", () => {
    const html = page(
      `<script>function asyncLoad() { noop(); }</script><script>var urls = ["https://other.js"];</script>`,
    );
    expect(parseScriptTagUrls(html)).toBeNull();
  });

  describe("choosing Shopify's block among lookalikes (gc-ux0y)", () => {
    const LOOKALIKE = asyncLoadWith('["https://theme-lookalike.example.com/a.js"]');
    const REAL = asyncLoadWith('["https://scripttag.example.com/b.js"]');

    it("takes the wired block after the Shopify.shop marker over a wired lookalike before it", () => {
      expect(parseScriptTagUrls(pageAround(LOOKALIKE, REAL))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
    });

    it("takes the first wired block after the marker over a wired lookalike after it", () => {
      expect(parseScriptTagUrls(pageAround("", `${REAL}${LOOKALIKE}`))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
    });

    it("skips an unwired lookalike that comes first after the marker", () => {
      const unwired = asyncLoadWith('["https://theme-lookalike.example.com/a.js"]', "");
      expect(parseScriptTagUrls(pageAround("", `${unwired}${REAL}`))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
    });

    it("skips a lookalike wired to a different function or event", () => {
      const otherFn = asyncLoadWith(
        '["https://theme-lookalike.example.com/a.js"]',
        "window.addEventListener('load', asyncLoadLater, false);",
      );
      const otherEvent = asyncLoadWith(
        '["https://theme-lookalike.example.com/a.js"]',
        "window.addEventListener('scroll', asyncLoad, false);",
      );
      expect(parseScriptTagUrls(pageAround("", `${otherFn}${otherEvent}${REAL}`))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
    });

    it("accepts the attachEvent-only and double-quoted wiring forms", () => {
      for (const wiring of [
        "window.attachEvent('onload', asyncLoad);",
        'window.addEventListener("load", asyncLoad, false);',
        "window.addEventListener( 'load' ,asyncLoad,false);",
      ]) {
        expect(
          parseScriptTagUrls(page(asyncLoadWith('["https://a.example.com/x.js"]', wiring))),
        ).toEqual(["https://a.example.com/x.js"]);
      }
    });

    it("falls back to a wired block before the marker when none comes after it", () => {
      expect(parseScriptTagUrls(pageAround(REAL, ""))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
    });

    it("returns null (never zero, never the theme's URLs) when no asyncLoad is wired", () => {
      const unwired = asyncLoadWith('["https://theme-lookalike.example.com/a.js"]', "");
      expect(parseScriptTagUrls(page(unwired))).toBeNull();
    });

    it(`examines at most ${MAX_ASYNC_LOAD_CANDIDATES} candidates, then reads as unreadable`, () => {
      expect(MAX_ASYNC_LOAD_CANDIDATES).toBe(10);
      const unwired = asyncLoadWith('["https://theme-lookalike.example.com/a.js"]', "");
      const within = unwired.repeat(MAX_ASYNC_LOAD_CANDIDATES - 1);
      expect(parseScriptTagUrls(pageAround("", `${within}${REAL}`))).toEqual([
        "https://scripttag.example.com/b.js",
      ]);
      const past = unwired.repeat(MAX_ASYNC_LOAD_CANDIDATES);
      expect(parseScriptTagUrls(pageAround("", `${past}${REAL}`))).toBeNull();
    });

    it("known limitation: a fake marker plus a wired lookalike ahead of the real block wins", () => {
      // Pins current behaviour (documented on parseScriptTagUrls): merchant
      // head markup before content_for_header can steer the parser.
      const fakeMarker = `<script>Shopify.shop = "fake.myshopify.com";</script>`;
      expect(parseScriptTagUrls(pageAround(`${fakeMarker}${LOOKALIKE}`, REAL))).toEqual([
        "https://theme-lookalike.example.com/a.js",
      ]);
    });

    it("known limitation: enough wired lookalikes ahead of the real block exhaust the cap", () => {
      const wired = LOOKALIKE.repeat(MAX_ASYNC_LOAD_CANDIDATES);
      expect(parseScriptTagUrls(pageAround(wired, REAL))).toEqual([
        "https://theme-lookalike.example.com/a.js",
      ]);
    });

    it("stays fast on a page of unterminated lookalikes", () => {
      const hostile = pageAround("", "<script>function asyncLoad() {".repeat(50_000));
      const started = Date.now();
      expect(parseScriptTagUrls(hostile)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("parses the real pawnaturals block placed after a wired lookalike", () => {
      expect(parseScriptTagUrls(pageAround(LOOKALIKE, REAL_BLOCK))).toHaveLength(5);
    });
  });

  it("reads a page whose only `var urls` is outside asyncLoad as zero", () => {
    expect(parseScriptTagUrls(page(`<script>var urls = ["https://theme.js"];</script>`))).toEqual(
      [],
    );
  });
});

describe("isPasswordPageHtml (linear time)", () => {
  // A 5 MB body is the cap, and a regex cannot be interrupted by the fetch
  // timeout, so every adversarial shape must finish fast (audit: the old
  // `<form\b[^>]*?\saction` regex was quadratic on repeated `<form `).
  const NEAR_CAP = STOREFRONT_MAX_BODY_BYTES - 1024;
  it.each([
    ["repeated `<form `", "<form "],
    ["repeated `<form action=`", "<form action="],
    ["repeated `<form` with long attributes", `<form ${"a".repeat(500)} `],
    ["`<form` then one long tag", "<form x"],
    ["repeated `<FORM `", "<FORM "],
  ])("handles 5 MB of %s well under 200 ms", (_label, unit) => {
    const body = unit.repeat(Math.floor(NEAR_CAP / unit.length));
    const started = performance.now();
    expect(isPasswordPageHtml(body)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("still finds the password form after many ordinary forms", () => {
    const forms = '<form action="/cart/add" method="post"></form>'.repeat(300);
    expect(isPasswordPageHtml(`${forms}<form method="post" action="/password">`)).toBe(true);
  });

  it("ignores a `<form` whose tag never closes within 2 KB", () => {
    expect(isPasswordPageHtml(`<form ${"x".repeat(3000)} action="/password">`)).toBe(false);
  });

  it("does not take `<formula` or `<form-field` for a form tag", () => {
    expect(isPasswordPageHtml('<formula action="/password">')).toBe(false);
    expect(isPasswordPageHtml('<form-field action="/password">')).toBe(false);
  });
});

describe("isShopifyStorefrontHtml", () => {
  it("recognizes the Shopify.shop marker", () => {
    expect(isShopifyStorefrontHtml(page(""))).toBe(true);
  });

  it("rejects a non-Shopify page", () => {
    expect(isShopifyStorefrontHtml("<html><body>Hello from WordPress</body></html>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

function makeAdmin(
  shop: unknown = {
    primaryDomain: { host: PRIMARY, url: `https://${PRIMARY}` },
    myshopifyDomain: MYSHOPIFY,
  },
  role: string | null = "MAIN",
) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({ data: { shop, theme: role === null ? null : { role } } }),
    })),
  };
}

const THEME_ID = "gid://shopify/OnlineStoreTheme/1";

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function redirect(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

describe("fetchStorefrontScriptTags", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  const run = (admin = makeAdmin(), timeoutMs?: number) =>
    fetchStorefrontScriptTags(admin, {
      shopId: SHOP_ID,
      themeId: THEME_ID,
      fetchImpl: fetchImpl as unknown as StorefrontFetch,
      timeoutMs,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCRIPT_TAG_SUNSET_LIVE_ENABLED = "true";
    fetchImpl = vi.fn();
  });

  afterEach(() => {
    delete process.env.SCRIPT_TAG_SUNSET_LIVE_ENABLED;
  });

  describe("flag off (dark)", () => {
    it.each([[undefined], ["false"], ["1"], ["TRUE"]])(
      "SCRIPT_TAG_SUNSET_LIVE_ENABLED=%j: zero fetch calls and zero Admin calls",
      async (value) => {
        if (value === undefined) delete process.env.SCRIPT_TAG_SUNSET_LIVE_ENABLED;
        else process.env.SCRIPT_TAG_SUNSET_LIVE_ENABLED = value;
        const globalFetch = vi.spyOn(globalThis, "fetch");
        const admin = makeAdmin();
        try {
          // No fetchImpl: the default (undici) path must also stay untouched.
          const result = await fetchStorefrontScriptTags(admin, {
            shopId: SHOP_ID,
            themeId: THEME_ID,
          });
          expect(result).toEqual({ status: "disabled" });
          expect(globalFetch).not.toHaveBeenCalled();
          expect(undiciFetch).not.toHaveBeenCalled();
          expect(Agent).not.toHaveBeenCalled();
          expect(admin.graphql).not.toHaveBeenCalled();
          expect(logger.info).not.toHaveBeenCalled();
        } finally {
          globalFetch.mockRestore();
        }
      },
    );
  });

  it("reads the primary domain homepage only, with an honest UA and manual redirects", async () => {
    fetchImpl.mockResolvedValue(html(page(REAL_BLOCK)));
    const admin = makeAdmin();
    const result = await run(admin);

    expect(result).toEqual({
      status: "ok",
      host: PRIMARY,
      urls: parseScriptTagUrls(page(REAL_BLOCK)),
    });
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`https://${PRIMARY}/`);
    expect(init.redirect).toBe("manual");
    expect(init.headers["User-Agent"]).toBe(STOREFRONT_USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Every request goes through the guarded undici Agent.
    expect(init.dispatcher).toBeDefined();
    expect(Agent).toHaveBeenCalledTimes(1);
    // The Admin query asks for the scanned theme's role.
    expect(admin.graphql.mock.calls[0]).toEqual([
      expect.stringContaining("theme(id: $themeId)"),
      { variables: { themeId: THEME_ID } },
    ]);
  });

  describe("published theme only", () => {
    it.each([["UNPUBLISHED"], ["DEVELOPMENT"], ["DEMO"], [null]])(
      "role %j: not_published, no request, no log",
      async (role) => {
        const result = await run(makeAdmin(undefined, role));
        expect(result).toEqual({ status: "not_published" });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(Agent).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
      },
    );
  });

  describe("address guard (M1)", () => {
    it.each([["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["0.0.0.0"], ["1.2.3.4"]])(
      "rejects an IP-literal primary host %s before any request",
      async (ip) => {
        const result = await run(
          makeAdmin({
            primaryDomain: { host: ip, url: `https://${ip}` },
            myshopifyDomain: MYSHOPIFY,
          }),
        );
        expect(result).toEqual({ status: "unreachable", reason: "no_domain" });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it("refuses at connect time when the name resolves to a private address (real undici fetch)", async () => {
      const dnsLookup = vi.fn(
        (_host: string, _opts: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
          cb(null, [{ address: "127.0.0.1", family: 4 }]),
      );
      const result = await fetchStorefrontScriptTags(makeAdmin(), {
        shopId: SHOP_ID,
        themeId: THEME_ID,
        dnsLookup,
      });
      expect(result).toEqual({ status: "unreachable", reason: "blocked_address" });
      expect(dnsLookup).toHaveBeenCalledWith(
        PRIMARY,
        expect.objectContaining({ all: true }),
        expect.any(Function),
      );
      expect(undiciFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to primaryDomain.host when url is missing", async () => {
    fetchImpl.mockResolvedValue(html(page("")));
    await run(makeAdmin({ primaryDomain: { host: PRIMARY }, myshopifyDomain: MYSHOPIFY }));
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://${PRIMARY}/`);
  });

  it("returns ok with zero URLs for a Shopify page with no asyncLoad block", async () => {
    fetchImpl.mockResolvedValue(html(page("")));
    expect(await run()).toEqual({ status: "ok", host: PRIMARY, urls: [] });
  });

  describe("unreachable", () => {
    it.each([
      ["no shop data", null],
      ["no primary domain", { primaryDomain: null, myshopifyDomain: MYSHOPIFY }],
      [
        "a host that is not a bare hostname",
        { primaryDomain: { host: "evil.com/path", url: "not a url" }, myshopifyDomain: MYSHOPIFY },
      ],
    ])("no_domain: %s (no request made)", async (_label, shop) => {
      expect(await run(makeAdmin(shop))).toEqual({ status: "unreachable", reason: "no_domain" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("no_domain when the Admin query throws", async () => {
      const admin = { graphql: vi.fn(async () => Promise.reject(new Error("throttled"))) };
      expect(await run(admin)).toEqual({ status: "unreachable", reason: "no_domain" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("password page by final path (redirect to /password)", async () => {
      fetchImpl
        .mockResolvedValueOnce(redirect(`https://${PRIMARY}/password`, 302))
        .mockResolvedValueOnce(html("<html><body>Enter store using password</body></html>"));
      expect(await run()).toEqual({ status: "unreachable", reason: "password" });
    });

    describe("password page by its form (served at /, no template class)", () => {
      // The live markers (verified on 2 password-protected stores, 2026-10-08):
      // form action="/password", id="password" and name="password" inputs.
      const passwordPage = (form: string) =>
        html(
          `<html><head>${SHOPIFY_MARKERS}</head><body class="password-page">${form}<input type="password" name="password" id="password"></form></body></html>`,
        );

      it.each([
        ['<form method="post" action="/password" id="login_form" accept-charset="UTF-8">'],
        ["<form method='post' action='/password'>"],
        ['<form method="post"\n      action = "/password"\n>'],
        ['<FORM METHOD="post" ACTION="/password">'],
        ["<form action=/password method=post>"],
        ['<form action="/password/">'],
      ])("detects %s", async (form) => {
        fetchImpl.mockResolvedValue(passwordPage(form));
        expect(await run()).toEqual({ status: "unreachable", reason: "password" });
      });

      it.each([
        // The customer-account login form on a normal storefront.
        [
          '<form method="post" action="/account/login" id="customer_login"><input type="password" name="customer[password]" id="CustomerPassword"></form>',
        ],
        ['<form method="post" action="/account/password">'],
        ['<form method="post" action="/password-reset">'],
        ['<form method="post" action="/passwords">'],
        ['<form data-action="/password" action="/cart">'],
        ['<a href="/password">Store password</a>'],
        ['<form action="/search">Forgot your password? action="/password"</form>'],
      ])("does not flag a normal storefront with %s", async (markup) => {
        fetchImpl.mockResolvedValue(html(page(`${REAL_BLOCK}</head><body>${markup}`)));
        expect((await run()).status).toBe("ok");
      });
    });

    it("password page by body class", async () => {
      fetchImpl.mockResolvedValue(
        html(
          `<html><head>${SHOPIFY_MARKERS}</head><body class="template-password">Opening soon</body></html>`,
        ),
      );
      expect(await run()).toEqual({ status: "unreachable", reason: "password" });
    });

    it.each([[404], [500], [503], [401]])("http_status for a %i", async (status) => {
      fetchImpl.mockResolvedValue(html(page(REAL_BLOCK), status));
      expect(await run()).toEqual({ status: "unreachable", reason: "http_status" });
    });

    it("not_shopify for a 200 HTML page without a Shopify marker", async () => {
      fetchImpl.mockResolvedValue(html(`<html><head>${REAL_BLOCK}</head></html>`));
      expect(await run()).toEqual({ status: "unreachable", reason: "not_shopify" });
    });

    it("parse_failed (never zero) when the block is malformed", async () => {
      fetchImpl.mockResolvedValue(html(page(asyncLoadWith('["https://a.js", 7]'))));
      expect(await run()).toEqual({ status: "unreachable", reason: "parse_failed" });
    });

    it("network for a fetch rejection", async () => {
      fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
      expect(await run()).toEqual({ status: "unreachable", reason: "network" });
    });

    it("timeout when the request outlives the budget", async () => {
      fetchImpl.mockImplementation(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      expect(await run(makeAdmin(), 20)).toEqual({ status: "unreachable", reason: "timeout" });
    });

    it("too_large when the declared content-length is over the cap", async () => {
      fetchImpl.mockResolvedValue(
        html(page(""), 200, { "content-length": String(STOREFRONT_MAX_BODY_BYTES + 1) }),
      );
      expect(await run()).toEqual({ status: "unreachable", reason: "too_large" });
    });

    it("too_large when the streamed body passes the cap (no content-length)", async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(97);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent++;
          if (sent > 8) controller.close();
          else controller.enqueue(chunk);
        },
      });
      fetchImpl.mockResolvedValue(new Response(stream, { status: 200 }));
      expect(await run()).toEqual({ status: "unreachable", reason: "too_large" });
      // Stopped reading once over the cap (5 MB = 5 chunks, the 6th crosses it).
      expect(sent).toBeLessThanOrEqual(7);
    });
  });

  describe("redirects", () => {
    it("follows a redirect to the myshopify host", async () => {
      fetchImpl
        .mockResolvedValueOnce(redirect(`https://${MYSHOPIFY}/`))
        .mockResolvedValueOnce(html(page(REAL_BLOCK)));
      const result = await run();
      expect(result.status).toBe("ok");
      expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://${MYSHOPIFY}/`);
    });

    it("follows a relative redirect on the primary host", async () => {
      fetchImpl
        .mockResolvedValueOnce(redirect("/en"))
        .mockResolvedValueOnce(html(page(REAL_BLOCK)));
      expect((await run()).status).toBe("ok");
      expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://${PRIMARY}/en`);
    });

    it.each([
      ["a foreign host", "https://evil.example.com/"],
      ["a lookalike subdomain", `https://${PRIMARY}.evil.com/`],
      ["a subdomain of the primary host", `https://shop.${PRIMARY}/`],
      ["a market domain the shop may own", "https://pawnaturals.ca/"],
    ])("refuses a redirect to %s as redirect_other_domain", async (_label, location) => {
      fetchImpl.mockResolvedValueOnce(redirect(location));
      expect(await run()).toEqual({ status: "unreachable", reason: "redirect_other_domain" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
      expect(logged).toContain('"reason":"redirect_other_domain"');
    });

    it.each([
      ["plain http", `http://${PRIMARY}/`],
      ["plain http to another domain", "http://evil.example.com/"],
      ["an IP-literal host", "https://23.227.38.65/"],
      ["a non-default port on another domain", "https://evil.example.com:8443/"],
      ["an internal address", "https://169.254.169.254/latest/meta-data"],
      ["credentials in the URL", `https://user:pass@${PRIMARY}/`],
      ["a non-default port", `https://${PRIMARY}:8443/`],
      ["no Location header", ""],
    ])("refuses a redirect to %s", async (_label, location) => {
      fetchImpl.mockResolvedValueOnce(
        location ? redirect(location) : new Response(null, { status: 302 }),
      );
      expect(await run()).toEqual({ status: "unreachable", reason: "redirect_refused" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("follows at most 3 redirects", async () => {
      fetchImpl.mockResolvedValue(redirect(`https://${PRIMARY}/loop`));
      expect(await run()).toEqual({ status: "unreachable", reason: "too_many_redirects" });
      // The original request + 3 followed redirects; the 4th Location is refused.
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("accepts exactly 3 redirects", async () => {
      fetchImpl
        .mockResolvedValueOnce(redirect(`https://${PRIMARY}/a`))
        .mockResolvedValueOnce(redirect(`https://${PRIMARY}/b`))
        .mockResolvedValueOnce(redirect(`https://${MYSHOPIFY}/`))
        .mockResolvedValueOnce(html(page("")));
      expect(await run()).toEqual({ status: "ok", host: PRIMARY, urls: [] });
    });
  });

  describe("logging (PII)", () => {
    const allLogged = () =>
      JSON.stringify([
        ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]);

    it("logs host + outcome only on success: no query strings, URLs, or HTML", async () => {
      fetchImpl.mockResolvedValue(html(page(REAL_BLOCK)));
      await run();
      const logged = allLogged();
      expect(logged).toContain(PRIMARY);
      expect(logged).toContain('"scriptTagCount":5');
      expect(logged).not.toContain("?");
      expect(logged).not.toContain("shop=");
      expect(logged).not.toContain("klaviyo");
      expect(logged).not.toContain("9ba1f5ec");
      expect(logged).not.toContain("<script");
    });

    it("logs only the reason on an unreachable outcome", async () => {
      fetchImpl.mockResolvedValue(html(page(asyncLoadWith('["https://a.js?token=SECRET", 7]'))));
      await run();
      const logged = allLogged();
      expect(logged).toContain("parse_failed");
      expect(logged).not.toContain("SECRET");
      expect(logged).not.toContain("?");
    });
  });
});

describe("isBareHostname", () => {
  it.each([
    ["pawnaturals.com"],
    ["shop.example.co.uk"],
    ["paw-naturals-llc.myshopify.com"],
    ["123shop.com"],
  ])("accepts %s", (host) => expect(isBareHostname(host)).toBe(true));

  it.each([
    ["127.0.0.1"],
    ["10.0.0.1"],
    ["0x7f.1"],
    ["1.2.3.4"],
    ["[::1]"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["localhost"],
    ["evil.com/path"],
    ["user@evil.com"],
    ["evil.com:8080"],
  ])("rejects %s", (host) => expect(isBareHostname(host)).toBe(false));
});

describe("isBlockedAddress", () => {
  it.each([
    ["0.1.2.3"],
    ["10.0.0.1"],
    ["100.64.0.1"],
    ["100.127.255.254"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.168.1.1"],
    ["224.0.0.1"],
    ["239.255.255.250"],
    ["255.255.255.255"],
    ["::"],
    ["::1"],
    ["fc00::1"],
    ["fd12:3456::1"],
    ["fe80::1"],
    ["ff02::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:10.0.0.1"],
    ["::ffff:a9fe:a9fe"],
    ["0:0:0:0:0:ffff:192.168.0.1"],
    ["not-an-ip"],
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    ["23.227.38.65"],
    ["100.63.255.255"],
    ["100.128.0.1"],
    ["172.32.0.1"],
    ["8.8.8.8"],
    ["2620:127:f00f:e::1"],
    ["::ffff:23.227.38.65"],
  ])("allows public %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe("createGuardedLookup", () => {
  type Cb = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
  const resolver = (addresses: LookupAddress[] | Error) =>
    vi.fn((_h: string, _o: unknown, cb: Cb) =>
      addresses instanceof Error ? cb(addresses as NodeJS.ErrnoException, []) : cb(null, addresses),
    );
  const call = (lookup: ReturnType<typeof createGuardedLookup>, all: boolean) =>
    new Promise<{ err: unknown; address: unknown; family: unknown }>((resolve) =>
      lookup("shop.example.com", { all }, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );

  it("returns the first address in single-address shape", async () => {
    const lookup = createGuardedLookup(resolver([{ address: "23.227.38.65", family: 4 }]));
    expect(await call(lookup, false)).toEqual({ err: null, address: "23.227.38.65", family: 4 });
  });

  it("returns every address in all:true shape", async () => {
    const list = [
      { address: "23.227.38.65", family: 4 },
      { address: "2620:127:f00f:e::1", family: 6 },
    ];
    const lookup = createGuardedLookup(resolver(list));
    expect((await call(lookup, true)).address).toEqual(list);
  });

  it("refuses when ANY resolved address is blocked (mixed answer)", async () => {
    const lookup = createGuardedLookup(
      resolver([
        { address: "23.227.38.65", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    const { err } = await call(lookup, true);
    expect((err as { code?: string }).code).toBe("ERR_BLOCKED_ADDRESS");
  });

  it("refuses an empty answer and passes DNS errors through", async () => {
    expect(
      ((await call(createGuardedLookup(resolver([])), false)).err as { code?: string }).code,
    ).toBe("ERR_BLOCKED_ADDRESS");
    const dnsErr = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    expect((await call(createGuardedLookup(resolver(dnsErr)), false)).err).toBe(dnsErr);
  });
});
