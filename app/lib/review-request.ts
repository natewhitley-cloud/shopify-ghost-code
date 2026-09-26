/**
 * Native App Store review popup (gc-97k.7). Client-safe: the shop-level
 * eligibility rule, the allow-listed result codes and what each one means for
 * the next request, and the navigation-mount client call.
 *
 * App Bridge Reviews API (confirmed 2026-09-26 against
 * https://shopify.dev/docs/api/app-home/v1.1/apis/user-interface-and-interactions/reviews-api
 * and the ReviewRequest* types in @shopify/app-bridge-types):
 *
 *   shopify.reviews.request(): Promise<ReviewRequestResponse>
 *     success:  { success: true,  code: "success", message }
 *     declined: { success: false, code: ReviewRequestDeclinedCode, message }
 *   ReviewRequestDeclinedCode = "mobile-app" | "already-reviewed"
 *     | "annual-limit-reached" | "cooldown-period" | "merchant-ineligible"
 *     | "recently-installed" | "already-open" | "open-in-progress" | "cancelled"
 *
 * Shopify owns the modal (no custom copy) and its limits: at most once per 60
 * days and three times per 365 days, never for a merchant who already
 * reviewed, never on mobile, never in the first 24h after install. The docs
 * advise requesting after a successful workflow, not on first open and not
 * from a merchant click. We cannot (and do not try to) learn whether the
 * merchant actually left a review.
 *
 * Lifecycle (server side: app/services/prompt-cap.server.ts and
 * app/services/review-request.server.ts):
 *   1. A results page load that picks the popup records an ATTEMPT on the
 *      server (reviewPopupAttemptCount + 1, reviewPopupLastAttemptAt = now)
 *      before the client ever asks. The popup does NOT claim the shop's 24h
 *      prompt slot here.
 *   2. The client asks App Bridge once, on navigation mount, and reports the
 *      code. The result policy below decides what happens next:
 *        terminal:  reviewPopupRequestedAt is stamped; never requested again.
 *                   Only "success" (the modal was displayed) claims the slot.
 *        retryable: reviewPopupRetryAfter = now + the code's delay.
 *   3. If the report is lost (keepalive POST dropped, tab closed), the attempt
 *      stands: the popup is not eligible again until 24h after it, and never
 *      after REVIEW_POPUP_MAX_ATTEMPTS attempts, so a lost report cannot hog
 *      the top prompt priority forever.
 */
import { useEffect, useRef, useState } from "react";

/** A later results visit: at least this long after the first results view. */
export const REVIEW_POPUP_MIN_DELAY_MS = 2 * 60 * 60 * 1000;

/** An attempt blocks the next one for this long (a lost report's retry delay). */
export const REVIEW_POPUP_ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** No request is made after this many attempts, whatever their outcome. */
export const REVIEW_POPUP_MAX_ATTEMPTS = 5;

export type ReviewPopupEligibilityInput = {
  /** Shop.firstResultsViewedAt as read BEFORE this load stamps it. */
  firstResultsViewedAt: Date | null;
  /** Set by a TERMINAL result: the popup is done for good. */
  reviewPopupRequestedAt: Date | null;
  /** Set by a RETRYABLE result: no request before this time. */
  reviewPopupRetryAfter: Date | null;
  /** Server-side attempts so far (incremented before the client asks). */
  reviewPopupAttemptCount: number;
  /** When the last attempt was recorded. */
  reviewPopupLastAttemptAt: Date | null;
};

/**
 * True when the SHOP is eligible for the review popup (before the cross-prompt
 * cap). ALL must hold:
 *   - no terminal result yet (reviewPopupRequestedAt null);
 *   - a LATER visit: the first results view was at least 2h ago (exactly 2h
 *     qualifies). The very first results view never qualifies, which keeps the
 *     popup out of onboarding;
 *   - fewer than REVIEW_POPUP_MAX_ATTEMPTS attempts;
 *   - the last attempt, if any, was MORE than 24h ago (exactly 24h does not
 *     qualify), so an attempt in flight or with a lost report is not pending;
 *   - not in a retry backoff: no retryAfter, or now >= retryAfter (exactly
 *     retryAfter qualifies).
 * Which pages can render it (a successful scan's results) is decided by
 * scanResultsPrompts in ./prompt-cap, not here.
 */
export function isReviewPopupEligible(input: ReviewPopupEligibilityInput, now: Date): boolean {
  if (input.reviewPopupRequestedAt !== null) return false;
  if (input.firstResultsViewedAt === null) return false;
  if (now.getTime() - input.firstResultsViewedAt.getTime() < REVIEW_POPUP_MIN_DELAY_MS) {
    return false;
  }
  if (input.reviewPopupAttemptCount >= REVIEW_POPUP_MAX_ATTEMPTS) return false;
  const lastAttempt = input.reviewPopupLastAttemptAt;
  if (
    lastAttempt !== null &&
    now.getTime() - lastAttempt.getTime() <= REVIEW_POPUP_ATTEMPT_COOLDOWN_MS
  ) {
    return false;
  }
  const retryAfter = input.reviewPopupRetryAfter;
  return retryAfter === null || now.getTime() >= retryAfter.getTime();
}

/**
 * Every result code the app records. Shopify's documented codes, plus three
 * of our own:
 *   unavailable: App Bridge or shopify.reviews is missing on the page.
 *   error:       request() threw or rejected.
 *   unknown:     Shopify returned a code this build does not know.
 */
export const REVIEW_REQUEST_CODES = [
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
] as const;

export type ReviewRequestCode = (typeof REVIEW_REQUEST_CODES)[number];

export function isReviewRequestCode(value: unknown): value is ReviewRequestCode {
  return typeof value === "string" && (REVIEW_REQUEST_CODES as readonly string[]).includes(value);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What a result code means for the next request. */
export type ReviewResultPolicy =
  | { kind: "terminal" }
  | {
      kind: "retry";
      /** No new request until this long after the result is reported. */
      afterMs: number;
    };

/**
 * The policy for EVERY code (a Record, so adding a code without a policy fails
 * the build):
 *   terminal: the merchant saw the modal (success, cancelled) or Shopify will
 *     not show it to this merchant (already-reviewed, merchant-ineligible,
 *     annual-limit-reached).
 *   retry: a transient or timing reason.
 * "unknown" (a code this build does not know) is treated like "error": retry
 * in 24h, bounded by REVIEW_POPUP_MAX_ATTEMPTS.
 */
export const REVIEW_RESULT_POLICY: Record<ReviewRequestCode, ReviewResultPolicy> = {
  success: { kind: "terminal" },
  "already-reviewed": { kind: "terminal" },
  "merchant-ineligible": { kind: "terminal" },
  "annual-limit-reached": { kind: "terminal" },
  cancelled: { kind: "terminal" },
  "recently-installed": { kind: "retry", afterMs: DAY_MS },
  "mobile-app": { kind: "retry", afterMs: DAY_MS },
  "cooldown-period": { kind: "retry", afterMs: 60 * DAY_MS },
  "already-open": { kind: "retry", afterMs: HOUR_MS },
  "open-in-progress": { kind: "retry", afterMs: HOUR_MS },
  error: { kind: "retry", afterMs: DAY_MS },
  unavailable: { kind: "retry", afterMs: DAY_MS },
  unknown: { kind: "retry", afterMs: DAY_MS },
};

/** The slice of the App Bridge global this module touches. */
type ReviewsGlobal = {
  shopify?: { reviews?: { request?: () => Promise<{ success: boolean; code: string }> } };
};

/**
 * Ask Shopify to show its review modal and reduce the outcome to one code.
 * NEVER THROWS: a missing App Bridge / Reviews API is "unavailable", a throw
 * or rejection is "error".
 */
export async function requestAppReview(): Promise<ReviewRequestCode> {
  const request = (globalThis as ReviewsGlobal).shopify?.reviews?.request;
  if (typeof request !== "function") return "unavailable";
  try {
    const result = await request();
    if (result?.success === true) return "success";
    return isReviewRequestCode(result?.code) && result.code !== "success" ? result.code : "unknown";
  } catch {
    return "error";
  }
}

/**
 * Report the outcome to the review-request action. Best-effort keepalive POST
 * (the page may navigate away); App Bridge's patched global `fetch` adds the
 * session token. Any error, sync or async, is swallowed. A lost report is
 * safe: the server already recorded the attempt (see the lifecycle above).
 */
export function sendReviewRequestResult(code: ReviewRequestCode): void {
  try {
    fetch("/app/review-request", {
      method: "POST",
      keepalive: true,
      body: new URLSearchParams({ code }),
    }).catch(() => {});
  } catch {
    // Telemetry must never break the page.
  }
}

/**
 * The body of the results page's effect: request the popup and report the
 * result, at most once per `guard`. The guard flips synchronously, before any
 * await, so React StrictMode's double-invoked effect and any re-render cannot
 * request twice. Every outcome, including "unavailable" and "error", is
 * reported so the server can apply its result policy.
 */
export async function runReviewRequestOnce(
  guard: { current: boolean },
  requestReview: boolean,
): Promise<void> {
  if (!requestReview || guard.current) return;
  guard.current = true;
  sendReviewRequestResult(await requestAppReview());
}

/**
 * The results page's hook: request the popup only for the loader value seen
 * when the page MOUNTED (a navigation), never mid-session. The value is
 * captured once (useState initializer), so a later revalidation (the ~3s
 * in-progress poll, an ignore action, a dismiss) that flips `requestReview`
 * to true does not pop Shopify's modal while the merchant is working. The ref
 * guard keeps StrictMode's double-invoked effect to one request.
 */
export function useReviewRequestOnMount(requestReview: boolean): void {
  const [requestReviewAtMount] = useState(() => requestReview);
  const guard = useRef(false);
  useEffect(() => {
    void runReviewRequestOnce(guard, requestReviewAtMount);
  }, [requestReviewAtMount]);
}
