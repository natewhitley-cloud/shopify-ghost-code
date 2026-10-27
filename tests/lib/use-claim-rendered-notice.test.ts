/**
 * useClaimRenderedNotice (gc-1q1s.11): Home's consent notices are stamped by
 * a post from an effect after render, once per page view. React's hooks are
 * stubbed (no DOM environment in this suite): useEffect runs its callback the
 * way React does after a commit, useRef keeps one box per "component".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const submit = vi.fn();
let ref: { current: unknown } | null = null;
let lastDeps: unknown[] | null = null;
const effects: Array<() => void> = [];

vi.mock("react", () => ({
  useRef: (init: unknown) => (ref ??= { current: init }),
  useEffect: (fn: () => void, deps: unknown[]) => {
    // React re-runs an effect only when a dependency changed.
    if (lastDeps && deps.every((d, i) => Object.is(d, lastDeps![i]))) return;
    lastDeps = deps;
    effects.push(fn);
  },
}));
vi.mock("react-router", () => ({ useFetcher: () => ({ submit }) }));

import { useClaimRenderedNotice } from "../../app/lib/use-claim-rendered-notice";

/** Commit: run the effects React would run after this render. */
const commit = () => effects.splice(0).forEach((fn) => fn());

beforeEach(() => {
  submit.mockReset();
  ref = null;
  lastDeps = null;
  effects.length = 0;
});

describe("useClaimRenderedNotice", () => {
  it("posts nothing while rendering, only from the effect after commit", () => {
    useClaimRenderedNotice({ email: "a@x.com" }, { intent: "guard-email-notice-shown" });
    expect(submit).not.toHaveBeenCalled();
    commit();
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { intent: "guard-email-notice-shown" },
      { method: "POST" },
    );
  });

  it("posts once per page view, however often the page re-renders", () => {
    const form = { intent: "guard-email-notice-shown", email: "a@x.com" };
    // Three renders of the same page view (a plain function stands in for
    // the component, so the hook rules do not apply to this harness).
    const useRender = (f: Record<string, string>) =>
      useClaimRenderedNotice({ email: "a@x.com" }, f);
    [1, 2, 3].forEach(() => {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- test harness, not a component
      useRender({ ...form });
      commit();
    });
    // A changed form after the post does not post again either.
    useClaimRenderedNotice({ email: "b@x.com" }, { ...form, email: "b@x.com" });
    commit();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual(form);
  });

  it("posts nothing while there is no notice, then once when one appears", () => {
    useClaimRenderedNotice(null, { intent: "summary-notice-shown" });
    commit();
    useClaimRenderedNotice(undefined, { intent: "summary-notice-shown" });
    commit();
    expect(submit).not.toHaveBeenCalled();
    useClaimRenderedNotice({ cadence: "weekly" }, { intent: "summary-notice-shown" });
    commit();
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { intent: "summary-notice-shown" },
      { method: "POST" },
    );
  });
});
