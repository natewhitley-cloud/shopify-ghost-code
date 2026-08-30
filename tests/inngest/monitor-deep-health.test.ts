/**
 * Tests for inngest/functions/monitor-deep-health.ts (gc-06e.13, sub-item 1)
 *
 * Strategy:
 *   - Mock the Inngest client (3-arg createFunction) so the module loads and the
 *     handler is captured via getInngestHandler.
 *   - Mock the shared deep-health checker and the failure notifier; the checker's
 *     own logic is covered in tests/services/deep-health.server.test.ts.
 *   - Verify the cron alerts (function_failure + ops-alert via
 *     notifyFunctionFailure) on a degraded/error result and stays quiet on ok,
 *     and that the heartbeat is recorded on every (non-throwing) run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

const mockPerformDeepHealthChecks = vi.hoisted(() => vi.fn());
vi.mock("../../app/services/deep-health.server", () => ({
  performDeepHealthChecks: mockPerformDeepHealthChecks,
}));

const mockNotifyFunctionFailure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../app/lib/notifications.server", () => ({
  notifyFunctionFailure: mockNotifyFunctionFailure,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { recordCronHeartbeat } from "../../app/models/ops-event.server";
import { monitorDeepHealth } from "../../inngest/functions/monitor-deep-health";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

const mockRecordCronHeartbeat = recordCronHeartbeat as ReturnType<typeof vi.fn>;

const OK_RESULT = {
  status: "ok" as const,
  checks: {
    db: { ok: true },
    inngest: { ok: true, envOk: true, overdueCrons: [] },
    sessions: { expiredOffline: 0 },
    scans: { stuckPending: 0 },
  },
};

const DEGRADED_RESULT = {
  status: "degraded" as const,
  checks: {
    db: { ok: true },
    inngest: { ok: false, envOk: true, overdueCrons: ["watch-stale-scans"] },
    sessions: { expiredOffline: 0 },
    scans: { stuckPending: 0 },
  },
};

async function runMonitor() {
  const step = createMockInngestStep();
  const event = { name: "scheduled/cron", data: {}, ts: Date.now(), id: "test-monitor" };
  const result = await getInngestHandler(monitorDeepHealth)({ event, step, runId: "run-xyz" });
  return { step, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPerformDeepHealthChecks.mockResolvedValue(OK_RESULT);
});

describe("monitorDeepHealth — healthy run", () => {
  it("does not alert when the deep-health result is ok", async () => {
    const { step, result } = await runMonitor();

    expect(result).toEqual(OK_RESULT);
    expect(mockNotifyFunctionFailure).not.toHaveBeenCalled();
    // Only the checks step ran — no alert step.
    expect(step.run).toHaveBeenCalledOnce();
    expect(step.run).toHaveBeenCalledWith("run-deep-health-checks", expect.any(Function));
  });

  it("records a cron heartbeat after a successful (ok) run", async () => {
    await runMonitor();

    expect(mockRecordCronHeartbeat).toHaveBeenCalledOnce();
    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("monitor-deep-health");
  });
});

describe("monitorDeepHealth — degraded/error run", () => {
  it("alerts (function_failure + ops-alert) when the result is degraded", async () => {
    mockPerformDeepHealthChecks.mockResolvedValue(DEGRADED_RESULT);

    const { step } = await runMonitor();

    expect(mockNotifyFunctionFailure).toHaveBeenCalledOnce();
    expect(mockNotifyFunctionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        functionId: "monitor-deep-health",
        eventName: "deep-health-check",
        runId: "run-xyz",
        error: expect.stringContaining("deep health degraded"),
      }),
    );
    // Two steps: checks + alert.
    expect(step.run).toHaveBeenCalledTimes(2);
    expect(step.run).toHaveBeenNthCalledWith(2, "alert-on-degraded", expect.any(Function));
  });

  it("alerts when the result is error (DB down)", async () => {
    mockPerformDeepHealthChecks.mockResolvedValue({
      status: "error",
      checks: {
        db: { ok: false },
        inngest: { ok: true, envOk: true, overdueCrons: [] },
        sessions: { expiredOffline: 0 },
        scans: { stuckPending: 0 },
      },
    });

    await runMonitor();

    expect(mockNotifyFunctionFailure).toHaveBeenCalledOnce();
    expect(mockNotifyFunctionFailure.mock.calls[0][0].error).toContain("deep health error");
  });

  it("still records a heartbeat on a degraded run (the monitor itself succeeded)", async () => {
    mockPerformDeepHealthChecks.mockResolvedValue(DEGRADED_RESULT);

    await runMonitor();

    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("monitor-deep-health");
  });
});
