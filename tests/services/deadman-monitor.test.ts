import { describe, it, expect, vi } from "vitest";

import type { StaleCron } from "../../app/models/ops-event.server";
import { buildStaleAlert, runDeadmanCheck } from "../../app/services/deadman-monitor";

/**
 * Tests for the external dead-man's-switch runner (gc-1we).
 *
 * All dependencies are injected — no test touches a real database or network.
 * buildStaleAlert is pure; runDeadmanCheck is driven with fake getStaleCrons /
 * sendOpsAlert / getOpsAlertConfigStatus / logger.
 */

function makeStaleCron(overrides: Partial<StaleCron> = {}): StaleCron {
  return {
    key: "watch-stale-scans",
    intervalMs: 10 * 60_000,
    thresholdMs: 20 * 60_000,
    ageMs: 90 * 60_000,
    lastHeartbeatAt: new Date("2026-09-11T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("buildStaleAlert", () => {
  it("returns null when no crons are stale", () => {
    expect(buildStaleAlert([])).toBeNull();
  });

  it("builds a subject and body naming the cron key and a readable age", () => {
    const alert = buildStaleAlert([makeStaleCron()]);

    expect(alert).not.toBeNull();
    expect(alert!.subject).toContain("1 cron(s) overdue");
    expect(alert!.body).toContain("watch-stale-scans");
    // 90 minutes renders as a readable "1h 30m", not raw milliseconds.
    expect(alert!.body).toContain("1h 30m");
    expect(alert!.body).toContain("2026-09-11T00:00:00.000Z");
  });
});

describe("runDeadmanCheck", () => {
  it("does not send an alert when no crons are stale", async () => {
    const send = vi.fn();
    const summary = await runDeadmanCheck({
      getStaleCrons: vi.fn().mockResolvedValue([]),
      sendOpsAlert: send,
      getOpsAlertConfigStatus: vi.fn().mockReturnValue({ configured: true, reason: "ok" }),
      logger: makeLogger(),
    });

    expect(send).not.toHaveBeenCalled();
    expect(summary).toEqual({ staleCount: 0, alertSent: false });
  });

  it("sends one alert mentioning the stale count when crons are overdue", async () => {
    const send = vi.fn().mockResolvedValue({ sent: true, reason: "sent" });
    const stale = [
      makeStaleCron({ key: "watch-stale-scans" }),
      makeStaleCron({ key: "operator-digest" }),
    ];

    const summary = await runDeadmanCheck({
      getStaleCrons: vi.fn().mockResolvedValue(stale),
      sendOpsAlert: send,
      getOpsAlertConfigStatus: vi.fn().mockReturnValue({ configured: true, reason: "ok" }),
      logger: makeLogger(),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("2 cron(s) overdue");
    expect(summary).toEqual({ staleCount: 2, alertSent: true });
  });

  it("still sends (log-only) and warns when the ops-alert channel is not configured", async () => {
    const send = vi.fn().mockResolvedValue({ sent: false, reason: "disabled" });
    const logger = makeLogger();

    const summary = await runDeadmanCheck({
      getStaleCrons: vi.fn().mockResolvedValue([makeStaleCron()]),
      sendOpsAlert: send,
      getOpsAlertConfigStatus: vi
        .fn()
        .mockReturnValue({ configured: false, reason: "no_recipient" }),
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ops-alert channel not configured"),
      expect.objectContaining({ reason: "no_recipient" }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ staleCount: 1, alertSent: false });
  });

  it("propagates a getStaleCrons rejection so main's catch/watchdog path fires", async () => {
    const send = vi.fn();
    await expect(
      runDeadmanCheck({
        getStaleCrons: vi.fn().mockRejectedValue(new Error("db unreachable")),
        sendOpsAlert: send,
        getOpsAlertConfigStatus: vi.fn().mockReturnValue({ configured: true, reason: "ok" }),
        logger: makeLogger(),
      }),
    ).rejects.toThrow("db unreachable");

    expect(send).not.toHaveBeenCalled();
  });
});
