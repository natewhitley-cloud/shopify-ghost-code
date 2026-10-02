/**
 * Resource route: POST /app/client-error (gc-nn6)
 *
 * Sink for the embedded app's browser-side error beacons
 * (app/lib/client-error-reporter.ts). The reporter sends a keepalive `fetch`
 * through App Bridge's patched global `fetch`, which adds the session token,
 * so authenticate.admin works as for the other in-app pings (app.upgrade,
 * app.review-request).
 *
 * Never trusts the client: the body is size-capped (a declared Content-Length
 * is checked first, then the body is read as a stream that is cancelled the
 * moment it exceeds the cap, so a chunked body is never fully buffered), then
 * every field is re-validated and re-sanitized with the same sanitizer the client used
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

/**
 * Read the request body as text, counting BYTES and cancelling the stream as
 * soon as it exceeds `maxBytes`. Returns null when over the cap; "" for a
 * missing body.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Refuse a declared-oversized body before reading it; the bounded read below
  // covers a Content-Length that is absent (chunked) or wrong.
  if (Number(request.headers.get("content-length")) > CLIENT_ERROR_MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const text = await readBoundedText(request, CLIENT_ERROR_MAX_BODY_BYTES);
  if (text === null) {
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
