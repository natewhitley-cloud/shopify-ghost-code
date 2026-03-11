import { describe, it, expect } from "vitest";
import { getPlanFeatures, PLANS } from "../../app/lib/billing.server";

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
