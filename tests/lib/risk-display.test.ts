/**
 * Tests for app/lib/risk-display.ts
 *
 * All three functions are pure switch-based mappers — no mocking required.
 * Tests cover every explicit case plus a default/unknown input case.
 */

import { describe, it, expect } from "vitest";

import type { ScopeSensitivity } from "../../app/data/category-permissions.server";
import { riskTone, riskLabel, sensitivityTone } from "../../app/lib/risk-display";
import type { RiskLevel } from "../../app/services/permission-scorer.server";

// ---------------------------------------------------------------------------
// riskTone
// ---------------------------------------------------------------------------

describe("riskTone", () => {
  it('returns "critical" for critical risk level', () => {
    expect(riskTone("critical")).toBe("critical");
  });

  it('returns "warning" for high risk level', () => {
    expect(riskTone("high")).toBe("warning");
  });

  it('returns "info" for medium risk level', () => {
    expect(riskTone("medium")).toBe("info");
  });

  it('returns "success" for low risk level', () => {
    expect(riskTone("low")).toBe("success");
  });

  it("returns undefined for an unknown risk level", () => {
    const result = riskTone("unknown" as RiskLevel);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// riskLabel
// ---------------------------------------------------------------------------

describe("riskLabel", () => {
  it('returns "Critical" for critical risk level', () => {
    expect(riskLabel("critical")).toBe("Critical");
  });

  it('returns "High" for high risk level', () => {
    expect(riskLabel("high")).toBe("High");
  });

  it('returns "Medium" for medium risk level', () => {
    expect(riskLabel("medium")).toBe("Medium");
  });

  it('returns "Low" for low risk level', () => {
    expect(riskLabel("low")).toBe("Low");
  });

  it("returns undefined for an unknown risk level", () => {
    const result = riskLabel("unknown" as RiskLevel);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sensitivityTone
// ---------------------------------------------------------------------------

describe("sensitivityTone", () => {
  it('returns "critical" for CRITICAL sensitivity', () => {
    expect(sensitivityTone("CRITICAL")).toBe("critical");
  });

  it('returns "warning" for HIGH sensitivity', () => {
    expect(sensitivityTone("HIGH")).toBe("warning");
  });

  it('returns "info" for MEDIUM sensitivity', () => {
    expect(sensitivityTone("MEDIUM")).toBe("info");
  });

  it('returns "success" for LOW sensitivity', () => {
    expect(sensitivityTone("LOW")).toBe("success");
  });

  it("returns undefined for an unknown sensitivity level", () => {
    const result = sensitivityTone("UNKNOWN" as ScopeSensitivity);
    expect(result).toBeUndefined();
  });
});
