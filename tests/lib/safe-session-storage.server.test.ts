/**
 * Tests for app/lib/safe-session-storage.server.ts
 *
 * Strategy:
 *   - Use a fake inner SessionStorage (vi.fn() stubs) — no real DB.
 *   - Build Session instances via the real Session class from @shopify/shopify-api
 *     so .isOnline / .isExpired() / .refreshToken behave like production.
 */

import { Session } from "@shopify/shopify-api";
import { SessionStorage } from "@shopify/shopify-app-session-storage";
import { describe, expect, it, vi } from "vitest";

import { SafeSessionStorage } from "../../app/lib/safe-session-storage.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(opts: {
  isOnline: boolean;
  expires?: Date;
  refreshToken?: string;
  accessToken?: string;
}): Session {
  const session = new Session({
    id: "test-session-id",
    shop: "test-shop.myshopify.com",
    state: "test-state",
    isOnline: opts.isOnline,
  });
  if (opts.expires !== undefined) session.expires = opts.expires;
  if (opts.refreshToken !== undefined) session.refreshToken = opts.refreshToken;
  if (opts.accessToken !== undefined) session.accessToken = opts.accessToken;
  return session;
}

function makeFakeInner(overrides?: Partial<SessionStorage>): SessionStorage {
  return {
    loadSession: vi.fn(),
    storeSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
    findSessionsByShop: vi.fn(),
    ...overrides,
  };
}

const PAST = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
// 1 minute in the future — within the 5-minute buffer, treated as expired
const NEAR_FUTURE = new Date(Date.now() + 60 * 1000);

// ---------------------------------------------------------------------------
// loadSession guard logic
// ---------------------------------------------------------------------------

describe("SafeSessionStorage.loadSession", () => {
  it("returns undefined for offline + expired + NO refreshToken (the bug case)", async () => {
    const session = makeSession({ isOnline: false, expires: PAST });
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(session) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("test-session-id");

    expect(result).toBeUndefined();
    expect(inner.loadSession).toHaveBeenCalledWith("test-session-id");
  });

  it("passes through offline + expired + WITH refreshToken (let SDK refresh it)", async () => {
    const session = makeSession({
      isOnline: false,
      expires: PAST,
      refreshToken: "rt-abc",
    });
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(session) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("test-session-id");

    expect(result).toBe(session);
  });

  it("passes through offline + NOT expired + no refreshToken (still valid)", async () => {
    const session = makeSession({ isOnline: false, expires: FUTURE });
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(session) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("test-session-id");

    expect(result).toBe(session);
  });

  it("passes through online session even if expired (guard must not touch online sessions)", async () => {
    const session = makeSession({ isOnline: true, expires: PAST });
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(session) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("test-session-id");

    expect(result).toBe(session);
  });

  it("passes through undefined from inner without crashing", async () => {
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(undefined) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("nonexistent");

    expect(result).toBeUndefined();
  });

  it("treats session expiring within the 5-minute buffer as expired (returns undefined)", async () => {
    // Expires 1 minute from now — within the 5-min buffer; guard should return undefined
    const session = makeSession({ isOnline: false, expires: NEAR_FUTURE });
    const inner = makeFakeInner({ loadSession: vi.fn().mockResolvedValue(session) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.loadSession("test-session-id");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Delegation — all other methods pass through unchanged
// ---------------------------------------------------------------------------

describe("SafeSessionStorage delegation", () => {
  it("storeSession delegates to inner and returns its result", async () => {
    const session = makeSession({ isOnline: false, expires: FUTURE });
    const inner = makeFakeInner({ storeSession: vi.fn().mockResolvedValue(true) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.storeSession(session);

    expect(result).toBe(true);
    expect(inner.storeSession).toHaveBeenCalledWith(session);
  });

  it("deleteSession delegates to inner and returns its result", async () => {
    const inner = makeFakeInner({ deleteSession: vi.fn().mockResolvedValue(true) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.deleteSession("some-id");

    expect(result).toBe(true);
    expect(inner.deleteSession).toHaveBeenCalledWith("some-id");
  });

  it("deleteSessions delegates to inner with the same ids and returns its result", async () => {
    const ids = ["id-1", "id-2"];
    const inner = makeFakeInner({ deleteSessions: vi.fn().mockResolvedValue(true) });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.deleteSessions(ids);

    expect(result).toBe(true);
    expect(inner.deleteSessions).toHaveBeenCalledWith(ids);
  });

  it("findSessionsByShop delegates to inner and returns its result", async () => {
    const sessions = [makeSession({ isOnline: false, expires: FUTURE })];
    const inner = makeFakeInner({
      findSessionsByShop: vi.fn().mockResolvedValue(sessions),
    });
    const storage = new SafeSessionStorage(inner);

    const result = await storage.findSessionsByShop("test-shop.myshopify.com");

    expect(result).toBe(sessions);
    expect(inner.findSessionsByShop).toHaveBeenCalledWith("test-shop.myshopify.com");
  });
});
