/**
 * Tests for the check-scan-stale per-scan delayed stale check (gc-ngx6).
 *
 * Replaces the 10-minute watch-stale-scans cron. Triggered by scan/requested (the one
 * event every dispatch path emits), sleeps to the PENDING threshold, expires the
 * scan if still stale, and re-checks once after the IN_PROGRESS threshold.
 */

import { ScanStatus } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const createFunctionMock = vi.hoisted(() =>
  vi.fn((_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
    fn: handler,
  })),
);

vi.mock("../../app/models/scan.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/scan.server")>();
  return { ...actual, expireStaleScan: vi.fn() };
});

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../inngest/client", () => ({ inngest: { createFunction: createFunctionMock } }));

import { logger } from "../../app/lib/logger.server";
import { DEFAULT_STALE_SCAN_THRESHOLDS, expireStaleScan } from "../../app/models/scan.server";
import { checkScanStale } from "../../inngest/functions/check-scan-stale";
import { createMockInngestEvent, createMockInngestStep, getInngestHandler } from "../mocks/inngest";

const mockExpire = expireStaleScan as ReturnType<typeof vi.fn>;
const SCAN_ID = "scan-1";

// Captured at import time (before any beforeEach clears mocks).
const registration = createFunctionMock.mock.calls[0];

async function run() {
  const step = createMockInngestStep();
  const event = createMockInngestEvent("scan/requested", {
    shopId: "shop-1",
    themeId: "gid://shopify/Theme/1",
    scanId: SCAN_ID,
  });
  const result = await getInngestHandler(checkScanStale)({ event, step });
  return { result, step };
}

const done = (status: ScanStatus | null) => ({
  expired: false,
  status,
  startedAt: null,
  createdAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkScanStale — registration", () => {
  it("is triggered by scan/requested, the event every dispatch path emits", () => {
    expect(registration[0]).toMatchObject({ id: "check-scan-stale" });
    expect(registration[1]).toEqual({ event: "scan/requested" });
  });
});

describe("checkScanStale — PENDING path", () => {
  it("sleeps the PENDING threshold, then expires the still-PENDING scan", async () => {
    mockExpire.mockResolvedValue({ ...done(ScanStatus.FAILED), expired: true });

    const { result, step } = await run();

    expect(step.sleep).toHaveBeenCalledWith(
      "wait-pending-threshold",
      `${DEFAULT_STALE_SCAN_THRESHOLDS.pendingMaxAgeMinutes}m`,
    );
    expect(mockExpire).toHaveBeenCalledOnce();
    expect(mockExpire).toHaveBeenCalledWith(SCAN_ID, DEFAULT_STALE_SCAN_THRESHOLDS);
    expect(step.sleepUntil).not.toHaveBeenCalled();
    expect(result).toEqual({ scanId: SCAN_ID, expired: true, checks: 1 });
  });
});

describe("checkScanStale — already finished", () => {
  it.each([ScanStatus.COMPLETED, ScanStatus.PARTIAL, ScanStatus.FAILED, null])(
    "is a no-op when the scan is %s",
    async (status) => {
      mockExpire.mockResolvedValue(done(status));

      const { result, step } = await run();

      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(result).toEqual({ scanId: SCAN_ID, expired: false, checks: 1 });
    },
  );
});

describe("checkScanStale — IN_PROGRESS path", () => {
  it("re-checks once at startedAt + IN_PROGRESS threshold and expires if still stale", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000);
    mockExpire
      .mockResolvedValueOnce({ ...done(ScanStatus.IN_PROGRESS), startedAt })
      .mockResolvedValueOnce({ ...done(ScanStatus.FAILED), expired: true });

    const { result, step } = await run();

    expect(mockExpire).toHaveBeenCalledTimes(2);
    expect(step.sleepUntil).toHaveBeenCalledOnce();
    const [id, wakeAt] = step.sleepUntil.mock.calls[0];
    expect(id).toBe("wait-in-progress-threshold");
    expect((wakeAt as Date).getTime()).toBe(
      startedAt.getTime() + DEFAULT_STALE_SCAN_THRESHOLDS.inProgressMaxAgeMinutes * 60_000 + 1000,
    );
    expect(result).toEqual({ scanId: SCAN_ID, expired: true, checks: 2 });
  });

  it("never schedules a third check even if the scan is still IN_PROGRESS", async () => {
    mockExpire.mockResolvedValue({ ...done(ScanStatus.IN_PROGRESS), startedAt: new Date() });

    const { result, step } = await run();

    expect(mockExpire).toHaveBeenCalledTimes(2);
    expect(step.sleepUntil).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ expired: false, checks: 2 });
  });
});

describe("checkScanStale — never throws", () => {
  it("logs and returns when the DB check fails", async () => {
    mockExpire.mockRejectedValue(new Error("db down"));

    const { result } = await run();

    expect(result).toEqual({ scanId: SCAN_ID, expired: false, checks: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("check failed"),
      expect.objectContaining({ scanId: SCAN_ID, error: "db down" }),
    );
  });
});
