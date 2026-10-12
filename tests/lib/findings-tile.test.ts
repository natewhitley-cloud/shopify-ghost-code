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
    });
  });

  it("(b) 2 malicious (1 ignored) plus 3 others (1 ignored) -> 4, no double count", () => {
    // Ignore-filtered total: 1 malicious + 2 others = 3. Add the 1 ignored malicious.
    expect(buildFindingsTile({ filteredTotal: 3, maliciousFound: 2, maliciousKept: 1 })).toEqual({
      total: 4,
      tone: "critical",
    });
  });

  it("(c) no malicious, everything ignored -> 0, success", () => {
    expect(buildFindingsTile({ filteredTotal: 0, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 0,
      tone: "success",
    });
  });

  it("(d) no malicious, normal findings -> the ignore-filtered total, warning", () => {
    expect(buildFindingsTile({ filteredTotal: 7, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 7,
      tone: "warning",
    });
  });

  it("malicious findings that are NOT ignored are counted once", () => {
    expect(buildFindingsTile({ filteredTotal: 5, maliciousFound: 2, maliciousKept: 2 })).toEqual({
      total: 5,
      tone: "critical",
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
    });
  });
});
