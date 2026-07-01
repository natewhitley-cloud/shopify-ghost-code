import { describe, it, expect } from "vitest";

import { buildPricingPlansUrl, getPlanFeatures, PLANS } from "../../app/lib/billing.server";

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
