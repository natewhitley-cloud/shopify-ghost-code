/**
 * Integration tests: billing flow — live plan path (redirect fast-path + on-load reconcile)
 *
 * The APP_SUBSCRIPTIONS_UPDATE webhook that historically wrote plan state is DEAD
 * as of 2026-04-28 (Shopify stopped sending it for Shopify App Pricing apps).
 * Plan state is now driven entirely by `reconcileShopPlan`, which is invoked from
 * the app/routes/app.tsx loader — immediately when the request carries a
 * `plan_handle` param (redirect fast-path), and periodically as an on-load
 * backstop for out-of-redirect changes (cancellations, freezes, expirations).
 *
 * These tests exercise that live path END-TO-END: the real reconciler
 * (app/services/billing-reconciler.server.ts) driving the real shop model
 * (app/models/shop.server.ts `updateShopPlanByDomain`) against a mocked Admin
 * GraphQL client and a real-shaped Prisma mock. Only the Shopify I/O boundary
 * (admin.graphql), the Prisma client, and the logger are mocked.
 *
 * Covers:
 *   - ACTIVE Standard subscription → Shop.plan reconciled to Standard (upgrade)
 *   - No active subscription → Shop.plan reverted to free (stale-drift backstop)
 *
 * Mocking strategy: mock at the I/O boundary (app/db.server Prisma client,
 * admin.graphql) and let the real reconciler + model wiring run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

// Real-shaped Prisma mock: only the shop methods the real model touches
// (updateShopPlanByDomain → shop.findUnique + shop.update).
vi.mock("../../app/db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { reconcileShopPlan } from "../../app/services/billing-reconciler.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockShop = (db as unknown as { shop: Record<string, ReturnType<typeof vi.fn>> }).shop;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Sub = { name?: string; status?: string };

/** Build an admin context whose graphql() returns the given active subscriptions. */
function makeAdmin(subscriptions: Sub[]) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: { currentAppInstallation: { activeSubscriptions: subscriptions } },
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Live plan path — reconcileShopPlan → updateShopPlanByDomain → Prisma
// ---------------------------------------------------------------------------

describe("Billing flow — live plan path (reconcileShopPlan → Shop.plan)", () => {
  describe("ACTIVE subscription — plan reconciled up", () => {
    it("reconciles Shop.plan to Standard when Shopify has an ACTIVE Standard subscription", async () => {
      // Stored plan is stale (free); Shopify reports an ACTIVE Standard subscription.
      mockShop.findUnique.mockResolvedValue({ id: SHOP_ID, domain: SHOP_DOMAIN, plan: "free" });
      mockShop.update.mockResolvedValue({ id: SHOP_ID, domain: SHOP_DOMAIN, plan: "Standard" });

      const admin = makeAdmin([{ name: "Standard", status: "ACTIVE" }]);

      const result = await reconcileShopPlan(admin, { domain: SHOP_DOMAIN, plan: "free" });

      // The real model persists the corrected plan and stamps planReconciledAt.
      expect(mockShop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { domain: SHOP_DOMAIN },
          data: expect.objectContaining({ plan: "Standard" }),
        }),
      );
      expect(result).toEqual({ status: "corrected", fromPlan: "free", toPlan: "Standard" });
    });
  });

  describe("no active subscription — stale-drift backstop reverts to free", () => {
    it("reverts Shop.plan to free when Shopify reports no active subscription", async () => {
      // Stored plan drifted to Standard but Shopify has no active subscription
      // (cancelled/expired out-of-redirect — the backstop must self-correct).
      mockShop.findUnique.mockResolvedValue({ id: SHOP_ID, domain: SHOP_DOMAIN, plan: "Standard" });
      mockShop.update.mockResolvedValue({ id: SHOP_ID, domain: SHOP_DOMAIN, plan: "free" });

      const admin = makeAdmin([]);

      const result = await reconcileShopPlan(admin, { domain: SHOP_DOMAIN, plan: "Standard" });

      expect(mockShop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { domain: SHOP_DOMAIN },
          data: expect.objectContaining({ plan: "free" }),
        }),
      );
      expect(result).toEqual({ status: "corrected", fromPlan: "Standard", toPlan: "free" });
    });
  });
});
