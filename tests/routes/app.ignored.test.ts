/**
 * Tests for app/routes/app.ignored.tsx (E2.3 ignored-findings management view)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock shop + ignored-finding models.
 *   - Loader: returns serialized rows for the shop; empty list when no shop.
 *   - Action: un-ignore is tenant-scoped (delete count drives success/error),
 *     rejects unsupported intents, and 404s when the shop cannot be resolved.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: {} }));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  hasAnyScans: vi.fn(),
}));

vi.mock("../../app/models/ignored-finding.server", () => ({
  listIgnoredFindings: vi.fn(),
  deleteIgnoredFindingForShop: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  deleteIgnoredFindingForShop,
  listIgnoredFindings,
} from "../../app/models/ignored-finding.server";
import { hasAnyScans } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import IgnoredFindings, { action, loader } from "../../app/routes/app.ignored";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockListIgnoredFindings = listIgnoredFindings as ReturnType<typeof vi.fn>;
const mockDeleteIgnoredFindingForShop = deleteIgnoredFindingForShop as ReturnType<typeof vi.fn>;
const mockHasAnyScans = hasAnyScans as ReturnType<typeof vi.fn>;

const SHOP = { id: "shop-1", domain: "test-shop.myshopify.com", plan: "Standard" };

function makeLoaderArgs(): LoaderFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/app/ignored"),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

function makeActionArgs(fields: Record<string, string>): ActionFunctionArgs {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return {
    request: new Request("https://test-shop.myshopify.com/app/ignored", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    params: {},
    context: {},
  } as unknown as ActionFunctionArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: SHOP.domain } });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockHasAnyScans.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("app.ignored loader", () => {
  it("returns serialized ignore rows for the shop (createdAt as ISO string)", async () => {
    const createdAt = new Date("2026-03-20T10:00:00Z");
    mockListIgnoredFindings.mockResolvedValue([
      {
        id: "a1",
        scope: "APP",
        fingerprint: null,
        appName: "Judge.me",
        reason: "known good",
        createdAt,
      },
      {
        id: "i1",
        scope: "INSTANCE",
        fingerprint: "deadbeef",
        appName: null,
        reason: null,
        createdAt,
      },
    ]);

    const result = (await loader(makeLoaderArgs())) as {
      ignores: Array<{ id: string; scope: string; fingerprint: string | null; createdAt: string }>;
    };

    expect(mockListIgnoredFindings).toHaveBeenCalledWith(SHOP.id);
    expect(result.ignores).toHaveLength(2);
    expect(result.ignores[0]).toEqual({
      id: "a1",
      scope: "APP",
      fingerprint: null,
      appName: "Judge.me",
      reason: "known good",
      createdAt: createdAt.toISOString(),
    });
    expect(result.ignores[1].fingerprint).toBe("deadbeef");
  });

  it("returns an empty list when the shop cannot be resolved", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = (await loader(makeLoaderArgs())) as { ignores: unknown[] };

    expect(result.ignores).toEqual([]);
    expect(mockListIgnoredFindings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action — un-ignore
// ---------------------------------------------------------------------------

describe("app.ignored action", () => {
  it("un-ignores a row scoped to the shop and returns success", async () => {
    mockDeleteIgnoredFindingForShop.mockResolvedValue({ count: 1 });

    const result = await action(makeActionArgs({ intent: "unignore", id: "i1" }));

    expect(mockDeleteIgnoredFindingForShop).toHaveBeenCalledWith("i1", SHOP.id);
    expect(result).toEqual({ success: true });
  });

  it("returns an error when the row is not the shop's (delete count 0)", async () => {
    mockDeleteIgnoredFindingForShop.mockResolvedValue({ count: 0 });

    const result = await action(makeActionArgs({ intent: "unignore", id: "other-shops-row" }));

    expect(result).toEqual({ error: "Suppression not found" });
  });

  it("returns an error when id is missing (no delete)", async () => {
    const result = await action(makeActionArgs({ intent: "unignore" }));

    expect(result).toEqual({ error: "Id is required" });
    expect(mockDeleteIgnoredFindingForShop).not.toHaveBeenCalled();
  });

  it("rejects an unsupported intent", async () => {
    const result = await action(makeActionArgs({ intent: "bogus", id: "i1" }));

    expect(result).toEqual({ error: "Unsupported action" });
    expect(mockDeleteIgnoredFindingForShop).not.toHaveBeenCalled();
  });

  it("throws a 404 Response when the shop cannot be resolved", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(action(makeActionArgs({ intent: "unignore", id: "i1" }))).rejects.toBeInstanceOf(
      Response,
    );
    expect(mockDeleteIgnoredFindingForShop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// gc-vg4: "Run your first scan" CTA only when the shop has zero scans ever
// ---------------------------------------------------------------------------

describe("app.ignored zero-scans CTA (gc-vg4)", () => {
  function renderPage(loaderData: unknown): string {
    const Stub = createRoutesStub([
      {
        id: "ignored",
        path: "/app/ignored",
        Component: IgnoredFindings as never,
        loader: () => loaderData,
      },
    ]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/app/ignored"],
        hydrationData: { loaderData: { ignored: loaderData } },
      }),
    );
  }

  it("loader reports hasAnyScans=false and the page shows the CTA linking Home", async () => {
    mockListIgnoredFindings.mockResolvedValue([]);
    mockHasAnyScans.mockResolvedValue(false);

    const data = await loader(makeLoaderArgs());

    expect(mockHasAnyScans).toHaveBeenCalledWith(SHOP.id);
    expect(data).toEqual({ ignores: [], hasAnyScans: false });
    const html = renderPage(data);
    expect(html).toContain("No suppressed findings");
    expect(html).toContain("Ghost Code hasn&#x27;t scanned your theme yet.");
    expect(html).toMatch(
      /<a href="\/app"[^>]*><s-button variant="primary">Run your first scan<\/s-button><\/a>/,
    );
  });

  it("empty list but the shop HAS scanned: no CTA", async () => {
    mockListIgnoredFindings.mockResolvedValue([]);
    mockHasAnyScans.mockResolvedValue(true);

    const data = await loader(makeLoaderArgs());

    expect(data).toEqual({ ignores: [], hasAnyScans: true });
    const html = renderPage(data);
    expect(html).toContain("No suppressed findings");
    expect(html).not.toContain("Run your first scan");
  });

  it("skips the scan query when ignores exist (an ignore implies a scan)", async () => {
    mockListIgnoredFindings.mockResolvedValue([
      {
        id: "i1",
        scope: "INSTANCE",
        fingerprint: "f",
        appName: null,
        reason: null,
        createdAt: new Date("2026-03-20T10:00:00Z"),
      },
    ]);

    const data = await loader(makeLoaderArgs());

    expect(mockHasAnyScans).not.toHaveBeenCalled();
    expect(data).toMatchObject({ hasAnyScans: true });
    expect(renderPage(data)).not.toContain("Run your first scan");
  });

  it("an unresolvable shop gets the CTA (Home creates the shop on load)", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const data = await loader(makeLoaderArgs());

    expect(data).toEqual({ ignores: [], hasAnyScans: false });
    expect(mockHasAnyScans).not.toHaveBeenCalled();
  });
});
