/**
 * Tests for app/lib/findings-tile.ts (gc-j8xq): Home's findings tile counts
 * known malicious code whether or not the merchant ignored it, and is never
 * green while the scan found any.
 */
import { describe, it, expect } from "vitest";

import { buildFindingsTile } from "../../app/lib/findings-tile";

describe("buildFindingsTile (gc-j8xq)", () => {
  it("(a) 2 malicious, both ignored, nothing else -> 2, not success", () => {
    expect(buildFindingsTile({ filteredTotal: 0, maliciousFound: 2, maliciousKept: 0 })).toEqual({
      total: 2,
      tone: "critical",
      securityRisks: 2,
    });
  });

  it("(b) 2 malicious (1 ignored) plus 3 others (1 ignored) -> 4, no double count", () => {
    // Ignore-filtered total: 1 malicious + 2 others = 3. Add the 1 ignored malicious.
    expect(buildFindingsTile({ filteredTotal: 3, maliciousFound: 2, maliciousKept: 1 })).toEqual({
      total: 4,
      tone: "critical",
      securityRisks: 2,
    });
  });

  it("(c) no malicious, everything ignored -> 0, success", () => {
    expect(buildFindingsTile({ filteredTotal: 0, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 0,
      tone: "success",
      securityRisks: 0,
    });
  });

  it("(d) no malicious, normal findings -> the ignore-filtered total, warning", () => {
    expect(buildFindingsTile({ filteredTotal: 7, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 7,
      tone: "warning",
      securityRisks: 0,
    });
  });

  it("malicious findings that are NOT ignored are counted once", () => {
    expect(buildFindingsTile({ filteredTotal: 5, maliciousFound: 2, maliciousKept: 2 })).toEqual({
      total: 5,
      tone: "critical",
      securityRisks: 2,
    });
  });

  it("the number is never lower than the malicious count", () => {
    for (let found = 0; found <= 3; found += 1) {
      for (let kept = 0; kept <= found; kept += 1) {
        for (const others of [0, 4]) {
          const tile = buildFindingsTile({
            filteredTotal: kept + others,
            maliciousFound: found,
            maliciousKept: kept,
          });
          expect(tile.total).toBe(found + others);
          expect(tile.tone === "success").toBe(found + others === 0);
        }
      }
    }
  });

  it("never subtracts when the kept count is above the found count (stale read)", () => {
    expect(buildFindingsTile({ filteredTotal: 3, maliciousFound: 1, maliciousKept: 2 })).toEqual({
      total: 3,
      tone: "critical",
      securityRisks: 1,
    });
  });

  // gc-q5z8: an app named in a security incident is a security risk too.
  it("a non-ignored advisory turns the tile critical and counts as a security risk", () => {
    expect(
      buildFindingsTile({
        filteredTotal: 13,
        maliciousFound: 0,
        maliciousKept: 0,
        advisoryKept: 1,
      }),
    ).toEqual({ total: 13, tone: "critical", securityRisks: 1 });
  });

  it("an ignored advisory (advisoryKept 0) neither counts nor turns the tile red", () => {
    expect(
      buildFindingsTile({ filteredTotal: 4, maliciousFound: 0, maliciousKept: 0, advisoryKept: 0 }),
    ).toEqual({ total: 4, tone: "warning", securityRisks: 0 });
    expect(
      buildFindingsTile({ filteredTotal: 0, maliciousFound: 0, maliciousKept: 0, advisoryKept: 0 }),
    ).toEqual({ total: 0, tone: "success", securityRisks: 0 });
  });

  it("malicious code and advisories add up: every malicious finding plus the kept advisories", () => {
    expect(
      buildFindingsTile({ filteredTotal: 5, maliciousFound: 2, maliciousKept: 1, advisoryKept: 2 }),
    ).toEqual({ total: 6, tone: "critical", securityRisks: 4 });
  });

  // gc-xtno: "k security risks" is the number of banners, not finding lines.
  it("counts distinct risks (the banners) when given: 3 lines on one domain = 1 risk", () => {
    expect(
      buildFindingsTile({
        filteredTotal: 5,
        maliciousFound: 3,
        maliciousKept: 3,
        distinctRisks: 1,
      }),
    ).toEqual({ total: 5, tone: "critical", securityRisks: 1 });
    expect(
      buildFindingsTile({
        filteredTotal: 6,
        maliciousFound: 3,
        maliciousKept: 3,
        advisoryKept: 1,
        distinctRisks: 2,
      }),
    ).toEqual({ total: 6, tone: "critical", securityRisks: 2 });
  });

  it("banners unreadable (distinctRisks 0) on a red tile: falls back to the finding count, never 0", () => {
    expect(
      buildFindingsTile({
        filteredTotal: 3,
        maliciousFound: 3,
        maliciousKept: 3,
        distinctRisks: 0,
      }),
    ).toEqual({ total: 3, tone: "critical", securityRisks: 3 });
  });

  it("no risk in the counts: distinctRisks cannot make the tile red or count a risk", () => {
    expect(
      buildFindingsTile({
        filteredTotal: 4,
        maliciousFound: 0,
        maliciousKept: 0,
        distinctRisks: 2,
      }),
    ).toEqual({ total: 4, tone: "warning", securityRisks: 0 });
  });
});
