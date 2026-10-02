/**
 * Integration: drives react-router's REAL createRequestHandler with a stub
 * ServerBuild whose entry module is our real app/entry.server.tsx and whose
 * root route module is our real app/root.tsx. Proves the root ErrorBoundary
 * replaces React Router's DefaultErrorComponent, which console.errors the full
 * error and renders error.stack into the page (gc-6lw).
 */

import { createRequestHandler, type ServerBuild } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../app/shopify.server", () => ({ addDocumentResponseHeaders: vi.fn() }));
const mockRecordApiError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../app/models/ops-event.server", () => ({ recordApiError: mockRecordApiError }));

const route = (id: string, parentId?: string, path?: string, hasLoader = false) => ({
  id,
  parentId,
  path,
  index: undefined,
  caseSensitive: undefined,
  module: `/${id}.js`,
  imports: [],
  css: [],
  hasAction: false,
  hasLoader,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  hasErrorBoundary: id === "root",
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
});

async function makeHandler() {
  const entry = await import("../app/entry.server");
  const root = await import("../app/root");
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
    allowedActionOrigins: false,
    assets: {
      url: "/m.js",
      version: "1",
      entry: { module: "/e.js", imports: [] },
      routes: {
        root: route("root"),
        boom: route("boom", "root", "boom", true),
      },
    },
    entry: { module: entry },
    routes: {
      root: { id: "root", path: "", module: root },
      boom: {
        id: "boom",
        parentId: "root",
        path: "boom",
        module: {
          default: () => null,
          loader: async () => {
            throw new Error("secret detail");
          },
        },
      },
    },
  } as unknown as ServerBuild;
  return createRequestHandler(build);
}

describe("root ErrorBoundary via the real request handler (gc-6lw)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("unmatched route: 404 page, no stack or router message, nothing logged", async () => {
    const handler = await makeHandler();

    const res = await handler(new Request("http://internal.test/definitely-not-a-route"));
    const raw = await res.text();
    // React Router's hydration payload (<script>) still carries the 404's
    // "No route matches URL" data string (it only echoes the request path);
    // what matters here is the visible markup the boundary renders.
    const html = raw.replace(/<script[\s\S]*?<\/script>/g, "");

    expect(res.status).toBe(404);
    expect(html).toContain("404 Not Found");
    expect(html).not.toContain("No route matches");
    expect(raw).not.toContain("ErrorResponseImpl");
    expect(raw).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockRecordApiError).not.toHaveBeenCalled();
  });

  it("loader Error: 500 generic page without the message; recorded once by handleError", async () => {
    const handler = await makeHandler();

    const res = await handler(new Request("http://internal.test/boom"));
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("secret detail");
    expect(html).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    // handleError (not the boundary) is the one place this is logged + recorded.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(mockRecordApiError).toHaveBeenCalledOnce();
  });
});
