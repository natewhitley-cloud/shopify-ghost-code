/**
 * Minimal in-memory TTL cache.
 *
 * Backed by a `Map` keyed by string. Each entry stores its value alongside an
 * absolute expiry timestamp (ms). `get` returns `undefined` on a miss or once
 * the entry has expired (expired entries are evicted lazily on read). `set`
 * (re)writes an entry with a fresh expiry `ttlMs` in the future.
 *
 * `undefined` is reserved to mean "miss" — callers can still cache a `null`
 * value and have it read back as a hit (distinct from `undefined`).
 *
 * The clock is injectable (defaults to `Date.now`) so expiry is deterministic
 * in tests without having to fake global timers.
 */

export type TtlCache<T> = {
  /** Returns the cached value, or `undefined` on a miss or expiry. */
  get: (key: string) => T | undefined;
  /** Stores `value` under `key`, resetting its expiry to `now + ttlMs`. */
  set: (key: string, value: T) => void;
  /** Removes every entry. */
  clear: () => void;
};

export function createTtlCache<T>(
  ttlMs: number,
  now: () => number = () => Date.now(),
): TtlCache<T> {
  const store = new Map<string, { value: T; expiresAt: number }>();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    clear() {
      store.clear();
    },
  };
}
