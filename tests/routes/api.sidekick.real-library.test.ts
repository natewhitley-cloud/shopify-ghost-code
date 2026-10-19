import { createHmac } from "node:crypto";

import { Session } from "@shopify/shopify-api";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// The Sidekick resource routes (gc-5nok) against the REAL installed
// @shopify/shopify-app-react-router: GhostCode is on 1.2.0 (ClearSignal and
// FraudPilot proved the same pattern on 3.0.2 / 2.1.0). Runs the app's own
// shopifyApp(...) config (app/shopify.server.ts, including SafeSessionStorage),
// the library's OPTIONS preflight, session-token validation and cors()
// helper. Only the edges are faked: the Prisma session backend (an in-memory
// Map), the two Sidekick services (their logic is covered in
// tests/services/sidekick-*-summary.server.test.ts), the DB and the ops-event
// model, and the network (any call fails the test).
//
// The extension's fetch runs in a Shopify-hosted sandbox on another origin
// with an Authorization header, so the browser sends a CORS preflight first.
// React Router 7 dispatches OPTIONS to the loader (it is not a mutation
// method); the library answers it inside authenticate.admin.

const SECRET = "sidekick-real-lib-secret";
const API_KEY = "sidekick-real-lib-key";
const APP_URL = "https://app.example.com";
const SHOP = "sidekick-shop.myshopify.com";
const SANDBOX_ORIGIN = "https://extensions.shopifycdn.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

process.env.SHOPIFY_API_SECRET = SECRET;
process.env.SHOPIFY_API_KEY = API_KEY;
process.env.SHOPIFY_APP_URL = APP_URL;
process.env.SCOPES = "read_themes";

const sessions = vi.hoisted(() => new Map<string, unknown>());
const mockScan = vi.hoisted(() => vi.fn());
const mockSpeed = vi.hoisted(() => vi.fn());

vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class {
    async storeSession(session: { id: string }) {
      sessions.set(session.id, session);
      return true;
    }
    async loadSession(id: string) {
      return sessions.get(id);
    }
    async deleteSession(id: string) {
      sessions.delete(id);
      return true;
    }
    async deleteSessions(ids: string[]) {
      ids.forEach((id) => sessions.delete(id));
      return true;
    }
    async findSessionsByShop() {
      return [];
    }
  },
}));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/ops-event.server", () => ({ recordApiError: vi.fn() }));
vi.mock("../../app/services/sidekick-scan-summary.server", () => ({
  getSidekickScanSummary: mockScan,
}));
vi.mock("../../app/services/sidekick-speed-summary.server", () => ({
  getSidekickSpeedSummary: mockSpeed,
}));

type Loader = typeof import("../../app/routes/api.sidekick.latest-scan").loader;
let routes: { name: string; loader: Loader; service: typeof mockScan }[];

beforeAll(async () => {
  const latest = await import("../../app/routes/api.sidekick.latest-scan");
  const speed = await import("../../app/routes/api.sidekick.speed");
  routes = [
    { name: "latest-scan", loader: latest.loader, service: mockScan },
    { name: "speed", loader: speed.loader, service: mockSpeed },
  ];
  // shopify.server is loaded by the route imports; no network is expected
  // because the stored offline session is valid (no token exchange).
  setAbstractFetchFunc((async (input: RequestInfo | URL) => {
    throw new Error(`unexpected network call in test: ${String(input)}`);
  }) as typeof fetch);
});

beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
  mockScan.mockResolvedValue({ status: "ok", totalFindings: 3 });
  mockSpeed.mockResolvedValue({ status: "ok", reportType: "speed_report" });
  const session = new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "",
    isOnline: false,
    scope: "read_themes",
    accessToken: "shpat_valid",
    expires: new Date(Date.now() + 3_600_000),
    refreshToken: "shprt_valid",
    refreshTokenExpires: new Date(Date.now() + 86_400_000),
  });
  sessions.set(session.id, session);
});

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** An HS256 App Bridge session token, signed with node:crypto. */
function sessionToken(secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://${SHOP}/admin`,
      dest: `https://${SHOP}`,
      aud: API_KEY,
      sub: "1",
      sid: "sid-1",
      jti: `jti-${Math.random()}`,
      iat: now,
      nbf: now - 5,
      exp: now + 60,
    }),
  );
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function run(
  loader: Loader,
  name: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request(`${APP_URL}/api/sidekick/${name}`, {
    method: init.method ?? "GET",
    headers: { "User-Agent": BROWSER_UA, Origin: SANDBOX_ORIGIN, ...init.headers },
  });
  try {
    return (await loader({
      request,
      params: {},
      context: {},
    } as unknown as LoaderFunctionArgs)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

const NAMES = ["latest-scan", "speed"];
const route = (name: string) => routes.find((r) => r.name === name)!;

describe("Sidekick routes against the real Shopify auth library (1.2.0)", () => {
  it("runs against @shopify/shopify-app-react-router 1.2.0 (re-check these pins on a bump)", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(
      readFileSync(
        new URL(
          "../../node_modules/@shopify/shopify-app-react-router/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { version: string };
    expect(pkg.version).toBe("1.2.0");
  });

  it.each(NAMES)(
    "%s: answers the CORS preflight with 204 + CORS headers, no data read",
    async (name) => {
      const res = await run(route(name).loader, name, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
      expect(route(name).service).not.toHaveBeenCalled();
    },
  );

  it.each(NAMES)(
    "%s: a valid session token returns the results envelope with CORS headers",
    async (name) => {
      const res = await run(route(name).loader, name, {
        headers: { Authorization: `Bearer ${sessionToken()}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await res.json()).toEqual({
        results: [await route(name).service.mock.results[0].value],
      });
      expect(route(name).service).toHaveBeenCalledWith(
        ...(name === "latest-scan" ? [expect.anything(), SHOP] : [SHOP]),
      );
    },
  );

  it.each(NAMES)(
    "%s: a forged session token is a 401 that still carries CORS headers",
    async (name) => {
      const res = await run(route(name).loader, name, {
        headers: { Authorization: `Bearer ${sessionToken("wrong")}` },
      });
      expect(res.status).toBe(401);
      // Without CORS headers the sandbox would see an opaque network error.
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(route(name).service).not.toHaveBeenCalled();
    },
  );

  it.each(NAMES)(
    "%s: no Authorization header is a 302 to /auth/login (1.2.0), never data",
    async (name) => {
      // Pinned from a real run on 1.2.0 (library 2.0+ answers 200 App Bridge
      // HTML instead). In the sandbox, fetch either follows the redirect to
      // the HTML login page (a 200 that is not JSON) or rejects it as a CORS
      // failure: tests/extensions/sidekick-tools.test.ts covers that fetchTool
      // turns both into the short error.
      const res = await run(route(name).loader, name);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login");
      expect(await res.text()).toBe("");
      expect(route(name).service).not.toHaveBeenCalled();
    },
  );
});
