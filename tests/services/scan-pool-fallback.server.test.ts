/**
 * Fallback path tests for scan-pool.server.ts (GC-8uw).
 *
 * These tests mock Piscina so they do NOT require the built worker file.
 * They verify that when the pool throws (worker spawn failure, task timeout,
 * etc.) the code:
 *   1. Falls back to the inline scanThemeFiles() call.
 *   2. Returns correct results (identical to the inline scan).
 *   3. Logs a warning with the distinct "worker_fallback" event field.
 *
 * vi.mock() is hoisted to the module boundary, so Piscina is mocked for
 * the entire file.  The pool singleton is reset between tests via
 * vi.resetModules() + dynamic re-import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeFile } from "../../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// Piscina mock — hoisted, applies to whole file
// ---------------------------------------------------------------------------

const mockRun = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("piscina", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      run: mockRun,
      destroy: mockDestroy,
    })),
  };
});

// Mock logger to capture warn calls
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  },
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

// ---------------------------------------------------------------------------
// Module isolation — reset module cache so the singleton pool is recreated
// per test group (with the mocked Piscina).
// ---------------------------------------------------------------------------

let scanThemeFilesInPool: (files: ThemeFile[]) => Promise<unknown>;
let destroyPool: () => Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  // Re-import after resetModules so the singleton starts fresh.
  const mod = await import("../../app/services/scan-pool.server");
  scanThemeFilesInPool = mod.scanThemeFilesInPool;
  destroyPool = mod.destroyPool;

  mockRun.mockReset();
  mockWarn.mockReset();
});

afterEach(async () => {
  await destroyPool();
});

// ---------------------------------------------------------------------------
// Fallback path
// ---------------------------------------------------------------------------

describe("scanThemeFilesInPool — fallback path", () => {
  it("falls back to inline scan when pool.run() rejects", async () => {
    mockRun.mockRejectedValue(new Error("worker spawn failed"));

    const { scanThemeFiles } = await import("../../app/services/scan-engine.server");
    const inlineResult = scanThemeFiles(TEST_FILES);

    const result = await scanThemeFilesInPool(TEST_FILES);

    expect(result).toEqual(inlineResult);
  });

  it("logs a warn with worker_fallback event when falling back", async () => {
    mockRun.mockRejectedValue(new Error("simulated timeout"));

    await scanThemeFilesInPool(TEST_FILES);

    expect(mockWarn).toHaveBeenCalledOnce();
    const [message, context] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("falling back to inline scan");
    expect(context).toMatchObject({ event: "worker_fallback", fileCount: TEST_FILES.length });
  });

  it("returns correct results even after fallback (no silent data loss)", async () => {
    mockRun.mockRejectedValue(new Error("worker thread dead"));

    const { scanThemeFiles } = await import("../../app/services/scan-engine.server");
    const expected = scanThemeFiles(TEST_FILES);

    const actual = await scanThemeFilesInPool(TEST_FILES);

    // Findings must include at least the known ghost script from TEST_FILES
    expect((actual as typeof expected).findings.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected);
  });
});
