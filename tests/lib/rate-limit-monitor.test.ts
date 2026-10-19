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
  parseRequestedQueryCost,
  rateLimitSleepMs,
  throttleSnapshot,
  waitForThrottleSnapshot,
  checkThrottleStatus,
  checkThrottleStatusFromExtensions,
  isThrottledError,
  parseThrottleStatus,
  thrownGraphqlResponse,
  type ThrottleStatus,
} from "../../app/lib/rate-limit-monitor.server";
import { graphqlQueryError, throttledGraphqlError } from "../fixtures/graphql-query-error";

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

// ---------------------------------------------------------------------------
// gc-747u: cost-aware backoff (minPoints) + requestedQueryCost parsing
// ---------------------------------------------------------------------------

describe("checkRateLimit minPoints (gc-747u)", () => {
  function captureSleeps(): number[] {
    const sleeps: number[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return sleeps;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits until minPoints are available when that exceeds the flat 100", async () => {
    const sleeps = captureSleeps();
    const result = await checkRateLimit(
      {
        cost: {
          throttleStatus: { currentlyAvailable: 200, maximumAvailable: 2000, restoreRate: 100 },
        },
      },
      700,
    );
    // (700 - 200) / 100 pts/s = 5 s
    expect(sleeps).toEqual([5000]);
    expect(result).toBe(700);
  });

  it("never waits for more than the bucket holds", async () => {
    const sleeps = captureSleeps();
    await checkRateLimit(
      {
        cost: {
          throttleStatus: { currentlyAvailable: 0, maximumAvailable: 1000, restoreRate: 50 },
        },
      },
      5000,
    );
    // Capped at the 1000-point bucket: 1000 / 50 = 20 s.
    expect(sleeps).toEqual([20_000]);
  });

  it("keeps the flat 100 floor when minPoints is smaller", async () => {
    const sleeps = captureSleeps();
    await checkRateLimit(
      {
        cost: {
          throttleStatus: { currentlyAvailable: 50, maximumAvailable: 2000, restoreRate: 50 },
        },
      },
      10,
    );
    expect(sleeps).toEqual([1000]);
  });
});

describe("parseRequestedQueryCost (gc-747u)", () => {
  it("reads cost.requestedQueryCost", () => {
    expect(parseRequestedQueryCost({ cost: { requestedQueryCost: 752 } })).toBe(752);
  });

  it.each([[null], [undefined], [{}], [{ cost: {} }], [{ cost: { requestedQueryCost: "752" } }]])(
    "returns 0 when absent or malformed (%j)",
    (ext) => {
      expect(parseRequestedQueryCost(ext)).toBe(0);
    },
  );
});

describe("rateLimitSleepMs (gc-747u audit #2)", () => {
  const ext = (currentlyAvailable: number, requestedQueryCost?: number) => ({
    cost: {
      requestedQueryCost,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate: 50 },
    },
  });

  it("returns the sleep checkRateLimit would take, without sleeping", () => {
    // Needs 650, has 150, refills 50/s: 10 s.
    expect(rateLimitSleepMs(ext(150, 650), 650)).toBe(10_000);
  });

  it("is 0 with enough headroom or no throttle status", () => {
    expect(rateLimitSleepMs(ext(900, 650), 650)).toBe(0);
    expect(rateLimitSleepMs({})).toBe(0);
  });

  it("never waits for more than the bucket holds", () => {
    // Requested 5,000 against a 1,000-point bucket: waits for 1,000 (20 s).
    expect(rateLimitSleepMs(ext(0, 5_000), 5_000)).toBe(20_000);
  });
});

describe("throttle snapshot across a step boundary (gc-747u audit #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ext = {
    cost: {
      requestedQueryCost: 650,
      actualQueryCost: 400,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
    },
  };

  it("captures the status, the requested cost and when it was observed (plain JSON)", () => {
    const snap = throttleSnapshot(ext);
    expect(snap).toEqual({
      currentlyAvailable: 0,
      maximumAvailable: 1000,
      restoreRate: 50,
      requestedQueryCost: 650,
      observedAt: 1_000_000,
    });
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("is null when the response carries no throttle status", () => {
    expect(throttleSnapshot({})).toBeNull();
    expect(throttleSnapshot(undefined)).toBeNull();
  });

  it("waits for the requested cost, crediting the refill since it was observed", async () => {
    const snap = throttleSnapshot(ext)!;
    // 4 s later the bucket has refilled 200 of the 650 needed: 450 / 50 = 9 s.
    vi.setSystemTime(1_004_000);
    let done = false;
    const wait = waitForThrottleSnapshot(snap).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(8_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(done).toBe(true);
  });

  it("does not wait when the bucket has refilled enough since", async () => {
    const snap = throttleSnapshot(ext)!;
    vi.setSystemTime(1_000_000 + 60_000);
    const started = Date.now();
    await waitForThrottleSnapshot(snap);
    expect(Date.now()).toBe(started);
  });
});

// ---------------------------------------------------------------------------
// gc-psew: unwrap the GraphQL response a thrown GraphqlQueryError carries
// ---------------------------------------------------------------------------

describe("thrownGraphqlResponse (gc-psew)", () => {
  it("returns the THROTTLED errors and throttle extensions of a real GraphqlQueryError", () => {
    const thrown = thrownGraphqlResponse(
      throttledGraphqlError({ currentlyAvailable: 5, maximumAvailable: 2000, restoreRate: 100 }),
    );
    expect(thrown?.errors.some(isThrottledError)).toBe(true);
    expect(parseThrottleStatus(thrown?.extensions)).toEqual({
      currentlyAvailable: 5,
      maximumAvailable: 2000,
      restoreRate: 100,
    });
  });

  it("returns a non-THROTTLED error list for other GraphQL errors", () => {
    const thrown = thrownGraphqlResponse(
      graphqlQueryError([{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }]),
    );
    expect(thrown?.errors).toHaveLength(1);
    expect(thrown?.errors.some(isThrottledError)).toBe(false);
    expect(thrown?.extensions).toBeUndefined();
  });

  it("returns null for anything that is not a GraphqlQueryError", () => {
    expect(thrownGraphqlResponse(new Error("socket hang up"))).toBeNull();
    expect(thrownGraphqlResponse(null)).toBeNull();
    expect(
      thrownGraphqlResponse({
        body: { errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] } },
      }),
    ).toBeNull();
  });
});
