/**
 * Tests for app/lib/install-source.ts (gc-3twe): the answer parser and the
 * card's eligibility rule.
 */
import { describe, it, expect } from "vitest";

import {
  INSTALL_SOURCE_COPY,
  INSTALL_SOURCE_OPTIONS,
  INSTALL_SOURCE_OTHER_MAX_LEN,
  parseInstallSourceAnswer,
  shouldShowInstallSourceCard,
} from "../../app/lib/install-source";

describe("parseInstallSourceAnswer", () => {
  it.each(INSTALL_SOURCE_OPTIONS.filter((o) => o.value !== "other").map((o) => o.value))(
    "accepts %s with no other text",
    (source) => {
      expect(parseInstallSourceAnswer({ source })).toEqual({ source, other: null });
    },
  );

  it.each(INSTALL_SOURCE_OPTIONS.filter((o) => o.value !== "other").map((o) => o.value))(
    "ignores other text sent with %s",
    (source) => {
      expect(parseInstallSourceAnswer({ source, other: "a podcast" })).toEqual({
        source,
        other: null,
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["null (field absent)", null],
    ["blank", ""],
    ["unknown", "tiktok"],
    ["case variant", "Sidekick"],
    ["label instead of value", "Shopify Sidekick"],
    ["number", 3],
  ])("returns null for a %s choice", (_label, source) => {
    expect(parseInstallSourceAnswer({ source, other: "x" })).toBeNull();
  });

  it("other: keeps the text, trimmed", () => {
    expect(parseInstallSourceAnswer({ source: "other", other: "  a podcast  " })).toEqual({
      source: "other",
      other: "a podcast",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", ""],
    ["whitespace", "   \t"],
    ["non-string", 42],
  ])("other: %s text is stored as null (the choice still counts)", (_label, other) => {
    expect(parseInstallSourceAnswer({ source: "other", other })).toEqual({
      source: "other",
      other: null,
    });
  });

  it("other: keeps text of exactly the cap and truncates longer text", () => {
    const exact = "a".repeat(INSTALL_SOURCE_OTHER_MAX_LEN);
    expect(parseInstallSourceAnswer({ source: "other", other: exact })?.other).toBe(exact);
    const long = "b".repeat(INSTALL_SOURCE_OTHER_MAX_LEN + 50);
    expect(parseInstallSourceAnswer({ source: "other", other: long })?.other).toBe(
      "b".repeat(INSTALL_SOURCE_OTHER_MAX_LEN),
    );
  });

  it("other: trims before applying the cap", () => {
    const text = `   ${"c".repeat(INSTALL_SOURCE_OTHER_MAX_LEN)}   `;
    expect(parseInstallSourceAnswer({ source: "other", other: text })?.other).toBe(
      "c".repeat(INSTALL_SOURCE_OTHER_MAX_LEN),
    );
  });
});

describe("INSTALL_SOURCE_COPY", () => {
  it("never says 'first scan' (existing merchants see it after any later scan)", () => {
    expect(INSTALL_SOURCE_COPY.heading).toBe("One quick question: how did you find GhostCode?");
    expect(INSTALL_SOURCE_COPY.body).toBe(
      "Knowing where merchants hear about us helps us reach more stores like yours. We only ask once.",
    );
    for (const text of Object.values(INSTALL_SOURCE_COPY)) {
      expect(text.toLowerCase()).not.toContain("first scan");
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("shouldShowInstallSourceCard", () => {
  const ELIGIBLE = {
    hasResults: true,
    isInternal: false,
    installSourceAnsweredAt: null,
    installSourceSkippedAt: null,
  };
  const DATE = new Date("2026-10-27T00:00:00Z");

  it("shows with results to a non-internal shop that neither answered nor skipped", () => {
    expect(shouldShowInstallSourceCard(ELIGIBLE)).toBe(true);
  });

  it.each([
    ["no results yet", { hasResults: false }],
    ["an internal store", { isInternal: true }],
    ["already answered", { installSourceAnsweredAt: DATE }],
    ["already skipped", { installSourceSkippedAt: DATE }],
  ])("hides for %s", (_label, override) => {
    expect(shouldShowInstallSourceCard({ ...ELIGIBLE, ...override })).toBe(false);
  });
});
