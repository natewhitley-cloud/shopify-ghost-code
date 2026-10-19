/** Tests for app/lib/plan-tiles.ts (gc-4wvb): tile bullets and CTAs. */
import { describe, it, expect } from "vitest";

import {
  PLAN_LISTING_BULLETS,
  planTileBullets,
  planTileCta,
  TILE_PLANS,
  TRIAL_BULLET,
} from "../../app/lib/plan-tiles";
import { PLANS } from "../../app/lib/plans";
import {
  FREE_SPEED_TEST_BULLET,
  MONTHLY_SPEED_REPORT_BULLET,
  WEEKLY_SPEED_REPORT_BULLET,
} from "../../app/lib/speed-report";
import { upgradeCtaLabel } from "../../app/lib/trial-cta";

const label = (eligible: boolean) => (t: typeof PLANS.STANDARD | typeof PLANS.PROFESSIONAL) =>
  upgradeCtaLabel(t, eligible);

describe("planTileBullets", () => {
  it.each(TILE_PLANS)("%s, live, not eligible: exactly the listing bullets", (plan) => {
    expect(planTileBullets(plan, { speedLive: true, trialEligible: false })).toEqual(
      PLAN_LISTING_BULLETS[plan],
    );
  });

  it.each([
    [PLANS.FREE, FREE_SPEED_TEST_BULLET],
    [PLANS.STANDARD, MONTHLY_SPEED_REPORT_BULLET],
    [PLANS.PROFESSIONAL, WEEKLY_SPEED_REPORT_BULLET],
  ] as const)("%s, dark: drops only its speed bullet", (plan, speed) => {
    const out = planTileBullets(plan, { speedLive: false, trialEligible: false });
    expect(out).toEqual(PLAN_LISTING_BULLETS[plan].filter((b) => b !== speed));
    expect(out).toHaveLength(PLAN_LISTING_BULLETS[plan].length - 1);
  });

  it("trial-eligible: paid tiles end with the trial bullet, Free never does", () => {
    const opts = { speedLive: true, trialEligible: true };
    expect(planTileBullets(PLANS.FREE, opts)).not.toContain(TRIAL_BULLET);
    expect(planTileBullets(PLANS.STANDARD, opts).at(-1)).toBe(TRIAL_BULLET);
    expect(planTileBullets(PLANS.PROFESSIONAL, opts).at(-1)).toBe(TRIAL_BULLET);
    expect(TRIAL_BULLET).toBe("7-day free trial");
  });

  it("never mutates the constants", () => {
    planTileBullets(PLANS.STANDARD, { speedLive: true, trialEligible: true });
    expect(PLAN_LISTING_BULLETS[PLANS.STANDARD]).not.toContain(TRIAL_BULLET);
  });
});

describe("planTileCta", () => {
  it("Free shop: no CTA on Free; primary upgrade (trial copy) on both paid tiles", () => {
    expect(planTileCta(PLANS.FREE, PLANS.FREE, label(true))).toBeNull();
    expect(planTileCta(PLANS.STANDARD, PLANS.FREE, label(true))).toEqual({
      label: "Start 7-day free trial",
      variant: "primary",
    });
    expect(planTileCta(PLANS.PROFESSIONAL, PLANS.FREE, label(false))).toEqual({
      label: "Upgrade to Professional",
      variant: "primary",
    });
  });

  it("Standard shop: secondary Downgrade to Free, none on Standard, primary Professional", () => {
    expect(planTileCta(PLANS.FREE, PLANS.STANDARD, label(false))).toEqual({
      label: "Downgrade to Free",
      variant: "secondary",
    });
    expect(planTileCta(PLANS.STANDARD, PLANS.STANDARD, label(false))).toBeNull();
    expect(planTileCta(PLANS.PROFESSIONAL, PLANS.STANDARD, label(false))).toEqual({
      label: "Upgrade to Professional",
      variant: "primary",
    });
  });

  it("Professional shop: two secondary downgrades, none on Professional", () => {
    expect(planTileCta(PLANS.FREE, PLANS.PROFESSIONAL, label(false))?.label).toBe(
      "Downgrade to Free",
    );
    expect(planTileCta(PLANS.STANDARD, PLANS.PROFESSIONAL, label(false))).toEqual({
      label: "Downgrade to Standard",
      variant: "secondary",
    });
    expect(planTileCta(PLANS.PROFESSIONAL, PLANS.PROFESSIONAL, label(false))).toBeNull();
  });

  it("an unrecognised stored plan is treated as Free (never 'upgrade to Free')", () => {
    expect(planTileCta(PLANS.FREE, "legacy", label(false))).toBeNull();
    expect(planTileCta(PLANS.STANDARD, "legacy", label(false))?.variant).toBe("primary");
  });
});
