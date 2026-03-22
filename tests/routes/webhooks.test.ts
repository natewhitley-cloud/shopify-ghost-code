/**
 * Tests for app/routes/webhooks.tsx (GDPR catch-all webhook)
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control which topic arrives.
 *   - Mock deleteShopData to verify it is called only for SHOP_REDACT.
 *   - Verify all GDPR topics return 200.
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
import { action } from "../../app/routes/webhooks";
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
    request: new Request("https://test-shop.myshopify.com/webhooks", {
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhooks (GDPR catch-all) action", () => {
  it("CUSTOMERS_DATA_REQUEST topic returns 200 and does not delete data", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "CUSTOMERS_DATA_REQUEST",
    });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT topic returns 200 and does not delete data", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "CUSTOMERS_REDACT",
    });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).not.toHaveBeenCalled();
  });

  it("SHOP_REDACT topic calls deleteShopData and returns 200", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "SHOP_REDACT",
    });
    mockDeleteShopData.mockResolvedValue({ id: "shop-1" });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("SHOP_REDACT returns 200 even when shop already deleted (idempotent)", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "SHOP_REDACT",
    });
    mockDeleteShopData.mockResolvedValue(null);

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });

  it("unknown topic returns 200", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "UNKNOWN_TOPIC",
    });

    const result = await action(makeActionArgs());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).not.toHaveBeenCalled();
  });
});
