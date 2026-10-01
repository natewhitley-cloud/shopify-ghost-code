/**
 * Tests for app/routes/app.client-error.tsx (gc-nn6): the authenticated sink
 * for browser-side error beacons. The client sanitizes before sending, but the
 * server must NEVER trust it: every field is re-validated and re-truncated
 * here, the shop always comes from the session, and the browser family is
 * derived from the request's own User-Agent header.
 */
import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordClientError: vi.fn(),
}));

import { recordClientError } from "../../app/models/ops-event.server";
import * as clientErrorRoute from "../../app/routes/app.client-error";
import { action, CLIENT_ERROR_MAX_BODY_BYTES } from "../../app/routes/app.client-error";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockRecord = recordClientError as ReturnType<typeof vi.fn>;

const SHOP = "nw-dev-store-2.myshopify.com";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function args(body: Record<string, string> | string, ua: string | null = CHROME_UA) {
  const headers = new Headers();
  if (ua !== null) headers.set("user-agent", ua);
  headers.set("content-type", "application/x-www-form-urlencoded");
  return {
    request: new Request("https://app.example.com/app/client-error", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : new URLSearchParams(body).toString(),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: SHOP } });
  mockRecord.mockResolvedValue(true);
});

describe("app.client-error action", () => {
  it("requires session-token auth: an auth failure propagates and nothing is written", async () => {
    mockAuthenticateAdmin.mockRejectedValue(new Response(null, { status: 401 }));

    await expect(
      action(args({ kind: "error", message: "x", path: "/app" })),
    ).rejects.toBeInstanceOf(Response);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("records a sanitized report for the SESSION shop with the UA's browser family, 204", async () => {
    const res = await action(
      args({
        kind: "fetch",
        message: "GET /app/scans.data -> 502",
        path: "/app/scans/abc",
        status: "502",
        stack: "    at a (https://h/a.js:1:1)",
      }),
    );

    expect(res.status).toBe(204);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(SHOP, {
      kind: "fetch",
      message: "GET /app/scans.data -> 502",
      path: "/app/scans/abc",
      status: 502,
      stack: "at a (https://h/a.js:1:1)",
      browser: "chrome",
    });
  });

  it("re-strips query strings and hashes the client should already have removed", async () => {
    await action(
      args({
        kind: "error",
        message: "load failed https://x.example/p?id_token=abc#h",
        path: "/app/scans?shop=s.myshopify.com&host=xyz#top",
        stack: "    at a (https://h/a.js?token=zzz:1:1)",
      }),
    );

    const [, report] = mockRecord.mock.calls[0];
    expect(report.message).toBe("load failed https://x.example/p");
    expect(report.path).toBe("/app/scans");
    expect(report.stack).toBe("at a (https://h/a.js:1:1)");
    expect(JSON.stringify(report)).not.toMatch(/id_token|shop=|host=|token=/);
  });

  it("re-truncates oversized fields (message <= 300, stack <= 5 frames)", async () => {
    await action(
      args({
        kind: "error",
        message: "m".repeat(5000),
        path: "/app",
        stack: Array.from({ length: 40 }, (_, i) => `    at f${i} (a.js:${i}:1)`).join("\n"),
      }),
    );

    const [, report] = mockRecord.mock.calls[0];
    expect(report.message).toHaveLength(300);
    expect(report.stack.split("\n")).toHaveLength(5);
  });

  it("ignores a client-supplied shop and any extra fields", async () => {
    await action(
      args({ kind: "error", message: "x", path: "/app", shop: "victim.myshopify.com", ua: "x" }),
    );

    expect(mockRecord.mock.calls[0][0]).toBe(SHOP);
    expect(mockRecord.mock.calls[0][1]).not.toHaveProperty("shop");
    expect(mockRecord.mock.calls[0][1]).not.toHaveProperty("ua");
  });

  it("falls back to browser 'other' without a User-Agent", async () => {
    await action(args({ kind: "error", message: "x", path: "/app" }, null));
    expect(mockRecord.mock.calls[0][1].browser).toBe("other");
  });

  it.each([
    [{ kind: "bogus", message: "x", path: "/app" }],
    [{ kind: "error", message: "", path: "/app" }],
    [{ message: "x" }],
  ])("returns 400 with no write for an invalid report %j", async (body) => {
    const res = await action(args(body));
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("returns 413 with no write for an oversized body", async () => {
    const res = await action(
      args(`kind=error&path=%2Fapp&message=${"a".repeat(CLIENT_ERROR_MAX_BODY_BYTES)}`),
    );
    expect(res.status).toBe(413);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("still answers 204 when the per-shop rate limit drops the write", async () => {
    mockRecord.mockResolvedValue(false);
    const res = await action(args({ kind: "error", message: "x", path: "/app" }));
    expect(res.status).toBe(204);
  });

  it("exports no loader and no default component (resource route, POST only)", () => {
    expect(clientErrorRoute).not.toHaveProperty("loader");
    expect(clientErrorRoute).not.toHaveProperty("default");
  });
});
