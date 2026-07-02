import { Session } from "@shopify/shopify-api";
import { SessionStorage } from "@shopify/shopify-app-session-storage";

// Mirrors the SDK's WITHIN_MILLISECONDS_OF_EXPIRY constant in
// ensure-offline-token-is-not-expired — treat a session expiring within this
// window as already expired so the guard and the SDK agree on stale sessions.
export const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Wraps a SessionStorage to intercept loadSession and return undefined for
 * offline sessions that are expired-beyond-refresh with no refreshToken.
 *
 * Without this guard, the SDK's ensureOfflineTokenIsNotExpired skips the
 * refresh branch (it requires session.refreshToken to be truthy), returns the
 * stale session unchanged, and the embedded app falls into an infinite
 * authenticate.admin reauth bounce loop (GC-07t).
 *
 * Returning undefined here forces a clean token exchange instead.
 */
export class SafeSessionStorage implements SessionStorage {
  constructor(private readonly inner: SessionStorage) {}

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (
      session &&
      !session.isOnline &&
      !session.refreshToken &&
      session.isExpired(FIVE_MINUTES_MS)
    ) {
      // Un-refreshable expired offline session — return undefined to force a
      // clean token exchange instead of an infinite reauth loop (GC-07t).
      return undefined;
    }
    return session;
  }

  async storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(session);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return this.inner.findSessionsByShop(shop);
  }
}
