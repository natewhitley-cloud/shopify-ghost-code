/**
 * Tests for app/lib/ttl-cache.server.ts
 *
 * Strategy:
 *   - Inject a mutable clock (`() => nowMs`) so expiry is fully deterministic
 *     without faking global timers — advancing time is just `nowMs = ...`.
 *   - Cover: hit within TTL, miss after expiry, distinct-key isolation, that
 *     `set` refreshes expiry, that `null` is a hit (distinct from an undefined
 *     miss), and that `clear` empties the store.
 */

import { describe, it, expect } from "vitest";

import { createTtlCache } from "../../app/lib/ttl-cache.server";

const TTL = 60_000;

describe("createTtlCache", () => {
  it("returns the cached value on a hit within the TTL", () => {
    let nowMs = 0;
    const cache = createTtlCache<string>(TTL, () => nowMs);

    cache.set("k", "v");
    nowMs = TTL - 1; // still inside the window

    expect(cache.get("k")).toBe("v");
  });

  it("returns undefined for a key that was never set", () => {
    const cache = createTtlCache<string>(TTL, () => 0);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns undefined once the entry has expired", () => {
    let nowMs = 0;
    const cache = createTtlCache<string>(TTL, () => nowMs);

    cache.set("k", "v");
    nowMs = TTL; // expiry is exclusive: now >= expiresAt is a miss

    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts the expired entry on read (does not resurrect it if the clock rewinds)", () => {
    let nowMs = 0;
    const cache = createTtlCache<string>(TTL, () => nowMs);

    cache.set("k", "v");
    nowMs = TTL + 1;
    expect(cache.get("k")).toBeUndefined(); // triggers lazy eviction

    nowMs = 0; // clock rewinds; entry was deleted, so still a miss
    expect(cache.get("k")).toBeUndefined();
  });

  it("isolates entries by key", () => {
    let nowMs = 0;
    const cache = createTtlCache<string>(TTL, () => nowMs);

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    nowMs = TTL - 1;

    expect(cache.get("a")).toBe("value-a");
    expect(cache.get("b")).toBe("value-b");
  });

  it("refreshes the expiry window when a key is set again", () => {
    let nowMs = 0;
    const cache = createTtlCache<string>(TTL, () => nowMs);

    cache.set("k", "first");
    nowMs = TTL - 1;
    cache.set("k", "second"); // new expiry = (TTL - 1) + TTL

    nowMs = TTL; // would have expired the first write, but not the refreshed one
    expect(cache.get("k")).toBe("second");
  });

  it("treats a cached null as a hit, distinct from an undefined miss", () => {
    const nowMs = 0;
    const cache = createTtlCache<string | null>(TTL, () => nowMs);

    cache.set("k", null);
    expect(cache.get("k")).toBeNull();
    expect(cache.get("absent")).toBeUndefined();
  });

  it("empties the store on clear", () => {
    const cache = createTtlCache<string>(TTL, () => 0);

    cache.set("k", "v");
    cache.clear();

    expect(cache.get("k")).toBeUndefined();
  });
});
