/**
 * Tests for app/services/theme-cache.server.ts
 *
 * Strategy:
 *   - Mock theme-fetcher.server so we can assert exactly how often the raw
 *     fetchers are hit through the cache.
 *   - resetThemeCaches() in beforeEach isolates the module-level cache per test.
 *   - Expiry is driven with vi.useFakeTimers() (the cache uses the real Date.now
 *     internally) so the 60s TTL is exercised without real sleeps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
  fetchAllThemes: vi.fn(),
}));

import {
  getCachedAllThemes,
  getCachedMainTheme,
  resetThemeCaches,
} from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";

const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockFetchAllThemes = fetchAllThemes as ReturnType<typeof vi.fn>;

const ADMIN = { graphql: vi.fn() } as never;

const MAIN_THEME = {
  id: "gid://shopify/Theme/1",
  name: "Dawn",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const ALL_THEMES = [
  { id: "gid://shopify/Theme/1", name: "Dawn", role: "MAIN", updatedAt: "2026-01-01T00:00:00Z" },
];

beforeEach(() => {
  vi.resetAllMocks();
  resetThemeCaches();
  mockFetchMainTheme.mockResolvedValue(MAIN_THEME);
  mockFetchAllThemes.mockResolvedValue(ALL_THEMES);
});

afterEach(() => {
  // Restore any Date.now spy installed by an expiry test so it can't leak into
  // later tests in this file.
  vi.restoreAllMocks();
});

describe("getCachedMainTheme", () => {
  it("fetches on the first call and returns the value", async () => {
    const result = await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");

    expect(result).toEqual(MAIN_THEME);
    expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
  });

  it("serves a second call within the TTL from cache without re-fetching", async () => {
    await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    const second = await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");

    expect(second).toEqual(MAIN_THEME);
    expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
  });

  it("does not share cache state across different shop keys", async () => {
    await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    await getCachedMainTheme(ADMIN, "shop-b.myshopify.com");

    expect(mockFetchMainTheme).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the TTL expires", async () => {
    // The cache reads Date.now() at call time; spy on it to drive expiry
    // deterministically without real sleeps.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);

    await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    nowSpy.mockReturnValue(61_000); // past the 60s TTL
    await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");

    expect(mockFetchMainTheme).toHaveBeenCalledTimes(2);
  });

  it("caches a null result (no published theme) for the TTL", async () => {
    mockFetchMainTheme.mockResolvedValue(null);

    const first = await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    const second = await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
  });

  it("does not cache a thrown fetch error — the next call retries", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("Shopify API error"));

    await expect(getCachedMainTheme(ADMIN, "shop-a.myshopify.com")).rejects.toThrow(
      "Shopify API error",
    );

    // Underlying mock now resolves; the failure must not have been cached.
    const retry = await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    expect(retry).toEqual(MAIN_THEME);
    expect(mockFetchMainTheme).toHaveBeenCalledTimes(2);
  });
});

describe("getCachedAllThemes", () => {
  it("serves a second call within the TTL from cache without re-fetching", async () => {
    const first = await getCachedAllThemes(ADMIN, "shop-a.myshopify.com");
    const second = await getCachedAllThemes(ADMIN, "shop-a.myshopify.com");

    expect(first).toEqual(ALL_THEMES);
    expect(second).toEqual(ALL_THEMES);
    expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
  });

  it("does not share cache state across different shop keys", async () => {
    await getCachedAllThemes(ADMIN, "shop-a.myshopify.com");
    await getCachedAllThemes(ADMIN, "shop-b.myshopify.com");

    expect(mockFetchAllThemes).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown fetch error — the next call retries", async () => {
    mockFetchAllThemes.mockRejectedValueOnce(new Error("throttled"));

    await expect(getCachedAllThemes(ADMIN, "shop-a.myshopify.com")).rejects.toThrow("throttled");

    const retry = await getCachedAllThemes(ADMIN, "shop-a.myshopify.com");
    expect(retry).toEqual(ALL_THEMES);
    expect(mockFetchAllThemes).toHaveBeenCalledTimes(2);
  });

  it("keeps main-theme and all-themes caches in separate namespaces", async () => {
    // A cached main-theme read must not satisfy an all-themes read for the same key.
    await getCachedMainTheme(ADMIN, "shop-a.myshopify.com");
    await getCachedAllThemes(ADMIN, "shop-a.myshopify.com");

    expect(mockFetchMainTheme).toHaveBeenCalledTimes(1);
    expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
  });
});
