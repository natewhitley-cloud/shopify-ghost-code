/**
 * Tests for the watch-stale-scans Inngest cron function.
 *
 * This function runs every 10 minutes and expires scans stuck in PENDING or
 * IN_PROGRESS status for longer than 15 minutes.
 *
 * Strategy:
 *   - Mock db.server (for the count query in step 1) and scan.server
 *     (for expireStaleScans in step 2) so the function is tested in isolation.
 *   - The Inngest client mock records the handler at createFunction time so
 *     getInngestHandler() can retrieve it for direct invocation.
 *
 * Key invariants under test:
 *   - No stale scans: expireStaleScans is NOT called; returns { staleCount: 0, expiredCount: 0 }
 *   - Stale scans exist: expireStaleScans IS called with 15; returns correct counts
 *   - Scans under 15 min: count query uses correct cutoff; count = 0 → no-op
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/db.server", () => ({
  default: {
    scan: {
      count: vi.fn(),
    },
  },
}));

vi.mock("../../app/models/scan.server", () => ({
  expireStaleScans: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { logger } from "../../app/lib/logger.server";
import { expireStaleScans } from "../../app/models/scan.server";
import { watchStaleScans } from "../../inngest/functions/watch-stale-scans";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDbScanCount = (db as unknown as { scan: { count: ReturnType<typeof vi.fn> } }).scan.count;
const mockExpireStaleScans = expireStaleScans as ReturnType<typeof vi.fn>;
const mockLoggerInfo = (logger as unknown as { info: ReturnType<typeof vi.fn> }).info;
const mockLoggerWarn = (logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

// ---------------------------------------------------------------------------
// Helper: invoke function handler
// ---------------------------------------------------------------------------

async function runWatchStaleScans(
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = { name: "scheduled/cron", data: {}, ts: Date.now(), id: "test-event-watch" };
  return getInngestHandler(watchStaleScans)({ event, step });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// No stale scans — early exit
// ---------------------------------------------------------------------------

describe("watchStaleScans — no stale scans", () => {
  beforeEach(() => {
    mockDbScanCount.mockResolvedValue(0);
  });

  it("returns staleCount: 0 and expiredCount: 0", async () => {
    const result = await runWatchStaleScans();

    expect(result).toEqual({ staleCount: 0, expiredCount: 0 });
  });

  it("does not call expireStaleScans when count is 0", async () => {
    await runWatchStaleScans();

    expect(mockExpireStaleScans).not.toHaveBeenCalled();
  });

  it("logs an info message on no-op", async () => {
    await runWatchStaleScans();

    expect(mockLoggerInfo).toHaveBeenCalledOnce();
    expect(mockLoggerInfo.mock.calls[0][0]).toContain("no stale scans found");
  });

  it("does not log a warning on no-op", async () => {
    await runWatchStaleScans();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale scans exist — expires and returns counts
// ---------------------------------------------------------------------------

describe("watchStaleScans — stale scans found", () => {
  beforeEach(() => {
    mockDbScanCount.mockResolvedValue(3);
    mockExpireStaleScans.mockResolvedValue(3);
  });

  it("returns the staleCount and expiredCount from the two steps", async () => {
    const result = await runWatchStaleScans();

    expect(result).toEqual({ staleCount: 3, expiredCount: 3 });
  });

  it("calls expireStaleScans with maxAgeMinutes = 15", async () => {
    await runWatchStaleScans();

    expect(mockExpireStaleScans).toHaveBeenCalledOnce();
    expect(mockExpireStaleScans).toHaveBeenCalledWith(15);
  });

  it("logs a warning with staleCount, expiredCount, and maxAgeMinutes", async () => {
    await runWatchStaleScans();

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    const [message, context] = mockLoggerWarn.mock.calls[0];
    expect(message).toContain("expired stale scan");
    expect(context).toMatchObject({ staleCount: 3, expiredCount: 3, maxAgeMinutes: 15 });
  });

  it("does not log an info no-op message when scans are expired", async () => {
    await runWatchStaleScans();

    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Partial expiry — expiredCount may differ from staleCount
// (race: another process expired some between the count and the update)
// ---------------------------------------------------------------------------

describe("watchStaleScans — partial expiry", () => {
  beforeEach(() => {
    // count returns 5, but by the time we UPDATE only 3 still qualify
    mockDbScanCount.mockResolvedValue(5);
    mockExpireStaleScans.mockResolvedValue(3);
  });

  it("returns both staleCount and expiredCount faithfully", async () => {
    const result = await runWatchStaleScans();

    expect(result).toEqual({ staleCount: 5, expiredCount: 3 });
  });

  it("still calls expireStaleScans since staleCount > 0", async () => {
    await runWatchStaleScans();

    expect(mockExpireStaleScans).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Count query correctness — scans under 15 min old are not stale
// ---------------------------------------------------------------------------

describe("watchStaleScans — count query uses 15-minute cutoff", () => {
  it("passes the correct statuses and cutoff to db.scan.count", async () => {
    const now = 1_700_000_000_000; // fixed epoch for determinism
    vi.setSystemTime(now);
    mockDbScanCount.mockResolvedValue(0);

    await runWatchStaleScans();

    expect(mockDbScanCount).toHaveBeenCalledOnce();
    const queryArg = mockDbScanCount.mock.calls[0][0];

    // Status filter must include both stuck states
    expect(queryArg.where.status.in).toContain("PENDING");
    expect(queryArg.where.status.in).toContain("IN_PROGRESS");

    // Cutoff must be exactly 15 minutes ago
    const expectedCutoff = new Date(now - 15 * 60 * 1000);
    expect(queryArg.where.createdAt.lt).toEqual(expectedCutoff);

    vi.useRealTimers();
  });
});
