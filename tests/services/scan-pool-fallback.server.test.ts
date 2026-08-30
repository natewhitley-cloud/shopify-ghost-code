/**
 * Worker-failure path tests for scan-pool.server.ts (gc-06e.2).
 *
 * These tests mock Piscina so they do NOT require the built worker file.
 * They verify the hardened failure behavior: when the pool throws (worker
 * spawn failure, task timeout, etc.) the code:
 *   1. Retries the run ONCE in the pool (with a stricter timeout).
 *   2. If the retry succeeds, returns the worker result.
 *   3. If the retry also fails, escalates (logger.error, distinct
 *      "worker_failed" event) and THROWS — it never re-runs scanThemeFiles
 *      inline on the main thread (which could stall the whole event loop).
 *
 * vi.mock() is hoisted to the module boundary, so Piscina is mocked for the
 * entire file.  The pool singleton is reset between tests via
 * vi.resetModules() + dynamic re-import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanResult, ThemeFile } from "../../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// Piscina mock — hoisted, applies to whole file. A class so `new Piscina()`
// is constructable and each instance exposes the shared run/destroy spies.
// ---------------------------------------------------------------------------

const mockRun = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("piscina", () => ({
  default: class {
    run = mockRun;
    destroy = mockDestroy;
  },
}));

// Mock logger to capture warn/error calls.
const mockWarn = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: mockWarn,
    error: mockError,
  },
}));

// Spy on the real scan-engine so we can assert the inline main-thread scan is
// NEVER invoked on the worker-failure path. scan-pool only imports types from
// this module at runtime, so this is a regression guard: if an inline fallback
// is ever re-introduced, scanThemeFiles would be called and this spy would trip.
const mockInlineScan = vi.hoisted(() => vi.fn());

vi.mock("../../app/services/scan-engine.server", () => ({
  scanThemeFiles: mockInlineScan,
}));

// Mock the ops-event model so the WORKER_FALLBACK digest write is observable
// without touching the database. OPS_EVENT_TYPES is re-exported unchanged.
// countOpsEvents/getLatestOpsEvent back the sustained-fallback escalation
// (gc-06e.13, sub-item 2); default to "no escalation" so the pre-existing
// worker-failure-path tests are unaffected.
const mockRecordOpsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCountOpsEvents = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockGetLatestOpsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../../app/models/ops-event.server", () => ({
  OPS_EVENT_TYPES: { WORKER_FALLBACK: "worker_fallback", FUNCTION_FAILURE: "function_failure" },
  recordOpsEvent: mockRecordOpsEvent,
  countOpsEvents: mockCountOpsEvents,
  getLatestOpsEvent: mockGetLatestOpsEvent,
}));

// Mock the ops-alert/failure notifier so escalation is observable without I/O.
const mockNotifyFunctionFailure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../app/lib/notifications.server", () => ({
  notifyFunctionFailure: mockNotifyFunctionFailure,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_FILES: ThemeFile[] = [
  {
    filename: "layout/theme.liquid",
    content: `
<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXX"></script>
{% render 'recharge-checkout-option' %}
`.trim(),
  },
];

const WORKER_RESULT: ScanResult = { findings: [], unknownScripts: [], skippedFiles: [] };

// ---------------------------------------------------------------------------
// Module isolation — reset module cache so the singleton pool is recreated
// per test (with the mocked Piscina).
// ---------------------------------------------------------------------------

let scanThemeFilesInPool: (files: ThemeFile[]) => Promise<ScanResult>;
let destroyPool: () => Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../../app/services/scan-pool.server");
  scanThemeFilesInPool = mod.scanThemeFilesInPool;
  destroyPool = mod.destroyPool;

  mockRun.mockReset();
  mockWarn.mockReset();
  mockError.mockReset();
  mockInlineScan.mockReset();
  mockRecordOpsEvent.mockReset();
  mockRecordOpsEvent.mockResolvedValue(undefined);
  mockCountOpsEvents.mockReset();
  mockCountOpsEvents.mockResolvedValue(0);
  mockGetLatestOpsEvent.mockReset();
  mockGetLatestOpsEvent.mockResolvedValue(null);
  mockNotifyFunctionFailure.mockReset();
  mockNotifyFunctionFailure.mockResolvedValue(undefined);
});

afterEach(async () => {
  await destroyPool();
});

// ---------------------------------------------------------------------------
// Worker-failure path
// ---------------------------------------------------------------------------

describe("scanThemeFilesInPool — worker-failure path", () => {
  it("retries once in the pool and returns the worker result when the retry succeeds", async () => {
    mockRun.mockRejectedValueOnce(new Error("transient worker spawn failure"));
    mockRun.mockResolvedValueOnce(WORKER_RESULT);

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockRun).toHaveBeenCalledTimes(2); // first attempt + one retry
    expect(mockWarn).toHaveBeenCalledOnce(); // retry warning only
    expect(mockError).not.toHaveBeenCalled();

    // The degraded-worker path records exactly one WORKER_FALLBACK OpsEvent for
    // the digest's Section-B "worker fallbacks" count — not the terminal failure.
    expect(mockRecordOpsEvent).toHaveBeenCalledOnce();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "worker_fallback",
        key: "scan-pool",
        metadata: expect.objectContaining({ fileCount: TEST_FILES.length }),
      }),
    );
  });

  it("throws after the retry also fails — and never runs the scan inline on the main thread", async () => {
    mockRun.mockRejectedValue(new Error("worker thread dead"));

    await expect(scanThemeFilesInPool(TEST_FILES)).rejects.toThrow(
      /refusing inline main-thread fallback/,
    );

    // Exactly two pool attempts (initial + single retry), no inline execution.
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockInlineScan).not.toHaveBeenCalled();
  });

  it("escalates to logger.error with the distinct worker_failed event on total failure", async () => {
    mockRun.mockRejectedValue(new Error("simulated timeout"));

    await expect(scanThemeFilesInPool(TEST_FILES)).rejects.toThrow();

    // One retry warning, then one escalated error.
    expect(mockWarn).toHaveBeenCalledOnce();
    const [warnMessage, warnContext] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(warnMessage).toContain("retrying once");
    expect(warnContext).toMatchObject({ event: "worker_retry", fileCount: TEST_FILES.length });

    expect(mockError).toHaveBeenCalledOnce();
    const [errMessage, errContext] = mockError.mock.calls[0] as [string, Record<string, unknown>];
    expect(errMessage).toContain("no inline fallback");
    expect(errContext).toMatchObject({ event: "worker_failed", fileCount: TEST_FILES.length });
  });

  it("returns the worker result on the happy path without warning or retrying", async () => {
    mockRun.mockResolvedValueOnce(WORKER_RESULT);

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
    expect(mockInlineScan).not.toHaveBeenCalled();
    // No worker degradation on the happy path — no OpsEvent written.
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
    // No escalation probe on a clean run.
    expect(mockCountOpsEvents).not.toHaveBeenCalled();
    expect(mockNotifyFunctionFailure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sustained-fallback escalation (gc-06e.13, sub-item 2)
// ---------------------------------------------------------------------------

describe("scanThemeFilesInPool — sustained-fallback escalation", () => {
  // Drive one fallback (reject once, then succeed) so a single WORKER_FALLBACK is
  // recorded and exactly one escalation check runs; the trailing-window count is
  // controlled directly via mockCountOpsEvents.
  function primeSingleFallback() {
    mockRun.mockRejectedValueOnce(new Error("transient worker spawn failure"));
    mockRun.mockResolvedValueOnce(WORKER_RESULT);
  }

  it("escalates once (function_failure + ops-alert) at/over the threshold with no prior escalation", async () => {
    primeSingleFallback();
    mockCountOpsEvents.mockResolvedValue(3); // == threshold
    mockGetLatestOpsEvent.mockResolvedValue(null); // no prior escalation

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockCountOpsEvents).toHaveBeenCalledWith("worker_fallback", 30 * 60_000);
    expect(mockNotifyFunctionFailure).toHaveBeenCalledOnce();
    expect(mockNotifyFunctionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        functionId: "scan-pool",
        eventName: "worker-fallback-escalation",
        error: expect.stringContaining("persistently degraded"),
      }),
    );
  });

  it("does NOT escalate below the threshold", async () => {
    primeSingleFallback();
    mockCountOpsEvents.mockResolvedValue(2); // < threshold

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockNotifyFunctionFailure).not.toHaveBeenCalled();
    // Below threshold, we never consult the de-dupe row.
    expect(mockGetLatestOpsEvent).not.toHaveBeenCalled();
  });

  it("de-dupes: suppresses a repeat page when a recent escalation exists in the window", async () => {
    primeSingleFallback();
    mockCountOpsEvents.mockResolvedValue(5); // over threshold
    // Prior escalation 1 minute ago — inside the 30m window.
    mockGetLatestOpsEvent.mockResolvedValue({ createdAt: new Date(Date.now() - 60_000) });

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockNotifyFunctionFailure).not.toHaveBeenCalled();
  });

  it("re-escalates once the prior escalation has aged out of the window", async () => {
    primeSingleFallback();
    mockCountOpsEvents.mockResolvedValue(5);
    // Prior escalation 45 minutes ago — outside the 30m window.
    mockGetLatestOpsEvent.mockResolvedValue({ createdAt: new Date(Date.now() - 45 * 60_000) });

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockNotifyFunctionFailure).toHaveBeenCalledOnce();
  });

  it("is best-effort: a probe error is swallowed to a warn and the scan still returns", async () => {
    primeSingleFallback();
    mockCountOpsEvents.mockRejectedValue(new Error("db unavailable"));

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(WORKER_RESULT);
    expect(mockNotifyFunctionFailure).not.toHaveBeenCalled();
    // Two warns: the retry warning and the swallowed-escalation warning.
    const escalationWarn = mockWarn.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("escalation check failed"),
    );
    expect(escalationWarn).toBeDefined();
  });
});
