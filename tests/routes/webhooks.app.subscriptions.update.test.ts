/**
 * Tests for the app/subscriptions_update webhook handler.
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control what shop/topic/payload the handler sees.
 *   - Mock updateShopPlanByDomain() to verify which plan string gets persisted.
 *   - Verify the handler ALWAYS returns 200, even for error paths.
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
  PLAN_STANDARD: "Standard",
  PLAN_PROFESSIONAL: "Professional",
}));

vi.mock("../../app/models/shop.server", () => ({
  updateShopPlanByDomain: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are established)
// ---------------------------------------------------------------------------

import { updateShopPlanByDomain } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.app.subscriptions.update";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest() {
  return new Request("https://example.com/webhooks/app/subscriptions/update", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
}

function mockWebhookAuth(shop: string, planName: string | undefined, status: string | undefined) {
  const payload =
    planName !== undefined || status !== undefined
      ? { app_subscription: { name: planName, status } }
      : {};

  (authenticate.webhook as ReturnType<typeof vi.fn>).mockResolvedValue({
    topic: "APP_SUBSCRIPTIONS_UPDATE",
    shop,
    payload,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhooks.app.subscriptions.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: shop exists and update succeeds.
    (updateShopPlanByDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "shop-1",
      domain: "test-shop.myshopify.com",
      plan: "Standard",
    });
  });

  describe("ACTIVE subscriptions", () => {
    it("sets plan to Standard when status=ACTIVE and name=Standard", async () => {
      mockWebhookAuth("test-shop.myshopify.com", "Standard", "ACTIVE");

      const response = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(updateShopPlanByDomain).toHaveBeenCalledWith("test-shop.myshopify.com", "Standard");
    });

    it("sets plan to Professional when status=ACTIVE and name=Professional", async () => {
      mockWebhookAuth("test-shop.myshopify.com", "Professional", "ACTIVE");

      const response = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(updateShopPlanByDomain).toHaveBeenCalledWith(
        "test-shop.myshopify.com",
        "Professional",
      );
    });

    it("falls back to free for ACTIVE status with unknown plan name", async () => {
      mockWebhookAuth("test-shop.myshopify.com", "UnknownPlan", "ACTIVE");

      const response = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(updateShopPlanByDomain).toHaveBeenCalledWith("test-shop.myshopify.com", "free");
    });
  });

  describe("non-ACTIVE subscriptions (downgrade / cancellation)", () => {
    const nonActiveStatuses = ["CANCELLED", "DECLINED", "EXPIRED", "FROZEN", "PENDING"];

    for (const status of nonActiveStatuses) {
      it(`sets plan to free when status=${status}`, async () => {
        mockWebhookAuth("test-shop.myshopify.com", "Standard", status);

        const response = await action({
          request: makeRequest(),
          params: {},
          context: {},
        } as unknown as ActionFunctionArgs);

        expect(response.status).toBe(200);
        expect(updateShopPlanByDomain).toHaveBeenCalledWith("test-shop.myshopify.com", "free");
      });
    }
  });

  describe("error and edge cases", () => {
    it("returns 200 and skips DB update when app_subscription is missing from payload", async () => {
      (authenticate.webhook as ReturnType<typeof vi.fn>).mockResolvedValue({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop: "test-shop.myshopify.com",
        payload: {}, // no app_subscription key
      });

      const response = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(updateShopPlanByDomain).not.toHaveBeenCalled();
    });

    it("returns 200 when shop is not found in DB (null return from model)", async () => {
      mockWebhookAuth("unknown-shop.myshopify.com", "Standard", "ACTIVE");
      (updateShopPlanByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const response = await action({
        request: makeRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      // Model was still called — we attempted the update.
      expect(updateShopPlanByDomain).toHaveBeenCalledWith("unknown-shop.myshopify.com", "Standard");
    });
  });
});
