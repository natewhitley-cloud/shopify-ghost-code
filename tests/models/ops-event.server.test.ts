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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    deleteMany: vi.fn(),
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
  getNeverSeenCrons,
  NUDGE_FUNNEL_EVENT_TYPES,
  NUDGE_RETENTION_DAYS,
  OPS_EVENT_TYPES,
  PAGE_VISIT_DEDUPE_WINDOW_MS,
  pruneOpsEvents,
  recordApiError,
  recordCronHeartbeat,
  recordOpsEvent,
  recordPageVisit,
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

// ---------------------------------------------------------------------------
// recordPageVisit (gc-0lo): one visit per shop + path per 10-minute window
// ---------------------------------------------------------------------------

describe("recordPageVisit", () => {
  type Row = { eventType: string; key: string | null; metadata: unknown; createdAt: Date };
  type Where = {
    key: string;
    eventType: string;
    createdAt: { gte: Date };
    metadata: { path: string[]; equals: string };
  };
  let rows: Row[];
  const T0 = new Date("2026-09-26T05:00:42Z");

  // Stateful fake OpsEvent table that evaluates the exact where-shape the real
  // query sends (asserted below), so the window/key/path semantics are real.
  beforeEach(() => {
    rows = [];
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mockDb.opsEvent.create.mockImplementation(
      async ({ data }: { data: Omit<Row, "createdAt"> }) => {
        rows.push({ ...data, createdAt: new Date() });
        return data;
      },
    );
    mockDb.opsEvent.findFirst.mockImplementation(async ({ where }: { where: Where }) => {
      const [field] = where.metadata.path;
      return (
        rows.find(
          (r) =>
            r.key === where.key &&
            r.eventType === where.eventType &&
            r.createdAt >= where.createdAt.gte &&
            (r.metadata as Record<string, unknown> | null)?.[field] === where.metadata.equals,
        ) ?? null
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SHOP = "ortho-india.myshopify.com";
  const SCAN_PATH = "/app/scans/scan-1";
  const visits = () => rows.filter((r) => r.eventType === OPS_EVENT_TYPES.PAGE_VISIT);

  it("queries by domain + page_visit + 10-minute lower bound + exact metadata.path", async () => {
    await recordPageVisit(SHOP, SCAN_PATH);

    expect(mockDb.opsEvent.findFirst).toHaveBeenCalledWith({
      where: {
        key: SHOP,
        eventType: "page_visit",
        createdAt: { gte: new Date(T0.getTime() - 10 * 60 * 1000) },
        metadata: { path: ["path"], equals: SCAN_PATH },
      },
      select: { id: true },
    });
    expect(PAGE_VISIT_DEDUPE_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: { eventType: "page_visit", key: SHOP, message: null, metadata: { path: SCAN_PATH } },
    });
  });

  it("25 polls over 75s of a running scan produce exactly 1 visit", async () => {
    for (let i = 0; i < 25; i++) {
      await recordPageVisit(SHOP, SCAN_PATH);
      vi.advanceTimersByTime(3_000);
    }

    expect(visits()).toHaveLength(1);
  });

  it("the same path after 10+ minutes records a new visit", async () => {
    await recordPageVisit(SHOP, SCAN_PATH);
    vi.advanceTimersByTime(9 * 60 * 1000);
    await recordPageVisit(SHOP, SCAN_PATH);
    expect(visits()).toHaveLength(1);

    vi.advanceTimersByTime(PAGE_VISIT_DEDUPE_WINDOW_MS + 1);
    await recordPageVisit(SHOP, SCAN_PATH);

    expect(visits()).toHaveLength(2);
  });

  it("different paths within the window are separate visits (incl. different scan ids)", async () => {
    for (const path of ["/app", "/app/scans", "/app/ignored", SCAN_PATH, "/app/scans/scan-2"]) {
      await recordPageVisit(SHOP, path);
      vi.advanceTimersByTime(5_000);
    }
    await recordPageVisit(SHOP, "/app"); // revisit inside the window: deduped

    expect(visits().map((r) => (r.metadata as { path: string }).path)).toEqual([
      "/app",
      "/app/scans",
      "/app/ignored",
      SCAN_PATH,
      "/app/scans/scan-2",
    ]);
  });

  it("a different shop on the same path is NOT deduped", async () => {
    await recordPageVisit(SHOP, SCAN_PATH);
    await recordPageVisit("other.myshopify.com", SCAN_PATH);

    expect(visits().map((r) => r.key)).toEqual([SHOP, "other.myshopify.com"]);
  });

  it("a failed dedupe query never throws: logs and records the visit (fail-open)", async () => {
    mockDb.opsEvent.findFirst.mockRejectedValueOnce(new Error("statement timeout"));

    await expect(recordPageVisit(SHOP, SCAN_PATH)).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith("page-visit-dedupe-failed", {
      key: SHOP,
      path: SCAN_PATH,
      error: "statement timeout",
    });
    expect(visits()).toHaveLength(1);
  });

  it("never throws when both the dedupe query and the insert fail (DB down)", async () => {
    mockDb.opsEvent.findFirst.mockRejectedValueOnce(new Error("db down"));
    mockDb.opsEvent.create.mockRejectedValueOnce(new Error("db down"));

    await expect(recordPageVisit(SHOP, SCAN_PATH)).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "ops-event-record-failed",
      expect.objectContaining({ eventType: "page_visit", key: SHOP }),
    );
  });
});

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

// gc-288: a misregistered cron (id typo, failed Inngest sync) never heartbeats,
// so getStaleCrons (cold-start safe) can never flag it. getNeverSeenCrons feeds
// the NON-gating daily digest only; heartbeats are retained 30d and the slowest
// cron is weekly, so "none on record" means it has not run in 30d (or yet).
describe("getNeverSeenCrons", () => {
  const EXPECTATIONS: CronExpectation[] = [
    { key: "watch-stale-scans", intervalMs: 10 * 60 * 1000 },
    { key: "weekly-scan", intervalMs: 7 * 24 * 60 * 60 * 1000 },
  ];

  it("returns [] without querying when expectations is empty", async () => {
    expect(await getNeverSeenCrons([])).toEqual([]);
    expect(mockDb.opsEvent.groupBy).not.toHaveBeenCalled();
  });

  it("returns the keys with no heartbeat on record, in expectation order", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([
      { key: "watch-stale-scans", _max: { createdAt: new Date() } },
    ]);

    expect(await getNeverSeenCrons(EXPECTATIONS)).toEqual(["weekly-scan"]);
  });

  it("returns [] when every cron has a heartbeat, however old", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([
      { key: "watch-stale-scans", _max: { createdAt: new Date(0) } },
      { key: "weekly-scan", _max: { createdAt: new Date(0) } },
    ]);

    expect(await getNeverSeenCrons(EXPECTATIONS)).toEqual([]);
  });

  it("uses the same per-key max-heartbeat query as getStaleCrons", async () => {
    mockDb.opsEvent.groupBy.mockResolvedValue([]);

    await getNeverSeenCrons(EXPECTATIONS);

    expect(mockDb.opsEvent.groupBy).toHaveBeenCalledWith({
      by: ["key"],
      where: {
        eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT,
        key: { in: ["watch-stale-scans", "weekly-scan"] },
      },
      _max: { createdAt: true },
    });
  });
});

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

// ---------------------------------------------------------------------------
// pruneOpsEvents (retention)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

describe("pruneOpsEvents", () => {
  // The predicate is a two-branch OR, one branch per pruned event type. Helpers
  // pull each branch out by eventType so assertions don't depend on OR order.
  function branchFor(
    where: { OR: Array<{ eventType: string; createdAt: { lt: Date } }> },
    type: string,
  ) {
    return where.OR.find((clause) => clause.eventType === type);
  }

  beforeEach(() => {
    // Default: no heartbeat keys on record, so no newest-row exclusion is built.
    mockDb.opsEvent.groupBy.mockResolvedValue([]);
  });

  it("deletes cron_heartbeat (30d) and page_visit (14d) rows and returns the total count", async () => {
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 42 });
    const before = Date.now();

    const deleted = await pruneOpsEvents();

    expect(deleted).toBe(42);
    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;

    const heartbeat = branchFor(where, OPS_EVENT_TYPES.CRON_HEARTBEAT);
    expect(heartbeat).toBeDefined();
    const hbCutoff = heartbeat!.createdAt.lt;
    expect(before - hbCutoff.getTime()).toBeGreaterThanOrEqual(30 * DAY_MS - 1000);
    expect(before - hbCutoff.getTime()).toBeLessThanOrEqual(30 * DAY_MS + 1000);

    const pageVisit = branchFor(where, OPS_EVENT_TYPES.PAGE_VISIT);
    expect(pageVisit).toBeDefined();
    const pvCutoff = pageVisit!.createdAt.lt;
    expect(before - pvCutoff.getTime()).toBeGreaterThanOrEqual(14 * DAY_MS - 1000);
    expect(before - pvCutoff.getTime()).toBeLessThanOrEqual(14 * DAY_MS + 1000);
  });

  it("targets ONLY cron_heartbeat, page_visit and the nudge types — no other type can match (preserved at any age)", async () => {
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });

    await pruneOpsEvents();

    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
    // Every OR branch pins a single eventType, so function_failure (and every
    // other type) is excluded and can never match regardless of age.
    const types = where.OR.map((clause: { eventType: string }) => clause.eventType).sort();
    expect(types).toEqual([
      "cron_heartbeat",
      "nudge_clicked",
      "nudge_converted",
      "nudge_dismissed",
      "nudge_shown",
      "page_visit",
    ]);
    // Each branch is bounded only by eventType + createdAt — nothing widens it.
    for (const clause of where.OR) {
      expect(Object.keys(clause).sort()).toEqual(["createdAt", "eventType"]);
    }
  });

  it("honours custom retention windows for both types", async () => {
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 3 });
    const before = Date.now();

    await pruneOpsEvents({ heartbeatOlderThanDays: 90, pageVisitOlderThanDays: 7 });

    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
    const hbCutoff = branchFor(where, OPS_EVENT_TYPES.CRON_HEARTBEAT)!.createdAt.lt;
    expect(before - hbCutoff.getTime()).toBeGreaterThanOrEqual(90 * DAY_MS - 1000);
    expect(before - hbCutoff.getTime()).toBeLessThanOrEqual(90 * DAY_MS + 1000);

    const pvCutoff = branchFor(where, OPS_EVENT_TYPES.PAGE_VISIT)!.createdAt.lt;
    expect(before - pvCutoff.getTime()).toBeGreaterThanOrEqual(7 * DAY_MS - 1000);
    expect(before - pvCutoff.getTime()).toBeLessThanOrEqual(7 * DAY_MS + 1000);
  });

  // gc-q8g: heartbeats are written only on SUCCESS, so a cron failing every run
  // for 30d+ would have ALL its heartbeats pruned, drop out of getStaleCrons
  // (cold-start safe), and turn /health/deep + the dead-man's-switch GREEN. The
  // prune must always keep the newest heartbeat per key.
  describe("retains the newest heartbeat per key (dead-man's-switch evidence)", () => {
    type HeartbeatBranch = {
      eventType: string;
      createdAt: { lt: Date };
      NOT?: { OR: Array<{ key: string | null; createdAt: Date }> };
    };

    function heartbeatBranch(): HeartbeatBranch {
      const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
      return where.OR.find(
        (clause: HeartbeatBranch) => clause.eventType === OPS_EVENT_TYPES.CRON_HEARTBEAT,
      );
    }

    it("reads max(createdAt) per key over ALL heartbeats in one grouped query", async () => {
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });

      await pruneOpsEvents();

      expect(mockDb.opsEvent.groupBy).toHaveBeenCalledTimes(1);
      expect(mockDb.opsEvent.groupBy).toHaveBeenCalledWith({
        by: ["key"],
        where: { eventType: OPS_EVENT_TYPES.CRON_HEARTBEAT },
        _max: { createdAt: true },
      });
      expect(mockDb.opsEvent.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("keeps exactly the newest row of a key whose heartbeats are ALL older than the cutoff", async () => {
      const newest = new Date(Date.now() - 45 * DAY_MS);
      mockDb.opsEvent.groupBy.mockResolvedValue([
        { key: "reconcile-installs", _max: { createdAt: newest } },
      ]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 7 });

      await pruneOpsEvents();

      const branch = heartbeatBranch();
      expect(branch.createdAt.lt).toBeInstanceOf(Date);
      expect(branch.NOT).toEqual({
        OR: [{ key: "reconcile-installs", createdAt: newest }],
      });
    });

    it("builds no exclusion for a key whose newest heartbeat is recent (its old rows are all deletable)", async () => {
      mockDb.opsEvent.groupBy.mockResolvedValue([
        { key: "watch-stale-scans", _max: { createdAt: new Date(Date.now() - 60_000) } },
      ]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 4000 });

      const deleted = await pruneOpsEvents();

      expect(deleted).toBe(4000);
      expect(heartbeatBranch().NOT).toBeUndefined();
    });

    it("handles multiple keys in the same two queries, excluding only the fully-stale keys", async () => {
      const staleA = new Date(Date.now() - 31 * DAY_MS);
      const staleB = new Date(Date.now() - 400 * DAY_MS);
      mockDb.opsEvent.groupBy.mockResolvedValue([
        { key: "weekly-scan", _max: { createdAt: staleA } },
        { key: "watch-stale-scans", _max: { createdAt: new Date() } },
        { key: "operator-digest", _max: { createdAt: staleB } },
      ]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 12 });

      const deleted = await pruneOpsEvents();

      expect(deleted).toBe(12);
      expect(mockDb.opsEvent.groupBy).toHaveBeenCalledTimes(1);
      expect(mockDb.opsEvent.deleteMany).toHaveBeenCalledTimes(1);
      expect(heartbeatBranch().NOT!.OR).toEqual([
        { key: "weekly-scan", createdAt: staleA },
        { key: "operator-digest", createdAt: staleB },
      ]);
    });

    it("treats a null key as its own group and keeps its newest row too", async () => {
      const newest = new Date(Date.now() - 90 * DAY_MS);
      mockDb.opsEvent.groupBy.mockResolvedValue([{ key: null, _max: { createdAt: newest } }]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 1 });

      await pruneOpsEvents();

      expect(heartbeatBranch().NOT).toEqual({ OR: [{ key: null, createdAt: newest }] });
    });

    it("honours a custom heartbeat window when deciding which keys need protecting", async () => {
      const fortyDaysAgo = new Date(Date.now() - 40 * DAY_MS);
      mockDb.opsEvent.groupBy.mockResolvedValue([
        { key: "weekly-scan", _max: { createdAt: fortyDaysAgo } },
      ]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });

      // 90d window: a 40d-old newest row is inside retention, so no exclusion.
      await pruneOpsEvents({ heartbeatOlderThanDays: 90 });

      expect(heartbeatBranch().NOT).toBeUndefined();
    });

    it("never adds the exclusion to the page_visit branch (other types unaffected)", async () => {
      mockDb.opsEvent.groupBy.mockResolvedValue([
        { key: "reconcile-installs", _max: { createdAt: new Date(Date.now() - 45 * DAY_MS) } },
      ]);
      mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });

      await pruneOpsEvents();

      const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
      const types = where.OR.map((clause: { eventType: string }) => clause.eventType).sort();
      expect(types).toEqual([
        "cron_heartbeat",
        "nudge_clicked",
        "nudge_converted",
        "nudge_dismissed",
        "nudge_shown",
        "page_visit",
      ]);
      const pageVisit = branchFor(where, OPS_EVENT_TYPES.PAGE_VISIT)!;
      expect(Object.keys(pageVisit).sort()).toEqual(["createdAt", "eventType"]);
    });
  });
});

// ---------------------------------------------------------------------------
// pruneOpsEvents: nudge-funnel retention (gc-97k.1)
// ---------------------------------------------------------------------------

describe("pruneOpsEvents: nudge-funnel retention (90d)", () => {
  type Row = { id: string; eventType: string; key: string | null; createdAt: Date };
  type Branch = {
    eventType: string;
    createdAt: { lt: Date };
    NOT?: { OR: Array<{ key: string | null; createdAt: Date }> };
  };

  // Evaluate the deleteMany OR predicate against in-memory rows the way
  // Postgres would, so the test asserts which ROWS go, not just the query shape.
  function applyPrune(rows: Row[], where: { OR: Branch[] }): Row[] {
    return rows.filter((r) =>
      where.OR.some(
        (b) =>
          r.eventType === b.eventType &&
          r.createdAt < b.createdAt.lt &&
          !(b.NOT?.OR ?? []).some(
            (n) => n.key === r.key && n.createdAt.getTime() === r.createdAt.getTime(),
          ),
      ),
    );
  }

  function seedRows(now: number): Row[] {
    const ago = (days: number) => new Date(now - days * DAY_MS);
    const rows: Row[] = [];
    for (const t of NUDGE_FUNNEL_EVENT_TYPES) {
      rows.push(
        { id: `${t}-91d`, eventType: t, key: "a.myshopify.com", createdAt: ago(91) },
        { id: `${t}-90d+1m`, eventType: t, key: "a.myshopify.com", createdAt: ago(90.001) },
        { id: `${t}-89d`, eventType: t, key: "a.myshopify.com", createdAt: ago(89) },
        { id: `${t}-1d`, eventType: t, key: "b.myshopify.com", createdAt: ago(1) },
      );
    }
    rows.push(
      // page_visit keeps its own 14d window, unaffected by the nudge window.
      { id: "pv-20d", eventType: "page_visit", key: "a.myshopify.com", createdAt: ago(20) },
      { id: "pv-10d", eventType: "page_visit", key: "a.myshopify.com", createdAt: ago(10) },
      // Types never pruned, at any age, including past the nudge window.
      { id: "ff-400d", eventType: "function_failure", key: "x", createdAt: ago(400) },
      { id: "ss-200d", eventType: "scan_signal", key: "scan-1", createdAt: ago(200) },
      { id: "api-100d", eventType: "api_error", key: "THROTTLED", createdAt: ago(100) },
      { id: "un-120d", eventType: "shop_uninstalled", key: "a.myshopify.com", createdAt: ago(120) },
      { id: "ds-100d", eventType: "digest_snapshot", key: "operator-digest", createdAt: ago(100) },
    );
    return rows;
  }

  beforeEach(() => {
    mockDb.opsEvent.groupBy.mockResolvedValue([]);
  });

  it("deletes nudge rows older than 90d, keeps newer ones, and leaves other types' retention alone", async () => {
    const now = Date.now();
    const rows = seedRows(now);
    let deletedIds: string[] = [];
    mockDb.opsEvent.deleteMany.mockImplementation(
      async ({ where }: { where: { OR: Branch[] } }) => {
        const gone = applyPrune(rows, where);
        deletedIds = gone.map((r) => r.id).sort();
        return { count: gone.length };
      },
    );

    const count = await pruneOpsEvents();

    const expected = [
      ...NUDGE_FUNNEL_EVENT_TYPES.flatMap((t) => [`${t}-91d`, `${t}-90d+1m`]),
      "pv-20d",
    ].sort();
    expect(deletedIds).toEqual(expected);
    expect(count).toBe(expected.length);
    // Explicitly: every 89d and 1d nudge row survives, and so does every
    // non-pruned type regardless of age.
    for (const t of NUDGE_FUNNEL_EVENT_TYPES) {
      expect(deletedIds).not.toContain(`${t}-89d`);
      expect(deletedIds).not.toContain(`${t}-1d`);
    }
    for (const id of ["pv-10d", "ff-400d", "ss-200d", "api-100d", "un-120d", "ds-100d"]) {
      expect(deletedIds).not.toContain(id);
    }
  });

  it("gives each nudge type its own single-eventType branch with a 90d cutoff and no NOT", async () => {
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });
    const before = Date.now();

    await pruneOpsEvents();

    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where as { OR: Branch[] };
    for (const t of NUDGE_FUNNEL_EVENT_TYPES) {
      const branches = where.OR.filter((b) => b.eventType === t);
      expect(branches).toHaveLength(1);
      expect(Object.keys(branches[0]).sort()).toEqual(["createdAt", "eventType"]);
      const cutoff = branches[0].createdAt.lt.getTime();
      expect(before - cutoff).toBeGreaterThanOrEqual(90 * DAY_MS - 1000);
      expect(before - cutoff).toBeLessThanOrEqual(90 * DAY_MS + 1000);
    }
  });

  it("honours a custom nudge window without moving the heartbeat or page_visit cutoffs", async () => {
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });
    const before = Date.now();

    await pruneOpsEvents({ nudgeOlderThanDays: 30 });

    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where as { OR: Branch[] };
    const cutoffAgo = (type: string) =>
      before - where.OR.find((b) => b.eventType === type)!.createdAt.lt.getTime();
    for (const t of NUDGE_FUNNEL_EVENT_TYPES) {
      expect(cutoffAgo(t)).toBeGreaterThanOrEqual(30 * DAY_MS - 1000);
      expect(cutoffAgo(t)).toBeLessThanOrEqual(30 * DAY_MS + 1000);
    }
    expect(Math.round(cutoffAgo(OPS_EVENT_TYPES.CRON_HEARTBEAT) / DAY_MS)).toBe(30);
    expect(Math.round(cutoffAgo(OPS_EVENT_TYPES.PAGE_VISIT) / DAY_MS)).toBe(14);
  });

  it("defaults to NUDGE_RETENTION_DAYS", () => {
    expect(NUDGE_RETENTION_DAYS).toBe(90);
  });
});
