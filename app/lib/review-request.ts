/**
 * Native App Store review popup (gc-97k.7). Client-safe: the eligibility rule
 * the loader applies, the allow-listed result codes the action accepts, and
 * the one-shot client call.
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
 */

/** A later results visit: at least this long after the first results view. */
export const REVIEW_POPUP_MIN_DELAY_MS = 2 * 60 * 60 * 1000;

export type ReviewPopupEligibilityInput = {
  /** Shop.firstResultsViewedAt as read BEFORE this load stamps it. */
  firstResultsViewedAt: Date | null;
  reviewPopupRequestedAt: Date | null;
};

/**
 * True when the SHOP is eligible for the review popup (before the cross-prompt
 * cap): never requested before, and a LATER visit, meaning the first results
 * view happened at least 2h ago (exactly 2h qualifies). The very first results
 * view never qualifies, which keeps the popup out of onboarding. Which pages
 * can render it (a successful scan's results) is decided by scanResultsPrompts
 * in ./prompt-cap, not here.
 */
export function isReviewPopupEligible(input: ReviewPopupEligibilityInput, now: Date): boolean {
  if (input.reviewPopupRequestedAt !== null) return false;
  if (input.firstResultsViewedAt === null) return false;
  return now.getTime() - input.firstResultsViewedAt.getTime() >= REVIEW_POPUP_MIN_DELAY_MS;
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
 * session token. Any error, sync or async, is swallowed.
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
 * await, so React StrictMode's double-invoked effect and any re-render or
 * revalidation (e.g. the in-progress poll) cannot request twice. Every outcome,
 * including "unavailable" and "error", is reported so the server stamps the
 * once-ever request: otherwise a page without the Reviews API would claim the
 * top-priority prompt slot on every later visit and starve the other prompts.
 */
export async function runReviewRequestOnce(
  guard: { current: boolean },
  requestReview: boolean,
): Promise<void> {
  if (!requestReview || guard.current) return;
  guard.current = true;
  sendReviewRequestResult(await requestAppReview());
}
