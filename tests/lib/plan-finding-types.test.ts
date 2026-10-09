/**
 * Tests for app/lib/plan-finding-types.ts: the one "types this plan may see in
 * full" helper, against the REAL plan matrix.
 */
import { describe, it, expect } from "vitest";

import { getPlanFeatures } from "../../app/lib/billing.server";
import { findingTypesWithheldByPlan } from "../../app/lib/plan-finding-types";

describe("findingTypesWithheldByPlan", () => {
  it("Free withholds Broken links and checkout sunset (Standard+ features)", () => {
    expect(findingTypesWithheldByPlan(getPlanFeatures("free"))).toEqual([
      "DANGLING_REFERENCE",
      "CHECKOUT_SUNSET",
    ]);
  });

  it.each(["Standard", "Professional"])("%s withholds nothing", (plan) => {
    expect(findingTypesWithheldByPlan(getPlanFeatures(plan))).toEqual([]);
  });

  it("an unknown plan resolves to Free and withholds the same", () => {
    expect(findingTypesWithheldByPlan(getPlanFeatures("bogus"))).toEqual([
      "DANGLING_REFERENCE",
      "CHECKOUT_SUNSET",
    ]);
  });
});
