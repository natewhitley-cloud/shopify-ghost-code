/**
 * Resource route: POST /app/review-request (gc-97k.7)
 *
 * Two intents, both for the SESSION shop only:
 *   - `intent=attempt&nonce=<loader nonce>`: record the attempt the client is
 *     about to make and claim the 24h prompt slot for it
 *     (claimReviewRequestAttempt, every eligibility rule re-checked). 204 when
 *     recorded (the client may call the Reviews API), 409 when not (another
 *     tab or prompt won, a cooldown or backoff, or done). A malformed nonce is
 *     a 400 with no write.
 *   - otherwise (`code=<result code>`, as below): the result report.
 *
 * The scan results page calls App Bridge's shopify.reviews.request() once and
 * reports the outcome here with a keepalive `fetch` (`code=<result code>`);
 * App Bridge's patched global `fetch` adds the session token, so
 * authenticate.admin works as for any other in-app fetch.
 *
 * Applies the code's result policy to the SESSION shop (terminal: done for
 * good; retryable: back off; any non-success hands the slot back) and records
 * its telemetry
 * (recordReviewRequestResult). The code is untrusted input: anything outside
 * the allow-list is a 400 with no write. Otherwise 204. No loader, no redirect.
 */
import type { ActionFunctionArgs } from "react-router";

import { isReviewRequestCode, parseReviewAttemptNonce } from "../lib/review-request";
import {
  claimReviewRequestAttempt,
  recordReviewRequestResult,
} from "../services/review-request.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();

  if (formData.get("intent") === "attempt") {
    const previous = parseReviewAttemptNonce(formData.get("nonce"));
    if (previous === undefined) return new Response(null, { status: 400 });
    const recorded = await claimReviewRequestAttempt(session.shop, previous, new Date());
    return new Response(null, { status: recorded ? 204 : 409 });
  }

  const code = formData.get("code");
  if (!isReviewRequestCode(code)) {
    return new Response(null, { status: 400 });
  }

  await recordReviewRequestResult(session.shop, code, new Date());
  return new Response(null, { status: 204 });
};
