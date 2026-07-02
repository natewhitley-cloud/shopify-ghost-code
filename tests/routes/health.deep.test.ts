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

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQueryRaw = vi.fn();
const mockSessionCount = vi.fn();
const mockScanCount = vi.fn();
const mockLoggerError = vi.fn();

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

import { loader } from "../../app/routes/health.deep";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/health/deep", { headers });
}

function callLoader(headers?: Record<string, string>) {
  return loader({ request: makeRequest(headers) } as LoaderFunctionArgs);
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
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("returns 503 + degraded when expired offline sessions exist", async () => {
    mockSessionCount.mockResolvedValue(4);

    const response = await callLoader({ "x-health-token": "secret-token" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.sessions.expiredOffline).toBe(4);
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
