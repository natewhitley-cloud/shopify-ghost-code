/**
 * Tests for app/entry.server.tsx — handleError export.
 *
 * Strategy:
 *   - Spy on console.error to assert errors surface to the logs.
 *   - Mock ./shopify.server so importing the entry module has no side effects.
 *   - Verify handleError logs normal errors and skips aborted requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../app/shopify.server", () => ({
  addDocumentResponseHeaders: vi.fn(),
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
});
