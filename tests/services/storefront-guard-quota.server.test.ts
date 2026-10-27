/**
 * Checkout guard Inngest quota tripwire (gc-1q1s.9): threshold parsing, the
 * step projection, and the at-most-once-a-day operator page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ops = vi.hoisted(() => ({
  getLatestOpsEvent: vi.fn(),
  recordOpsEvent: vi.fn(),
  OPS_EVENT_TYPES: { GUARD_QUOTA_ALERT: "guard_quota_alert" },
}));
const alert = vi.hoisted(() => ({ sendOpsAlert: vi.fn() }));
vi.mock("../../app/models/ops-event.server", () => ops);
vi.mock("../../app/services/ops-alert.server", () => alert);

import {
  alertGuardQuotaOnce,
  GUARD_MONTHLY_STEP_ALERT_DEFAULT,
  GUARD_QUOTA_ALERT_KEY,
  guardMonthlyStepAlert,
  guardRunSteps,
  projectGuardMonthlySteps,
} from "../../app/services/storefront-guard-quota.server";

const NOW = new Date("2026-10-27T05:17:00Z");
const input = { projected: 21_600, threshold: 20_000, runSteps: 30, due: 400, now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  ops.getLatestOpsEvent.mockResolvedValue(null);
  alert.sendOpsAlert.mockResolvedValue({ sent: true, reason: "sent" });
});

describe("guardMonthlyStepAlert", () => {
  it("defaults to 20k", () => {
    expect(GUARD_MONTHLY_STEP_ALERT_DEFAULT).toBe(20_000);
    expect(guardMonthlyStepAlert({})).toBe(20_000);
  });
  it("reads a positive integer from STOREFRONT_GUARD_MONTHLY_STEP_ALERT", () => {
    expect(guardMonthlyStepAlert({ STOREFRONT_GUARD_MONTHLY_STEP_ALERT: " 35000 " })).toBe(35_000);
  });
  it.each(["", "0", "-5", "1.5", "abc", "1e9", "99999999999999999999"])(
    "falls back to the default for %j",
    (raw) => {
      expect(guardMonthlyStepAlert({ STOREFRONT_GUARD_MONTHLY_STEP_ALERT: raw })).toBe(20_000);
    },
  );
});

describe("guardRunSteps / projectGuardMonthlySteps", () => {
  it("counts run + select + chunks + notify steps, over 720 hourly runs", () => {
    expect(guardRunSteps({ chunks: 0, notifySteps: 0 })).toBe(2);
    expect(guardRunSteps({ chunks: 20, notifySteps: 3 })).toBe(25);
    expect(projectGuardMonthlySteps(25)).toBe(18_000);
  });
});

describe("alertGuardQuotaOnce", () => {
  it("records a counts-only row on a constant key, then pages", async () => {
    expect(await alertGuardQuotaOnce(input)).toBe("alerted");
    expect(ops.recordOpsEvent).toHaveBeenCalledWith({
      eventType: "guard_quota_alert",
      key: GUARD_QUOTA_ALERT_KEY,
      metadata: { projected: 21_600, threshold: 20_000, runSteps: 30, due: 400 },
    });
    expect(GUARD_QUOTA_ALERT_KEY).toBe("storefront-guard");
    expect(alert.sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(alert.sendOpsAlert.mock.calls[0][1]).toContain("21600");
    // Row before send: a retried step never pages twice.
    expect(ops.recordOpsEvent.mock.invocationCallOrder[0]).toBeLessThan(
      alert.sendOpsAlert.mock.invocationCallOrder[0],
    );
  });

  it("pages at most once a day", async () => {
    ops.getLatestOpsEvent.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
    });
    expect(await alertGuardQuotaOnce(input)).toBe("already_alerted_today");
    expect(ops.recordOpsEvent).not.toHaveBeenCalled();
    expect(alert.sendOpsAlert).not.toHaveBeenCalled();

    ops.getLatestOpsEvent.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
    });
    expect(await alertGuardQuotaOnce(input)).toBe("alerted");
    expect(ops.getLatestOpsEvent).toHaveBeenCalledWith("guard_quota_alert", "storefront-guard");
  });
});
