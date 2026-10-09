/**
 * Tests for the poll-theme-changes Inngest function: since gc-iefo
 * (2026-10-09) a daily stale-scan sweep only. Scheduled scans moved to the
 * plan-cadence coordinators (tests/inngest/lib/plan-scan-coordinator.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const thresholds = vi.hoisted(() => ({ pendingMaxAgeMinutes: 15, inProgressMaxAgeMinutes: 30 }));

vi.mock("../../app/db.server", () => ({
  default: { shop: { findMany: vi.fn() } },
}));

vi.mock("../../app/models/scan.server", () => ({
  expireStaleScans: vi.fn(),
  // The sweep passes these shared thresholds to expireStaleScans (LOG-6).
  DEFAULT_STALE_SCAN_THRESHOLDS: thresholds,
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    createFunction: vi.fn(
      (config: unknown, trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        config,
        trigger,
        fn: handler,
      }),
    ),
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

import db from "../../app/db.server";
import { recordCronHeartbeat } from "../../app/models/ops-event.server";
import { expireStaleScans } from "../../app/models/scan.server";
import { inngest } from "../../inngest/client";
import {
  pollThemeChanges,
  POLL_THEME_CHANGES_CRON,
} from "../../inngest/functions/poll-theme-changes";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

const mockExpire = expireStaleScans as ReturnType<typeof vi.fn>;
const mockFindMany = (db as unknown as { shop: { findMany: ReturnType<typeof vi.fn> } }).shop
  .findMany;
const mockSend = (inngest as unknown as { send: ReturnType<typeof vi.fn> }).send;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function run() {
  const step = createMockInngestStep();
  const event = { name: "scheduled/daily", data: {}, ts: Date.now(), id: "e" };
  return { step, result: getInngestHandler(pollThemeChanges)({ event, step, logger: mockLogger }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExpire.mockResolvedValue(0);
});

describe("pollThemeChanges (daily stale-scan sweep)", () => {
  it("keeps its function id and daily 06:00 UTC cron", () => {
    const fn = pollThemeChanges as unknown as { config: { id: string }; trigger: { cron: string } };
    expect(fn.config.id).toBe("poll-theme-changes");
    expect(fn.trigger.cron).toBe(POLL_THEME_CHANGES_CRON);
    expect(POLL_THEME_CHANGES_CRON).toBe("0 6 * * *");
  });

  it("expires stale scans with the shared thresholds and reports the count", async () => {
    mockExpire.mockResolvedValue(2);
    const { result } = run();
    await expect(result).resolves.toEqual({ expired: 2 });
    expect(mockExpire).toHaveBeenCalledWith(thresholds);
    expect(mockLogger.warn).toHaveBeenCalledWith("[poll-theme-changes] expired 2 stale scan(s)");
  });

  it("no longer dispatches scheduled scans (gc-iefo)", async () => {
    const { step, result } = run();
    await result;
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(step.run.mock.calls.map((c) => c[0])).toEqual(["expire-stale-scans"]);
  });

  it("records its heartbeat after a successful run", async () => {
    await run().result;
    expect(recordCronHeartbeat).toHaveBeenCalledWith("poll-theme-changes");
  });

  it("propagates a sweep failure (no heartbeat, Inngest retries)", async () => {
    mockExpire.mockRejectedValue(new Error("db down"));
    await expect(run().result).rejects.toThrow("db down");
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
  });
});
