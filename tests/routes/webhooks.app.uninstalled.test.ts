/**
 * Tests for app/routes/webhooks.app.uninstalled.tsx
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control the webhook context.
 *   - Mock the shared markShopUninstalledWithEvent helper (gc-dyt) to verify the
 *     deferred-delete flow.
 *   - Verify the handler records + marks via the shared helper (source=webhook,
 *     NOT a hard delete), and is idempotent (returns 200 even when the shop does
 *     not exist).
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
  // The webhook now records + marks via the SHARED path (gc-dyt); the direct
  // recordOpsEvent + markShopUninstalled calls were folded into this helper.
  markShopUninstalledWithEvent: vi.fn(),
  deleteShopData: vi.fn(),
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordWebhookFailure: vi.fn(),
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

import { recordWebhookFailure } from "../../app/models/ops-event.server";
import { deleteShopData, markShopUninstalledWithEvent } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.app.uninstalled";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockMarkShopUninstalledWithEvent = markShopUninstalledWithEvent as ReturnType<typeof vi.fn>;
const mockDeleteShopData = deleteShopData as ReturnType<typeof vi.fn>;
const mockRecordWebhookFailure = recordWebhookFailure as ReturnType<typeof vi.fn>;

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
  mockMarkShopUninstalledWithEvent.mockResolvedValue({ found: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhooks.app.uninstalled action", () => {
  it("records + marks via the shared helper, keyed on the shop domain with source=webhook", async () => {
    await action(makeActionArgs());

    expect(mockMarkShopUninstalledWithEvent).toHaveBeenCalledWith("test-shop.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });
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
    mockMarkShopUninstalledWithEvent.mockResolvedValue({ found: false });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockMarkShopUninstalledWithEvent).toHaveBeenCalledWith("test-shop.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });
  });

  it("propagates the rejection when the shared mark helper fails, relying on Shopify retry", async () => {
    // Deliberate contract: the handler does NOT wrap the mark in try/catch to
    // swallow it. When it fails, the rejection propagates out of the action (the
    // returned promise rejects, surfacing as a 5xx) so Shopify retries the
    // uninstall webhook rather than us silently dropping the state change.
    const dbError = new Error("transient DB failure during app/uninstalled");
    mockMarkShopUninstalledWithEvent.mockRejectedValueOnce(dbError);

    await expect(action(makeActionArgs())).rejects.toThrow(
      "transient DB failure during app/uninstalled",
    );

    expect(mockMarkShopUninstalledWithEvent).toHaveBeenCalledWith("test-shop.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });
    // The failure is recorded durably before re-throwing (gc-6fb).
    expect(mockRecordWebhookFailure).toHaveBeenCalledWith({
      topic: "APP_UNINSTALLED",
      shop: "test-shop.myshopify.com",
      error: dbError,
    });
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

    expect(mockMarkShopUninstalledWithEvent).not.toHaveBeenCalled();
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });
});
