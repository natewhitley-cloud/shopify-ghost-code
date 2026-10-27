/**
 * useClaimRenderedNotice (gc-1q1s.11): Home's consent notices are stamped by
 * a post from an effect after render, once per page view, retried once when
 * the post settles without a claim (wave 3 U6). React's hooks are stubbed (no
 * DOM environment in this suite): useEffect runs its callback the way React
 * does after a commit (only when a dependency changed), useRef keeps one box
 * per "component", and the fetcher's state and data are set by the test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const submit = vi.fn();
const fetcher: { state: string; data: unknown; submit: typeof submit } = {
  state: "idle",
  data: undefined,
  submit,
};
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
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));

import { MAX_CLAIM_POSTS, useClaimRenderedNotice } from "../../app/lib/use-claim-rendered-notice";

/** Commit: run the effects React would run after this render. */
const commit = () => effects.splice(0).forEach((fn) => fn());

const FORM = { intent: "guard-email-notice-shown" };
/** One render + commit of the page with the notice on screen. */
const render = (...args: [notice?: unknown, form?: Record<string, string>]) => {
  // An explicit `undefined` notice stays undefined (no default).
  const notice = args.length === 0 ? { email: "a@x.com" } : args[0];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- test harness, not a component
  useClaimRenderedNotice(notice, args[1] ?? FORM);
  commit();
};
/** The post goes out, then settles with `data` (undefined: no response). */
const settle = (data: unknown) => {
  fetcher.state = "submitting";
  render();
  fetcher.state = "idle";
  fetcher.data = data;
  render();
};

beforeEach(() => {
  submit.mockReset();
  fetcher.state = "idle";
  fetcher.data = undefined;
  ref = null;
  lastDeps = null;
  effects.length = 0;
});

describe("useClaimRenderedNotice", () => {
  it("posts nothing while rendering, only from the effect after commit", () => {
    useClaimRenderedNotice({ email: "a@x.com" }, FORM);
    expect(submit).not.toHaveBeenCalled();
    commit();
    expect(submit).toHaveBeenCalledExactlyOnceWith(FORM, { method: "POST" });
  });

  it("posts once per page view, however often the page re-renders", () => {
    const form = { intent: "guard-email-notice-shown", email: "a@x.com" };
    [1, 2, 3].forEach(() => render({ email: "a@x.com" }, { ...form }));
    // A changed form after the post does not post again either.
    render({ email: "b@x.com" }, { ...form, email: "b@x.com" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual(form);
  });

  it("posts nothing while there is no notice, then once when one appears", () => {
    render(null, { intent: "summary-notice-shown" });
    render(undefined, { intent: "summary-notice-shown" });
    expect(submit).not.toHaveBeenCalled();
    render({ cadence: "weekly" }, { intent: "summary-notice-shown" });
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { intent: "summary-notice-shown" },
      { method: "POST" },
    );
  });

  it("a successful claim is never posted again", () => {
    render();
    settle({ noticeClaimed: true });
    render();
    render();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a failed post (no response) is retried once, and only once (wave 3 U6)", () => {
    expect(MAX_CLAIM_POSTS).toBe(2);
    render();
    settle(undefined);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual([FORM, { method: "POST" }]);
    settle(undefined);
    render();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a post the server answered without a claim is retried once; the retry's success ends it", () => {
    render();
    settle({ noticeClaimed: false });
    expect(submit).toHaveBeenCalledTimes(2);
    settle({ noticeClaimed: true });
    render();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("an idle fetcher before the post starts is not read as a failure", () => {
    render();
    render();
    render();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
