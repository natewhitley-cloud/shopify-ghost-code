// gc-4n0y: the shared App Bridge optional-scopes hook behind the Settings
// Permissions card and Home's welcome-card line. GC has no jsdom, so (as in
// use-hydrated.test.tsx) the hook runs in a tiny SSR harness: effects never
// run, which is the first-render state, and the returned request function is
// driven directly against a stubbed App Bridge global.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, afterEach } from "vitest";

import { OPTIONAL_SCOPES } from "../../app/lib/optional-scopes";
import { useOptionalScopes } from "../../app/lib/use-optional-scopes";
import type { OptionalScopesState } from "../../app/lib/use-optional-scopes";

function captureState(): OptionalScopesState {
  let captured!: OptionalScopesState;
  function Harness() {
    captured = useOptionalScopes();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useOptionalScopes", () => {
  it("first render: grant state unknown, nothing requested, every optional scope missing", () => {
    const state = captureState();
    expect(state.granted).toBeNull();
    expect(state.unsupported).toBe(false);
    expect(state.requesting).toBe(false);
    expect(state.missing).toEqual([...OPTIONAL_SCOPES]);
  });

  it("requestMissing opens the App Bridge scopes request for the missing scopes, then re-queries", async () => {
    const request = vi.fn().mockResolvedValue({ result: "granted-all", detail: { granted: [] } });
    const query = vi
      .fn()
      .mockResolvedValue({ granted: [...OPTIONAL_SCOPES], required: [], optional: [] });
    vi.stubGlobal("shopify", { scopes: { request, query } });

    await captureState().requestMissing();

    expect(request).toHaveBeenCalledWith([...OPTIONAL_SCOPES]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requestMissing is a no-op without the App Bridge scopes API", async () => {
    vi.stubGlobal("shopify", {});
    await expect(captureState().requestMissing()).resolves.toBeUndefined();
  });

  it("a rejected request never throws to the caller", async () => {
    const request = vi.fn().mockRejectedValue(new Error("modal failed"));
    vi.stubGlobal("shopify", { scopes: { request, query: vi.fn() } });
    await expect(captureState().requestMissing()).resolves.toBeUndefined();
  });
});
