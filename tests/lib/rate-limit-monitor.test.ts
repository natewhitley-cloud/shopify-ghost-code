/**
 * Tests for app/lib/rate-limit-monitor.server.ts
 *
 * Strategy:
 *   - Mock logger to assert warn/error calls without real output.
 *   - Test checkThrottleStatus with boundary values for 20% and 5% thresholds.
 *   - Test checkThrottleStatusFromExtensions for defensive parsing behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
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
  checkThrottleStatus,
  checkThrottleStatusFromExtensions,
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
