/**
 * Tests for app/models/ops-event.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control OpsEvent reads/writes.
 *   - Mock logger to assert the best-effort swallow path.
 *   - recordOpsEvent must NEVER throw — verify it swallows a create() rejection.
 *   - getStaleCrons is the dead-man's-switch: verify fresh vs overdue, the
 *     interval*grace threshold, and the cold-start rule (never-seen = not stale).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  opsEvent: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockLoggerWarn = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  countApiErrorsByLevel,
  countOpsEvents,
  getLatestHeartbeat,
  getStaleCrons,
  OPS_EVENT_TYPES,
  recordApiError,
  recordCronHeartbeat,
  recordOpsEvent,
  recordWebhookFailure,
  type CronExpectation,
} from "../../app/models/ops-event.server";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// recordOpsEvent
// ---------------------------------------------------------------------------

describe("recordOpsEvent", () => {
  it("inserts a row with the provided fields", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordOpsEvent({
      eventType: "function_failure",
      key: "scan-theme",
      message: "boom",
      metadata: { runId: "r1" },
    });

    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: "function_failure",
        key: "scan-theme",
        message: "boom",
        metadata: { runId: "r1" },
      },
    });
  });

  it("defaults key and message to null when omitted", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordOpsEvent({ eventType: "worker_fallback" });

    const data = mockDb.opsEvent.create.mock.calls[0][0].data;
    expect(data.key).toBeNull();
    expect(data.message).toBeNull();
    expect(data.metadata).toBeUndefined();
  });

  it("NEVER throws — swallows a create() rejection and logs a warn", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordOpsEvent({ eventType: "function_failure", key: "x" }),
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "ops-event-record-failed",
      expect.objectContaining({ eventType: "function_failure", key: "x", error: "db down" }),
    );
  });

  it("coerces a non-Error thrown value to a string in the warn context", async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    mockDb.opsEvent.create.mockRejectedValue("string-error");

    await recordOpsEvent({ eventType: "function_failure" });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "ops-event-record-failed",
      expect.objectContaining({ error: "string-error" }),
    );
  });
});

// ---------------------------------------------------------------------------
// recordCronHeartbeat
// ---------------------------------------------------------------------------

describe("recordCronHeartbeat", () => {
  it("writes a cron_heartbeat event keyed to the function id", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordCronHeartbeat("watch-stale-scans");

    const data = mockDb.opsEvent.create.mock.calls[0][0].data;
    expect(data.eventType).toBe(OPS_EVENT_TYPES.CRON_HEARTBEAT);
    expect(data.key).toBe("watch-stale-scans");
  });

  it("never throws even if the underlying insert fails", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(recordCronHeartbeat("weekly-scan")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getLatestHeartbeat
// ---------------------------------------------------------------------------

describe("getLatestHeartbeat", () => {
  it("queries the newest cron_heartbeat for the key", async () => {
    const row = {
      id: "e1",
      eventType: "cron_heartbeat",
      key: "weekly-scan",
      createdAt: new Date(),
    };
    mockDb.opsEvent.findFirst.mockResolvedValue(row);

    const result = await getLatestHeartbeat("weekly-scan");

    expect(mockDb.opsEvent.findFirst).toHaveBeenCalledWith({
      where: { eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT, key: "weekly-scan" },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toBe(row);
  });

  it("returns null when the cron has never recorded a heartbeat", async () => {
    mockDb.opsEvent.findFirst.mockResolvedValue(null);

    expect(await getLatestHeartbeat("weekly-scan")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countOpsEvents
// ---------------------------------------------------------------------------

describe("countOpsEvents", () => {
  it("counts events of a type since a trailing window", async () => {
    mockDb.opsEvent.count.mockResolvedValue(4);
    const before = Date.now();

    const result = await countOpsEvents("function_failure", 24 * 60 * 60 * 1000);

    expect(result).toBe(4);
    const where = mockDb.opsEvent.count.mock.calls[0][0].where;
    expect(where.eventType).toBe("function_failure");
    const gte = where.createdAt.gte as Date;
    // Window start is ~24h before now.
    expect(before - gte.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
  });
});

// ---------------------------------------------------------------------------
// recordWebhookFailure
// ---------------------------------------------------------------------------

describe("recordWebhookFailure", () => {
  it("writes a webhook_failure event keyed to the topic with the error message and shop metadata", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordWebhookFailure({
      topic: "APP_UNINSTALLED",
      shop: "acme.myshopify.com",
      error: new Error("boom"),
    });

    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: OPS_EVENT_TYPES.WEBHOOK_FAILURE,
        key: "APP_UNINSTALLED",
        message: "boom",
        metadata: { shop: "acme.myshopify.com" },
      },
    });
  });

  it("coerces a non-Error thrown value to a string message", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordWebhookFailure({ topic: "SHOP_REDACT", shop: "acme.myshopify.com", error: "nope" });

    const data = mockDb.opsEvent.create.mock.calls[0][0].data;
    expect(data.message).toBe("nope");
  });

  it("never throws even if the underlying insert fails", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordWebhookFailure({
        topic: "SHOP_REDACT",
        shop: "acme.myshopify.com",
        error: new Error("x"),
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordApiError
// ---------------------------------------------------------------------------

describe("recordApiError", () => {
  it("writes an api_error event with level in metadata and code as the key", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordApiError({
      level: "error",
      code: "graphql_error",
      message: "Access denied",
      metadata: { context: "[test]" },
    });

    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: OPS_EVENT_TYPES.API_ERROR,
        key: "graphql_error",
        message: "Access denied",
        metadata: { level: "error", context: "[test]" },
      },
    });
  });

  it("includes shopDomain in metadata only when provided", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordApiError({
      level: "warn",
      code: "rate_limit_proximity",
      shopDomain: "acme.myshopify.com",
      message: "low headroom",
      metadata: { available: 190, maximum: 1000 },
    });

    expect(mockDb.opsEvent.create.mock.calls[0][0].data.metadata).toEqual({
      level: "warn",
      shopDomain: "acme.myshopify.com",
      available: 190,
      maximum: 1000,
    });
  });

  it("omits shopDomain from metadata when not provided", async () => {
    mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });

    await recordApiError({ level: "error", code: "graphql_error", message: "boom" });

    const metadata = mockDb.opsEvent.create.mock.calls[0][0].data.metadata;
    expect(metadata).toEqual({ level: "error" });
    expect(metadata).not.toHaveProperty("shopDomain");
  });

  it("never throws even if the underlying insert fails", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordApiError({ level: "error", code: "graphql_error", message: "boom" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// countApiErrorsByLevel
// ---------------------------------------------------------------------------

describe("countApiErrorsByLevel", () => {
  it("queries API_ERROR rows in the trailing window selecting only metadata", async () => {
    mockDb.opsEvent.findMany.mockResolvedValue([]);
    const before = Date.now();

    await countApiErrorsByLevel(24 * 60 * 60 * 1000);

    const arg = mockDb.opsEvent.findMany.mock.calls[0][0];
    expect(arg.where.eventType).toBe(OPS_EVENT_TYPES.API_ERROR);
    expect(arg.select).toEqual({ metadata: true });
    const gte = arg.where.createdAt.gte as Date;
    expect(before - gte.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
  });

  it("tallies rows by metadata.level", async () => {
    mockDb.opsEvent.findMany.mockResolvedValue([
      { metadata: { level: "error" } },
      { metadata: { level: "warn" } },
      { metadata: { level: "warn" } },
      { metadata: { level: "error" } },
    ]);

    expect(await countApiErrorsByLevel(1000)).toEqual({ error: 2, warn: 2 });
  });

  it("treats any non-warn level (missing/null/unknown) as an error (fallback)", async () => {
    mockDb.opsEvent.findMany.mockResolvedValue([
      { metadata: { level: "warn" } },
      { metadata: {} }, // missing level -> error
      { metadata: null }, // null metadata -> error
      { metadata: { level: "bogus" } }, // unknown level -> error
    ]);

    expect(await countApiErrorsByLevel(1000)).toEqual({ error: 3, warn: 1 });
  });
});

// ---------------------------------------------------------------------------
// getStaleCrons (dead-man's-switch)
// ---------------------------------------------------------------------------

describe("getStaleCrons", () => {
  const NOW = 1_700_000_000_000;
  const EXPECTATIONS: CronExpectation[] = [
    { key: "watch-stale-scans", intervalMs: 10 * 60 * 1000 }, // 10m
    { key: "weekly-scan", intervalMs: 7 * 24 * 60 * 60 * 1000 }, // 7d
  ];

  function groupRow(key: string, createdAt: Date) {
    return { key, _max: { createdAt } };
  }

  it("returns [] without querying when expectations is empty", async () => {
    const result = await getStaleCrons([]);

    expect(result).toEqual([]);
    expect(mockDb.opsEvent.groupBy).not.toHaveBeenCalled();
  });

  it("queries the max heartbeat per key for the given keys only", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([]);

    await getStaleCrons(EXPECTATIONS, { now: NOW });

    expect(mockDb.opsEvent.groupBy).toHaveBeenCalledWith({
      by: ["key"],
      where: {
        eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT,
        key: { in: ["watch-stale-scans", "weekly-scan"] },
      },
      _max: { createdAt: true },
    });
  });

  it("does NOT flag a cron that has never recorded a heartbeat (cold-start safe)", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([]);

    const result = await getStaleCrons(EXPECTATIONS, { now: NOW });

    expect(result).toEqual([]);
  });

  it("does NOT flag a cron whose heartbeat is within interval * grace", async () => {
    // 15m old, interval 10m, default grace 2 -> threshold 20m. Fresh.
    mockDb.opsEvent.groupBy.mockResolvedValue([
      groupRow("watch-stale-scans", new Date(NOW - 15 * 60 * 1000)),
    ]);

    const result = await getStaleCrons(EXPECTATIONS, { now: NOW });

    expect(result).toEqual([]);
  });

  it("flags a cron whose heartbeat is older than interval * grace", async () => {
    // 25m old, threshold 20m -> overdue.
    const last = new Date(NOW - 25 * 60 * 1000);
    mockDb.opsEvent.groupBy.mockResolvedValue([groupRow("watch-stale-scans", last)]);

    const result = await getStaleCrons(EXPECTATIONS, { now: NOW });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: "watch-stale-scans",
      intervalMs: 10 * 60 * 1000,
      thresholdMs: 20 * 60 * 1000,
      ageMs: 25 * 60 * 1000,
      lastHeartbeatAt: last,
    });
  });

  it("honours a custom graceFactor", async () => {
    // 25m old, interval 10m. graceFactor 3 -> threshold 30m -> NOT overdue.
    mockDb.opsEvent.groupBy.mockResolvedValue([
      groupRow("watch-stale-scans", new Date(NOW - 25 * 60 * 1000)),
    ]);

    const result = await getStaleCrons(EXPECTATIONS, { now: NOW, graceFactor: 3 });

    expect(result).toEqual([]);
  });

  it("flags only the overdue cron when several are tracked", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([
      groupRow("watch-stale-scans", new Date(NOW - 60 * 60 * 1000)), // 1h old -> overdue
      groupRow("weekly-scan", new Date(NOW - 60 * 1000)), // 1m old -> fresh
    ]);

    const result = await getStaleCrons(EXPECTATIONS, { now: NOW });

    expect(result.map((c) => c.key)).toEqual(["watch-stale-scans"]);
  });
});
