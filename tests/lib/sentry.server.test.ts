/**
 * Tests for app/lib/sentry.server.ts
 *
 * Strategy:
 *   - Test no-op behavior when SENTRY_DSN is unset.
 *   - Test pass-through to @sentry/node when DSN is set.
 *   - Mock @sentry/node to verify calls without hitting real Sentry.
 *
 * Note on env isolation: process.env mutations must be cleaned up in
 * afterEach to avoid leaking state between tests.
 *
 * Note on module reset: sentry.server.ts runs initSentry() eagerly at
 * module load time and checks process.env.SENTRY_DSN at call time.
 * We reset the module between tests that change SENTRY_DSN.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockSentryInit = vi.fn();
const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
const mockWithScope = vi.fn((cb: (scope: { setExtras: ReturnType<typeof vi.fn> }) => void) => {
  cb({ setExtras: vi.fn() });
});

vi.mock("@sentry/node", () => ({
  init: mockSentryInit,
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  withScope: mockWithScope,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importSentry() {
  return import("../../app/lib/sentry.server");
}

// ---------------------------------------------------------------------------
// captureException
// ---------------------------------------------------------------------------

describe("captureException", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    vi.resetModules();
  });

  describe("when SENTRY_DSN is not set", () => {
    it("does not call @sentry/node captureException", async () => {
      delete process.env.SENTRY_DSN;
      const { captureException } = await importSentry();

      captureException(new Error("test error"));

      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("does not throw when called without context", async () => {
      delete process.env.SENTRY_DSN;
      const { captureException } = await importSentry();

      expect(() => captureException(new Error("test error"))).not.toThrow();
    });

    it("does not throw when called with context", async () => {
      delete process.env.SENTRY_DSN;
      const { captureException } = await importSentry();

      expect(() =>
        captureException(new Error("test error"), { shop: "test.myshopify.com" }),
      ).not.toThrow();
    });
  });

  describe("when SENTRY_DSN is set", () => {
    it("calls through to @sentry/node captureException via withScope", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";
      const { captureException } = await importSentry();

      const err = new Error("something went wrong");
      captureException(err);

      expect(mockWithScope).toHaveBeenCalledOnce();
      expect(mockCaptureException).toHaveBeenCalledOnce();
    });

    it("sets extra context on the scope when context is provided", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";

      const mockSetExtras = vi.fn();
      mockWithScope.mockImplementationOnce(
        (cb: (scope: { setExtras: ReturnType<typeof vi.fn> }) => void) => {
          cb({ setExtras: mockSetExtras });
        },
      );

      const { captureException } = await importSentry();
      captureException(new Error("err"), { shop: "test.myshopify.com", scanId: "scan-1" });

      expect(mockSetExtras).toHaveBeenCalledWith({ shop: "test.myshopify.com", scanId: "scan-1" });
    });

    it("does not call setExtras when no context is provided", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";

      const mockSetExtras = vi.fn();
      mockWithScope.mockImplementationOnce(
        (cb: (scope: { setExtras: ReturnType<typeof vi.fn> }) => void) => {
          cb({ setExtras: mockSetExtras });
        },
      );

      const { captureException } = await importSentry();
      captureException(new Error("err"));

      expect(mockSetExtras).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// initSentry — release wiring
// ---------------------------------------------------------------------------

describe("initSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    vi.resetModules();
  });

  it("sets release from RAILWAY_GIT_COMMIT_SHA when present", async () => {
    process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc1234";

    // Eager init runs on import.
    await importSentry();

    expect(mockSentryInit).toHaveBeenCalledOnce();
    expect(mockSentryInit).toHaveBeenCalledWith(expect.objectContaining({ release: "abc1234" }));
  });

  it("leaves release undefined when RAILWAY_GIT_COMMIT_SHA is absent", async () => {
    process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";
    delete process.env.RAILWAY_GIT_COMMIT_SHA;

    await importSentry();

    expect(mockSentryInit).toHaveBeenCalledOnce();
    expect(mockSentryInit).toHaveBeenCalledWith(expect.objectContaining({ release: undefined }));
  });

  it("does not initialize Sentry when DSN is absent", async () => {
    delete process.env.SENTRY_DSN;

    await importSentry();

    expect(mockSentryInit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// captureMessage
// ---------------------------------------------------------------------------

describe("captureMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    vi.resetModules();
  });

  describe("when SENTRY_DSN is not set", () => {
    it("does not call @sentry/node captureMessage", async () => {
      delete process.env.SENTRY_DSN;
      const { captureMessage } = await importSentry();

      captureMessage("something happened");

      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("does not throw when called with level and context", async () => {
      delete process.env.SENTRY_DSN;
      const { captureMessage } = await importSentry();

      expect(() =>
        captureMessage("rate-limit-critical", "warning", { shop: "test.myshopify.com" }),
      ).not.toThrow();
    });
  });

  describe("when SENTRY_DSN is set", () => {
    it("calls through to @sentry/node captureMessage via withScope", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";
      const { captureMessage } = await importSentry();

      captureMessage("scan quota exceeded", "warning");

      expect(mockWithScope).toHaveBeenCalledOnce();
      expect(mockCaptureMessage).toHaveBeenCalledWith("scan quota exceeded", "warning");
    });

    it("defaults level to info when not provided", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";
      const { captureMessage } = await importSentry();

      captureMessage("hello");

      expect(mockCaptureMessage).toHaveBeenCalledWith("hello", "info");
    });

    it("sets extra context on the scope when context is provided", async () => {
      process.env.SENTRY_DSN = "https://fake-dsn@o0.ingest.sentry.io/0";

      const mockSetExtras = vi.fn();
      mockWithScope.mockImplementationOnce(
        (cb: (scope: { setExtras: ReturnType<typeof vi.fn> }) => void) => {
          cb({ setExtras: mockSetExtras });
        },
      );

      const { captureMessage } = await importSentry();
      captureMessage("rate-limit-critical", "error", { shop: "test.myshopify.com" });

      expect(mockSetExtras).toHaveBeenCalledWith({ shop: "test.myshopify.com" });
    });
  });
});
