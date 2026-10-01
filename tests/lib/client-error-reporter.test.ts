/**
 * Tests for app/lib/client-error-reporter.ts (gc-nn6): the browser wiring that
 * turns window errors, unhandled rejections, route ErrorBoundary renders and
 * failed same-origin fetches into best-effort beacons to /app/client-error.
 *
 * No DOM library in this suite (vitest env = node), so the reporter takes an
 * injectable window. Each test re-imports the module (vi.resetModules) so the
 * per-page-load dedupe/rate-limit state starts fresh, exactly like a reload.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// `never` mirrors ReporterWindow: the reporter decides each event's shape.
type Listener = (event: never) => void;
type FetchImpl = (input: unknown, init?: RequestInit) => Promise<Response>;

interface FakeWin {
  fetch: typeof fetch;
  location: { origin: string; pathname: string };
  listeners: Map<string, Listener[]>;
  addEventListener: (type: string, l: Listener) => void;
  removeEventListener: (type: string, l: Listener) => void;
  dispatch: (type: string, event: unknown) => void;
}

const ORIGIN = "https://ghost.example";

function fakeWin(rawFetch: Mock<FetchImpl>): FakeWin {
  const listeners = new Map<string, Listener[]>();
  return {
    fetch: rawFetch as unknown as typeof fetch,
    location: { origin: ORIGIN, pathname: "/app/scans/abc" },
    listeners,
    addEventListener: (type, l) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type, l) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((x) => x !== l),
      ),
    dispatch: (type, event) => (listeners.get(type) ?? []).forEach((l) => l(event as never)),
  };
}

async function load() {
  vi.resetModules();
  return import("../../app/lib/client-error-reporter");
}

/** Let fetch promise chains (wrapper .then handlers) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The beacon calls the underlying (pre-install) fetch mock records. */
function beacons(raw: Mock<FetchImpl>) {
  return raw.mock.calls
    .filter(([input]) => String(input) === "/app/client-error")
    .map(([, init]) => {
      const i = init as RequestInit;
      return {
        init: i,
        body: Object.fromEntries(new URLSearchParams(String(i.body))),
      };
    });
}

let win: FakeWin;
let raw: Mock<FetchImpl>;

beforeEach(() => {
  raw = vi.fn<FetchImpl>(async () => new Response(null, { status: 200 }));
  win = fakeWin(raw);
});

describe("installClientErrorCapture: fetch", () => {
  it("returns the original response untouched and does not beacon a 2xx", async () => {
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);
    const res = await win.fetch("/app/scans.data");
    expect(res.status).toBe(200);
    await flush();
    expect(beacons(raw)).toHaveLength(0);
  });

  it("beacons a same-origin 5xx with method, query-stripped request path, status and page path", async () => {
    raw.mockImplementation(async (input: unknown) =>
      String(input) === "/app/client-error"
        ? new Response(null, { status: 204 })
        : new Response("x", { status: 502 }),
    );
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    const res = await win.fetch("/app/scans.data?_routes=routes%2Fapp&shop=s.myshopify.com", {
      method: "POST",
    });
    expect(res.status).toBe(502);
    await flush();

    const sent = beacons(raw);
    expect(sent).toHaveLength(1);
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].init.keepalive).toBe(true);
    expect(sent[0].body).toEqual({
      kind: "fetch",
      message: "POST /app/scans.data -> 502",
      path: "/app/scans/abc",
      status: "502",
    });
  });

  it("handles absolute same-origin URLs and Request objects", async () => {
    raw.mockImplementation(async (input: unknown) =>
      String(input) === "/app/client-error"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 404 }),
    );
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    await win.fetch(`${ORIGIN}/app/a?x=1`);
    await win.fetch(new Request(`${ORIGIN}/app/b?y=2`, { method: "DELETE" }));
    await flush();

    expect(beacons(raw).map((b) => b.body.message)).toEqual([
      "GET /app/a -> 404",
      "DELETE /app/b -> 404",
    ]);
  });

  it("ignores cross-origin requests, 401s (App Bridge re-auth) and opaque redirects", async () => {
    raw.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://cdn.example")) return new Response(null, { status: 500 });
      // redirect: "manual" resolves with an opaque-redirect (status 0, not ok).
      if (url === "/app/redir") {
        return { ok: false, status: 0, type: "opaqueredirect" } as unknown as Response;
      }
      return new Response(null, { status: 401 });
    });
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    await win.fetch("https://cdn.example/x.js");
    await win.fetch("/app/settings.data");
    await win.fetch("/app/redir");
    await flush();
    expect(beacons(raw)).toHaveLength(0);
  });

  it("never reports its own beacon endpoint (no recursion when /app/client-error fails)", async () => {
    raw.mockImplementation(async () => new Response(null, { status: 500 }));
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    await win.fetch("/app/x");
    await flush();
    await flush();
    // One beacon for /app/x; its own 500 must not trigger another.
    expect(beacons(raw)).toHaveLength(1);
  });

  it("beacons a network failure with status 0 and still rejects to the caller", async () => {
    raw.mockImplementation(async (input: unknown) => {
      if (String(input) === "/app/client-error") return new Response(null, { status: 204 });
      throw new TypeError("Failed to fetch");
    });
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    await expect(win.fetch("/app/scans.data?x=1")).rejects.toThrow("Failed to fetch");
    await flush();
    expect(beacons(raw)[0].body).toMatchObject({
      kind: "fetch",
      message: "GET /app/scans.data failed: Failed to fetch",
      status: "0",
    });
  });

  it("does not report aborted requests (React Router cancels loaders on navigation)", async () => {
    raw.mockImplementation(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    await expect(win.fetch("/app/scans.data")).rejects.toThrow();
    await flush();
    expect(beacons(raw)).toHaveLength(0);
  });

  it("is idempotent (a second install does not double-wrap) and uninstall restores fetch", async () => {
    const { installClientErrorCapture } = await load();
    const uninstall = installClientErrorCapture(win);
    const wrapped = win.fetch;
    expect(wrapped).not.toBe(raw);
    installClientErrorCapture(win);
    expect(win.fetch).toBe(wrapped);
    expect(win.listeners.get("error")).toHaveLength(1);

    uninstall();
    expect(win.fetch).toBe(raw);
    expect(win.listeners.get("error")).toHaveLength(0);
    expect(win.listeners.get("unhandledrejection")).toHaveLength(0);
  });
});

describe("installClientErrorCapture: window events", () => {
  it("beacons window error events with message and top frames", async () => {
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);
    const err = new TypeError("x is undefined");
    err.stack = "TypeError: x is undefined\n    at a (https://h/a.js?v=2:1:1)";

    win.dispatch("error", { message: "Uncaught TypeError: x is undefined", error: err });
    await flush();

    expect(beacons(raw)[0].body).toEqual({
      kind: "error",
      message: "Uncaught TypeError: x is undefined",
      stack: "at a (https://h/a.js:1:1)",
      path: "/app/scans/abc",
    });
  });

  it("beacons unhandled rejections (Error and non-Error reasons) but skips AbortError", async () => {
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    win.dispatch("unhandledrejection", { reason: new Error("boom") });
    win.dispatch("unhandledrejection", { reason: "plain string" });
    win.dispatch("unhandledrejection", { reason: { some: "object" } });
    win.dispatch("unhandledrejection", {
      reason: new DOMException("aborted", "AbortError"),
    });
    await flush();

    expect(beacons(raw).map((b) => [b.body.kind, b.body.message])).toEqual([
      ["rejection", "boom"],
      ["rejection", "plain string"],
      ["rejection", "Unhandled rejection (object)"],
    ]);
  });

  it("dedupes identical errors and caps at 5 beacons per page load", async () => {
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);

    for (let i = 0; i < 3; i++) win.dispatch("error", { message: "same" });
    for (let i = 0; i < 10; i++) win.dispatch("error", { message: `m${i}` });
    await flush();

    const sent = beacons(raw);
    expect(sent).toHaveLength(5);
    expect(sent.filter((b) => b.body.message === "same")).toHaveLength(1);
  });

  it("swallows a throwing fetch so telemetry never breaks the page", async () => {
    raw.mockImplementation(() => {
      throw new Error("sync throw");
    });
    const { installClientErrorCapture } = await load();
    installClientErrorCapture(win);
    expect(() => win.dispatch("error", { message: "x" })).not.toThrow();
  });
});

describe("reportRouteError", () => {
  it("reports a thrown Error as a boundary error", async () => {
    const { reportRouteError } = await load();
    reportRouteError(new Error("render failed"), win);
    await flush();
    expect(beacons(raw)[0].body).toMatchObject({
      kind: "boundary",
      message: "render failed",
      path: "/app/scans/abc",
    });
  });

  it("reports a route error response with its status, but not a 401", async () => {
    const { reportRouteError } = await load();
    reportRouteError({ status: 404, statusText: "Not Found", data: "secret body" }, win);
    reportRouteError({ status: 401, statusText: "Unauthorized" }, win);
    await flush();
    const sent = beacons(raw);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({
      kind: "boundary",
      message: "404 Not Found",
      path: "/app/scans/abc",
      status: "404",
    });
  });

  it("is a no-op during SSR (no window)", async () => {
    const { reportRouteError } = await load();
    expect(() => reportRouteError(new Error("ssr"))).not.toThrow();
  });

  it("re-rendering the same boundary does not re-send (dedupe)", async () => {
    const { reportRouteError } = await load();
    const err = new Error("same");
    reportRouteError(err, win);
    reportRouteError(err, win);
    await flush();
    expect(beacons(raw)).toHaveLength(1);
  });
});
