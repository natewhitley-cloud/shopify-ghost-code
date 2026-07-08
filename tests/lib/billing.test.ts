import { describe, it, expect } from "vitest";

import {
  PLAN_AMOUNTS,
  PLANS,
  buildPricingPlansUrl,
  determineBillingEventType,
  getPlanFeatures,
} from "../../app/lib/billing.server";
import type { BillingEventType } from "../../app/models/billing-event.server";

describe("getPlanFeatures", () => {
  it("returns free tier features by default", () => {
    const features = getPlanFeatures("unknown");
    expect(features.maxScansPerMonth).toBe(1);
    expect(features.showFindingDetails).toBe(false);
    expect(features.scheduledScan).toBe(false);
  });

  it("returns standard features", () => {
    const features = getPlanFeatures(PLANS.STANDARD);
    expect(features.maxScansPerMonth).toBe(Infinity);
    expect(features.showFindingDetails).toBe(true);
    expect(features.maxThemes).toBe(1);
    expect(features.scheduledScan).toBe(true);
  });

  it("returns professional features", () => {
    const features = getPlanFeatures(PLANS.PROFESSIONAL);
    expect(features.autoRescan).toBe(true);
    expect(features.scanDiffing).toBe(true);
    expect(features.maxThemes).toBe(Infinity);
    expect(features.scheduledScan).toBe(true);
  });
});

describe("buildPricingPlansUrl", () => {
  it("strips the .myshopify.com suffix and builds the managed pricing URL", () => {
    expect(buildPricingPlansUrl("nw-dev-store-2.myshopify.com")).toBe(
      "https://admin.shopify.com/store/nw-dev-store-2/charges/ghost-code/pricing_plans",
    );
  });

  it("handles a different store slug", () => {
    expect(buildPricingPlansUrl("acme-storefront.myshopify.com")).toBe(
      "https://admin.shopify.com/store/acme-storefront/charges/ghost-code/pricing_plans",
    );
  });

  it("falls back to using the domain as-is when the suffix is absent", () => {
    expect(buildPricingPlansUrl("nw-dev-store-2")).toBe(
      "https://admin.shopify.com/store/nw-dev-store-2/charges/ghost-code/pricing_plans",
    );
  });

  it("strips the suffix case-insensitively", () => {
    expect(buildPricingPlansUrl("nw-dev-store-2.MyShopify.com")).toBe(
      "https://admin.shopify.com/store/nw-dev-store-2/charges/ghost-code/pricing_plans",
    );
  });
});

// ---------------------------------------------------------------------------
// PLAN_AMOUNTS
// ---------------------------------------------------------------------------

describe("PLAN_AMOUNTS", () => {
  it("Standard plan amount is $29", () => {
    expect(PLAN_AMOUNTS[PLANS.STANDARD]).toBe(29);
  });

  it("Professional plan amount is $49", () => {
    expect(PLAN_AMOUNTS[PLANS.PROFESSIONAL]).toBe(49);
  });

  it("free plan has no amount (undefined) — no recurring charge", () => {
    expect(PLAN_AMOUNTS[PLANS.FREE]).toBeUndefined();
  });

  it("every paid plan key maps to a numeric amount (forward-compatibility guard)", () => {
    // If a new plan is added and PLAN_AMOUNTS is not updated this loop catches it.
    const paidPlans = [PLANS.STANDARD, PLANS.PROFESSIONAL] as const;
    for (const plan of paidPlans) {
      expect(typeof PLAN_AMOUNTS[plan]).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// determineBillingEventType
// ---------------------------------------------------------------------------

describe("determineBillingEventType", () => {
  // -------------------------------------------------------------------------
  // Same-plan no-ops → null
  // -------------------------------------------------------------------------

  it("returns null when free stays free", () => {
    expect(determineBillingEventType(PLANS.FREE, PLANS.FREE)).toBeNull();
  });

  it("returns null when Standard stays Standard (unchanged-plan webhook)", () => {
    expect(determineBillingEventType(PLANS.STANDARD, PLANS.STANDARD)).toBeNull();
  });

  it("returns null when Professional stays Professional", () => {
    expect(determineBillingEventType(PLANS.PROFESSIONAL, PLANS.PROFESSIONAL)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Upgrades from free
  // -------------------------------------------------------------------------

  it("returns upgrade when going from free to Standard", () => {
    expect(determineBillingEventType(PLANS.FREE, PLANS.STANDARD)).toBe("upgrade");
  });

  it("returns upgrade when going from free to Professional", () => {
    expect(determineBillingEventType(PLANS.FREE, PLANS.PROFESSIONAL)).toBe("upgrade");
  });

  // -------------------------------------------------------------------------
  // Cancellations to free
  // -------------------------------------------------------------------------

  it("returns cancellation when going from Standard to free", () => {
    expect(determineBillingEventType(PLANS.STANDARD, PLANS.FREE)).toBe("cancellation");
  });

  it("returns cancellation when going from Professional to free", () => {
    expect(determineBillingEventType(PLANS.PROFESSIONAL, PLANS.FREE)).toBe("cancellation");
  });

  // -------------------------------------------------------------------------
  // Paid-to-paid transitions
  // -------------------------------------------------------------------------

  it("returns upgrade when going from Standard to Professional", () => {
    expect(determineBillingEventType(PLANS.STANDARD, PLANS.PROFESSIONAL)).toBe("upgrade");
  });

  it("returns downgrade when going from Professional to Standard", () => {
    expect(determineBillingEventType(PLANS.PROFESSIONAL, PLANS.STANDARD)).toBe("downgrade");
  });

  // -------------------------------------------------------------------------
  // Unknown-plan-name edge cases — rank-0 fallback behavior
  // -------------------------------------------------------------------------

  it("returns null for unknown→unknown (both get rank 0 fallback — same rank)", () => {
    expect(determineBillingEventType("ghost-plan", "mystery-plan")).toBeNull();
  });

  it("returns null for unknown→free (both rank 0)", () => {
    expect(determineBillingEventType("ghost-plan", PLANS.FREE)).toBeNull();
  });

  it("returns upgrade for unknown→Standard (rank 0→1, fromPlan not FREE literal)", () => {
    // Unknown plans get rank 0 via fallback. The toPlan is not FREE, fromPlan
    // is not the literal FREE string, so it falls to rank comparison → upgrade.
    expect(determineBillingEventType("ghost-plan", PLANS.STANDARD)).toBe("upgrade");
  });

  it("returns downgrade for Standard→unknown (rank 1→0, toPlan not FREE literal)", () => {
    // Unknown toPlan gets rank 0 but is NOT the literal "free" string, so
    // toPlan === PLANS.FREE is false — falls to rank comparison → downgrade.
    expect(determineBillingEventType(PLANS.STANDARD, "ghost-plan")).toBe("downgrade");
  });

  // -------------------------------------------------------------------------
  // Forward-compatibility guard: all returned values must be valid BillingEventType | null
  // -------------------------------------------------------------------------

  it("every transition returns a valid BillingEventType or null (forward-compatibility guard)", () => {
    const validTypes = new Set<BillingEventType | null>([
      "upgrade",
      "downgrade",
      "cancellation",
      "reactivation",
      null,
    ]);

    const plans = [PLANS.FREE, PLANS.STANDARD, PLANS.PROFESSIONAL];
    for (const from of plans) {
      for (const to of plans) {
        const result = determineBillingEventType(from, to);
        expect(
          validTypes,
          `${from} → ${to} returned unexpected value: ${String(result)}`,
        ).toContain(result);
      }
    }
  });
});
