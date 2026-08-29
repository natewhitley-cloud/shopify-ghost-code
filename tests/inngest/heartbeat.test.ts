/**
 * Tests for inngest/lib/heartbeat.ts (withCronHeartbeat)
 *
 * The wrapper is applied to every cron function, so verifying it once covers the
 * heartbeat-write behaviour for all of them:
 *   - records a heartbeat keyed to the function id AFTER a successful run
 *   - records on early-return handlers (the common watch-stale-scans path)
 *   - does NOT record when the handler throws (a failed run is never counted)
 *   - passes the handler's result and context through unchanged
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecordCronHeartbeat = vi.fn();
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: (...args: unknown[]) => mockRecordCronHeartbeat(...args),
}));

import { withCronHeartbeat } from "../../inngest/lib/heartbeat";

beforeEach(() => {
  vi.clearAllMocks();
});

// The wrapper never inspects the context (it only threads it to the handler),
// so tests pass a minimal stand-in cast to the real context type.
type CronCtx = Parameters<Parameters<typeof withCronHeartbeat>[1]>[0];
const asCtx = (c: unknown = {}): CronCtx => c as CronCtx;

describe("withCronHeartbeat", () => {
  it("runs the handler and returns its result unchanged", async () => {
    const handler = vi.fn().mockResolvedValue({ done: true });
    const wrapped = withCronHeartbeat("snapshot-metrics", handler);

    const result = await wrapped(asCtx({ step: {} }));

    expect(result).toEqual({ done: true });
  });

  it("passes the context through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const wrapped = withCronHeartbeat("snapshot-metrics", handler);
    const ctx = { step: { run: vi.fn() }, event: { name: "scheduled/cron" } };

    await wrapped(asCtx(ctx));

    expect(handler).toHaveBeenCalledWith(ctx);
  });

  it("records a heartbeat keyed to the function id after a successful run", async () => {
    const wrapped = withCronHeartbeat("watch-stale-scans", vi.fn().mockResolvedValue("ok"));

    await wrapped(asCtx());

    expect(mockRecordCronHeartbeat).toHaveBeenCalledOnce();
    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("watch-stale-scans");
  });

  it("records a heartbeat even when the handler early-returns", async () => {
    // Mirrors watch-stale-scans returning immediately when nothing is stale.
    const wrapped = withCronHeartbeat("watch-stale-scans", async () => ({
      staleCount: 0,
      expiredCount: 0,
    }));

    const result = await wrapped(asCtx());

    expect(result).toEqual({ staleCount: 0, expiredCount: 0 });
    expect(mockRecordCronHeartbeat).toHaveBeenCalledOnce();
  });

  it("does NOT record a heartbeat when the handler throws, and re-throws the error", async () => {
    const wrapped = withCronHeartbeat("weekly-scan", async () => {
      throw new Error("handler failed");
    });

    await expect(wrapped(asCtx())).rejects.toThrow("handler failed");
    expect(mockRecordCronHeartbeat).not.toHaveBeenCalled();
  });

  it("records the heartbeat only after the handler resolves (ordering)", async () => {
    const order: string[] = [];
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
    });
    mockRecordCronHeartbeat.mockImplementation(async () => {
      order.push("heartbeat");
    });
    const wrapped = withCronHeartbeat("monitor-scan-failures", handler);

    await wrapped(asCtx());

    expect(order).toEqual(["handler", "heartbeat"]);
  });
});
