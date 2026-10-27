/**
 * Checkout guard page reader (gc-1q1s.3): typed outcomes over the guarded
 * storefront GET. Unreadable, blocked, password and redirect outcomes must
 * never look like a clean or a hit; only the homepage decides the outcome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { logger } from "../../app/lib/logger.server";
import {
  fetchShopDomains,
  readStorefrontPage,
  type StorefrontFetch,
} from "../../app/services/storefront-fetcher.server";
import {
  checkStorefront,
  GUARD_DOMAINS_MAX_AGE_MS,
  guardDomainsNeedRefresh,
} from "../../app/services/storefront-guard-check.server";
import type { AdminApiContext } from "../../app/types/shopify";

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DOMAINS = { primaryHost: "shop.example.com", myshopifyHost: "shop-x.myshopify.com" };
const STOREFRONT = (body: string) =>
  `<html><head><script>Shopify.shop = "shop-x.myshopify.com";</script></head><body>${body}</body></html>`;

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}
function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

let fetchImpl: ReturnType<typeof vi.fn>;
const opts = () => ({ shopId: "shop-1", fetchImpl: fetchImpl as unknown as StorefrontFetch });
const analyze = (html: string) => ({ length: html.length });

beforeEach(() => {
  vi.clearAllMocks();
  fetchImpl = vi.fn();
});

/** Route responses by path. */
function byPath(routes: Record<string, () => Response | Promise<Response>>) {
  fetchImpl.mockImplementation((url: URL) => {
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return Promise.resolve(route());
  });
}

describe("checkStorefront", () => {
  it("reads the homepage then /cart, in that order, and is complete", async () => {
    byPath({
      "/": () => htmlResponse(STOREFRONT("home")),
      "/cart": () => htmlResponse(STOREFRONT("cart")),
    });
    const out = await checkStorefront(DOMAINS, analyze, opts());
    expect(out.outcome).toBe("ok");
    if (out.outcome !== "ok") return;
    expect(out.complete).toBe(true);
    expect(out.pages.map((p) => p.page)).toEqual(["home", "cart"]);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/cart",
    ]);
  });

  it("sends no cookie and the honest user agent", async () => {
    byPath({
      "/": () => htmlResponse(STOREFRONT("")),
      "/cart": () => htmlResponse(STOREFRONT("")),
    });
    await checkStorefront(DOMAINS, analyze, opts());
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Cookie).toBeUndefined();
    expect(headers["User-Agent"]).toMatch(/^GhostCode\//);
  });

  it("a failed /cart makes the check partial, never unreachable", async () => {
    byPath({
      "/": () => htmlResponse(STOREFRONT("home")),
      "/cart": () => htmlResponse("err", 500),
    });
    const out = await checkStorefront(DOMAINS, analyze, opts());
    expect(out).toMatchObject({ outcome: "ok", complete: false });
    if (out.outcome === "ok") expect(out.pages).toHaveLength(1);
  });

  it("password redirect on the homepage pauses the check without reading /cart", async () => {
    byPath({
      "/": () => redirect("https://shop.example.com/password"),
      "/password": () => htmlResponse("pw"),
    });
    const out = await checkStorefront(DOMAINS, analyze, opts());
    expect(out).toEqual({ outcome: "paused_password" });
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).endsWith("/cart"))).toBe(false);
  });

  it("a password page served in place (template-password) is paused too", async () => {
    byPath({ "/": () => htmlResponse('<body class="template-password">x</body>') });
    expect(await checkStorefront(DOMAINS, analyze, opts())).toEqual({
      outcome: "paused_password",
    });
  });

  it("a redirect to another domain pauses with that host only (no path)", async () => {
    byPath({ "/": () => redirect("https://shop.example.ca/en?x=1") });
    expect(await checkStorefront(DOMAINS, analyze, opts())).toEqual({
      outcome: "paused_redirect",
      redirectHost: "shop.example.ca",
    });
  });

  it.each([403, 429])("HTTP %i is unreachable and challenged", async (status) => {
    byPath({ "/": () => htmlResponse("blocked", status) });
    expect(await checkStorefront(DOMAINS, analyze, opts())).toEqual({
      outcome: "unreachable",
      reason: "http_status",
      challenged: true,
    });
  });

  it("HTTP 500 is unreachable, not challenged", async () => {
    byPath({ "/": () => htmlResponse("err", 503) });
    expect(await checkStorefront(DOMAINS, analyze, opts())).toEqual({
      outcome: "unreachable",
      reason: "http_status",
      challenged: false,
    });
  });

  it("a network failure is unreachable", async () => {
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    expect(await checkStorefront(DOMAINS, analyze, opts())).toEqual({
      outcome: "unreachable",
      reason: "network",
      challenged: false,
    });
  });

  it("a fetch blocked at connect time (private address) is unreachable blocked_address", async () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ERR_BLOCKED_ADDRESS" }),
    });
    fetchImpl.mockRejectedValue(err);
    expect(await checkStorefront(DOMAINS, analyze, opts())).toMatchObject({
      outcome: "unreachable",
      reason: "blocked_address",
    });
  });

  it("a non-Shopify page is unreachable not_shopify", async () => {
    byPath({ "/": () => htmlResponse("<html>parked domain</html>") });
    expect(await checkStorefront(DOMAINS, analyze, opts())).toMatchObject({
      outcome: "unreachable",
      reason: "not_shopify",
    });
  });

  it("an analyzer that throws on the homepage is an error, not a clean check", async () => {
    byPath({ "/": () => htmlResponse(STOREFRONT("x")) });
    const out = await checkStorefront(
      DOMAINS,
      () => {
        throw new Error("boom");
      },
      opts(),
    );
    expect(out).toEqual({ outcome: "error" });
  });

  it("logs host and outcome only, never HTML", async () => {
    byPath({
      "/": () => htmlResponse(STOREFRONT("secret-text")),
      "/cart": () => htmlResponse(STOREFRONT("")),
    });
    await checkStorefront(DOMAINS, analyze, opts());
    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("storefront_guard_check");
    expect(logged).not.toContain("secret-text");
  });
});

describe("readStorefrontPage", () => {
  it("only follows redirects to the shop's own hosts", async () => {
    fetchImpl
      .mockResolvedValueOnce(redirect("https://shop-x.myshopify.com/cart"))
      .mockResolvedValueOnce(htmlResponse("ok"));
    const read = await readStorefrontPage(DOMAINS, "/cart", {
      readBody: () => true,
      fetchImpl: fetchImpl as unknown as StorefrontFetch,
    });
    expect(read).toMatchObject({ status: "read", httpStatus: 200, body: "ok" });
  });
});

describe("fetchShopDomains", () => {
  const admin = (body: unknown) =>
    ({
      graphql: vi.fn().mockResolvedValue({ json: async () => body }),
    }) as unknown as AdminApiContext;

  it("returns the validated, lower-cased hosts", async () => {
    const out = await fetchShopDomains(
      admin({
        data: {
          shop: {
            primaryDomain: { url: "https://Shop.Example.com", host: "shop.example.com" },
            myshopifyDomain: "shop-x.myshopify.com",
          },
        },
      }),
    );
    expect(out).toEqual(DOMAINS);
  });

  it("is null when the primary host is unusable (IP literal)", async () => {
    expect(
      await fetchShopDomains(
        admin({ data: { shop: { primaryDomain: { url: "https://127.0.0.1" } } } }),
      ),
    ).toBeNull();
  });

  it("is null on an empty response", async () => {
    expect(await fetchShopDomains(admin({}))).toBeNull();
  });
});

describe("guardDomainsNeedRefresh", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  it("refreshes when nothing is cached", () => {
    expect(guardDomainsNeedRefresh({ primaryHost: null, domainsRefreshedAt: null }, now)).toBe(
      true,
    );
  });
  it("keeps hosts younger than a day", () => {
    const at = new Date(now.getTime() - GUARD_DOMAINS_MAX_AGE_MS + 60_000);
    expect(guardDomainsNeedRefresh({ primaryHost: "a.com", domainsRefreshedAt: at }, now)).toBe(
      false,
    );
  });
  it("refreshes hosts a day old", () => {
    const at = new Date(now.getTime() - GUARD_DOMAINS_MAX_AGE_MS);
    expect(guardDomainsNeedRefresh({ primaryHost: "a.com", domainsRefreshedAt: at }, now)).toBe(
      true,
    );
  });
});
