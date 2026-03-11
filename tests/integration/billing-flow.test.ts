/**
 * Integration tests: billing flow — subscribe → webhook → plan update
 *
 * This file tests the billing lifecycle across two layers:
 *
 *   Part A — Settings action (app.settings.tsx)
 *     Tests that posting with intent="subscribe-standard" or
 *     "subscribe-professional" triggers billing.request(), which throws a
 *     redirect. Also tests the unknown-intent fallback and the professional
 *     intent path.
 *
 *   Part B — APP_SUBSCRIPTIONS_UPDATE webhook (webhooks.app.subscriptions.update.tsx)
 *     Tests that the webhook handler correctly maps Shopify subscription status
 *     to internal plan tiers and persists the result, covering:
 *       - Subscription activated (ACTIVE) → plan upgraded
 *       - Subscription cancelled (CANCELLED) → plan reverted to free
 *       - Unknown plan name with ACTIVE status → free (safe default)
 *       - Missing payload → 200 with no DB write
 *       - Shop not found in DB → 200 with attempted update
 *
 * Mocking strategy: mock at the I/O boundary (authenticate.admin,
 * authenticate.webhook, updateShopPlanByDomain) and verify the business logic
 * wiring that connects authentication, plan resolution, and DB persistence.
 */

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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { action as settingsAction } from "../../app/routes/app.settings";
import { action as subscriptionWebhookAction } from "../../app/routes/webhooks.app.subscriptions.update";
import { authenticate } from "../../app/shopify.server";
import { updateShopPlanByDomain } from "../../app/models/shop.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockUpdateShopPlanByDomain = updateShopPlanByDomain as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";

const MOCK_SHOP_FREE = {
  id: SHOP_ID,
  domain: SHOP_DOMAIN,
  plan: "free",
  accessToken: "test-token",
};

const MOCK_BILLING = {
  request: vi.fn(),
  require: vi.fn(),
  check: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettingsRequest(intent: string) {
  const body = new URLSearchParams({ intent });
  return new Request("https://example.com/app/settings", {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

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

  // Default: billing.request throws a redirect (as Shopify SDK does)
  MOCK_BILLING.request.mockImplementation(async () => {
    throw new Response(null, {
      status: 302,
      headers: { Location: "https://accounts.shopify.com/billing/confirm" },
    });
  });

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
    admin: { graphql: vi.fn() },
    billing: MOCK_BILLING,
  });

  // Default: DB update succeeds
  mockUpdateShopPlanByDomain.mockResolvedValue({
    id: SHOP_ID,
    domain: SHOP_DOMAIN,
    plan: "Standard",
  });
});

// ---------------------------------------------------------------------------
// Part A: Settings action — initiate billing subscription
// ---------------------------------------------------------------------------

describe("Billing flow — Part A: settings action (subscribe)", () => {
  describe("intent=subscribe-standard", () => {
    it("calls billing.request with the Standard plan", async () => {
      // billing.request throws a redirect; catch it
      try {
        await settingsAction({
          request: makeSettingsRequest("subscribe-standard"),
          params: {},
          context: {},
        } as any);
      } catch {
        // redirect expected
      }

      expect(MOCK_BILLING.request).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "Standard" }),
      );
    });

    it("throws a redirect response (Shopify billing.request behaviour)", async () => {
      let threw = false;
      let thrownValue: unknown;

      try {
        await settingsAction({
          request: makeSettingsRequest("subscribe-standard"),
          params: {},
          context: {},
        } as any);
      } catch (e) {
        threw = true;
        thrownValue = e;
      }

      expect(threw).toBe(true);
      expect(thrownValue instanceof Response).toBe(true);
      expect((thrownValue as Response).status).toBe(302);
    });
  });

  describe("intent=subscribe-professional", () => {
    it("calls billing.request with the Professional plan", async () => {
      try {
        await settingsAction({
          request: makeSettingsRequest("subscribe-professional"),
          params: {},
          context: {},
        } as any);
      } catch {
        // redirect expected
      }

      expect(MOCK_BILLING.request).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "Professional" }),
      );
    });
  });

  describe("unknown intent", () => {
    it("does not call billing.request for an unknown intent", async () => {
      const result = await settingsAction({
        request: makeSettingsRequest("invalid-intent"),
        params: {},
        context: {},
      } as any);

      expect(MOCK_BILLING.request).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "Unknown intent" });
    });

    it("returns 200 with error payload (not a 4xx) for unknown intent", async () => {
      // Verify the action returns a plain object (not throws), so React Router
      // renders the error banner via useActionData rather than swallowing it.
      const result = await settingsAction({
        request: makeSettingsRequest("bogus"),
        params: {},
        context: {},
      } as any);

      // Must be a plain object — not a Response — so useActionData gets it
      expect(result).not.toBeInstanceOf(Response);
      expect(result).toHaveProperty("error");
    });
  });
});

// ---------------------------------------------------------------------------
// Part B: Subscription webhook — plan update and downgrade
// ---------------------------------------------------------------------------

describe("Billing flow — Part B: APP_SUBSCRIPTIONS_UPDATE webhook (plan sync)", () => {
  describe("subscription activated — plan upgrade", () => {
    it("updates shop plan to Standard when status=ACTIVE and name=Standard", async () => {
      mockSubscriptionWebhook("Standard", "ACTIVE");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "Standard");
    });

    it("updates shop plan to Professional when status=ACTIVE and name=Professional", async () => {
      mockSubscriptionWebhook("Professional", "ACTIVE");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as any);

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
      } as any);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });

    it("reverts shop plan to free when status=DECLINED", async () => {
      mockSubscriptionWebhook("Standard", "DECLINED");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });

    it("reverts shop plan to free when status=EXPIRED", async () => {
      mockSubscriptionWebhook("Professional", "EXPIRED");

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as any);

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
      } as any);

      expect(response.status).toBe(200);
      // Unknown plan names must not silently grant paid features
      expect(mockUpdateShopPlanByDomain).toHaveBeenCalledWith(SHOP_DOMAIN, "free");
    });
  });

  describe("edge cases — webhook always returns 200", () => {
    it("returns 200 and skips DB update when app_subscription is missing from payload", async () => {
      mockAuthenticateWebhook.mockResolvedValue({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop: SHOP_DOMAIN,
        payload: {}, // malformed — no app_subscription key
      });

      const response = await subscriptionWebhookAction({
        request: makeWebhookRequest(),
        params: {},
        context: {},
      } as any);

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
      } as any);

      // Must return 200 — non-200 causes Shopify to retry indefinitely
      expect(response.status).toBe(200);
    });
  });
});
