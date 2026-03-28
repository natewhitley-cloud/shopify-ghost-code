/**
 * Tests for app/lib/notifications.server.ts
 *
 * Strategy:
 *   - Mock logger to verify structured log output without real I/O.
 *   - Verify fire-and-forget error swallowing: even when logger throws,
 *     notifyFunctionFailure must resolve without re-throwing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockLoggerError, mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  notifyFunctionFailure,
  type FunctionFailureContext,
} from "../../app/lib/notifications.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CTX: FunctionFailureContext = {
  functionId: "scan-theme",
  eventName: "scan/requested",
  error: "Shop not found",
  runId: "run-abc-123",
};

// ---------------------------------------------------------------------------
// notifyFunctionFailure
// ---------------------------------------------------------------------------

describe("notifyFunctionFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("happy path — structured log output", () => {
    it("logs a structured error entry with all context fields", async () => {
      await notifyFunctionFailure(BASE_CTX);

      expect(mockLoggerError).toHaveBeenCalledOnce();
      expect(mockLoggerError).toHaveBeenCalledWith("inngest-function-failed", {
        functionId: BASE_CTX.functionId,
        eventName: BASE_CTX.eventName,
        error: BASE_CTX.error,
        runId: BASE_CTX.runId,
        attemptNumber: undefined,
      });
    });

    it("includes attemptNumber when provided", async () => {
      await notifyFunctionFailure({ ...BASE_CTX, attemptNumber: 2 });

      expect(mockLoggerError).toHaveBeenCalledWith(
        "inngest-function-failed",
        expect.objectContaining({ attemptNumber: 2 }),
      );
    });

    it("includes undefined attemptNumber when not provided", async () => {
      await notifyFunctionFailure(BASE_CTX);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "inngest-function-failed",
        expect.objectContaining({ attemptNumber: undefined }),
      );
    });

    it("resolves without throwing on success", async () => {
      await expect(notifyFunctionFailure(BASE_CTX)).resolves.toBeUndefined();
    });
  });

  describe("error swallowing — failures must not propagate", () => {
    it("resolves without throwing even when logger.error throws", async () => {
      mockLoggerError.mockImplementation(() => {
        throw new Error("Logger unavailable");
      });

      await expect(notifyFunctionFailure(BASE_CTX)).resolves.toBeUndefined();
    });

    it("logs a warn entry when an internal error is caught", async () => {
      mockLoggerError.mockImplementation(() => {
        throw new Error("Logger unavailable");
      });

      await notifyFunctionFailure(BASE_CTX);

      expect(mockLoggerWarn).toHaveBeenCalledOnce();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "notification-dispatch-failed",
        expect.objectContaining({
          functionId: BASE_CTX.functionId,
          runId: BASE_CTX.runId,
          error: "Logger unavailable",
        }),
      );
    });

    it("includes non-Error thrown values in the warn context as strings", async () => {
      mockLoggerError.mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw "string-error";
      });

      await notifyFunctionFailure(BASE_CTX);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "notification-dispatch-failed",
        expect.objectContaining({ error: "string-error" }),
      );
    });
  });
});
