/**
 * Integration (gc-syz.7): drives react-router's REAL createRequestHandler, with
 * the real entry.server handleError and the real allowedActionOrigins, against
 * the REAL unsubscribe route module. Proves which POSTs the route accepts:
 *   (a) RFC 8058 one-click from a mail provider (no Origin header)
 *   (b) a same-origin browser form POST from the confirm page
 *   (c) `Origin: null` and a foreign Origin
 * and that the route shape (resource route) is what makes (c) work: the same
 * module mounted as a DOCUMENT route is rejected by RR's CSRF check.
 */

import { createRequestHandler, type ServerBuild } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ALLOWED_ACTION_ORIGINS } from "../app/lib/action-origins";
import { disableAlertsByToken } from "../app/models/merchant-alert.server";

vi.mock("../app/shopify.server", () => ({ addDocumentResponseHeaders: vi.fn() }));
vi.mock("../app/models/ops-event.server", () => ({
  recordApiError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../app/models/merchant-alert.server", () => ({ disableAlertsByToken: vi.fn() }));

const mockDisable = disableAlertsByToken as ReturnType<typeof vi.fn>;
const TOKEN = "t".repeat(43);
const ORIGIN = "https://app.test";
const URL_ = `${ORIGIN}/unsubscribe/${TOKEN}`;

async function makeHandler(asDocumentRoute: boolean) {
  const { handleError } = await import("../app/entry.server");
  const routeModule = await import("../app/routes/unsubscribe.$token");
  const build = {
    mode: "production",
    basename: "/",
    publicPath: "/",
    assetsBuildDirectory: "x",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial" },
    allowedActionOrigins: ALLOWED_ACTION_ORIGINS,
    assets: {
      url: "/m.js",
      version: "1",
      entry: { module: "/e.js", imports: [] },
      routes: {},
    },
    entry: { module: { default: async () => new Response("doc"), handleError } },
    routes: {
      unsub: {
        id: "unsub",
        path: "unsubscribe/:token",
        module: asDocumentRoute ? { ...routeModule, default: () => null } : routeModule,
      },
    },
  } as unknown as ServerBuild;
  return createRequestHandler(build);
}

function post(headers: Record<string, string>, body = "List-Unsubscribe=One-Click") {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("unsubscribe route through the real request handler", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDisable.mockResolvedValue(true);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("GET renders the confirm page and changes nothing", async () => {
    const handler = await makeHandler(false);
    const res = await handler(new Request(URL_));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Turn off Ghost Code monitoring emails");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it("(a) one-click POST with NO Origin header succeeds", async () => {
    const handler = await makeHandler(false);
    const res = await handler(post({}));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Monitoring emails are off");
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("(b) same-origin browser form POST succeeds", async () => {
    const handler = await makeHandler(false);
    const res = await handler(post({ origin: ORIGIN }));

    expect(res.status).toBe(200);
    expect(mockDisable).toHaveBeenCalledOnce();
  });

  it("(c) `Origin: null` and a foreign Origin are accepted (resource route skips the CSRF check)", async () => {
    const handler = await makeHandler(false);

    for (const origin of ["null", "https://mail.example.com"]) {
      mockDisable.mockClear();
      const res = await handler(post({ origin }));
      expect(res.status).toBe(200);
      expect(mockDisable).toHaveBeenCalledOnce();
    }
  });

  it("(c) control: the SAME module as a document route rejects `Origin: null` with 400", async () => {
    const handler = await makeHandler(true);
    const res = await handler(post({ origin: "null" }));

    expect(res.status).toBe(400);
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it("POST twice stays 'off' (idempotent)", async () => {
    const handler = await makeHandler(false);
    await handler(post({}));
    const res = await handler(post({}));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Monitoring emails are off");
  });

  it("unknown token: 404 invalid-link page", async () => {
    mockDisable.mockResolvedValue(false);
    const handler = await makeHandler(false);
    const res = await handler(post({}));

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link is invalid or has expired");
  });
});
