/**
 * Tests for app/lib/rate-limit-monitor.server.ts
 *
 * Strategy:
 *   - Mock logger to assert warn/error calls without real output.
 *   - Test checkThrottleStatus with boundary values for 20% and 5% thresholds.
 *   - Test checkThrottleStatusFromExtensions for defensive parsing behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockLoggerWarn, mockLoggerError, mockRecordApiError } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockRecordApiError: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordApiError: mockRecordApiError,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  checkRateLimit,
  checkThrottleStatus,
  checkThrottleStatusFromExtensions,
  isThrottledError,
  parseThrottleStatus,
  type ThrottleStatus,
} from "../../app/lib/rate-limit-monitor.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThrottleStatus(overrides: Partial<ThrottleStatus> = {}): ThrottleStatus {
  return {
    currentlyAvailable: 500,
    maximumAvailable: 1000,
    restoreRate: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkThrottleStatus
// ---------------------------------------------------------------------------

describe("checkThrottleStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when usage is well below thresholds", () => {
    it("does not log warn or error when above 20% remaining", () => {
      // 50% remaining — well above both thresholds
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 500,
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("does not record an API_ERROR OpsEvent when headroom is healthy", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({ currentlyAvailable: 500, maximumAvailable: 1000 }),
      );

      expect(mockRecordApiError).not.toHaveBeenCalled();
    });

    it("does not log at exactly 20% remaining", () => {
      // Exactly 20% — the threshold is strictly less-than (<), so 20% should not trigger warn
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 200,
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });
  });

  describe("when usage is below the 20% warn threshold", () => {
    it("calls logger.warn when 19% remaining", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 190,
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerWarn).toHaveBeenCalledOnce();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "rate-limit-proximity",
        expect.objectContaining({
          shopDomain: "test-shop.myshopify.com",
          available: 190,
          maximum: 1000,
        }),
      );
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("records an API_ERROR OpsEvent with level warn in the proximity branch", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({ currentlyAvailable: 190, maximumAvailable: 1000 }),
      );

      expect(mockRecordApiError).toHaveBeenCalledOnce();
      expect(mockRecordApiError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          code: "rate_limit_proximity",
          shopDomain: "test-shop.myshopify.com",
          metadata: { available: 190, maximum: 1000 },
        }),
      );
    });

    it("includes percentRemaining rounded to nearest integer in the log context", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 100, // 10%
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "rate-limit-proximity",
        expect.objectContaining({ percentRemaining: 10 }),
      );
    });
  });

  describe("when usage is below the 5% error threshold", () => {
    it("calls logger.error when 4% remaining", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 40,
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerError).toHaveBeenCalledOnce();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "rate-limit-critical",
        expect.objectContaining({
          shopDomain: "test-shop.myshopify.com",
          available: 40,
          maximum: 1000,
        }),
      );
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("records an API_ERROR OpsEvent with level error in the critical branch", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({ currentlyAvailable: 40, maximumAvailable: 1000 }),
      );

      expect(mockRecordApiError).toHaveBeenCalledOnce();
      expect(mockRecordApiError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          code: "rate_limit_critical",
          shopDomain: "test-shop.myshopify.com",
          metadata: { available: 40, maximum: 1000 },
        }),
      );
    });

    it("does not log warn when in error territory (only error fires)", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 1,
          maximumAvailable: 1000,
        }),
      );

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledOnce();
    });
  });

  describe("edge cases", () => {
    it("does not throw or log when maximumAvailable is zero", () => {
      expect(() =>
        checkThrottleStatus(
          "test-shop.myshopify.com",
          makeThrottleStatus({
            currentlyAvailable: 0,
            maximumAvailable: 0,
          }),
        ),
      ).not.toThrow();

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("does not throw or log when maximumAvailable is negative", () => {
      expect(() =>
        checkThrottleStatus(
          "test-shop.myshopify.com",
          makeThrottleStatus({
            currentlyAvailable: 0,
            maximumAvailable: -1,
          }),
        ),
      ).not.toThrow();

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("includes restoreRate in the log context", () => {
      checkThrottleStatus(
        "test-shop.myshopify.com",
        makeThrottleStatus({
          currentlyAvailable: 190,
          maximumAvailable: 1000,
          restoreRate: 50,
        }),
      );

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "rate-limit-proximity",
        expect.objectContaining({ restoreRate: 50 }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// checkThrottleStatusFromExtensions
// ---------------------------------------------------------------------------

describe("checkThrottleStatusFromExtensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("defensive parsing — missing or malformed input", () => {
    it("does not throw when extensions is null", () => {
      expect(() => checkThrottleStatusFromExtensions("test.myshopify.com", null)).not.toThrow();
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("does not throw when extensions is undefined", () => {
      expect(() =>
        checkThrottleStatusFromExtensions("test.myshopify.com", undefined),
      ).not.toThrow();
    });

    it("does not throw when extensions has no cost field", () => {
      expect(() =>
        checkThrottleStatusFromExtensions("test.myshopify.com", { other: "data" }),
      ).not.toThrow();
    });

    it("does not throw when cost has no throttleStatus", () => {
      expect(() =>
        checkThrottleStatusFromExtensions("test.myshopify.com", {
          cost: { requestedQueryCost: 10 },
        }),
      ).not.toThrow();
    });

    it("does not throw when throttleStatus has non-numeric fields", () => {
      expect(() =>
        checkThrottleStatusFromExtensions("test.myshopify.com", {
          cost: {
            throttleStatus: {
              currentlyAvailable: "not-a-number",
              maximumAvailable: 1000,
              restoreRate: 50,
            },
          },
        }),
      ).not.toThrow();
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("silently skips when any of the three required number fields is missing", () => {
      expect(() =>
        checkThrottleStatusFromExtensions("test.myshopify.com", {
          cost: {
            throttleStatus: {
              currentlyAvailable: 100,
              // maximumAvailable missing
              restoreRate: 50,
            },
          },
        }),
      ).not.toThrow();
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
  });

  describe("well-formed payload", () => {
    it("calls logger.warn when percentRemaining is below 20% threshold", () => {
      checkThrottleStatusFromExtensions("test.myshopify.com", {
        cost: {
          throttleStatus: {
            currentlyAvailable: 150,
            maximumAvailable: 1000,
            restoreRate: 50,
          },
        },
      });

      expect(mockLoggerWarn).toHaveBeenCalledOnce();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "rate-limit-proximity",
        expect.objectContaining({ shopDomain: "test.myshopify.com" }),
      );
    });

    it("calls logger.error when percentRemaining is below 5% threshold", () => {
      checkThrottleStatusFromExtensions("test.myshopify.com", {
        cost: {
          throttleStatus: {
            currentlyAvailable: 30,
            maximumAvailable: 1000,
            restoreRate: 50,
          },
        },
      });

      expect(mockLoggerError).toHaveBeenCalledOnce();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "rate-limit-critical",
        expect.objectContaining({ shopDomain: "test.myshopify.com" }),
      );
    });

    it("does not log when percentRemaining is above 20%", () => {
      checkThrottleStatusFromExtensions("test.myshopify.com", {
        cost: {
          throttleStatus: {
            currentlyAvailable: 800,
            maximumAvailable: 1000,
            restoreRate: 50,
          },
        },
      });

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// parseThrottleStatus
// ---------------------------------------------------------------------------

describe("parseThrottleStatus", () => {
  it("returns null when extensions is nullish", () => {
    expect(parseThrottleStatus(null)).toBeNull();
    expect(parseThrottleStatus(undefined)).toBeNull();
  });

  it("returns null when there is no cost block", () => {
    expect(parseThrottleStatus({ other: "data" })).toBeNull();
  });

  it("returns null when cost has no throttleStatus", () => {
    expect(parseThrottleStatus({ cost: { requestedQueryCost: 10 } })).toBeNull();
  });

  it("extracts all three numeric fields when present", () => {
    expect(
      parseThrottleStatus({
        cost: {
          throttleStatus: { currentlyAvailable: 100, maximumAvailable: 1000, restoreRate: 50 },
        },
      }),
    ).toEqual({ currentlyAvailable: 100, maximumAvailable: 1000, restoreRate: 50 });
  });

  it("drops non-numeric fields rather than including them", () => {
    expect(
      parseThrottleStatus({
        cost: {
          throttleStatus: {
            currentlyAvailable: "nope",
            maximumAvailable: 1000,
            restoreRate: null,
          },
        },
      }),
    ).toEqual({ maximumAvailable: 1000 });
  });

  it("returns an empty object when throttleStatus exists but has no numeric fields", () => {
    expect(parseThrottleStatus({ cost: { throttleStatus: {} } })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// isThrottledError
// ---------------------------------------------------------------------------

describe("isThrottledError", () => {
  it("returns false for null/undefined", () => {
    expect(isThrottledError(null)).toBe(false);
    expect(isThrottledError(undefined)).toBe(false);
  });

  it("matches the THROTTLED extensions code (case-insensitive)", () => {
    expect(isThrottledError({ extensions: { code: "THROTTLED" } })).toBe(true);
    expect(isThrottledError({ extensions: { code: "throttled" } })).toBe(true);
  });

  it("matches a throttled message when no code is present", () => {
    expect(isThrottledError({ message: "Throttled" })).toBe(true);
    expect(isThrottledError({ message: "Query was throttled, retry later" })).toBe(true);
  });

  it("returns false for an unrelated error", () => {
    expect(
      isThrottledError({ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit (proactive backoff)
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Infinity when extensions is nullish", async () => {
    expect(await checkRateLimit(null)).toBe(Infinity);
  });

  it("returns Infinity when extensions has no cost block", async () => {
    expect(await checkRateLimit({})).toBe(Infinity);
  });

  it("returns currentlyAvailable without sleeping when headroom is sufficient", async () => {
    const sleepSpy = vi.spyOn(global, "setTimeout");
    const result = await checkRateLimit({
      cost: { throttleStatus: { currentlyAvailable: 500, restoreRate: 50 } },
    });
    expect(result).toBe(500);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("sleeps and returns the threshold sentinel when headroom is below 100", async () => {
    const advanceSpy = vi.spyOn(global, "setTimeout");
    const promise = checkRateLimit({
      cost: { throttleStatus: { currentlyAvailable: 50, restoreRate: 100 } },
    });
    vi.runAllTimers();
    const result = await promise;
    expect(advanceSpy).toHaveBeenCalled();
    expect(result).toBe(100);
  });

  it("computes sleep duration proportional to points needed and restore rate", async () => {
    const sleepDurations: number[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      sleepDurations.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await checkRateLimit({
      cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } },
    });

    // 100 pts needed / 50 pts/sec * 1000 = 2000ms
    expect(sleepDurations[0]).toBe(2000);
  });

  it("defaults restoreRate to 50 when the field is absent", async () => {
    const sleepDurations: number[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      sleepDurations.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    // currentlyAvailable 0, no restoreRate -> 100 / 50 * 1000 = 2000ms
    await checkRateLimit({ cost: { throttleStatus: { currentlyAvailable: 0 } } });
    expect(sleepDurations[0]).toBe(2000);
  });
});
