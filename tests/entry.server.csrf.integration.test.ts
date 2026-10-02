/**
 * Integration: drives react-router's REAL createRequestHandler with a stub
 * ServerBuild whose handleError is our real handleError and whose
 * allowedActionOrigins is the shared constant, for both a document POST and a
 * single-fetch `.data` POST. Goes red if RR changes how CSRF rejections reach
 * handleError (gc-1cm).
 */

import { createRequestHandler, type ServerBuild } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ALLOWED_ACTION_ORIGINS } from "../app/lib/action-origins";

vi.mock("../app/shopify.server", () => ({ addDocumentResponseHeaders: vi.fn() }));
const mockRecordApiError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../app/models/ops-event.server", () => ({ recordApiError: mockRecordApiError }));

async function makeHandler() {
  const { handleError } = await import("../app/entry.server");
  const build = {
    mode: "production",
    basename: "/",
    publicPath: "/",
    assetsBuildDirectory: "x",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
    allowedActionOrigins: ALLOWED_ACTION_ORIGINS,
    assets: { url: "/m.js", version: "1", entry: { module: "/e.js", imports: [] }, routes: {} },
    entry: { module: { default: async () => new Response("doc"), handleError } },
    routes: {
      root: {
        id: "root",
        path: "",
        module: { default: () => null, action: async () => "ok", loader: async () => null },
      },
    },
  } as unknown as ServerBuild;
  return createRequestHandler(build);
}

function post(path: string, origin: string) {
  return new Request(`http://internal.test${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: "a=1",
  });
}

describe("react-router CSRF rejection -> handleError (real handler)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each([
    ["document POST", "/"],
    ["single-fetch .data POST", "/_root.data"],
  ])("%s with a foreign Origin: 400, one warn line, nothing recorded", async (_l, path) => {
    const handler = await makeHandler();

    const res = await handler(post(path, "https://evil.com"));

    expect(res.status).toBe(400);
    expect(mockRecordApiError).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["document POST", "/"],
    ["single-fetch .data POST", "/_root.data"],
  ])("%s with the allowed Origin is not rejected", async (_l, path) => {
    const handler = await makeHandler();

    const res = await handler(post(path, `https://${ALLOWED_ACTION_ORIGINS[0]}`));

    expect(res.status).not.toBe(400);
    expect(mockRecordApiError).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
