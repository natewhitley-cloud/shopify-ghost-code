/**
 * useClaimRenderedNotice (gc-1q1s.11): Home's consent notices are stamped by
 * a post from an effect after render, once per page view, retried once when
 * the post settles without an answer or with the server's `retry` (wave 3
 * U6), never when the server says the notice is not owed (wave 4). React's
 * hooks are stubbed (no DOM environment in this suite): useEffect runs its
 * callback the way React does after a commit (only when a dependency
 * changed), useRef and useState keep one box per "component", and each
 * submit returns a promise the test settles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Each post's promise, settled by the test. */
let pending: Array<() => void> = [];
/** How many of the next submits throw synchronously (reset per test). */
let syncThrows = 0;
const submit = vi.fn<(form: Record<string, string>, opts: { method: string }) => Promise<void>>(
  () => {
    if (syncThrows > 0) {
      syncThrows -= 1;
      throw new Error("submit threw");
    }
    return new Promise<void>((resolve) => {
      pending.push(resolve);
    });
  },
);
const fetcher: { state: string; data: unknown; submit: typeof submit } = {
  state: "idle",
  data: undefined,
  submit,
};
let ref: { current: unknown } | null = null;
let stateBox: { value: unknown } | null = null;
let lastDeps: unknown[] | null = null;
const effects: Array<() => void> = [];

vi.mock("react", () => ({
  useRef: (init: unknown) => (ref ??= { current: init }),
  useState: (init: unknown) => {
    stateBox ??= { value: init };
    const box = stateBox;
    return [
      box.value,
      (next: unknown) => {
        box.value =
          typeof next === "function" ? (next as (v: unknown) => unknown)(box.value) : next;
      },
    ];
  },
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
/**
 * The oldest post settles with `data` (undefined: no response) WITHOUT any
 * render seeing the fetcher busy, then the page re-renders (the settle's
 * state update).
 */
const settle = async (data: unknown) => {
  if (data !== undefined) fetcher.data = data;
  pending.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  render();
};

beforeEach(() => {
  submit.mockClear();
  pending = [];
  syncThrows = 0;
  fetcher.state = "idle";
  fetcher.data = undefined;
  ref = null;
  stateBox = null;
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

  it("a successful claim is never posted again", async () => {
    render();
    await settle({ noticeClaimed: true });
    render();
    render();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a failed post (no response) is retried once, and only once (wave 3 U6)", async () => {
    expect(MAX_CLAIM_POSTS).toBe(2);
    render();
    await settle(undefined);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual([FORM, { method: "POST" }]);
    await settle(undefined);
    render();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a post the server's write failed is retried once; the retry's success ends it", async () => {
    render();
    await settle({ noticeClaimed: false, retry: true });
    expect(submit).toHaveBeenCalledTimes(2);
    await settle({ noticeClaimed: true });
    render();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a retry whose answer is the same failure as before still counts as answered", async () => {
    render();
    await settle({ noticeClaimed: false, retry: true });
    // A new response object with the same values: the second post's answer.
    await settle({ noticeClaimed: false, retry: true });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("claimed elsewhere (the server says not owed) is final: no retry (wave 4)", async () => {
    render();
    // Even when a render did see the post in flight.
    fetcher.state = "submitting";
    render();
    fetcher.state = "idle";
    await settle({ noticeClaimed: false });
    render();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a post that settles between renders, never seen busy, is still retried (wave 4)", async () => {
    render();
    // The fetcher never reports a busy state to any render.
    expect(fetcher.state).toBe("idle");
    await settle(undefined);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("stale data from before the post is not read as its answer", async () => {
    fetcher.data = { noticeClaimed: false };
    render();
    await settle(undefined); // no new response: the old data is not an answer
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a submit that throws synchronously is a failed post: retried once, never thrown", async () => {
    syncThrows = 1;
    expect(() => render()).not.toThrow();
    expect(submit).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    render(); // the settle's re-render
    expect(submit).toHaveBeenCalledTimes(2);
    await settle({ noticeClaimed: true });
    render();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a retry that also throws synchronously is the last post", async () => {
    syncThrows = 2;
    render();
    await new Promise((r) => setTimeout(r, 0));
    expect(() => render()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    render();
    expect(submit).toHaveBeenCalledTimes(MAX_CLAIM_POSTS);
  });

  it("an idle fetcher before the post settles is not read as a failure", () => {
    render();
    render();
    render();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
