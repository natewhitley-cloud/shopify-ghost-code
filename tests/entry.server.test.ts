/**
 * Tests for app/entry.server.tsx — handleError export AND the handleRequest
 * render wiring (onError / onShellError / shell-success callbacks).
 *
 * Strategy:
 *   - Spy on console.error to assert errors surface to the logs.
 *   - Mock ./shopify.server so importing the entry module has no side effects.
 *   - Mock ./models/ops-event.server's recordApiError to count durable records.
 *   - Verify handleError logs normal errors and skips aborted requests.
 *   - Verify EXACTLY-ONCE recording across the three real error sources by
 *     driving the actual options object handleRequest passes to
 *     renderToPipeableStream and invoking its callbacks in the framework's
 *     faithful call sequence (empirically confirmed against react-dom@18.3.1:
 *     a shell-render error fires onError THEN onShellError; a post-shell error
 *     fires the shell-success callback THEN onError).
 */

import { type EntryContext } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../app/shopify.server", () => ({
  addDocumentResponseHeaders: vi.fn(),
}));

const mockRecordApiError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../app/models/ops-event.server", () => ({
  recordApiError: mockRecordApiError,
}));

// Capture the options object handleRequest passes to renderToPipeableStream so
// tests can invoke onError / onShellError / onShellReady directly. The mock does
// not render, so the throwing-component distinction is expressed purely by the
// order in which the test invokes these captured callbacks.
type RenderCallbacks = Record<string, (...args: unknown[]) => void>;
const rdsCapture = vi.hoisted(() => ({ options: null as RenderCallbacks | null }));
vi.mock("react-dom/server", () => ({
  renderToPipeableStream: (_element: unknown, options: RenderCallbacks) => {
    rdsCapture.options = options;
    return { pipe: vi.fn(), abort: vi.fn() };
  },
}));

async function importHandleError() {
  const mod = await import("../app/entry.server");
  return mod.handleError;
}

function makeRequest(aborted: boolean): Request {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return new Request("https://example.com/app/scans", {
    method: "POST",
    signal: controller.signal,
  });
}

describe("handleError", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("logs a normal error to console.error", async () => {
    const handleError = await importHandleError();
    const error = new Error("loader blew up");

    handleError(error, { request: makeRequest(false) });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(error);
  });

  it("does NOT log when the request was aborted", async () => {
    const handleError = await importHandleError();

    handleError(new Error("client cancelled"), { request: makeRequest(true) });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("records a durable api_error OpsEvent for a real Error, with the request path", async () => {
    const handleError = await importHandleError();

    handleError(new Error("loader blew up"), { request: makeRequest(false) });

    expect(mockRecordApiError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        code: "server_error",
        message: "loader blew up",
        metadata: { path: "/app/scans" },
      }),
    );
  });

  it("does NOT record an OpsEvent for a thrown Response (redirect / 4xx control flow)", async () => {
    const handleError = await importHandleError();

    handleError(new Response(null, { status: 302 }), { request: makeRequest(false) });

    // Still logs (existing behavior) but must not count control-flow Responses.
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(mockRecordApiError).not.toHaveBeenCalled();
  });

  it("does NOT record an OpsEvent when the request was aborted", async () => {
    const handleError = await importHandleError();

    handleError(new Error("client cancelled"), { request: makeRequest(true) });

    expect(mockRecordApiError).not.toHaveBeenCalled();
  });
});

describe("handleRequest wiring — exactly-once recording per error source", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); // swallow handleRequest's setTimeout(abort, ...) safety net
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rdsCapture.options = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
  });

  async function importEntry() {
    return await import("../app/entry.server");
  }

  // No user-agent header -> isbot("") is false -> the shell-success callback is
  // "onShellReady" (not the bot-path "onAllReady").
  function makeRenderRequest(): Request {
    return new Request("https://example.com/app/scans");
  }

  it("shell-render error records EXACTLY ONCE across onError + handleError", async () => {
    const { default: handleRequest, handleError } = await importEntry();
    const request = makeRenderRequest();

    const pending = handleRequest(request, 200, new Headers(), {} as EntryContext);
    pending.catch(() => {}); // a shell error rejects this promise

    const options = rdsCapture.options!;
    const error = new Error("shell boom");

    // Framework sequence for a shell-render error (throw before flush):
    // onError fires first, then onShellError -> reject -> framework forwards to
    // the exported handleError.
    options.onError(error);
    options.onShellError(error);
    handleError(error, { request });

    // Pre-fix this was 2 (onError recorded unconditionally + handleError). The
    // shellFlushed guard suppresses the onError record for shell errors.
    expect(mockRecordApiError).toHaveBeenCalledTimes(1);
  });

  it("post-shell streaming error records EXACTLY ONCE (via onError)", async () => {
    const { default: handleRequest } = await importEntry();
    const request = makeRenderRequest();

    const pending = handleRequest(request, 200, new Headers(), {} as EntryContext);

    const options = rdsCapture.options!;

    // Framework sequence for a post-shell error: the shell flushes first
    // (onShellReady), then a streaming render error fires onError. handleError
    // is never called because the response already resolved.
    options.onShellReady();
    options.onError(new Error("post-shell boom"));

    await pending; // resolves with the streamed Response
    expect(mockRecordApiError).toHaveBeenCalledTimes(1);
  });

  it("loader/action error (into handleError only) records EXACTLY ONCE", async () => {
    const { handleError } = await importEntry();

    // Loader/action errors are converted to context.errors before the stream,
    // so onError never fires — only handleError sees them.
    handleError(new Error("loader blew up"), { request: makeRenderRequest() });

    expect(mockRecordApiError).toHaveBeenCalledTimes(1);
  });

  it("thrown Response (control flow) is NOT recorded", async () => {
    const { handleError } = await importEntry();

    handleError(new Response(null, { status: 302 }), { request: makeRenderRequest() });

    expect(mockRecordApiError).not.toHaveBeenCalled();
  });
});
