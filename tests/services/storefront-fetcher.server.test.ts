import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../app/lib/logger.server";
import {
  fetchStorefrontScriptTags,
  isShopifyStorefrontHtml,
  parseScriptTagUrls,
  STOREFRONT_MAX_BODY_BYTES,
  STOREFRONT_USER_AGENT,
} from "../../app/services/storefront-fetcher.server";

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

function asyncLoadWith(arrayLiteral: string): string {
  return `<script>(function() { function asyncLoad() { var urls = ${arrayLiteral}; }; })();</script>`;
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
      parseScriptTagUrls(page(`<script>function asyncLoad() { var urls = ["https://a.js"`)),
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

  it("reads a page whose only `var urls` is outside asyncLoad as zero", () => {
    expect(parseScriptTagUrls(page(`<script>var urls = ["https://theme.js"];</script>`))).toEqual(
      [],
    );
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
) {
  return {
    graphql: vi.fn(async () => ({ json: async () => ({ data: { shop } }) })),
  };
}

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
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
          // No fetchImpl: the default (global fetch) path must also stay untouched.
          const result = await fetchStorefrontScriptTags(admin, { shopId: SHOP_ID });
          expect(result).toEqual({ status: "disabled" });
          expect(globalFetch).not.toHaveBeenCalled();
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
      ["plain http", `http://${PRIMARY}/`],
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
