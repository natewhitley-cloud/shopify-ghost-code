import { describe, it, expect } from "vitest";

import {
  scoreApp,
  scoreStore,
  riskLevelFromScore,
  type AppRiskScore,
} from "../../app/services/permission-scorer.server";

// ---------------------------------------------------------------------------
// riskLevelFromScore
// ---------------------------------------------------------------------------

describe("riskLevelFromScore", () => {
  it("returns low for 0", () => {
    expect(riskLevelFromScore(0)).toBe("low");
  });

  it("returns low for 25", () => {
    expect(riskLevelFromScore(25)).toBe("low");
  });

  it("returns medium for 26", () => {
    expect(riskLevelFromScore(26)).toBe("medium");
  });

  it("returns medium for 50", () => {
    expect(riskLevelFromScore(50)).toBe("medium");
  });

  it("returns high for 51", () => {
    expect(riskLevelFromScore(51)).toBe("high");
  });

  it("returns high for 75", () => {
    expect(riskLevelFromScore(75)).toBe("high");
  });

  it("returns critical for 76", () => {
    expect(riskLevelFromScore(76)).toBe("critical");
  });

  it("returns critical for 100", () => {
    expect(riskLevelFromScore(100)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// scoreApp — basic cases
// ---------------------------------------------------------------------------

describe("scoreApp", () => {
  it("returns score 0 and level low for an app with no scopes", () => {
    const result = scoreApp([], "marketing-and-conversion");
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
    expect(result.factors).toHaveLength(0);
  });

  it("returns score 0 and level low for empty scopes with null category", () => {
    const result = scoreApp([], null);
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
    expect(result.factors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Only expected scopes → low score
  // -------------------------------------------------------------------------

  it("scores low for an app with only expected low-sensitivity scopes", () => {
    // A marketing app holding read_analytics (LOW sensitivity, expected for category)
    const result = scoreApp(["read_analytics"], "marketing-and-conversion");
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.level).toBe("low");
    expect(result.factors.length).toBeGreaterThanOrEqual(1);
  });

  it("scores low for an app with a few expected medium-sensitivity scopes", () => {
    // A marketing app with read_products and read_script_tags — both expected
    const result = scoreApp(["read_products", "read_script_tags"], "marketing-and-conversion");
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.level).toBe("low");
  });

  it("scores low for an app with several expected scopes including high ones", () => {
    // A finding-products app with expected scopes (includes write_products = HIGH)
    const result = scoreApp(
      ["read_products", "write_products", "read_inventory"],
      "finding-products",
    );
    // Expected for category, so no mismatch penalty — should stay reasonable
    expect(result.score).toBeLessThanOrEqual(50);
    expect(result.level).not.toBe("critical");
  });

  // -------------------------------------------------------------------------
  // Unexpected scopes → higher score
  // -------------------------------------------------------------------------

  it("scores high/critical for a countdown timer app with write_orders", () => {
    // Countdown timer should NOT have write_orders (CRITICAL sensitivity)
    const result = scoreApp(
      ["read_products", "read_script_tags", "write_orders"],
      "marketing-and-conversion-upsell-and-bundles-countdown-timer",
    );
    // write_orders is unexpected AND critical → should push score up significantly
    expect(result.score).toBeGreaterThanOrEqual(26);
    expect(["medium", "high", "critical"]).toContain(result.level);

    // Should have a mismatch factor mentioning the unexpected scope
    const mismatchFactor = result.factors.find((f) => f.description.includes("unexpected"));
    expect(mismatchFactor).toBeDefined();
    expect(mismatchFactor!.description).toContain("write_orders");
  });

  it("scores higher when more unexpected critical scopes are present", () => {
    const oneUnexpected = scoreApp(
      ["read_products", "write_orders"],
      "marketing-and-conversion-upsell-and-bundles-countdown-timer",
    );

    const threeUnexpected = scoreApp(
      ["read_products", "write_orders", "write_customers", "write_checkouts"],
      "marketing-and-conversion-upsell-and-bundles-countdown-timer",
    );

    expect(threeUnexpected.score).toBeGreaterThan(oneUnexpected.score);
  });

  // -------------------------------------------------------------------------
  // Null category → sensitivity only, no mismatch
  // -------------------------------------------------------------------------

  it("scores purely on sensitivity when categorySlug is null", () => {
    const result = scoreApp(["write_orders", "write_customers"], null);
    expect(result.score).toBeGreaterThan(0);
    expect(result.level).not.toBe("low");

    // Should have a sensitivity factor but no mismatch factor
    expect(result.factors.length).toBe(1);
    expect(result.factors[0].description).toContain("scope");
    const mismatchFactor = result.factors.find((f) => f.description.includes("unexpected"));
    expect(mismatchFactor).toBeUndefined();
  });

  it("scores lower for low-sensitivity scopes with null category", () => {
    const lowResult = scoreApp(["read_analytics", "read_locales"], null);
    const criticalResult = scoreApp(["write_orders", "write_customers"], null);
    expect(criticalResult.score).toBeGreaterThan(lowResult.score);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles a single LOW scope gracefully", () => {
    const result = scoreApp(["read_analytics"], null);
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.level).toBe("low");
    expect(result.factors).toHaveLength(1);
  });

  it("handles a single CRITICAL scope", () => {
    const result = scoreApp(["write_orders"], null);
    expect(result.score).toBeGreaterThan(0);
    expect(result.factors).toHaveLength(1);
    expect(result.factors[0].description).toContain("1 scope");
    expect(result.factors[0].description).toContain("1 critical");
  });

  it("handles unknown scopes (defaults to MEDIUM sensitivity)", () => {
    const result = scoreApp(["some_totally_unknown_scope"], null);
    expect(result.score).toBeGreaterThan(0);
    // Should score same as a known MEDIUM scope
    const mediumResult = scoreApp(["read_products"], null);
    expect(result.score).toBe(mediumResult.score);
  });

  it("score never exceeds 100", () => {
    // Pathological case: many critical unexpected scopes
    const scopes = [
      "write_orders",
      "write_customers",
      "read_all_orders",
      "write_payment_terms",
      "write_merchant_managed_fulfillment_orders",
      "write_third_party_fulfillment_orders",
      "write_gift_cards",
      "write_payment_gateways",
      "write_checkouts",
    ];
    const result = scoreApp(scopes, "marketing-and-conversion-upsell-and-bundles-countdown-timer");
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(76);
    expect(result.level).toBe("critical");
  });

  it("score is always a whole number", () => {
    const result = scoreApp(
      ["read_products", "write_orders", "read_analytics"],
      "marketing-and-conversion",
    );
    expect(Number.isInteger(result.score)).toBe(true);
  });

  it("factors array explains what drove the score", () => {
    const result = scoreApp(
      ["read_products", "write_orders"],
      "marketing-and-conversion-upsell-and-bundles-countdown-timer",
    );
    // Should have at least sensitivity factor and mismatch factor
    expect(result.factors.length).toBeGreaterThanOrEqual(2);

    // Each factor should have a description and numeric impact
    for (const factor of result.factors) {
      expect(typeof factor.description).toBe("string");
      expect(factor.description.length).toBeGreaterThan(0);
      expect(typeof factor.impact).toBe("number");
      expect(factor.impact).toBeGreaterThan(0);
    }
  });

  it("diminishing returns: doubling scopes does not double the score", () => {
    const twoScopes = scoreApp(["read_products", "read_inventory"], null);
    const fourScopes = scoreApp(
      ["read_products", "read_inventory", "read_content", "read_themes"],
      null,
    );
    // 4 scopes should score higher but less than 2x
    expect(fourScopes.score).toBeGreaterThan(twoScopes.score);
    expect(fourScopes.score).toBeLessThan(twoScopes.score * 2);
  });
});

// ---------------------------------------------------------------------------
// scoreStore
// ---------------------------------------------------------------------------

describe("scoreStore", () => {
  it("returns zero score for empty app list", () => {
    const result = scoreStore([]);
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
    expect(result.appCount).toBe(0);
    expect(result.criticalApps).toBe(0);
    expect(result.highApps).toBe(0);
    expect(result.topRiskFactors).toHaveLength(0);
  });

  it("reflects a single app's score", () => {
    const appScore: AppRiskScore = {
      score: 60,
      level: "high",
      factors: [{ description: "Test factor", impact: 5 }],
    };
    const result = scoreStore([appScore]);
    // 0.7 * 60 + 0.3 * 60 = 60
    expect(result.score).toBe(60);
    expect(result.level).toBe("high");
    expect(result.appCount).toBe(1);
    expect(result.highApps).toBe(1);
    expect(result.criticalApps).toBe(0);
  });

  it("counts critical and high apps correctly", () => {
    const apps: AppRiskScore[] = [
      { score: 80, level: "critical", factors: [{ description: "A", impact: 10 }] },
      { score: 60, level: "high", factors: [{ description: "B", impact: 8 }] },
      { score: 55, level: "high", factors: [{ description: "C", impact: 6 }] },
      { score: 10, level: "low", factors: [{ description: "D", impact: 1 }] },
    ];
    const result = scoreStore(apps);
    expect(result.criticalApps).toBe(1);
    expect(result.highApps).toBe(2);
    expect(result.appCount).toBe(4);
  });

  it("store score is dominated by max app score (70% weight)", () => {
    const apps: AppRiskScore[] = [
      { score: 90, level: "critical", factors: [{ description: "Bad", impact: 10 }] },
      { score: 5, level: "low", factors: [{ description: "Fine", impact: 1 }] },
      { score: 5, level: "low", factors: [{ description: "Fine", impact: 1 }] },
    ];
    const result = scoreStore(apps);
    // max=90, mean=33.33, store = 0.7*90 + 0.3*33.33 = 63 + 10 = 73
    expect(result.score).toBe(73);
    expect(result.level).toBe("high");
  });

  it("store score capped at 100", () => {
    const apps: AppRiskScore[] = [
      { score: 100, level: "critical", factors: [{ description: "Max", impact: 20 }] },
      { score: 100, level: "critical", factors: [{ description: "Max", impact: 20 }] },
    ];
    const result = scoreStore(apps);
    expect(result.score).toBe(100);
  });

  it("deduplicates top risk factors", () => {
    const apps: AppRiskScore[] = [
      {
        score: 50,
        level: "medium",
        factors: [
          { description: "Same factor", impact: 5 },
          { description: "Unique A", impact: 3 },
        ],
      },
      {
        score: 40,
        level: "medium",
        factors: [
          { description: "Same factor", impact: 5 },
          { description: "Unique B", impact: 2 },
        ],
      },
    ];
    const result = scoreStore(apps);
    // "Same factor" should appear only once
    const sameCount = result.topRiskFactors.filter((f) => f === "Same factor").length;
    expect(sameCount).toBeLessThanOrEqual(1);
  });

  it("returns at most 3 top risk factors", () => {
    const apps: AppRiskScore[] = [
      {
        score: 50,
        level: "medium",
        factors: [
          { description: "Factor 1", impact: 10 },
          { description: "Factor 2", impact: 9 },
          { description: "Factor 3", impact: 8 },
          { description: "Factor 4", impact: 7 },
        ],
      },
    ];
    const result = scoreStore(apps);
    expect(result.topRiskFactors.length).toBeLessThanOrEqual(3);
  });

  it("sorts top risk factors by impact (highest first)", () => {
    const apps: AppRiskScore[] = [
      {
        score: 50,
        level: "medium",
        factors: [
          { description: "Low impact", impact: 1 },
          { description: "High impact", impact: 10 },
          { description: "Mid impact", impact: 5 },
        ],
      },
    ];
    const result = scoreStore(apps);
    expect(result.topRiskFactors[0]).toBe("High impact");
    expect(result.topRiskFactors[1]).toBe("Mid impact");
    expect(result.topRiskFactors[2]).toBe("Low impact");
  });

  it("handles all-low-risk apps", () => {
    const apps: AppRiskScore[] = [
      { score: 5, level: "low", factors: [] },
      { score: 10, level: "low", factors: [] },
      { score: 3, level: "low", factors: [] },
    ];
    const result = scoreStore(apps);
    expect(result.level).toBe("low");
    expect(result.criticalApps).toBe(0);
    expect(result.highApps).toBe(0);
  });
});
