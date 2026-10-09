/**
 * The App Bridge optional-scopes state and request, shared by the Settings
 * Permissions card and Home's welcome-card "deeper first scan" line (gc-4n0y),
 * so both open the SAME `shopify.scopes.request()` modal for the same scopes.
 *
 * The `shopify` global is injected by App Bridge in embedded context. The
 * `scopes` API is relatively new, so it is typed optional and guarded at runtime:
 * on an older App Bridge `shopify.scopes` is undefined and `unsupported` turns
 * true instead of throwing.
 *
 * Shapes verified against the App Home Scopes API docs
 * (shopify.dev/docs/api/app-home/v1.0/apis/authentication-and-data/scopes-api):
 *   - query()   -> { granted, required, optional }  (string[] each)
 *   - request() -> { result: "granted-all" | "declined-all", detail: { granted } }
 *
 * Client-safe: the effect runs only in the browser, so SSR never touches
 * `shopify` (the first render has granted === null).
 */
import { useEffect, useState } from "react";

import { missingOptionalScopes } from "./optional-scopes";
import type { OptionalScope } from "./optional-scopes";

declare const shopify:
  | {
      scopes?: {
        query: () => Promise<{ granted: string[]; required: string[]; optional: string[] }>;
        request: (
          scopes: string[],
        ) => Promise<{ result: "granted-all" | "declined-all"; detail: { granted: string[] } }>;
      };
    }
  | undefined;

/**
 * How a scopes request ended. The App Bridge modal is all-or-nothing, and a
 * closed modal resolves like a decline, so the outcome is read from the
 * re-queried grant state rather than the request's own result.
 */
export type ScopeRequestOutcome = "granted" | "declined" | "failed";

/** Pure: the outcome from the scopes granted AFTER the request. */
export function scopeRequestOutcome(grantedAfter: readonly string[]): ScopeRequestOutcome {
  return missingOptionalScopes(grantedAfter).length === 0 ? "granted" : "declined";
}

export type OptionalScopesState = {
  /** null until the first query resolves (and forever if it failed). */
  granted: string[] | null;
  /** true when the App Bridge scopes API is unavailable (older App Bridge). */
  unsupported: boolean;
  /** true when the initial query or a request failed. */
  failed: boolean;
  requesting: boolean;
  /** Optional scopes not granted (all of them while granted is unknown). */
  missing: OptionalScope[];
  /**
   * Open the App Bridge permission modal for `missing`, then re-query. Resolves
   * with the outcome (null when the scopes API is unavailable); never rejects.
   */
  requestMissing: () => Promise<ScopeRequestOutcome | null>;
};

export function useOptionalScopes(): OptionalScopesState {
  const [granted, setGranted] = useState<string[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [failed, setFailed] = useState(false);
  const [requesting, setRequesting] = useState(false);

  // Query current scopes on mount.
  useEffect(() => {
    if (typeof shopify === "undefined" || !shopify.scopes) {
      setUnsupported(true);
      return;
    }
    let cancelled = false;
    shopify.scopes
      .query()
      .then((res) => {
        if (!cancelled) setGranted(res.granted);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missing = missingOptionalScopes(granted ?? []);

  async function requestMissing(): Promise<ScopeRequestOutcome | null> {
    if (typeof shopify === "undefined" || !shopify.scopes) return null;
    setRequesting(true);
    setFailed(false);
    try {
      await shopify.scopes.request(missing);
      // Re-query so the displayed state reflects the merchant's decision (the
      // modal is all-or-nothing, but re-querying is the authoritative source).
      const res = await shopify.scopes.query();
      setGranted(res.granted);
      return scopeRequestOutcome(res.granted);
    } catch {
      setFailed(true);
      return "failed";
    } finally {
      setRequesting(false);
    }
  }

  return { granted, unsupported, failed, requesting, missing, requestMissing };
}
