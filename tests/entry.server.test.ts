/**
 * Tests for app/entry.server.tsx — handleError export.
 *
 * Strategy:
 *   - Mock ~/lib/sentry.server's captureException to assert forwarding.
 *   - Mock ./shopify.server so importing the entry module has no side effects.
 *   - Verify handleError forwards normal errors and skips aborted requests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCaptureException = vi.fn();

vi.mock("../app/lib/sentry.server", () => ({
  captureException: mockCaptureException,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a normal error to captureException with request context", async () => {
    const handleError = await importHandleError();
    const error = new Error("loader blew up");

    handleError(error, { request: makeRequest(false) });

    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      url: "https://example.com/app/scans",
      method: "POST",
    });
  });

  it("does NOT call captureException when the request was aborted", async () => {
    const handleError = await importHandleError();

    handleError(new Error("client cancelled"), { request: makeRequest(true) });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
