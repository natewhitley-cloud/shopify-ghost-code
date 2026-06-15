/**
 * Tests for app/services/scan-dispatch.server.ts
 *
 * Covers:
 *   - Happy path: createScan succeeds, inngest.send succeeds → returns scan.
 *   - createScan throws: propagated to caller (no inngest.send attempt).
 *   - inngest.send fails: logged, swallowed, scan still returned (best-effort).
 *   - Quota forwarding: options.quota is threaded into createScan.
 *   - Correct event payload shape (shopId, themeId, scanId).
 *   - LOG-8 regression: the "double createScan on send-retry" bug that existed
 *     when create + send lived in a single Inngest step. In request-context the
 *     fix is structural (inngest.send errors never re-call createScan), but the
 *     test makes the invariant explicit so a future regression is caught.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/models/scan.server", () => ({
  createScan: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
  },
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { logger } from "../../app/lib/logger.server";
import { createScan } from "../../app/models/scan.server";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc-123";
const THEME_ID = "gid://shopify/Theme/987654321";
const THEME_NAME = "Dawn";
const SCAN_ID = "scan-dispatch-001";

const MOCK_SCAN = {
  id: SCAN_ID,
  shopId: SHOP_ID,
  themeId: THEME_ID,
  themeName: THEME_NAME,
  status: "PENDING",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateScan.mockResolvedValue(MOCK_SCAN);
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("dispatchScan — happy path", () => {
  it("returns the created scan", async () => {
    const result = await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(result.scan).toEqual(MOCK_SCAN);
  });

  it("calls createScan with the correct arguments", async () => {
    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(mockCreateScan).toHaveBeenCalledOnce();
    expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_ID, THEME_NAME, undefined);
  });

  it("forwards quota to createScan when provided", async () => {
    const quota = {
      periodStart: new Date("2026-06-01T00:00:00Z"),
      maxScans: 5,
      periodLabel: "month" as const,
      isFirstScan: false,
    };

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME, { quota });

    expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_ID, THEME_NAME, quota);
  });

  it("passes null quota when options is omitted", async () => {
    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    // createScan receives undefined (no quota) — the model treats undefined
    // the same as null (no quota enforcement).
    expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_ID, THEME_NAME, undefined);
  });

  it("sends a scan/requested event with the correct payload", async () => {
    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(mockInngestSend).toHaveBeenCalledOnce();
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "scan/requested",
      data: {
        shopId: SHOP_ID,
        themeId: THEME_ID,
        scanId: SCAN_ID,
      },
    });
  });

  it("sends inngest AFTER createScan (scan id available in payload)", async () => {
    const callOrder: string[] = [];
    mockCreateScan.mockImplementation(async () => {
      callOrder.push("createScan");
      return MOCK_SCAN;
    });
    mockInngestSend.mockImplementation(async () => {
      callOrder.push("inngest.send");
    });

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(callOrder).toEqual(["createScan", "inngest.send"]);
  });
});

// ---------------------------------------------------------------------------
// createScan failure — propagated
// ---------------------------------------------------------------------------

describe("dispatchScan — createScan throws", () => {
  it("propagates the createScan error to the caller", async () => {
    mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).rejects.toThrow(
      "A scan is already in progress for this shop.",
    );
  });

  it("does NOT call inngest.send when createScan throws", async () => {
    mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).rejects.toThrow();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("propagates quota-exceeded errors from createScan", async () => {
    mockCreateScan.mockRejectedValue(
      new Error("Scan limit reached: 1 of 1 scans used this month."),
    );

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).rejects.toThrow("Scan limit reached");

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inngest.send failure — swallowed (best-effort)
// ---------------------------------------------------------------------------

describe("dispatchScan — inngest.send fails (best-effort)", () => {
  it("does NOT throw when inngest.send rejects", async () => {
    mockInngestSend.mockRejectedValue(new Error("Inngest EVENT_KEY not configured"));

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).resolves.not.toThrow();
  });

  it("still returns the created scan when inngest.send fails", async () => {
    mockInngestSend.mockRejectedValue(new Error("transient send failure"));

    const result = await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(result.scan).toEqual(MOCK_SCAN);
  });

  it("logs an error when inngest.send fails", async () => {
    mockInngestSend.mockRejectedValue(new Error("Inngest unreachable"));

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(mockLoggerError).toHaveBeenCalledOnce();
    const [message, context] = mockLoggerError.mock.calls[0];
    expect(message).toContain("dispatch failed");
    expect(context.scanId).toBe(SCAN_ID);
    expect(context.shopId).toBe(SHOP_ID);
    expect(context.error).toContain("Inngest unreachable");
  });

  it("includes themeId in the error log context", async () => {
    mockInngestSend.mockRejectedValue(new Error("network error"));

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    const [, context] = mockLoggerError.mock.calls[0];
    expect(context.themeId).toBe(THEME_ID);
  });

  it("handles non-Error throws from inngest.send (string throw)", async () => {
    mockInngestSend.mockRejectedValue("string-shaped error");

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).resolves.not.toThrow();

    const [, context] = mockLoggerError.mock.calls[0];
    expect(context.error).toBe("string-shaped error");
  });

  it("does NOT log when inngest.send succeeds", async () => {
    mockInngestSend.mockResolvedValue(undefined);

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LOG-8 regression: a send failure must not trigger a second createScan call
// ---------------------------------------------------------------------------

describe("dispatchScan — LOG-8 regression (request-context)", () => {
  it("calls createScan exactly once even when inngest.send fails", async () => {
    // The old bug (LOG-8) occurred in poll-check-shop when create + send shared
    // a single Inngest step: a send failure triggered a step retry that re-ran
    // createScan, hitting "A scan is already in progress" against the PENDING
    // row it had just created — a poisoned retry loop.
    //
    // In request-context (routes/webhooks) there are no Inngest step retries,
    // so the structural risk is lower. But this test asserts the invariant:
    // a failed send NEVER causes a second createScan call at this call site.
    mockInngestSend.mockRejectedValue(new Error("Inngest unreachable"));

    await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);

    // createScan called exactly once regardless of send outcome.
    expect(mockCreateScan).toHaveBeenCalledTimes(1);
  });

  it("createScan is not retried when called a second time after a send failure", async () => {
    // Simulate a caller that calls dispatchScan twice (e.g., an accidental
    // double-submit in a webhook handler). The second call must hit the
    // "already in progress" guard from createScan — verifying that the first
    // PENDING scan is not orphaned by a retry of the send step.
    mockInngestSend.mockRejectedValueOnce(new Error("Inngest send failed"));

    // First call: creates scan, send fails (swallowed).
    const result = await dispatchScan(SHOP_ID, THEME_ID, THEME_NAME);
    expect(result.scan.id).toBe(SCAN_ID);

    // Second call: createScan would fail with "already in progress" because
    // the PENDING scan from call 1 still exists.
    mockCreateScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

    await expect(dispatchScan(SHOP_ID, THEME_ID, THEME_NAME)).rejects.toThrow(
      "A scan is already in progress for this shop.",
    );

    // Total createScan calls: 2 (one per dispatchScan call — not one per send attempt).
    expect(mockCreateScan).toHaveBeenCalledTimes(2);
  });
});
