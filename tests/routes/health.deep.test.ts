/**
 * Tests for app/routes/health.deep.tsx
 *
 * Strategy:
 *   - Mock db ($queryRaw liveness probe + session.count + scan.count).
 *   - Mock logger to assert the DB-failure and misconfig paths log.
 *   - Mock scan.server for the shared staleness threshold (route reuses the
 *     real constant; the count is controlled directly so its value is inert).
 *   - Drive env vars per test — the loader reads process.env at call time.
 *
 * Covers: all-ok (200), degraded conditions (503) for expired offline sessions,
 * stuck PENDING scans, and missing Inngest keys, DB failure (503 error), and the
 * token gate (fail-closed in prod, 401 on mismatch, pass on match).
 */

import { readFileSync } from "node:fs";

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { loader } from "../../app/routes/health.deep";

const mockQueryRaw = vi.fn();
const mockSessionCount = vi.fn();
const mockScanCount = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

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

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/health/deep", { headers });
}

function callLoader(headers?: Record<string, string>) {
  return loader({ request: makeRequest(headers) } as LoaderFunctionArgs);
}

// Grace window mirroring SafeSessionStorage.FIVE_MINUTES_MS (kept local so the
// test doesn't pull in the SDK imports the lib module carries at load time).
const FIVE_MINUTES_MS = 5 * 60 * 1000;

type SessionRow = { isOnline: boolean; refreshToken: string | null; expires: Date | null };

// Applies the route's Prisma `where` filter against in-memory rows so the mock
// exercises the real filter intent (refreshToken null + offline + expired
// beyond grace) rather than returning a fixed count.
function matchesWhere(row: SessionRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const value = (row as Record<string, unknown>)[field];
    if (cond === null) return value === null;
    if (cond && typeof cond === "object") {
      const c = cond as { not?: unknown; lt?: unknown };
      if ("not" in c && c.not === null && value === null) return false;
      if ("lt" in c && !(value instanceof Date && value < (c.lt as Date))) return false;
      return true;
    }
    return value === cond;
  });
}

function countMatching(rows: SessionRow[]) {
  return (args: { where?: Record<string, unknown> }) =>
    rows.filter((row) => matchesWhere(row, args?.where ?? {})).length;
}

const ORIGINAL_ENV = { ...process.env };

describe("health.deep loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Healthy baseline: DB up, no stale rows, Inngest configured, token set.
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mockSessionCount.mockResolvedValue(0);
    mockScanCount.mockResolvedValue(0);
    process.env.INNGEST_EVENT_KEY = "evt-key";
    process.env.INNGEST_SIGNING_KEY = "sign-key";
    process.env.HEALTH_CHECK_TOKEN = "secret-token";
    process.env.NODE_ENV = "test";
    // Default: .deploy-sha contains a known SHA.
    vi.mocked(readFileSync).mockImplementation(() => "abc123def456abc123def456abc123def456abc1");
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns 200 + ok when every check passes and the token matches", async () => {
    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({
      db: { ok: true },
      inngest: { ok: true },
      sessions: { expiredOffline: 0 },
      scans: { stuckPending: 0 },
    });
    expect(typeof body.timestamp).toBe("string");
    expect(body.deployedSha).toBe("abc123def456abc123def456abc123def456abc1");
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("returns deployedSha: null when .deploy-sha is absent", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    });

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deployedSha).toBeNull();
  });

  it("returns deployedSha: null when .deploy-sha is empty", async () => {
    vi.mocked(readFileSync).mockImplementation(() => "");

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deployedSha).toBeNull();
  });

  it("does not count expired offline sessions that still have a refreshToken (self-healing)", async () => {
    const now = Date.now();
    // Expired an hour ago, but a refreshToken means the SDK auto-refreshes it.
    mockSessionCount.mockImplementation(
      countMatching([
        { isOnline: false, refreshToken: "refresh-abc", expires: new Date(now - 60 * 60 * 1000) },
      ]),
    );

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.sessions.expiredOffline).toBe(0);
  });

  it("returns 503 + degraded for an offline session expired beyond grace with no refreshToken", async () => {
    const now = Date.now();
    // Expired an hour ago with no refreshToken — the genuinely-stuck GC-07t state.
    mockSessionCount.mockImplementation(
      countMatching([
        { isOnline: false, refreshToken: null, expires: new Date(now - 60 * 60 * 1000) },
      ]),
    );

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.sessions.expiredOffline).toBe(1);

    // Query mirrors SafeSessionStorage's trigger exactly.
    const where = mockSessionCount.mock.calls[0][0].where;
    expect(where.refreshToken).toBeNull();
    expect(where.isOnline).toBe(false);
    expect(where.expires.not).toBeNull();
    expect(where.expires.lt).toBeInstanceOf(Date);
    expect(where.expires.lt.getTime()).toBeLessThanOrEqual(Date.now() - FIVE_MINUTES_MS);
  });

  it("does not count offline sessions still within the 5-minute grace window", async () => {
    const now = Date.now();
    // Expired 2 min ago (< 5 min grace), no refreshToken — SDK still refreshes.
    mockSessionCount.mockImplementation(
      countMatching([
        { isOnline: false, refreshToken: null, expires: new Date(now - 2 * 60 * 1000) },
      ]),
    );

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.sessions.expiredOffline).toBe(0);
  });

  it("returns 503 + degraded when PENDING scans are stuck", async () => {
    mockScanCount.mockResolvedValue(2);

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.scans.stuckPending).toBe(2);
  });

  it("returns 503 + degraded when Inngest keys are missing", async () => {
    delete process.env.INNGEST_SIGNING_KEY;

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.inngest.ok).toBe(false);
  });

  it("returns 503 + error and logs when the DB probe rejects", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks.db.ok).toBe(false);
    expect(mockLoggerError).toHaveBeenCalledOnce();
  });

  it("fails closed with 503 when the token is unset in production", async () => {
    delete process.env.HEALTH_CHECK_TOKEN;
    process.env.NODE_ENV = "production";

    const response = await callLoader();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.message).toMatch(/health token not configured/i);
    expect(mockLoggerError).toHaveBeenCalledOnce();
    // Never ran the checks — bailed at the gate.
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it("returns 401 when the token is set but the header does not match", async () => {
    const response = await callLoader({ "x-health-token": "wrong" });

    expect(response.status).toBe(401);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it("allows the request in non-production when no token is configured", async () => {
    delete process.env.HEALTH_CHECK_TOKEN;
    process.env.NODE_ENV = "test";

    const response = await callLoader();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });
});
