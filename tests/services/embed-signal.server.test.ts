import { describe, it, expect } from "vitest";

import {
  compareEmbedSignals,
  MAX_EMBED_CHECK_HANDLES,
} from "../../app/services/embed-signal.server";

describe("compareEmbedSignals (gc-uczg, log only)", () => {
  it("lists each source and the two one-sided differences, sorted", () => {
    expect(
      compareEmbedSignals({
        storefrontBlockHandles: ["seo-king", "judge-me-reviews", "bucks"],
        settingsEmbedHandles: ["judge-me-reviews", "klaviyo-email-marketing-sms"],
        extensionHandles: ["pushowl"],
      }),
    ).toEqual({
      storefrontBlocks: ["bucks", "judge-me-reviews", "seo-king"],
      settingsEmbeds: ["judge-me-reviews", "klaviyo-email-marketing-sms"],
      extensions: ["pushowl"],
      onlyOnStorefront: ["bucks", "seo-king"],
      onlyInSettings: ["klaviyo-email-marketing-sms"],
    });
  });

  it("all empty: no differences", () => {
    expect(
      compareEmbedSignals({
        storefrontBlockHandles: [],
        settingsEmbedHandles: [],
        extensionHandles: [],
      }),
    ).toEqual({
      storefrontBlocks: [],
      settingsEmbeds: [],
      extensions: [],
      onlyOnStorefront: [],
      onlyInSettings: [],
    });
  });

  it("lower-cases and de-duplicates before comparing", () => {
    const r = compareEmbedSignals({
      storefrontBlockHandles: ["Judge-Me-Reviews", "judge-me-reviews"],
      settingsEmbedHandles: ["JUDGE-ME-REVIEWS"],
      extensionHandles: [],
    });
    expect(r.storefrontBlocks).toEqual(["judge-me-reviews"]);
    expect(r.onlyOnStorefront).toEqual([]);
    expect(r.onlyInSettings).toEqual([]);
  });

  it.each([
    ["HTML", "<script>alert(1)</script>"],
    ["a path", "x/../../etc"],
    ["an email", "jane@example.com"],
    ["whitespace", "judge me"],
    ["a Kelvin sign that lower-cases to ASCII", "\u212Aaviyo"],
    ["a dotted capital I", "\u0130nstafeed"],
    ["full-width letters", "ｊｕｄｇｅ"],
    ["zero-width space", "judge​me"],
    ["too long", "a".repeat(101)],
    ["empty", ""],
  ])("drops a handle that is %s (theme-authored settings_data is untrusted)", (_label, bad) => {
    const r = compareEmbedSignals({
      storefrontBlockHandles: [bad],
      settingsEmbedHandles: [bad],
      extensionHandles: [bad],
    });
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        storefrontBlocks: [],
        settingsEmbeds: [],
        extensions: [],
        onlyOnStorefront: [],
        onlyInSettings: [],
      }),
    );
  });

  it("caps every list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `app-${i}`);
    const r = compareEmbedSignals({
      storefrontBlockHandles: many,
      settingsEmbedHandles: many.map((h) => `${h}-x`),
      extensionHandles: many,
    });
    for (const list of Object.values(r))
      expect(list.length).toBeLessThanOrEqual(MAX_EMBED_CHECK_HANDLES);
  });
});
