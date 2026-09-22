import { PassThrough } from "stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";

import { recordApiError } from "./models/ops-event.server";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

/** Best-effort request path for error context; never throws. */
function requestPath(request: Request): string | undefined {
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Durably record a genuine server-side exception (loader/action/render) as an
 * `api_error` OpsEvent so the operator digest counts it. Since the Sentry
 * removal these errors otherwise only console.error and are invisible to the
 * digest's failure counts.
 *
 * Reuses the existing `api_error` type (a new id-keyed type would open
 * redact/prune coverage gaps). Best-effort and fire-and-forget: React Router
 * does not await these hooks, so the write is never awaited and its rejection is
 * swallowed — a logging failure must never mask or replace the original error
 * surfaced to the user.
 *
 * Thrown `Response`s (React Router redirects / 4xx route-error-responses) and any
 * other non-Error throw are control flow, not failures. The `instanceof Error`
 * guard skips them so the digest counts only real exceptions.
 */
function recordServerError(error: unknown, path?: string): void {
  // Relies on the codebase convention of `throw new Response(...)` (not
  // `throw new Error(...)`) for expected 4xx control flow: a future route that
  // threw a bare Error for control flow would be recorded here as noise.
  if (!(error instanceof Error)) return;
  try {
    void recordApiError({
      level: "error",
      code: "server_error",
      message: error.message || "Server error",
      ...(path ? { metadata: { path } } : {}),
    }).catch(() => {});
  } catch {
    // Never let observability recording become a new failure mode.
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    // Tracks whether the shell has flushed, so onError records each error
    // source EXACTLY ONCE across onError + handleError:
    //   - loader/action errors: converted to context.errors before the stream,
    //     so onError never fires — handleError records them (once).
    //   - shell-render errors (throw before flush): onError fires AND
    //     onShellError -> reject -> handleError fires. shellFlushed is still
    //     false here, so onError does NOT record; handleError records (once).
    //   - post-shell streaming errors (throw after flush): the shell already
    //     resolved, so handleError is never called — onError records (once).
    let shellFlushed = false;
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          shellFlushed = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          // Log every error unconditionally; recording is separate.
          console.error(error);
          // Only record post-shell streaming errors here. A shell-render error
          // also fires onError, but onShellError -> reject -> handleError will
          // record it — recording here too would double-count (inflating the
          // digest's api_error metric this exists to make accurate).
          if (shellFlushed) {
            recordServerError(error, requestPath(request));
          }
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

/**
 * React Router v7 calls this for errors thrown in loaders, actions, and
 * server rendering. Errors surface to console/structured logs and, for genuine
 * exceptions, a durable `api_error` OpsEvent (see recordServerError) so the
 * operator digest counts them; there is no external error-capture service.
 *
 * Aborted requests (client cancelled / navigated away) are skipped — they are
 * not real failures and would otherwise spam the logs.
 */
export function handleError(error: unknown, { request }: { request: Request }): void {
  if (request.signal.aborted) return;
  console.error(error);
  recordServerError(error, requestPath(request));
}
