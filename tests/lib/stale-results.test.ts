/**
 * Tests for app/lib/stale-results.ts (gc-mgi): the single "theme changed since
 * this scan" condition shared by Home's theme-change nudge and the scan page's
 * stale-results banner, plus the banner's upgrade-ask copy.
 */
import { describe, it, expect } from "vitest";

import { isScanStaleAfterThemeChange, staleResultsUpgradeAsk } from "../../app/lib/stale-results";

const COMPLETED = new Date("2026-09-22T15:00:00Z");
const PUBLISHED_AFTER = new Date("2026-09-22T20:09:00Z");
const PUBLISHED_BEFORE = new Date("2026-09-22T14:00:00Z");

const scan = (overrides: Partial<{ status: string; completedAt: Date | string | null }> = {}) => ({
  status: "COMPLETED",
  completedAt: COMPLETED as Date | string | null,
  ...overrides,
});

describe("isScanStaleAfterThemeChange", () => {
  it("true when the theme was published after a successful scan completed", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: scan(),
      }),
    ).toBe(true);
  });

  it("true for a PARTIAL scan (successful) too", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: scan({ status: "PARTIAL" }),
      }),
    ).toBe(true);
  });

  it("false when the theme was published before the scan completed", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_BEFORE,
        scan: scan(),
      }),
    ).toBe(false);
  });

  it("false when the publish time EQUALS completedAt (strictly after only)", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: new Date(COMPLETED),
        scan: scan(),
      }),
    ).toBe(false);
  });

  it("false when no theme publish was ever recorded", () => {
    expect(
      isScanStaleAfterThemeChange({ autoRescan: false, lastThemePublishAt: null, scan: scan() }),
    ).toBe(false);
  });

  it("false when there is no scan", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: null,
      }),
    ).toBe(false);
  });

  it.each(["PENDING", "IN_PROGRESS", "FAILED"])("false for a %s scan", (status) => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: scan({ status }),
      }),
    ).toBe(false);
  });

  it("false when the scan has no completedAt", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: scan({ completedAt: null }),
      }),
    ).toBe(false);
  });

  it("false when the plan auto-rescans on theme publish (Professional)", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: true,
        lastThemePublishAt: PUBLISHED_AFTER,
        scan: scan(),
      }),
    ).toBe(false);
  });

  it("accepts serialized ISO strings (loader data) as well as Dates", () => {
    expect(
      isScanStaleAfterThemeChange({
        autoRescan: false,
        lastThemePublishAt: PUBLISHED_AFTER.toISOString(),
        scan: scan({ completedAt: COMPLETED.toISOString() }),
      }),
    ).toBe(true);
  });
});

describe("staleResultsUpgradeAsk", () => {
  it("trial framing for a trial-eligible shop", () => {
    expect(staleResultsUpgradeAsk(true)).toBe("Try Standard free for 7 days to scan every week.");
  });

  it("plain upgrade framing for a shop that has had a paid plan", () => {
    expect(staleResultsUpgradeAsk(false)).toBe("Upgrade to Standard to scan every week.");
  });

  it("never uses an em dash", () => {
    for (const eligible of [true, false]) {
      expect(staleResultsUpgradeAsk(eligible)).not.toContain("—");
    }
  });
});
