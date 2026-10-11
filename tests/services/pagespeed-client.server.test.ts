/**
 * Tests for app/services/pagespeed-client.server.ts (gc-wt3y). No network:
 * every call goes through an injected fetch double.
 */
import { describe, it, expect, vi } from "vitest";

import {
  buildPageSpeedRequestUrl,
  callPageSpeed,
  classifyPageSpeedBody,
  classifyPageSpeedHttpError,
  PAGESPEED_ENDPOINT,
  PAGESPEED_MAX_RESPONSE_CHARS,
  type PageSpeedFetch,
} from "../../app/services/pagespeed-client.server";
import {
  buildPageSpeedError,
  buildPageSpeedResponse,
  URLS,
} from "../fixtures/pagespeed-lighthouse";

const KEY = "AIza-TEST-SECRET-KEY-123";

function respond(status: number, body: unknown): PageSpeedFetch {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("buildPageSpeedRequestUrl", () => {
  it("asks for one mobile performance run of the page", () => {
    const url = new URL(buildPageSpeedRequestUrl(URLS.document, KEY));
    expect(`${url.origin}${url.pathname}`).toBe(PAGESPEED_ENDPOINT);
    expect(url.searchParams.get("url")).toBe(URLS.document);
    expect(url.searchParams.get("strategy")).toBe("mobile");
    expect(url.searchParams.get("category")).toBe("performance");
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(url.searchParams.getAll("category")).toHaveLength(1);
  });

  it("encodes a page URL with its own query string as one parameter", () => {
    const page = "https://shop.example/products/a?variant=1&x=2";
    const url = new URL(buildPageSpeedRequestUrl(page, KEY));
    expect(url.searchParams.get("url")).toBe(page);
    expect(url.searchParams.get("x")).toBeNull();
  });
});

describe("callPageSpeed", () => {
  it("returns the lighthouseResult on a 200", async () => {
    const fetchImpl = respond(200, buildPageSpeedResponse());
    const result = await callPageSpeed(URLS.document, { apiKey: KEY, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.lighthouse as { finalDisplayedUrl: string }).finalDisplayedUrl).toBe(
        URLS.document,
      );
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(requestUrl).toContain("strategy=mobile");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [429, buildPageSpeedError(429, "Quota exceeded for quota metric"), "rate_limited"],
    [500, buildPageSpeedError(500, "Internal error encountered."), "server_error"],
    [503, "Service Unavailable", "server_error"],
    [
      500,
      buildPageSpeedError(
        500,
        "Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested.",
      ),
      "document_failed",
    ],
    [
      400,
      buildPageSpeedError(
        400,
        "Lighthouse returned error: ERRORED_DOCUMENT_REQUEST. (Status code: 404)",
      ),
      "document_failed",
    ],
    [400, buildPageSpeedError(400, "Lighthouse returned error: NO_FCP."), "document_failed"],
    [
      400,
      buildPageSpeedError(400, "API key not valid. Please pass a valid API key."),
      "http_error",
    ],
    [403, buildPageSpeedError(403, "PageSpeed Insights API has not been used"), "http_error"],
  ])("maps HTTP %i to %s", async (status, body, code) => {
    const result = await callPageSpeed(URLS.document, {
      apiKey: KEY,
      fetchImpl: respond(status, body),
    });
    expect(result).toEqual({ ok: false, code, httpStatus: status });
  });

  it("maps a 200 with a Lighthouse runtimeError to document_failed", async () => {
    const body = buildPageSpeedResponse({
      runtimeError: { code: "FAILED_DOCUMENT_REQUEST", message: "Unable to load" },
    });
    const result = await callPageSpeed(URLS.document, {
      apiKey: KEY,
      fetchImpl: respond(200, body),
    });
    expect(result).toEqual({ ok: false, code: "document_failed", httpStatus: 200 });
  });

  it("maps a 200 that is not JSON, or has no lighthouseResult, to bad_response", async () => {
    for (const body of ["<html>oops</html>", { kind: "pagespeedonline#result" }, "null"]) {
      const result = await callPageSpeed(URLS.document, {
        apiKey: KEY,
        fetchImpl: respond(200, body),
      });
      expect(result).toMatchObject({ ok: false, code: "bad_response" });
    }
  });

  it("refuses an oversized response body", async () => {
    const huge = "x".repeat(PAGESPEED_MAX_RESPONSE_CHARS + 1);
    const result = await callPageSpeed(URLS.document, {
      apiKey: KEY,
      fetchImpl: respond(200, huge),
    });
    expect(result).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("maps a network failure to network", async () => {
    const fetchImpl: PageSpeedFetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${buildPageSpeedRequestUrl(URLS.document, KEY)}`);
    });
    const result = await callPageSpeed(URLS.document, { apiKey: KEY, fetchImpl });
    expect(result).toEqual({ ok: false, code: "network", httpStatus: null });
  });

  it("aborts and maps a slow call to timeout", async () => {
    const fetchImpl: PageSpeedFetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = await callPageSpeed(URLS.document, { apiKey: KEY, fetchImpl, timeoutMs: 5 });
    expect(result).toEqual({ ok: false, code: "timeout", httpStatus: null });
  });

  it("never echoes the key or Google's error text in a result (even when Google echoes the URL)", async () => {
    const echo = buildPageSpeedError(
      400,
      `Bad request ${buildPageSpeedRequestUrl(URLS.document, KEY)}`,
    );
    const cases: PageSpeedFetch[] = [
      respond(400, echo),
      respond(500, echo),
      respond(429, echo),
      respond(200, "not json"),
      vi.fn(async () => {
        throw new Error(`boom ${KEY}`);
      }),
    ];
    for (const fetchImpl of cases) {
      const result = await callPageSpeed(URLS.document, { apiKey: KEY, fetchImpl });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain("Bad request");
    }
  });
});

describe("classifiers", () => {
  it("classifyPageSpeedBody accepts a lighthouseResult with an empty runtimeError code", () => {
    const body = buildPageSpeedResponse();
    (body.lighthouseResult as Record<string, unknown>).runtimeError = { code: "", message: "" };
    expect(classifyPageSpeedBody(body).ok).toBe(true);
  });

  it("classifyPageSpeedHttpError treats an unparseable error body by status alone", () => {
    expect(classifyPageSpeedHttpError(502, null)).toBe("server_error");
    expect(classifyPageSpeedHttpError(404, null)).toBe("http_error");
    expect(classifyPageSpeedHttpError(429, null)).toBe("rate_limited");
  });
});
