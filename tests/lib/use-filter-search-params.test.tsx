// Ported from ClearSignal (bot-analytics-cleanup-app), adapted to Ghost Code's
// node test environment: GC has no jsdom/@testing-library, so instead of
// `renderHook` we drive the hook through a tiny SSR harness component rendered
// with react-dom/server and inspect what the mocked underlying setter received.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock react-router's useSearchParams so we can inspect exactly what options
// the hook forwards to the underlying setter.
const underlyingSet = vi.fn();
const currentParams = new URLSearchParams("cursor=abc");

vi.mock("react-router", () => ({
  useSearchParams: () => [currentParams, underlyingSet] as const,
}));

import { useFilterSearchParams } from "../../app/lib/use-filter-search-params";

/**
 * Render a harness that invokes the hook once, runs `run` against the returned
 * tuple during render (so any setter calls hit the mocked underlyingSet), and
 * returns the tuple for assertions on the read value.
 */
function driveHook(
  run: (tuple: ReturnType<typeof useFilterSearchParams>) => void,
): ReturnType<typeof useFilterSearchParams> {
  let captured!: ReturnType<typeof useFilterSearchParams>;
  function Harness() {
    const tuple = useFilterSearchParams();
    captured = tuple;
    run(tuple);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return captured;
}

describe("useFilterSearchParams", () => {
  beforeEach(() => {
    underlyingSet.mockClear();
  });

  it("returns the current searchParams from useSearchParams", () => {
    const tuple = driveHook(() => {});
    expect(tuple[0]).toBe(currentParams);
  });

  it("forwards preventScrollReset:true for the functional-updater form", () => {
    const updater = (prev: URLSearchParams) => prev;
    driveHook(([, setFilter]) => setFilter(updater));

    expect(underlyingSet).toHaveBeenCalledTimes(1);
    const [passedInit, passedOpts] = underlyingSet.mock.calls[0];
    expect(passedInit).toBe(updater);
    expect(passedOpts).toEqual({ preventScrollReset: true });
  });

  it("forwards preventScrollReset:true for the value form", () => {
    const value = new URLSearchParams("status=FAILED");
    driveHook(([, setFilter]) => setFilter(value));

    expect(underlyingSet).toHaveBeenCalledTimes(1);
    const [passedInit, passedOpts] = underlyingSet.mock.calls[0];
    expect(passedInit).toBe(value);
    expect(passedOpts).toEqual({ preventScrollReset: true });
  });

  it("preserves caller-supplied navigate options while forcing preventScrollReset", () => {
    driveHook(([, setFilter]) => setFilter(new URLSearchParams(), { replace: true }));

    const [, passedOpts] = underlyingSet.mock.calls[0];
    expect(passedOpts).toEqual({ replace: true, preventScrollReset: true });
  });

  it("cannot be overridden to reset scroll: preventScrollReset stays true even if a caller passes false", () => {
    driveHook(([, setFilter]) => setFilter(new URLSearchParams(), { preventScrollReset: false }));

    const [, passedOpts] = underlyingSet.mock.calls[0];
    expect(passedOpts).toEqual({ preventScrollReset: true });
  });
});
