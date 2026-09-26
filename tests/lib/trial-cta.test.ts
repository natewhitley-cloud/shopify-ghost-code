/**
 * Tests for app/lib/trial-cta.ts (gc-97k.8): trial eligibility and the shared
 * upgrade-button label.
 */
import { describe, it, expect } from "vitest";

import { FREE_TRIAL_DAYS, isTrialEligible, upgradeCtaLabel } from "../../app/lib/trial-cta";

describe("isTrialEligible", () => {
  it("a never-paid Free shop is eligible", () => {
    expect(isTrialEligible({ plan: "free", hasBillingHistory: false })).toBe(true);
  });

  it("a Free shop with any BillingEvent (previously paid) is not eligible", () => {
    expect(isTrialEligible({ plan: "free", hasBillingHistory: true })).toBe(false);
  });

  it.each(["Standard", "Professional"])(
    "a shop currently on %s is never eligible (history or not)",
    (plan) => {
      expect(isTrialEligible({ plan, hasBillingHistory: false })).toBe(false);
      expect(isTrialEligible({ plan, hasBillingHistory: true })).toBe(false);
    },
  );

  it("an unrecognized stored plan is not eligible (never promise what we cannot confirm)", () => {
    expect(isTrialEligible({ plan: "Legacy", hasBillingHistory: false })).toBe(false);
  });
});

describe("upgradeCtaLabel", () => {
  it("is 7 days, matching docs/pricing-and-plans.md", () => {
    expect(FREE_TRIAL_DAYS).toBe(7);
  });

  it.each(["Standard", "Professional"] as const)("trial-eligible, %s: trial label", (plan) => {
    expect(upgradeCtaLabel(plan, true)).toBe("Start 7-day free trial");
  });

  it("previously paid: names the target plan", () => {
    expect(upgradeCtaLabel("Standard", false)).toBe("Upgrade to Standard");
    expect(upgradeCtaLabel("Professional", false)).toBe("Upgrade to Professional");
  });

  it("no label uses an em dash", () => {
    for (const eligible of [true, false]) {
      for (const plan of ["Standard", "Professional"] as const) {
        expect(upgradeCtaLabel(plan, eligible)).not.toContain("—");
      }
    }
  });
});
