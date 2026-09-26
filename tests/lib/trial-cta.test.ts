/**
 * Tests for app/lib/trial-cta.ts (gc-97k.8): trial eligibility and the shared
 * upgrade-button label.
 */
import { describe, it, expect } from "vitest";

import { FREE_TRIAL_DAYS, isTrialEligible, upgradeCtaLabel } from "../../app/lib/trial-cta";

describe("isTrialEligible", () => {
  const PAID_AT = new Date("2026-05-01T00:00:00Z");

  it("a never-paid Free shop (no everPaidAt, no BillingEvent) is eligible", () => {
    expect(isTrialEligible({ plan: "free", everPaidAt: null, hasBillingHistory: false })).toBe(
      true,
    );
  });

  it("a Free shop with any BillingEvent (previously paid) is not eligible", () => {
    expect(isTrialEligible({ plan: "free", everPaidAt: null, hasBillingHistory: true })).toBe(
      false,
    );
  });

  it("a Free shop with everPaidAt set is not eligible even with NO BillingEvent (backstop-only paid)", () => {
    expect(isTrialEligible({ plan: "free", everPaidAt: PAID_AT, hasBillingHistory: false })).toBe(
      false,
    );
  });

  it("both signals set: not eligible", () => {
    expect(isTrialEligible({ plan: "free", everPaidAt: PAID_AT, hasBillingHistory: true })).toBe(
      false,
    );
  });

  it.each(["Standard", "Professional"])(
    "a shop currently on %s is never eligible (history or not)",
    (plan) => {
      for (const everPaidAt of [null, PAID_AT]) {
        for (const hasBillingHistory of [false, true]) {
          expect(isTrialEligible({ plan, everPaidAt, hasBillingHistory })).toBe(false);
        }
      }
    },
  );

  it("an unrecognized stored plan is not eligible (never promise what we cannot confirm)", () => {
    expect(isTrialEligible({ plan: "Legacy", everPaidAt: null, hasBillingHistory: false })).toBe(
      false,
    );
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
