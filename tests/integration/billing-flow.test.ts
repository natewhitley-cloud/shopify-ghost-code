/**
 * Integration tests: billing flow — webhook → plan update
 *
 * Tests the APP_SUBSCRIPTIONS_UPDATE webhook handler, which maps Shopify
 * subscription status to internal plan tiers. Billing is handled via
 * Managed Pricing in the Partner Dashboard — there is no in-app billing
 * action to test.
 *
 * Covers:
 *   - Subscription activated (ACTIVE) → plan upgraded
 *   - Subscription cancelled (CANCELLED) → plan reverted to free
 *   - Unknown plan name with ACTIVE status → free (safe default)
 *   - Missing payload → 200 with no DB write
 *   - Shop not found in DB → 200 with attempted update
 *
 * Mocking strategy: mock at the I/O boundary (authenticate.webhook,
 * updateShopPlanByDomain) and verify the business logic wiring.
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
    webhook: vi.fn(),
  },
  PLAN_STANDARD: "Standard",
  PLAN_PROFESSIONAL: "Professional",
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopByDomain: vi.fn(),
  updateShopPlanByDomain: vi.fn(),
}));

vi.mock("../../app/models/billing-event.server", () => ({
  recordBillingEvent: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { getShopByDomain, updateShopPlanByDomain } from "../../app/models/shop.server";
import { action as subscriptionWebhookAction } from "../../app/routes/webhooks.app.subscriptions.update";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockUpdateShopPlanByDomain = updateShopPlanByDomain as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookRequest() {
  return new Request("https://example.com/webhooks/app/subscriptions/update", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
}

function mockSubscriptionWebhook(planName: string | undefined, status: string | undefined) {
  const payload =
    planName !== undefined || status !== undefined
      ? { app_subscription: { name: planName, status } }
      : {};

  mockAuthenticateWebhook.mockResolvedValue({
    topic: "APP_SUBSCRIPTIONS_UPDATE",
    shop: SHOP_DOMAIN,
    payload,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: DB update succeeds
  mockUpdateShopPlanByDomain.mockResolvedValue({
    id: SHOP_ID,
    domain: SHOP_DOMAIN,
    plan: "Standard",
  });

  mockGetShopByDomain.mockResolvedValue({
    id: SHOP_ID,
    domain: SHOP_DOMAIN,
    plan: "Free",
  });
});

// ---------------------------------------------------------------------------
// APP_SUBSCRIPTIONS_UPDATE webhook — plan update and downgrade
// ---------------------------------------------------------------------------

describe("Billing flow — APP_SUBSCRIPTIONS_UPDATE webhook (plan sync)", () => {
  describe("subscription activated — plan upgrade", () => {
    it("updates shop plan to Standard when status=ACTIVE and name=Standard", async () => {
      mockSubscriptionWebhook("Standard", "ACTIVE");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "Standard");
    });

    it("updates shop plan to Professional when status=ACTIVE and name=Professional", async () => {
      mockSubscriptionWebhook("Professional", "ACTIVE");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "Professional");
    });
  });

  describe("subscription cancelled — plan downgrade to free", () => {
    it("reverts shop plan to free when status=CANCELLED", async () => {
      mockSubscriptionWebhook("Standard", "CANCELLED");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });

    it("reverts shop plan to free when status=DECLINED", async () => {
      mockSubscriptionWebhook("Standard", "DECLINED");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });

    it("reverts shop plan to free when status=EXPIRED", async () => {
      mockSubscriptionWebhook("Professional", "EXPIRED");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });
  });

  describe("unknown plan name — safe fallback to free", () => {
    it("reverts to free for ACTIVE subscription with an unrecognised plan name", async () => {
      mockSubscriptionWebhook("GoldPlan", "ACTIVE");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });
  });

  describe("edge cases — webhook always returns 200", () => {
    it("returns 200 and skips DB update when app_subscription is missing from payload", async () => {
      mockAuthenticateWebhook.mockResolvedValue({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop: SHOP_DOMAIN,
        payload: {},
      });

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).not.toHaveBeenCalled();
    });

    it("returns 200 when shop is not found in DB (null return from model)", async () => {
      mockSubscriptionWebhook("Standard", "ACTIVE");
      mockUpdateShopPlanByDomain.mockResolvedValue(null);

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(200);
    });
  });
});
