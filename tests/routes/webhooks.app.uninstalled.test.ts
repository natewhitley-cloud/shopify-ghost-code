/**
 * Tests for app/routes/webhooks.app.uninstalled.tsx
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control the webhook context.
 *   - Mock deleteShopData to verify cleanup behavior.
 *   - Verify the handler is idempotent (returns 200 even when shop does not exist).
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
  deleteShopData: vi.fn(),
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

import { deleteShopData } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.app.uninstalled";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockDeleteShopData = deleteShopData as ReturnType<typeof vi.fn>;

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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhooks.app.uninstalled action", () => {
  it("calls deleteShopData with correct shop domain", async () => {
    mockDeleteShopData.mockResolvedValue({ id: "shop-1" });

    await action(makeActionArgs());

    expect(mockDeleteShopData).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("returns 200 on success", async () => {
    mockDeleteShopData.mockResolvedValue({ id: "shop-1" });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });

  it("returns 200 even when shop does not exist (idempotent)", async () => {
    mockDeleteShopData.mockResolvedValue(null);

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).toHaveBeenCalledWith("test-shop.myshopify.com");
  });
});
