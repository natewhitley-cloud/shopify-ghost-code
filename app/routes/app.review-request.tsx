/**
 * Resource route: POST /app/review-request (gc-97k.7)
 *
 * The scan results page calls App Bridge's shopify.reviews.request() once and
 * reports the outcome here with a keepalive `fetch` (`code=<result code>`);
 * App Bridge's patched global `fetch` adds the session token, so
 * authenticate.admin works as for any other in-app fetch.
 *
 * Stamps the SESSION shop's once-ever request and records its telemetry
 * (recordReviewRequestResult). The code is untrusted input: anything outside
 * the allow-list is a 400 with no write. Otherwise 204. No loader, no redirect.
 */
import type { ActionFunctionArgs } from "react-router";

import { isReviewRequestCode } from "../lib/review-request";
import { recordReviewRequestResult } from "../services/review-request.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const code = formData.get("code");
  if (!isReviewRequestCode(code)) {
    return new Response(null, { status: 400 });
  }

  await recordReviewRequestResult(session.shop, code);
  return new Response(null, { status: 204 });
};
