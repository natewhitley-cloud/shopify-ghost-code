/**
 * Tests for app/routes/webhooks.tsx (GDPR catch-all webhook)
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control which topic arrives.
 *   - Mock deleteShopData to verify it is called only for SHOP_REDACT.
 *   - Verify all GDPR topics return 200.
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  apiVersion: "2026-07",
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
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
import { deleteShopData } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks";
import { authenticate } from "../../app/shopify.server";
import { signedWebhookRequest, stubWebhookEnv } from "../test-utils/signed-webhook";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockDeleteShopData = deleteShopData as ReturnType<typeof vi.fn>;
const mockRecordWebhookFailure = recordWebhookFailure as ReturnType<typeof vi.fn>;

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

  it("SHOP_REDACT records a webhook failure and re-throws when deleteShopData rejects", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "SHOP_REDACT",
    });
    const dbError = new Error("transient DB failure during shop/redact");
    mockDeleteShopData.mockRejectedValue(dbError);

    await expect(action(makeActionArgs())).rejects.toThrow(
      "transient DB failure during shop/redact",
    );

    // The failure is recorded (durably countable for the digest) before the
    // error is re-thrown so Shopify sees a 5xx and retries.
    expect(mockRecordWebhookFailure).toHaveBeenCalledWith({
      topic: "SHOP_REDACT",
      shop: "test-shop.myshopify.com",
      error: dbError,
    });
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

// ---------------------------------------------------------------------------
// gc-4hk: offline-session refresh failure after a valid HMAC
// ---------------------------------------------------------------------------

describe("webhooks (GDPR catch-all) action — dead refresh token (gc-4hk)", () => {
  const SHOP = "dead-token.myshopify.com";

  beforeEach(() => {
    stubWebhookEnv();
    mockAuthenticateWebhook.mockImplementation(async (request: Request) => {
      await request.text();
      throw new Error("refresh token expired");
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shop/redact returns 200 and the redact actually runs", async () => {
    mockDeleteShopData.mockResolvedValue({ id: "shop-1" });

    const result = await action({
      request: signedWebhookRequest({
        topic: "shop/redact",
        shop: SHOP,
        payload: { shop_id: 1, shop_domain: SHOP },
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs);

    expect((result as Response).status).toBe(200);
    expect(mockDeleteShopData).toHaveBeenCalledWith(SHOP);
  });

  it.each(["customers/redact", "customers/data_request"])(
    "%s returns 200 without touching shop data",
    async (topic) => {
      const result = await action({
        request: signedWebhookRequest({ topic, shop: SHOP, payload: { shop_domain: SHOP } }),
        params: {},
        context: {},
      } as ActionFunctionArgs);

      expect((result as Response).status).toBe(200);
      expect(mockDeleteShopData).not.toHaveBeenCalled();
      expect(mockRecordWebhookFailure).toHaveBeenCalledWith(
        expect.objectContaining({ shop: SHOP, degradedReason: "offline_session_failed" }),
      );
    },
  );

  it("a forged shop/redact is rejected 401 and deletes nothing", async () => {
    await expect(
      action({
        request: signedWebhookRequest({
          topic: "shop/redact",
          shop: SHOP,
          secret: "attacker-secret",
        }),
        params: {},
        context: {},
      } as ActionFunctionArgs),
    ).rejects.toMatchObject({ status: 401 });

    expect(mockDeleteShopData).not.toHaveBeenCalled();
  });
});
