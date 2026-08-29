/**
 * Tests for app/routes/webhooks.app.uninstalled.tsx
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control the webhook context.
 *   - Mock markShopUninstalled + recordOpsEvent to verify the deferred-delete flow.
 *   - Verify the handler records a SHOP_UNINSTALLED OpsEvent, revokes access via
 *     markShopUninstalled (NOT a hard delete), and is idempotent (returns 200 even
 *     when the shop does not exist).
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
  markShopUninstalled: vi.fn(),
  deleteShopData: vi.fn(),
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordOpsEvent: vi.fn(),
  OPS_EVENT_TYPES: {
    CRON_HEARTBEAT: "cron_heartbeat",
    FUNCTION_FAILURE: "function_failure",
    WORKER_FALLBACK: "worker_fallback",
    SHOP_UNINSTALLED: "shop_uninstalled",
  },
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OPS_EVENT_TYPES, recordOpsEvent } from "../../app/models/ops-event.server";
import { deleteShopData, markShopUninstalled } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.app.uninstalled";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockMarkShopUninstalled = markShopUninstalled as ReturnType<typeof vi.fn>;
const mockDeleteShopData = deleteShopData as ReturnType<typeof vi.fn>;
const mockRecordOpsEvent = recordOpsEvent as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActionArgs(): ActionFunctionArgs {
  return {
    request: new Request("https://test-shop.myshopify.com/webhooks/app/uninstalled", {
      method: "POST",
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateWebhook.mockResolvedValue({
    shop: "test-shop.myshopify.com",
    topic: "APP_UNINSTALLED",
  });
  mockRecordOpsEvent.mockResolvedValue(undefined);
  mockMarkShopUninstalled.mockResolvedValue({ found: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhooks.app.uninstalled action", () => {
  it("records a SHOP_UNINSTALLED OpsEvent keyed on the shop domain", async () => {
    await action(makeActionArgs());

    expect(mockRecordOpsEvent).toHaveBeenCalledWith({
      eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED,
      key: "test-shop.myshopify.com",
      message: "app/uninstalled",
    });
  });

  it("calls markShopUninstalled with the correct shop domain", async () => {
    await action(makeActionArgs());

    expect(mockMarkShopUninstalled).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("does NOT hard-delete the shop (deleteShopData stays deferred to shop/redact)", async () => {
    await action(makeActionArgs());

    expect(mockDeleteShopData).not.toHaveBeenCalled();
  });

  it("returns 200 on success", async () => {
    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });

  it("returns 200 even when the shop does not exist (idempotent)", async () => {
    mockMarkShopUninstalled.mockResolvedValue({ found: false });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockMarkShopUninstalled).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("propagates the rejection when markShopUninstalled fails, relying on Shopify retry", async () => {
    // Deliberate contract: the handler does NOT wrap markShopUninstalled in
    // try/catch. When it fails, the rejection propagates out of the action (the
    // returned promise rejects, surfacing as a 5xx) so Shopify retries the
    // uninstall webhook rather than us silently dropping the state change.
    const dbError = new Error("transient DB failure during app/uninstalled");
    mockMarkShopUninstalled.mockRejectedValueOnce(dbError);

    await expect(action(makeActionArgs())).rejects.toThrow(
      "transient DB failure during app/uninstalled",
    );

    expect(mockMarkShopUninstalled).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("propagates the thrown Response on invalid HMAC and never touches the DB", async () => {
    // Shopify's authenticate.webhook throws a Response (not a plain Error) when
    // HMAC verification fails. That Response must propagate unchanged, and neither
    // the OpsEvent nor the state change must run — we never act on a request we
    // could not authenticate. Use mockRejectedValueOnce so the rejection is scoped
    // to this invocation only.
    const unauthorized = new Response("Unauthorized", { status: 401 });
    mockAuthenticateWebhook.mockRejectedValueOnce(unauthorized);

    await expect(action(makeActionArgs())).rejects.toBe(unauthorized);

    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
    expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
  });
});
