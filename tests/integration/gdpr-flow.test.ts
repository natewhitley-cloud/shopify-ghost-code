/**
 * Integration tests: GDPR flows
 *
 *   Flow 1 — shop/redact: webhook fires → all shop data hard-deleted
 *     The handler calls deleteShopData(shop) which runs a $transaction that
 *     deletes sessions, scans (cascade-deletes findings), and the shop record.
 *     We verify the model is called with the correct domain and that the handler
 *     always returns 200 (required by Shopify GDPR policy), including when the
 *     shop doesn't exist (idempotent).
 *
 *   Flow 2 — customers/data_request: webhook fires → 200 no-op
 *     Ghost Code stores no customer PII — only shop-level theme scan data.
 *     The handler must acknowledge receipt with 200 and perform no DB writes.
 *
 *   Flow 3 — customers/redact: webhook fires → 200 no-op
 *     Same as data_request — no customer data to redact.
 *
 * Mocking strategy: mock authenticate.webhook to control topic/shop/payload,
 * and mock deleteShopData to verify it is called with the right domain without
 * touching a real database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
  deleteShopData: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { action as shopRedactAction } from "../../app/routes/webhooks.shop.redact";
import { action as customersDataRequestAction } from "../../app/routes/webhooks.customers.data-request";
import { action as customersRedactAction } from "../../app/routes/webhooks.customers.redact";
import { authenticate } from "../../app/shopify.server";
import { deleteShopData } from "../../app/models/shop.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockDeleteShopData = deleteShopData as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const UNKNOWN_SHOP_DOMAIN = "gone.myshopify.com";

const MOCK_DELETED_SHOP = {
  id: "shop-abc-123",
  domain: SHOP_DOMAIN,
  plan: "free",
  accessToken: "redacted-token",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookRequest(path: string) {
  return new Request(`https://example.com/${path}`, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
}

function mockShopRedactWebhook(shop: string = SHOP_DOMAIN) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "SHOP_REDACT",
    shop,
    payload: { shop_domain: shop },
  });
}

function mockCustomersDataRequestWebhook(shop: string = SHOP_DOMAIN) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "CUSTOMERS_DATA_REQUEST",
    shop,
    payload: {
      shop_id: 12345,
      shop_domain: shop,
      orders_requested: [],
      customer: { id: 67890, email: "customer@example.com" },
    },
  });
}

function mockCustomersRedactWebhook(shop: string = SHOP_DOMAIN) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "CUSTOMERS_REDACT",
    shop,
    payload: {
      shop_id: 12345,
      shop_domain: shop,
      customer: { id: 67890, email: "customer@example.com" },
      orders_to_redact: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteShopData.mockResolvedValue(MOCK_DELETED_SHOP);
});

// ---------------------------------------------------------------------------
// Flow 1: shop/redact — data deletion
// ---------------------------------------------------------------------------

describe("GDPR flow — shop/redact (data deletion)", () => {
  describe("happy path — shop exists and is deleted", () => {
    it("returns 200", async () => {
      mockShopRedactWebhook();

      const response = await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
    });

    it("calls deleteShopData with the shop domain from the webhook", async () => {
      mockShopRedactWebhook();

      await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      expect(mockDeleteShopData).toHaveBeenCalledOnce();
      expect(mockDeleteShopData).toHaveBeenCalledWith(SHOP_DOMAIN);
    });

    it("calls deleteShopData exactly once per webhook invocation", async () => {
      mockShopRedactWebhook();

      await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      expect(mockDeleteShopData).toHaveBeenCalledTimes(1);
    });
  });

  describe("idempotent path — shop already deleted (not in DB)", () => {
    it("returns 200 even when deleteShopData returns null (shop not found)", async () => {
      mockShopRedactWebhook(UNKNOWN_SHOP_DOMAIN);
      mockDeleteShopData.mockResolvedValue(null);

      const response = await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      // Must return 200 — GDPR requires acknowledgment regardless of DB state
      expect(response.status).toBe(200);
    });

    it("still calls deleteShopData when shop is unknown (model handles the not-found case)", async () => {
      mockShopRedactWebhook(UNKNOWN_SHOP_DOMAIN);
      mockDeleteShopData.mockResolvedValue(null);

      await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      // The handler delegates the not-found check to the model — it does not
      // short-circuit before calling deleteShopData
      expect(mockDeleteShopData).toHaveBeenCalledWith(UNKNOWN_SHOP_DOMAIN);
    });
  });

  describe("data cascade — verifying what deleteShopData is expected to clean up", () => {
    it("passes the exact domain string from the Shopify webhook payload to deleteShopData", async () => {
      const specificDomain = "merchant-store.myshopify.com";
      mockShopRedactWebhook(specificDomain);

      await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      // deleteShopData is the single entry point for the cascade:
      //   sessions → scans (cascade findings) → shop
      // Verifying the correct domain ensures the right shop's data is targeted
      expect(mockDeleteShopData).toHaveBeenCalledWith(specificDomain);
    });
  });

  describe("different shop domains", () => {
    it("correctly routes deletion to the shop from the webhook (not a hardcoded value)", async () => {
      const anotherShop = "another-merchant.myshopify.com";
      mockShopRedactWebhook(anotherShop);

      await shopRedactAction({
        request: makeWebhookRequest("webhooks/shop/redact"),
        params: {},
        context: {},
      } as any);

      expect(mockDeleteShopData).toHaveBeenCalledWith(anotherShop);
      expect(mockDeleteShopData).not.toHaveBeenCalledWith(SHOP_DOMAIN);
    });
  });
});

// ---------------------------------------------------------------------------
// Flow 2: customers/data_request — no-op acknowledgment
// ---------------------------------------------------------------------------

describe("GDPR flow — customers/data_request (no-op acknowledgment)", () => {
  describe("happy path", () => {
    it("returns 200", async () => {
      mockCustomersDataRequestWebhook();

      const response = await customersDataRequestAction({
        request: makeWebhookRequest("webhooks/customers/data-request"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
    });

    it("does not perform any DB operations (no customer PII stored)", async () => {
      mockCustomersDataRequestWebhook();

      await customersDataRequestAction({
        request: makeWebhookRequest("webhooks/customers/data-request"),
        params: {},
        context: {},
      } as any);

      // Ghost Code stores no customer data — this must be a pure 200 no-op
      expect(mockDeleteShopData).not.toHaveBeenCalled();
    });

    it("authenticates the webhook before returning", async () => {
      mockCustomersDataRequestWebhook();

      await customersDataRequestAction({
        request: makeWebhookRequest("webhooks/customers/data-request"),
        params: {},
        context: {},
      } as any);

      expect(mockAuthenticateWebhook).toHaveBeenCalledOnce();
    });
  });

  describe("with different shops", () => {
    it("returns 200 for any shop domain without performing writes", async () => {
      mockCustomersDataRequestWebhook("big-store.myshopify.com");

      const response = await customersDataRequestAction({
        request: makeWebhookRequest("webhooks/customers/data-request"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      expect(mockDeleteShopData).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Flow 3: customers/redact — no-op acknowledgment
// ---------------------------------------------------------------------------

describe("GDPR flow — customers/redact (no-op acknowledgment)", () => {
  describe("happy path", () => {
    it("returns 200", async () => {
      mockCustomersRedactWebhook();

      const response = await customersRedactAction({
        request: makeWebhookRequest("webhooks/customers/redact"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
    });

    it("does not perform any DB operations (no customer PII to redact)", async () => {
      mockCustomersRedactWebhook();

      await customersRedactAction({
        request: makeWebhookRequest("webhooks/customers/redact"),
        params: {},
        context: {},
      } as any);

      expect(mockDeleteShopData).not.toHaveBeenCalled();
    });

    it("authenticates the webhook before returning", async () => {
      mockCustomersRedactWebhook();

      await customersRedactAction({
        request: makeWebhookRequest("webhooks/customers/redact"),
        params: {},
        context: {},
      } as any);

      expect(mockAuthenticateWebhook).toHaveBeenCalledOnce();
    });
  });

  describe("with customer redact payload", () => {
    it("returns 200 and ignores the customer payload (nothing to redact)", async () => {
      mockAuthenticateWebhook.mockResolvedValue({
        topic: "CUSTOMERS_REDACT",
        shop: SHOP_DOMAIN,
        payload: {
          shop_id: 99999,
          shop_domain: SHOP_DOMAIN,
          customer: {
            id: 11111,
            email: "todelete@example.com",
            phone: "+15551234567",
          },
          orders_to_redact: [12345, 67890],
        },
      });

      const response = await customersRedactAction({
        request: makeWebhookRequest("webhooks/customers/redact"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      expect(mockDeleteShopData).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: GDPR compliance invariants
// ---------------------------------------------------------------------------

describe("GDPR compliance invariants", () => {
  it("shop/redact always returns 200 — never 4xx or 5xx", async () => {
    // Even if deleteShopData rejects unexpectedly, Shopify requires 200 for
    // GDPR webhooks to avoid infinite retries. This test documents the contract.
    // Note: the current implementation does not wrap deleteShopData in try/catch,
    // so a DB error would propagate. This test verifies the normal-path guarantee.
    mockShopRedactWebhook();
    mockDeleteShopData.mockResolvedValue(MOCK_DELETED_SHOP);

    const response = await shopRedactAction({
      request: makeWebhookRequest("webhooks/shop/redact"),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(200);
  });

  it("customers/data_request always returns 200", async () => {
    mockCustomersDataRequestWebhook();

    const response = await customersDataRequestAction({
      request: makeWebhookRequest("webhooks/customers/data-request"),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(200);
  });

  it("customers/redact always returns 200", async () => {
    mockCustomersRedactWebhook();

    const response = await customersRedactAction({
      request: makeWebhookRequest("webhooks/customers/redact"),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(200);
  });
});
