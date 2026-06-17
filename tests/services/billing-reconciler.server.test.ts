/**
 * Tests for app/services/billing-reconciler.server.ts (CMP-2 / GC-fur).
 *
 * Strategy:
 *   - Mock the shop model (updateShopPlanByDomain, stampPlanReconciledAt) to
 *     verify which writes the reconciler performs.
 *   - Mock the admin GraphQL client to control Shopify's active-subscriptions
 *     response, including error and transport-failure paths.
 *   - resolveEffectivePlan and isPlanReconcileStale are pure and tested directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../app/models/shop.server", () => ({
  updateShopPlanByDomain: vi.fn(),
  stampPlanReconciledAt: vi.fn(),
}));

// Silence logger output but allow assertions on calls.
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

import { logger } from "../../app/lib/logger.server";
import { stampPlanReconciledAt, updateShopPlanByDomain } from "../../app/models/shop.server";
import {
  PLAN_RECONCILE_FRESHNESS_MS,
  isPlanReconcileStale,
  reconcileShopPlan,
  resolveEffectivePlan,
} from "../../app/services/billing-reconciler.server";

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

/** Build an admin context whose graphql() returns a GraphQL errors array. */
function makeAdminWithErrors(errors: Array<{ message?: string; extensions?: { code?: string } }>) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({ errors }),
    }),
  };
}

/** Build an admin context whose graphql() rejects (transport failure). */
function makeAdminThatThrows(err: Error) {
  return {
    graphql: vi.fn().mockRejectedValue(err),
  };
}

const mockUpdate = updateShopPlanByDomain as ReturnType<typeof vi.fn>;
const mockStamp = stampPlanReconciledAt as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// isPlanReconcileStale
// ---------------------------------------------------------------------------

describe("isPlanReconcileStale", () => {
  const now = new Date("2026-06-17T12:00:00Z");

  it("returns true when never reconciled (null)", () => {
    expect(isPlanReconcileStale(null, now)).toBe(true);
  });

  it("returns false when reconciled within the freshness window", () => {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    expect(isPlanReconcileStale(oneHourAgo, now)).toBe(false);
  });

  it("returns true when reconciled longer ago than the freshness window", () => {
    const stale = new Date(now.getTime() - PLAN_RECONCILE_FRESHNESS_MS - 1);
    expect(isPlanReconcileStale(stale, now)).toBe(true);
  });

  it("returns true exactly at the freshness boundary", () => {
    const boundary = new Date(now.getTime() - PLAN_RECONCILE_FRESHNESS_MS);
    expect(isPlanReconcileStale(boundary, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectivePlan
// ---------------------------------------------------------------------------

describe("resolveEffectivePlan", () => {
  it("returns free when there are no active subscriptions", () => {
    expect(resolveEffectivePlan([])).toBe("free");
  });

  it("resolves a single ACTIVE Standard subscription to Standard", () => {
    expect(resolveEffectivePlan([{ name: "Standard", status: "ACTIVE" }])).toBe("Standard");
  });

  it("resolves a single ACTIVE Professional subscription to Professional", () => {
    expect(resolveEffectivePlan([{ name: "Professional", status: "ACTIVE" }])).toBe("Professional");
  });

  it("picks the highest tier when multiple active subscriptions exist", () => {
    expect(
      resolveEffectivePlan([
        { name: "Standard", status: "ACTIVE" },
        { name: "Professional", status: "ACTIVE" },
      ]),
    ).toBe("Professional");
  });

  it("ignores non-ACTIVE subscriptions in the list", () => {
    expect(
      resolveEffectivePlan([
        { name: "Professional", status: "CANCELLED" },
        { name: "Standard", status: "ACTIVE" },
      ]),
    ).toBe("Standard");
  });

  it("treats an unknown active plan name as free", () => {
    expect(resolveEffectivePlan([{ name: "Mystery", status: "ACTIVE" }])).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// reconcileShopPlan
// ---------------------------------------------------------------------------

describe("reconcileShopPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ id: "shop-1", domain: "s.myshopify.com", plan: "x" });
    mockStamp.mockResolvedValue({ id: "shop-1" });
  });

  it("upgrades when stored plan is free but Shopify has an ACTIVE Standard subscription", async () => {
    const admin = makeAdmin([{ name: "Standard", status: "ACTIVE" }]);

    const result = await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "free" });

    expect(mockUpdate).toHaveBeenCalledWith("s.myshopify.com", "Standard");
    expect(mockStamp).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "corrected", fromPlan: "free", toPlan: "Standard" });
  });

  it("reverts to free when stored plan is Professional but Shopify has no active subscription", async () => {
    const admin = makeAdmin([]);

    const result = await reconcileShopPlan(admin, {
      domain: "s.myshopify.com",
      plan: "Professional",
    });

    expect(mockUpdate).toHaveBeenCalledWith("s.myshopify.com", "free");
    expect(result).toEqual({ status: "corrected", fromPlan: "Professional", toPlan: "free" });
  });

  it("is a no-op that still stamps the timestamp when the stored plan already matches", async () => {
    const admin = makeAdmin([{ name: "Standard", status: "ACTIVE" }]);

    const result = await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "Standard" });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStamp).toHaveBeenCalledWith("s.myshopify.com");
    expect(result).toEqual({ status: "matched", plan: "Standard" });
  });

  it("corrects to the highest tier when multiple active subscriptions exist", async () => {
    const admin = makeAdmin([
      { name: "Standard", status: "ACTIVE" },
      { name: "Professional", status: "ACTIVE" },
    ]);

    const result = await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "Standard" });

    expect(mockUpdate).toHaveBeenCalledWith("s.myshopify.com", "Professional");
    expect(result).toEqual({ status: "corrected", fromPlan: "Standard", toPlan: "Professional" });
  });

  it("does not change the plan, logs, and does not throw when GraphQL returns errors", async () => {
    const admin = makeAdminWithErrors([
      { message: "Throttled", extensions: { code: "THROTTLED" } },
    ]);

    const result = await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "Standard" });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "billing-reconcile-graphql-error",
      expect.objectContaining({ shop: "s.myshopify.com" }),
    );
    expect(result).toEqual({ status: "skipped-error" });
  });

  it("flags access-denied errors distinctly in the log", async () => {
    const admin = makeAdminWithErrors([
      { message: "Access denied", extensions: { code: "ACCESS_DENIED" } },
    ]);

    await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "free" });

    expect(logger.error).toHaveBeenCalledWith(
      "billing-reconcile-graphql-error",
      expect.objectContaining({ accessDenied: true }),
    );
  });

  it("does not change the plan, logs, and does not throw on a transport failure", async () => {
    const admin = makeAdminThatThrows(new Error("network down"));

    const result = await reconcileShopPlan(admin, { domain: "s.myshopify.com", plan: "Standard" });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "billing-reconcile-request-failed",
      expect.objectContaining({ shop: "s.myshopify.com", error: "network down" }),
    );
    expect(result).toEqual({ status: "skipped-error" });
  });

  it("returns shop-not-found when the model reports the shop is gone during a correction", async () => {
    mockUpdate.mockResolvedValue(null);
    const admin = makeAdmin([{ name: "Standard", status: "ACTIVE" }]);

    const result = await reconcileShopPlan(admin, { domain: "gone.myshopify.com", plan: "free" });

    expect(result).toEqual({ status: "shop-not-found" });
  });
});
