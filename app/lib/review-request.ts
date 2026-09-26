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
 *   app/services/review-request.server.ts):
 *   1. A results page load that picks the popup writes NOTHING; it hands the
 *      client an attempt nonce. The popup does NOT claim the 24h prompt slot.
 *   2. On a scan page's mount only, the client asks the server to record the
 *      ATTEMPT (reviewPopupAttemptCount + 1, reviewPopupLastAttemptAt = now,
 *      compare-and-set on the nonce), and only if that succeeds calls App
 *      Bridge once and reports the code. The result policy below decides what
 *      happens next:
 *        terminal:  reviewPopupRequestedAt is stamped; never requested again.
 *                   Only "success" (the modal was displayed) claims the slot.
 *        retryable: reviewPopupRetryAfter = now + the code's delay.
 *   3. If the RESULT report is lost (keepalive POST dropped, tab closed), the
 *      attempt stands: the popup is not eligible again until 24h after it, and
 *      never after REVIEW_POPUP_MAX_ATTEMPTS attempts. If the client never
 *      even records an attempt, nothing is burned, and the 7-day bounded
 *      blocking (PROMPT_BLOCK_MAX_MS in ./prompt-cap) stops the pending popup
 *      from blocking lower prompts forever.
 */
import { useEffect, useRef } from "react";

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
 * When the popup last BECAME eligible (bounded blocking, ./prompt-cap): the
 * latest of the first results view + 2h, the end of a retry backoff, and the
 * end of the last attempt's 24h cooldown. Only meaningful while
 * isReviewPopupEligible is true.
 */
export function reviewPopupEligibleSince(input: ReviewPopupEligibilityInput): Date {
  const times = [
    (input.firstResultsViewedAt?.getTime() ?? 0) + REVIEW_POPUP_MIN_DELAY_MS,
    input.reviewPopupRetryAfter?.getTime() ?? -Infinity,
    input.reviewPopupLastAttemptAt === null
      ? -Infinity
      : input.reviewPopupLastAttemptAt.getTime() + REVIEW_POPUP_ATTEMPT_COOLDOWN_MS,
  ];
  return new Date(Math.max(...times));
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

/** The nonce value that stands for "no attempt recorded yet". */
export const REVIEW_ATTEMPT_NONCE_NONE = "none";

/**
 * The attempt nonce the loader issues with a review request: the
 * reviewPopupLastAttemptAt it read (ISO, millisecond precision like the
 * TIMESTAMP(3) column), or REVIEW_ATTEMPT_NONCE_NONE. The attempt action
 * records an attempt only while the stored value still equals it
 * (compare-and-set), so of several tabs or loads issued the same nonce
 * exactly one gets to call the Reviews API.
 */
export function reviewAttemptNonce(lastAttemptAt: Date | null): string {
  return lastAttemptAt === null ? REVIEW_ATTEMPT_NONCE_NONE : lastAttemptAt.toISOString();
}

/**
 * Parse an untrusted nonce back to the last-attempt time it stands for:
 * null for REVIEW_ATTEMPT_NONCE_NONE, a Date for a canonical ISO timestamp,
 * undefined for anything else (the action answers 400).
 */
export function parseReviewAttemptNonce(value: unknown): Date | null | undefined {
  if (value === REVIEW_ATTEMPT_NONCE_NONE) return null;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : date;
}

/**
 * Ask the server to record the attempt for `nonce` before calling the Reviews
 * API. True only on 204 (this call recorded it). Any other status or a network
 * error is false: the client then does NOT call the API, so nothing is
 * requested that the server has not counted. NEVER THROWS.
 */
export async function claimReviewAttempt(nonce: string): Promise<boolean> {
  try {
    const res = await fetch("/app/review-request", {
      method: "POST",
      body: new URLSearchParams({ intent: "attempt", nonce }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * The body of the results page's effect: at most once per `guard`, record the
 * attempt on the server (keyed by the loader's `nonce`), and only if that won,
 * request the popup and report the result. The guard flips synchronously,
 * before any await, so React StrictMode's double-invoked effect cannot run it
 * twice. A null nonce means the loader did not pick the popup.
 */
export async function runReviewRequestOnce(
  guard: { current: boolean },
  nonce: string | null,
): Promise<void> {
  if (nonce === null || guard.current) return;
  guard.current = true;
  if (!(await claimReviewAttempt(nonce))) return;
  sendReviewRequestResult(await requestAppReview());
}

/**
 * The results page's hook. Fires only for the nonce captured when a SCAN's
 * page mounted (a navigation), never mid-session:
 *   - the capture is keyed by `scanId`, so moving to another scan (React
 *     Router reuses the component) captures that scan's value afresh;
 *   - a revalidation on the same scan (the ~3s poll, an ignore, a dismiss)
 *     keeps the first capture, so a nonce that appears later never pops
 *     Shopify's modal while the merchant is working. Such a load recorded
 *     nothing (the attempt is recorded only by runReviewRequestOnce), so no
 *     attempt is wasted.
 * The per-capture guard keeps StrictMode's double-invoked effect to one run.
 */
export function useReviewRequestOnMount(nonce: string | null, scanId: string): void {
  const capture = useRef<{
    scanId: string;
    nonce: string | null;
    fired: { current: boolean };
  } | null>(null);
  if (capture.current === null || capture.current.scanId !== scanId) {
    capture.current = { scanId, nonce, fired: { current: false } };
  }
  const current = capture.current;
  useEffect(() => {
    void runReviewRequestOnce(current.fired, current.nonce);
  }, [current]);
}
