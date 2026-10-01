/**
 * Resource route: POST /app/client-error (gc-nn6)
 *
 * Sink for the embedded app's browser-side error beacons
 * (app/lib/client-error-reporter.ts). The reporter sends a keepalive `fetch`
 * through App Bridge's patched global `fetch`, which adds the session token,
 * so authenticate.admin works as for the other in-app pings (app.upgrade,
 * app.review-request).
 *
 * Never trusts the client: the body is size-capped, then every field is
 * re-validated and re-sanitized with the same sanitizer the client used
 * (sanitizeClientErrorReport: known fields only, message <= 300 chars, top 5
 * frames, query strings / hashes / tokens / emails stripped). The shop is
 * always the SESSION shop, and the browser family comes from this request's
 * own User-Agent header. The write is rate-limited per shop inside
 * recordClientError.
 *
 * 204 when accepted (also when the per-shop limit drops it: the client has
 * nothing to do differently), 400 for an invalid report, 413 for an oversized
 * body. No loader and no redirect.
 */
import type { ActionFunctionArgs } from "react-router";

import { browserFamily, sanitizeClientErrorReport } from "../lib/client-error";
import { recordClientError } from "../models/ops-event.server";
import { authenticate } from "../shopify.server";

/** Well above a maximal legitimate report (~2.5 KB encoded). */
export const CLIENT_ERROR_MAX_BODY_BYTES = 8 * 1024;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Refuse a declared-oversized body before reading it; re-check after reading
  // since Content-Length can be absent (chunked) or wrong.
  if (Number(request.headers.get("content-length")) > CLIENT_ERROR_MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const text = await request.text();
  if (text.length > CLIENT_ERROR_MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const report = sanitizeClientErrorReport(Object.fromEntries(new URLSearchParams(text)));
  if (!report) {
    return new Response(null, { status: 400 });
  }

  await recordClientError(session.shop, {
    ...report,
    browser: browserFamily(request.headers.get("user-agent")),
  });
  return new Response(null, { status: 204 });
};
