/**
 * Tests for the watch-stale-scans Inngest cron function.
 *
 * This function runs every 10 minutes and expires scans stuck in PENDING or
 * IN_PROGRESS status past their per-status thresholds (LOG-6, #2-A): PENDING aged
 * from createdAt (15 min), IN_PROGRESS aged from startedAt (30 min).
 *
 * Strategy:
 *   - Mock db.server (for the count query in step 1).
 *   - Use the REAL buildStaleScanWhere from scan.server so the test exercises the
 *     actual predicate, but mock expireStaleScans (step 2) so no UPDATE runs.
 *   - The Inngest client mock records the handler at createFunction time so
 *     getInngestHandler() can retrieve it for direct invocation.
 *
 * Key invariants under test:
 *   - No stale scans: expireStaleScans is NOT called; returns { staleCount: 0, expiredCount: 0 }
 *   - Stale scans exist: expireStaleScans IS called with the shared thresholds
 *   - The count predicate and the update predicate AGREE (both come from the same
 *     buildStaleScanWhere(thresholds) — the DRY invariant that keeps the
 *     early-exit honest).
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

// Partial mock: keep the real buildStaleScanWhere + DEFAULT_STALE_SCAN_THRESHOLDS
// (pure, no DB) so the count step uses the genuine predicate; stub only the
// expireStaleScans UPDATE.
vi.mock("../../app/models/scan.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/scan.server")>();
  return {
    ...actual,
    expireStaleScans: vi.fn(),
  };
});

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
import {
  buildStaleScanWhere,
  DEFAULT_STALE_SCAN_THRESHOLDS,
  expireStaleScans,
} from "../../app/models/scan.server";
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

  it("calls expireStaleScans with the shared per-status thresholds", async () => {
    await runWatchStaleScans();

    expect(mockExpireStaleScans).toHaveBeenCalledOnce();
    expect(mockExpireStaleScans).toHaveBeenCalledWith(DEFAULT_STALE_SCAN_THRESHOLDS);
  });

  it("logs a warning with staleCount, expiredCount, and both thresholds", async () => {
    await runWatchStaleScans();

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    const [message, context] = mockLoggerWarn.mock.calls[0];
    expect(message).toContain("expired stale scan");
    expect(context).toMatchObject({
      staleCount: 3,
      expiredCount: 3,
      pendingMaxAgeMinutes: DEFAULT_STALE_SCAN_THRESHOLDS.pendingMaxAgeMinutes,
      inProgressMaxAgeMinutes: DEFAULT_STALE_SCAN_THRESHOLDS.inProgressMaxAgeMinutes,
    });
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
// Count/update predicate agreement (LOG-6, #2-A)
//
// The early-exit is only correct if the count query and the UPDATE select the
// SAME rows. Both derive from buildStaleScanWhere(thresholds), so with the clock
// frozen the count's where must deep-equal a freshly built predicate.
// ---------------------------------------------------------------------------

describe("watchStaleScans — count and update predicates agree", () => {
  it("counts using exactly buildStaleScanWhere(thresholds)", async () => {
    const now = 1_700_000_000_000; // fixed epoch for determinism
    vi.setSystemTime(now);
    mockDbScanCount.mockResolvedValue(0);

    await runWatchStaleScans();

    expect(mockDbScanCount).toHaveBeenCalledOnce();
    const queryArg = mockDbScanCount.mock.calls[0][0];

    // Frozen time → the predicate the count used must equal a fresh one built
    // from the same shared thresholds (the same builder expireStaleScans uses).
    expect(queryArg.where).toEqual(buildStaleScanWhere(DEFAULT_STALE_SCAN_THRESHOLDS));

    // Sanity: the predicate ORs the two status-specific branches.
    const statuses = queryArg.where.OR.map((b: { status: string }) => b.status);
    expect(statuses).toContain("PENDING");
    expect(statuses).toContain("IN_PROGRESS");

    vi.useRealTimers();
  });

  it("counts and expires using identical thresholds (no drift between steps)", async () => {
    mockDbScanCount.mockResolvedValue(2);
    mockExpireStaleScans.mockResolvedValue(2);

    await runWatchStaleScans();

    // expireStaleScans (the UPDATE) receives the same thresholds the count built
    // its predicate from, so neither can select rows the other misses.
    expect(mockExpireStaleScans).toHaveBeenCalledWith(DEFAULT_STALE_SCAN_THRESHOLDS);
  });
});
