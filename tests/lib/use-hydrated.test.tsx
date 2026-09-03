// GC has no jsdom/@testing-library, so (as in use-filter-search-params.test.tsx)
// we drive the hook through a tiny SSR harness rendered with react-dom/server.
// react-dom/server never runs effects, which is exactly the SSR + first-client-
// render condition useHydrated is designed for: it must report `false` there.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";

import { useHydrated } from "../../app/lib/use-hydrated";

function captureHydrated(): boolean {
  let captured!: boolean;
  function Harness() {
    captured = useHydrated();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return captured;
}

describe("useHydrated", () => {
  it("returns false during SSR / the first render (before effects run)", () => {
    // renderToStaticMarkup does not run useEffect, mirroring the server render
    // and the first client render before hydration commits.
    expect(captureHydrated()).toBe(false);
  });

  // After mount, the useEffect setter flips the value to true. That transition
  // requires a real effect flush (browser hydration / act() with a DOM), which
  // this node environment (no jsdom/RTL) cannot drive, so it is not asserted
  // here. The false-on-first-render guarantee above is what prevents the
  // hydration mismatch; the post-mount `true` is standard useState/useEffect
  // behavior exercised by React itself.
});
