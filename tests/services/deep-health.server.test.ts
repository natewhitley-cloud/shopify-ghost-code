/**
 * Tests for app/services/deep-health.server.ts (gc-06e.13, sub-item 1)
 *
 * The read-only deep-health checks were extracted from the health.deep route so
 * both the route and the monitor-deep-health cron run ONE implementation. This
 * covers the derived status directly (the route test covers the token gate +
 * HTTP mapping on top of it).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { performDeepHealthChecks } from "../../app/services/deep-health.server";

const mockQueryRaw = vi.fn();
const mockSessionCount = vi.fn();
const mockScanCount = vi.fn();
const mockLoggerError = vi.fn();
const mockGetStaleCrons = vi.fn();

vi.mock("../../app/db.server", () => ({
  default: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    session: { count: (...args: unknown[]) => mockSessionCount(...args) },
    scan: { count: (...args: unknown[]) => mockScanCount(...args) },
  },
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

vi.mock("../../app/models/scan.server", () => ({
  DEFAULT_STALE_SCAN_THRESHOLDS: { pendingMaxAgeMinutes: 15, inProgressMaxAgeMinutes: 30 },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  getStaleCrons: (...args: unknown[]) => mockGetStaleCrons(...args),
  CRON_HEARTBEAT_EXPECTATIONS: [{ key: "watch-stale-scans", intervalMs: 600000 }],
}));

const ORIGINAL_ENV = { ...process.env };

describe("performDeepHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mockSessionCount.mockResolvedValue(0);
    mockScanCount.mockResolvedValue(0);
    mockGetStaleCrons.mockResolvedValue([]);
    process.env.INNGEST_EVENT_KEY = "evt-key";
    process.env.INNGEST_SIGNING_KEY = "sign-key";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns ok with all checks green when everything passes", async () => {
    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("ok");
    expect(checks).toEqual({
      db: { ok: true },
      inngest: { ok: true, envOk: true, overdueCrons: [] },
      sessions: { expiredOffline: 0 },
      scans: { stuckPending: 0 },
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("returns degraded when PENDING scans are stuck", async () => {
    mockScanCount.mockResolvedValue(2);

    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("degraded");
    expect(checks.scans.stuckPending).toBe(2);
  });

  it("returns degraded when Inngest keys are missing", async () => {
    delete process.env.INNGEST_SIGNING_KEY;

    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("degraded");
    expect(checks.inngest.ok).toBe(false);
    expect(checks.inngest.envOk).toBe(false);
  });

  it("returns degraded when a cron heartbeat is overdue even with keys present", async () => {
    mockGetStaleCrons.mockResolvedValue([
      { key: "watch-stale-scans", intervalMs: 600000, thresholdMs: 1200000, ageMs: 3600000 },
    ]);

    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("degraded");
    expect(checks.inngest.envOk).toBe(true);
    expect(checks.inngest.ok).toBe(false);
    expect(checks.inngest.overdueCrons).toEqual(["watch-stale-scans"]);
  });

  it("fails open (stays ok) and logs when the cron probe throws", async () => {
    mockGetStaleCrons.mockRejectedValue(new Error("groupBy failed"));

    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("ok");
    expect(checks.inngest.ok).toBe(true);
    expect(mockLoggerError).toHaveBeenCalledOnce();
  });

  it("returns error and logs when the DB probe rejects", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));

    const { status, checks } = await performDeepHealthChecks();

    expect(status).toBe("error");
    expect(checks.db.ok).toBe(false);
    expect(mockLoggerError).toHaveBeenCalledOnce();
  });
});
