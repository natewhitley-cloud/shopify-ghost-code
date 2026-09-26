/**
 * Tests for app/lib/review-request.ts (gc-97k.7): the review popup's
 * eligibility rule, result-code allow-list, and the one-shot client call.
 *
 * `shopify.reviews.request` is mocked on globalThis (no App Bridge in node).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  isReviewPopupEligible,
  isReviewRequestCode,
  REVIEW_POPUP_MIN_DELAY_MS,
  REVIEW_REQUEST_CODES,
  requestAppReview,
  runReviewRequestOnce,
  sendReviewRequestResult,
} from "../../app/lib/review-request";

const NOW = new Date("2026-09-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("isReviewPopupEligible", () => {
  const base = {
    firstResultsViewedAt: ago(REVIEW_POPUP_MIN_DELAY_MS),
    reviewPopupRequestedAt: null,
  };

  it("is 2 hours", () => {
    expect(REVIEW_POPUP_MIN_DELAY_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("is eligible exactly 2h after the first results view", () => {
    expect(isReviewPopupEligible(base, NOW)).toBe(true);
  });

  it("is eligible well after the first results view", () => {
    expect(isReviewPopupEligible({ ...base, firstResultsViewedAt: ago(30 * 86400000) }, NOW)).toBe(
      true,
    );
  });

  it("is not eligible 1ms short of 2h", () => {
    expect(
      isReviewPopupEligible(
        { ...base, firstResultsViewedAt: ago(REVIEW_POPUP_MIN_DELAY_MS - 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it("is not eligible on the first results view (never stamped yet)", () => {
    expect(isReviewPopupEligible({ ...base, firstResultsViewedAt: null }, NOW)).toBe(false);
  });

  // A successful scan is no longer part of the SHOP-level rule (owner decision
  // 1A): only a successful scan's page can RENDER the popup, which is pinned in
  // tests/lib/prompt-cap.test.ts (scanResultsPrompts).

  it("is not eligible once requested, however long ago", () => {
    expect(
      isReviewPopupEligible({ ...base, reviewPopupRequestedAt: ago(400 * 86400000) }, NOW),
    ).toBe(false);
  });

  it("treats a first view in the future (clock skew) as not yet 2h", () => {
    expect(isReviewPopupEligible({ ...base, firstResultsViewedAt: ago(-60_000) }, NOW)).toBe(false);
  });
});

describe("isReviewRequestCode", () => {
  it("accepts every documented Shopify code and our own three", () => {
    for (const code of REVIEW_REQUEST_CODES) expect(isReviewRequestCode(code)).toBe(true);
    expect(REVIEW_REQUEST_CODES).toEqual(
      expect.arrayContaining([
        "success",
        "mobile-app",
        "already-reviewed",
        "annual-limit-reached",
        "cooldown-period",
        "merchant-ineligible",
        "recently-installed",
        "already-open",
        "open-in-progress",
        "cancelled",
        "unavailable",
        "error",
        "unknown",
      ]),
    );
  });

  it.each([null, undefined, "", "SUCCESS", "cooldown", "<script>", 42, {}])(
    "rejects %s",
    (value) => {
      expect(isReviewRequestCode(value)).toBe(false);
    },
  );
});

type GlobalWithShopify = { shopify?: unknown };
const g = globalThis as GlobalWithShopify;

function installReviews(request: () => Promise<unknown>) {
  g.shopify = { reviews: { request: vi.fn(request) } };
  return (g.shopify as { reviews: { request: ReturnType<typeof vi.fn> } }).reviews.request;
}

afterEach(() => {
  delete g.shopify;
  vi.unstubAllGlobals();
});

describe("requestAppReview", () => {
  it("returns success when Shopify displayed the modal", async () => {
    installReviews(async () => ({
      success: true,
      code: "success",
      message: "Review modal shown successfully",
    }));
    await expect(requestAppReview()).resolves.toBe("success");
  });

  it.each([
    "mobile-app",
    "already-reviewed",
    "annual-limit-reached",
    "cooldown-period",
    "merchant-ineligible",
    "recently-installed",
    "already-open",
    "open-in-progress",
    "cancelled",
  ])("passes through the declined code %s", async (code) => {
    installReviews(async () => ({ success: false, code, message: "declined" }));
    await expect(requestAppReview()).resolves.toBe(code);
  });

  it("maps a declined code this build does not know to unknown", async () => {
    installReviews(async () => ({ success: false, code: "new-shopify-reason", message: "x" }));
    await expect(requestAppReview()).resolves.toBe("unknown");
  });

  it("never reports success from a declined response claiming code success", async () => {
    installReviews(async () => ({ success: false, code: "success", message: "x" }));
    await expect(requestAppReview()).resolves.toBe("unknown");
  });

  it("maps a malformed response to unknown", async () => {
    installReviews(async () => undefined);
    await expect(requestAppReview()).resolves.toBe("unknown");
  });

  it("is unavailable without App Bridge", async () => {
    await expect(requestAppReview()).resolves.toBe("unavailable");
  });

  it("is unavailable when App Bridge has no Reviews API", async () => {
    g.shopify = { toast: { show: vi.fn() } };
    await expect(requestAppReview()).resolves.toBe("unavailable");
  });

  it("is error when request() rejects", async () => {
    installReviews(async () => {
      throw new Error("boom");
    });
    await expect(requestAppReview()).resolves.toBe("error");
  });

  it("is error when request() throws synchronously", async () => {
    g.shopify = {
      reviews: {
        request: () => {
          throw new Error("sync boom");
        },
      },
    };
    await expect(requestAppReview()).resolves.toBe("error");
  });
});

describe("sendReviewRequestResult", () => {
  it("POSTs the code to /app/review-request with keepalive", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    sendReviewRequestResult("cooldown-period");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/app/review-request");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect((init.body as URLSearchParams).get("code")).toBe("cooldown-period");
  });

  it("swallows a rejected fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(() => sendReviewRequestResult("success")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("swallows a synchronous fetch throw", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("sync");
      }),
    );
    expect(() => sendReviewRequestResult("success")).not.toThrow();
  });
});

describe("runReviewRequestOnce (the results page effect)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("requests once and reports the result once", async () => {
    const request = installReviews(async () => ({ success: true, code: "success" }));
    const guard = { current: false };

    await runReviewRequestOnce(guard, true);

    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get("code")).toBe("success");
  });

  it("fires once under StrictMode's double-invoked effect and later re-renders", async () => {
    const request = installReviews(async () => ({ success: false, code: "cooldown-period" }));
    const guard = { current: false };

    // StrictMode: mount effect, cleanup, effect again (same ref), both in flight.
    await Promise.all([runReviewRequestOnce(guard, true), runReviewRequestOnce(guard, true)]);
    // A later re-render or poll revalidation re-running the effect.
    await runReviewRequestOnce(guard, true);

    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the loader did not ask for a review", async () => {
    const request = installReviews(async () => ({ success: true, code: "success" }));
    const guard = { current: false };

    await runReviewRequestOnce(guard, false);

    expect(request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guard.current).toBe(false);
  });

  it("reports unavailable (so the server stamps it) when App Bridge has no Reviews API", async () => {
    await runReviewRequestOnce({ current: false }, true);

    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get("code")).toBe("unavailable");
  });

  it("never throws when request() rejects; reports error", async () => {
    installReviews(async () => {
      throw new Error("boom");
    });

    await expect(runReviewRequestOnce({ current: false }, true)).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get("code")).toBe("error");
  });
});
