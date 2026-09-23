/**
 * Tests for the monitor-scan-failures Inngest cron function.
 *
 * This function runs every 6 hours and logs the scan failure rate over the
 * trailing 24-hour window. It uses three log branches:
 *   - rate > 25%  → logger.error (critical)
 *   - rate > 10%  → logger.warn  (elevated)
 *   - rate <= 10% → logger.info  (nominal)
 *
 * Strategy:
 *   - Mock scan.server (getFailureRateStats) and logger.server so the function
 *     is tested in full isolation.
 *   - The Inngest client mock records the handler at createFunction time so
 *     getInngestHandler() can retrieve it for direct invocation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/models/scan.server", () => ({
  getFailureRateStats: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// The real withCronHeartbeat wrapper runs the handler then records a heartbeat.
// Stub the heartbeat write so it does not touch the DB or logger in these tests.
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
  getLatestOpsEvent: vi.fn(),
  OPS_EVENT_TYPES: { FUNCTION_FAILURE: "function_failure" },
}));

vi.mock("../../app/lib/notifications.server", () => ({
  notifyFunctionFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { logger } from "../../app/lib/logger.server";
import { notifyFunctionFailure } from "../../app/lib/notifications.server";
import { getLatestOpsEvent } from "../../app/models/ops-event.server";
import { getFailureRateStats } from "../../app/models/scan.server";
import { monitorScanFailures } from "../../inngest/functions/monitor-scan-failures";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockGetFailureRateStats = getFailureRateStats as ReturnType<typeof vi.fn>;
const mockNotify = notifyFunctionFailure as ReturnType<typeof vi.fn>;
const mockGetLatestOpsEvent = getLatestOpsEvent as ReturnType<typeof vi.fn>;
const mockLoggerInfo = (logger as unknown as { info: ReturnType<typeof vi.fn> }).info;
const mockLoggerWarn = (logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
const mockLoggerError = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;

// ---------------------------------------------------------------------------
// Helper: invoke function handler
// ---------------------------------------------------------------------------

async function runMonitorScanFailures(
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = {
    name: "scheduled/cron",
    data: {},
    ts: Date.now(),
    id: "test-event-monitor-failures",
  };
  return getInngestHandler(monitorScanFailures)({ event, step });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Calls getFailureRateStats with correct window hours
// ---------------------------------------------------------------------------

describe("monitorScanFailures — getFailureRateStats call", () => {
  it("calls getFailureRateStats with 24 as the window hours", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 10, failed: 1, rate: 0.1 });

    await runMonitorScanFailures();

    expect(mockGetFailureRateStats).toHaveBeenCalledOnce();
    expect(mockGetFailureRateStats).toHaveBeenCalledWith(24);
  });
});

// ---------------------------------------------------------------------------
// Rate <= 10% — logs info
// ---------------------------------------------------------------------------

describe("monitorScanFailures — nominal rate (<=10%)", () => {
  beforeEach(() => {
    mockGetFailureRateStats.mockResolvedValue({ total: 100, failed: 10, rate: 0.1 });
  });

  it("logs info when rate is exactly 10%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerInfo).toHaveBeenCalledOnce();
  });

  it("does not log warn or error when rate is exactly 10%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("logs info when rate is 0%", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 50, failed: 0, rate: 0 });

    await runMonitorScanFailures();

    expect(mockLoggerInfo).toHaveBeenCalledOnce();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate > 10% and <= 25% — logs warn
// ---------------------------------------------------------------------------

describe("monitorScanFailures — elevated rate (>10% and <=25%)", () => {
  beforeEach(() => {
    mockGetFailureRateStats.mockResolvedValue({ total: 100, failed: 20, rate: 0.2 });
  });

  it("logs warn when rate is 20%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
  });

  it("does not log info or error when rate is 20%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("logs warn when rate is exactly 25%", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 100, failed: 25, rate: 0.25 });

    await runMonitorScanFailures();

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("passes total, failed, rate, and windowHours to logger.warn", async () => {
    await runMonitorScanFailures();

    const context = mockLoggerWarn.mock.calls[0][1];
    expect(context).toMatchObject({ total: 100, failed: 20, rate: 0.2, windowHours: 24 });
  });
});

// ---------------------------------------------------------------------------
// Rate > 25% — logs error (critical)
// ---------------------------------------------------------------------------

describe("monitorScanFailures — critical rate (>25%)", () => {
  beforeEach(() => {
    mockGetFailureRateStats.mockResolvedValue({ total: 100, failed: 30, rate: 0.3 });
  });

  it("logs error when rate is 30%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerError).toHaveBeenCalledOnce();
  });

  it("does not log info or warn when rate is 30%", async () => {
    await runMonitorScanFailures();

    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("passes total, failed, rate, and windowHours to logger.error", async () => {
    await runMonitorScanFailures();

    const context = mockLoggerError.mock.calls[0][1];
    expect(context).toMatchObject({ total: 100, failed: 30, rate: 0.3, windowHours: 24 });
  });
});

// ---------------------------------------------------------------------------
// Return value
// ---------------------------------------------------------------------------

describe("monitorScanFailures — return value", () => {
  it("returns the stats object from getFailureRateStats", async () => {
    const stats = { total: 50, failed: 5, rate: 0.1 };
    mockGetFailureRateStats.mockResolvedValue(stats);

    const result = await runMonitorScanFailures();

    expect(result).toEqual(stats);
  });
});

// ---------------------------------------------------------------------------
// gc-i1n: sustained CRITICAL → durable function_failure + page (deduped, floored)
// ---------------------------------------------------------------------------

describe("monitorScanFailures — critical escalation (gc-i1n)", () => {
  beforeEach(() => {
    mockGetLatestOpsEvent.mockResolvedValue(null);
  });

  it("pages via notifyFunctionFailure when rate > 25% and failures meet the floor", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 10, failed: 4, rate: 0.4 });

    await runMonitorScanFailures();

    expect(mockNotify).toHaveBeenCalledOnce();
    const ctx = mockNotify.mock.calls[0][0];
    expect(ctx.functionId).toBe("monitor-scan-failures");
    expect(ctx.error).toContain("40.0%");
    expect(ctx.error).toContain("4 of 10");
  });

  it("does NOT page on a small-sample spike below the failure floor (e.g. 1 of 3)", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 3, failed: 1, rate: 1 / 3 });

    await runMonitorScanFailures();

    expect(mockLoggerError).toHaveBeenCalledOnce(); // still logged as critical
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does NOT page again inside the 24h dedupe window", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 10, failed: 4, rate: 0.4 });
    mockGetLatestOpsEvent.mockResolvedValue({ createdAt: new Date(Date.now() - 6 * 3600_000) });

    await runMonitorScanFailures();

    expect(mockGetLatestOpsEvent).toHaveBeenCalledWith("function_failure", "monitor-scan-failures");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("pages again once the prior escalation is older than 24h", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 10, failed: 4, rate: 0.4 });
    mockGetLatestOpsEvent.mockResolvedValue({ createdAt: new Date(Date.now() - 25 * 3600_000) });

    await runMonitorScanFailures();

    expect(mockNotify).toHaveBeenCalledOnce();
  });

  it("does NOT page at an elevated (non-critical) rate", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 100, failed: 20, rate: 0.2 });

    await runMonitorScanFailures();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("is best-effort: an escalation failure never fails the cron", async () => {
    mockGetFailureRateStats.mockResolvedValue({ total: 10, failed: 4, rate: 0.4 });
    mockGetLatestOpsEvent.mockRejectedValue(new Error("db down"));

    await expect(runMonitorScanFailures()).resolves.toMatchObject({ failed: 4 });
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
