/**
 * Tests for app/routes/health.tsx
 *
 * Strategy:
 *   - Mock db ($queryRaw) to control liveness probe outcome.
 *   - Mock logger to assert failures are logged.
 *   - Verify 200/ok on success, 503/error on rejection, 503 on timeout.
 *
 * Note: the timeout test uses fake timers so we don't actually wait 2s.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQueryRaw = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("../../app/db.server", () => ({
  default: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

async function importLoader() {
  const mod = await import("../../app/routes/health");
  return mod.loader;
}

describe("health loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 + ok with a timestamp when the DB probe resolves", async () => {
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const loader = await importLoader();

    const response = await loader();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("returns 503 + error and logs when the DB probe rejects", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const loader = await importLoader();

    const response = await loader();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(mockLoggerError).toHaveBeenCalledOnce();
  });

  it("returns 503 + error when the DB probe exceeds the timeout", async () => {
    vi.useFakeTimers();
    // A query that never settles — only the timeout can win the race.
    mockQueryRaw.mockReturnValue(new Promise(() => {}));
    const loader = await importLoader();

    const resultPromise = loader();
    // Advance past the 2s probe timeout.
    await vi.advanceTimersByTimeAsync(2000);

    const response = await resultPromise;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(mockLoggerError).toHaveBeenCalledOnce();
  });
});
