import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../app/lib/logger.server";
import { notifyFunctionFailure } from "../../app/lib/notifications.server";
import { captureException } from "../../app/lib/sentry.server";
import {
  failureLoggingMiddleware,
  loggingMiddleware,
  sentryMiddleware,
} from "../../inngest/middleware";

/**
 * Behavioral tests for the Inngest observability middleware (TST-4 / GC-f6w).
 *
 * These middlewares are the production observability path for EVERY
 * background-job failure: if a hook signature drifts on an Inngest SDK
 * upgrade, scan failures would silently stop reaching Sentry and the
 * notification dispatch with nothing to catch it. We invoke the hooks the way
 * the Inngest SDK does — `middleware.init()` to get `{ onFunctionRun }`, then
 * `onFunctionRun({ fn, ctx })` to get the per-run hooks (`afterExecution` /
 * `transformOutput`) — and assert on observable behaviour.
 *
 * `init` is exposed as a readonly property on the `InngestMiddleware` instance
 * (verified against node_modules/inngest/components/InngestMiddleware.d.ts).
 * Both `init` and `onFunctionRun` may be sync or async per the SDK contract, so
 * we await their results defensively.
 */

// The module-under-test imports `logger`, `notifyFunctionFailure`, and
// `captureException`; every export must be present in the factory or Vitest
// throws at runtime when the module is loaded.
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../app/lib/notifications.server", () => ({
  notifyFunctionFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../app/lib/sentry.server", () => ({
  captureException: vi.fn(),
}));

const loggerInfo = vi.mocked(logger.info);
const notifyMock = vi.mocked(notifyFunctionFailure);
const captureMock = vi.mocked(captureException);

// `fn.id()` is a METHOD returning the kebab id; `name` is the display label.
const fn = { name: "scan-theme", id: () => "scan-theme" };

// ctx supplied to `onFunctionRun` (carries event + run identity).
const runCtx = { event: { name: "scan/theme.requested" }, runId: "run-123" };

/**
 * The per-run hooks the SDK exposes. The real `onFunctionRun` return is a union
 * (`{ afterExecution } | { transformOutput }`) that TypeScript cannot narrow at
 * a call site, so we surface both as optional for ergonomic test access.
 */
type RunHooks = {
  afterExecution: () => void;
  transformOutput: (ctx: { result: { error?: unknown } }) => undefined;
};

/**
 * Drive a middleware through the SDK invocation contract and return the per-run
 * hooks object (`{ afterExecution?, transformOutput? }`).
 */
async function initRun(
  middleware: typeof loggingMiddleware | typeof sentryMiddleware | typeof failureLoggingMiddleware,
): Promise<RunHooks> {
  const registered = await middleware.init();
  return registered.onFunctionRun({ fn, ctx: runCtx } as never) as unknown as RunHooks;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loggingMiddleware", () => {
  it("logs the function name and a numeric duration on afterExecution", async () => {
    const hooks = await initRun(loggingMiddleware);

    hooks.afterExecution();

    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith("inngest function completed", {
      function: "scan-theme",
      durationMs: expect.any(Number),
    });
  });

  it("captures the wall-clock delta between init and afterExecution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));

    const hooks = await initRun(loggingMiddleware);

    // Advance 250ms of real work before the execution completes.
    vi.advanceTimersByTime(250);
    hooks.afterExecution();

    expect(loggerInfo).toHaveBeenCalledWith("inngest function completed", {
      function: "scan-theme",
      durationMs: 250,
    });
  });
});

describe("sentryMiddleware", () => {
  it("forwards the error to Sentry with the function name when result.error is set", async () => {
    const hooks = await initRun(sentryMiddleware);
    const error = new Error("scan exploded");

    const result = hooks.transformOutput({ result: { error } });

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(error, { inngestFunction: "scan-theme" });
    // Output passthrough: returns undefined to leave the result unchanged.
    expect(result).toBeUndefined();
  });

  it("does not call captureException when result.error is absent", async () => {
    const hooks = await initRun(sentryMiddleware);

    const result = hooks.transformOutput({ result: { error: undefined } });

    expect(captureMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe("failureLoggingMiddleware", () => {
  it("dispatches notifyFunctionFailure with the Error message and run context", async () => {
    const hooks = await initRun(failureLoggingMiddleware);
    const error = new Error("theme fetch failed");

    const result = hooks.transformOutput({ result: { error } });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      functionId: "scan-theme",
      eventName: "scan/theme.requested",
      error: "theme fetch failed",
      runId: "run-123",
    });
    expect(result).toBeUndefined();
  });

  it("stringifies a non-Error string value via String() rather than dropping it", async () => {
    const hooks = await initRun(failureLoggingMiddleware);

    const result = hooks.transformOutput({ result: { error: "boom" } });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      functionId: "scan-theme",
      eventName: "scan/theme.requested",
      error: "boom",
      runId: "run-123",
    });
    expect(result).toBeUndefined();
  });

  it("stringifies a non-Error object value via String() (not an accidental [object Object] bug)", async () => {
    const hooks = await initRun(failureLoggingMiddleware);
    // An object with a custom toString proves String() is applied, not a
    // hard-coded "[object Object]" fallback.
    const weird = { toString: () => "custom-stringified" };

    const result = hooks.transformOutput({ result: { error: weird } });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      functionId: "scan-theme",
      eventName: "scan/theme.requested",
      error: "custom-stringified",
      runId: "run-123",
    });
    expect(result).toBeUndefined();
  });

  it("does not dispatch a notification when there is no error", async () => {
    const hooks = await initRun(failureLoggingMiddleware);

    const result = hooks.transformOutput({ result: { error: undefined } });

    expect(notifyMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
