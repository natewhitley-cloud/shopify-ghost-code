/**
 * Tests for app/lib/use-scan-polling.ts: the shared in-progress poll used by
 * the scan page and Home. GC has no jsdom, so the hook's effect cannot run
 * here; its decisions live in the pure isScanRunning and startScanPolling,
 * driven below with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOME_POLL_TIMEOUT_MESSAGE,
  isScanRunning,
  MAX_POLL_COUNT,
  SCAN_POLL_INTERVAL_MS,
  startScanPolling,
} from "../../app/lib/use-scan-polling";

describe("isScanRunning", () => {
  it.each(["PENDING", "IN_PROGRESS"])("polls while %s", (status) => {
    expect(isScanRunning(status)).toBe(true);
  });

  it.each(["COMPLETED", "PARTIAL", "FAILED"])("never polls a %s scan", (status) => {
    expect(isScanRunning(status)).toBe(false);
  });

  it("never polls when there is no scan", () => {
    expect(isScanRunning(null)).toBe(false);
    expect(isScanRunning(undefined)).toBe(false);
  });
});

describe("startScanPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(pollCount = { current: 0 }) {
    const revalidate = vi.fn();
    const onTimeout = vi.fn();
    const stop = startScanPolling({ pollCount, revalidate, onTimeout });
    return { revalidate, onTimeout, stop, pollCount };
  }

  it("revalidates every 3 seconds", () => {
    const { revalidate } = start();
    expect(SCAN_POLL_INTERVAL_MS).toBe(3_000);
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_999);
    expect(revalidate).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(revalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000 * 4);
    expect(revalidate).toHaveBeenCalledTimes(5);
  });

  it("stops when the cleanup runs (the scan reached a terminal state)", () => {
    const { revalidate, stop, onTimeout } = start();
    vi.advanceTimersByTime(3_000);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops at the ~10 minute cap and reports the timeout once", () => {
    expect(MAX_POLL_COUNT).toBe(200);
    const { revalidate, onTimeout } = start();
    vi.advanceTimersByTime(SCAN_POLL_INTERVAL_MS * MAX_POLL_COUNT);
    // The 200th tick times out instead of revalidating.
    expect(revalidate).toHaveBeenCalledTimes(MAX_POLL_COUNT - 1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SCAN_POLL_INTERVAL_MS * 50);
    expect(revalidate).toHaveBeenCalledTimes(MAX_POLL_COUNT - 1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps counting across restarts (shared counter), so a restart never extends the cap", () => {
    const pollCount = { current: MAX_POLL_COUNT - 2 };
    const { revalidate, onTimeout } = start(pollCount);
    vi.advanceTimersByTime(SCAN_POLL_INTERVAL_MS * 2);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("HOME_POLL_TIMEOUT_MESSAGE", () => {
  it("asks for a refresh without telling the merchant to come back", () => {
    expect(HOME_POLL_TIMEOUT_MESSAGE).toBe(
      "This scan is taking longer than usual. Refresh the page to check its status.",
    );
    expect(HOME_POLL_TIMEOUT_MESSAGE).not.toMatch(/come back|later|leave|e-?mail|[—–]/i);
  });
});
