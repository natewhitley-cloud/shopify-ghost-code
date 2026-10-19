/**
 * Static checks for extensions/sidekick-tools (gc-5nok, copied from
 * FraudPilot ft-68j / ClearSignal ba-lgun): tools.json is valid and inside
 * Sidekick's limits, src/index.js registers exactly the tools in tools.json,
 * each tool fetches an existing /api/sidekick resource route, no promotional
 * wording ships in the extension (App Store rules 2.2.8/2.2.9), the product
 * wording rules hold, and the extension stays read-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

const ROOT = join(__dirname, "../..");
const DIR = join(ROOT, "extensions/sidekick-tools");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

type Tool = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
};
const tools = JSON.parse(read("tools.json")) as Tool[];
const indexJs = read("src/index.js");
const instructions = read("instructions.md");
const toml = read("shopify.extension.toml");
const appToml = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");
const sidekickSummary = appToml.split("[sidekick]")[1] ?? "";

// Rough token estimate (~4 characters per token), deliberately conservative.
const tokens = (s: string) => Math.ceil(s.length / 4);

/** Everything that ships to Sidekick as text: extension files, response copy, app summary. */
const shippedText = [
  read("tools.json"),
  instructions,
  read("locales/en.default.json"),
  readFileSync(join(ROOT, "app/services/sidekick-scan-summary.server.ts"), "utf8"),
  readFileSync(join(ROOT, "app/services/sidekick-speed-summary.server.ts"), "utf8"),
  readFileSync(join(ROOT, "app/services/sidekick-route.server.ts"), "utf8"),
  sidekickSummary,
].join("\n");

describe("extensions/sidekick-tools", () => {
  it("declares the admin.app.tools.data target with the tools and instructions files", () => {
    expect(toml).toMatch(/api_version = "2026-07"/);
    expect(toml).toMatch(/type = "ui_extension"/);
    expect(toml).toMatch(/target = "admin\.app\.tools\.data"/);
    expect(toml).toMatch(/tools = "\.\/tools\.json"/);
    expect(toml).toMatch(/instructions = "\.\/instructions\.md"/);
    expect(toml).toMatch(/module = "\.\/src\/index\.js"/);
    // The CLI's uid shape: 8-4-4-4-24 hex.
    expect(toml).toMatch(/^uid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{24}"$/m);
  });

  it("has no package.json or tsconfig (a workspace package desyncs package-lock and breaks npm ci)", () => {
    expect(existsSync(join(DIR, "package.json"))).toBe(false);
    expect(existsSync(join(DIR, "tsconfig.json"))).toBe(false);
  });

  it("has valid tool definitions within Sidekick's limits", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(20);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.description.length).toBeLessThanOrEqual(512);
      // Sidekick's description limit is 256 tokens.
      expect(tokens(t.description)).toBeLessThan(256);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("keeps instructions under 2,048 tokens", () => {
    expect(tokens(instructions)).toBeLessThan(2048);
  });

  it("registers exactly the tools in tools.json", () => {
    const registered = [...indexJs.matchAll(/shopify\.tools\.register\("([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(registered.sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it("fetches relative /api/sidekick paths that have a resource route", () => {
    const paths = [...indexJs.matchAll(/"(\/api\/sidekick\/[a-z-]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBe(tools.length);
    for (const p of paths) {
      const route = join(ROOT, "app/routes", `${p.slice(1).replace(/\//g, ".")}.ts`);
      expect(existsSync(route), route).toBe(true);
    }
  });

  it("stays read-only: the routes export a loader and no action", async () => {
    vi.doMock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
    for (const name of ["latest-scan", "speed"]) {
      const mod = await import(`../../app/routes/api.sidekick.${name}.ts`);
      expect(typeof mod.loader).toBe("function");
      expect(mod.action).toBeUndefined();
    }
    vi.doUnmock("../../app/shopify.server");
  });

  it("contains no upsell or review-request wording", () => {
    expect(shippedText).not.toMatch(
      /\bupgrade\b|\bunlock\b|\bpremium\b|\bfree trial\b|\breview us\b|leave a review|\brate us\b/i,
    );
  });

  it('says "GhostCode" and "leftover code", never the two-word product name, and has no em dashes', () => {
    expect(shippedText).not.toMatch(/ghost\s+code/i);
    expect(shippedText).not.toContain("—");
  });

  it("describes impact areas, not severity, in what Sidekick reads", () => {
    const merchantFacing = [read("tools.json"), read("locales/en.default.json"), sidekickSummary];
    for (const text of merchantFacing) expect(text).not.toMatch(/severity/i);
  });

  it("explains app security advisories: first when present, facts only, never 'affected'", () => {
    const line = instructions.split("\n").find((l) => l.includes("`appSecurityAdvisories`")) ?? "";
    expect(line).toContain("say so first");
    expect(line).toContain("An app named in a security incident is in your theme.");
    expect(line).toContain("the app is in the theme, and a public incident report names it");
    expect(line).toMatch(/Never say or suggest the store was hacked, breached or affected/);
    expect(line).toMatch(/never add incident details .* not in the result/);
  });

  it("adds a one-sentence [sidekick] extensions_summary to shopify.app.toml", () => {
    expect(sidekickSummary).toMatch(/^\s*extensions_summary = "[^"]+"\s*$/);
  });

  it("gitignores the CLI-generated shopify.d.ts", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toMatch(
      /^extensions\/\*\/shopify\.d\.ts$/m,
    );
  });
});

describe("extensions/sidekick-tools/src/index.js at runtime", () => {
  type Handler = (input?: unknown) => Promise<unknown>;

  async function registerTools() {
    const handlers = new Map<string, Handler>();
    vi.stubGlobal("shopify", {
      tools: { register: (name: string, fn: Handler) => handlers.set(name, fn) },
    });
    const mod = await import("../../extensions/sidekick-tools/src/index.js");
    await mod.default();
    return handlers;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches each tool's relative route and returns its JSON", async () => {
    const fetchMock = vi.fn<(path: string) => Promise<Response>>(async () =>
      Response.json({ results: [{ status: "ok" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = await registerTools();
    await expect(handlers.get("get_latest_scan_summary")!({})).resolves.toEqual({
      results: [{ status: "ok" }],
    });
    await handlers.get("get_speed_summary")!();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/sidekick/latest-scan",
      "/api/sidekick/speed",
    ]);
  });

  it.each([
    ["a 401 with an empty body", async () => new Response(null, { status: 401 })],
    ["a 500 with an HTML body", async () => new Response("<html>", { status: 500 })],
    [
      // shopify-app-react-router 1.2.0 answers a request with no session token
      // with a 302 to /auth/login (tests/routes/api.sidekick.real-library);
      // followed, that is the HTML login page with a 200.
      "the 200 HTML login page after the no-token 302",
      async () =>
        new Response("<!DOCTYPE html><form>Log in</form>", {
          status: 200,
          headers: { "content-type": "text/html;charset=utf-8" },
        }),
    ],
    [
      // Library 2.0+ renders a 200 App Bridge page instead (siblings).
      "a 200 App Bridge HTML page",
      async () =>
        new Response("<script data-api-key></script>", {
          status: 200,
          headers: { "content-type": "text/html;charset=utf-8" },
        }),
    ],
    [
      // The 302 itself carries no CORS headers: the sandbox may reject it.
      "a redirect rejected as a CORS failure",
      async () => Promise.reject(new TypeError("Failed to fetch")),
    ],
    ["a network failure", async () => Promise.reject(new TypeError("failed"))],
    ["a 200 JSON body without a results list", async () => Response.json({ error: "unexpected" })],
  ])("returns a short factual error on %s instead of throwing", async (_label, impl) => {
    vi.stubGlobal("fetch", vi.fn(impl));
    const handlers = await registerTools();
    for (const handler of handlers.values()) {
      await expect(handler()).resolves.toEqual({
        results: [{ status: "error", message: "GhostCode could not read this data right now." }],
      });
    }
  });
});
