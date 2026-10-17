/**
 * Tests for app/routes/ops.digest[.]json.tsx (GET /ops/digest.json).
 * The loader is mocked; this file covers the auth gate and HTTP shape only.
 */

import type { LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBuild = vi.fn();
vi.mock("../../inngest/lib/nod-digest", () => ({
  buildNodDigest: (...args: unknown[]) => mockBuild(...args),
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action, loader } from "../../app/routes/ops.digest[.]json";

const SECRET = "s".repeat(40);

function call(headers: Record<string, string> = {}) {
  const request = new Request("https://ghostcode.test/ops/digest.json", { headers });
  return loader({ request } as LoaderFunctionArgs);
}

beforeEach(() => {
  process.env.NOD_OPS_SECRET = SECRET;
  mockBuild.mockReset().mockResolvedValue({ contractVersion: 1 });
});
afterEach(() => {
  delete process.env.NOD_OPS_SECRET;
});

async function expectBare404(res: Response | Promise<Response>) {
  const r = await res;
  expect(r.status).toBe(404);
  expect(await r.text()).toBe("");
  expect(mockBuild).not.toHaveBeenCalled();
}

describe("GET /ops/digest.json auth", () => {
  it("404s when NOD_OPS_SECRET is unset", async () => {
    delete process.env.NOD_OPS_SECRET;
    await expectBare404(call({ authorization: `Bearer ${SECRET}` }));
  });

  it("404s when NOD_OPS_SECRET is shorter than 32 chars, even with a matching header", async () => {
    process.env.NOD_OPS_SECRET = "short-secret";
    await expectBare404(call({ authorization: "Bearer short-secret" }));
  });

  it("404s when the Authorization header is missing", async () => {
    await expectBare404(call());
  });

  it("404s on a wrong secret", async () => {
    await expectBare404(call({ authorization: `Bearer ${"x".repeat(40)}` }));
  });

  it("404s on a wrong-length secret and on a missing Bearer prefix", async () => {
    await expectBare404(call({ authorization: `Bearer ${SECRET}extra` }));
    await expectBare404(call({ authorization: SECRET }));
  });

  it("404s on any non-GET method (action)", async () => {
    const res = await action();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("GET /ops/digest.json success", () => {
  it("returns 200 JSON with no-store for the correct secret", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ contractVersion: 1 });
  });

  it("returns a bare 500 (no detail) when the loader throws", async () => {
    mockBuild.mockRejectedValue(new Error("db down for secret-shop.myshopify.com"));
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });
});
