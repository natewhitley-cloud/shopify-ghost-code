import { FindingType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isAdvisoryCheckLive,
  isHomepageMaliciousCheckLive,
  isRuntimeMaliciousCheckLive,
  isScriptTagSunsetLive,
  isSoftLaunchLive,
  SOFT_LAUNCH_FLAGS,
} from "../../app/services/soft-launch-flags.server";

const FLAG = "SCRIPT_TAG_SUNSET_LIVE_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("soft-launch flags", () => {
  it("maps SCRIPT_TAG_SUNSET to its own flag", () => {
    expect(SOFT_LAUNCH_FLAGS[FindingType.SCRIPT_TAG_SUNSET]).toBe(FLAG);
  });

  it("treats a type without a flag as always live", () => {
    expect(isSoftLaunchLive(FindingType.GHOST_SCRIPT)).toBe(true);
  });

  it.each([[undefined], [""], ["false"], ["1"], ["TRUE"], [" true"]])(
    'keeps SCRIPT_TAG_SUNSET dark for %j (only the exact string "true" enables it)',
    (value) => {
      if (value !== undefined) process.env[FLAG] = value;
      expect(isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET)).toBe(false);
      expect(isScriptTagSunsetLive()).toBe(false);
    },
  );

  it("LIQUID_ERROR_RENDERED shares the storefront request's flag (gc-i6du): dark and live together", () => {
    expect(SOFT_LAUNCH_FLAGS[FindingType.LIQUID_ERROR_RENDERED]).toBe(FLAG);
    expect(isSoftLaunchLive(FindingType.LIQUID_ERROR_RENDERED)).toBe(false);
    process.env[FLAG] = "1";
    expect(isSoftLaunchLive(FindingType.LIQUID_ERROR_RENDERED)).toBe(false);
    process.env[FLAG] = "true";
    expect(isSoftLaunchLive(FindingType.LIQUID_ERROR_RENDERED)).toBe(true);
    expect(isScriptTagSunsetLive()).toBe(true);
  });

  describe("APP_INCIDENT_ADVISORY (gc-14x5)", () => {
    const ADVISORY_FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";
    // A day on which the list's entry is active, so these tests do not start
    // failing when it reaches its review date (the review-date test does that).
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
      delete process.env[ADVISORY_FLAG];
    });

    describe("expiry: live needs an unexpired list entry as well as the flag", () => {
      // Live while ANY entry is unexpired: the list's last review date is
      // Swym Wishlist Plus, 2027-01-12 (Hulk's 2027-01-08 alone is not enough).
      it.each([
        ["after the first entry expired (Hulk, 2027-01-08)", "2027-01-09T00:00:00Z", true],
        ["the day before the last review date", "2027-01-11T12:00:00Z", true],
        ["on the last review date", "2027-01-12T23:59:59Z", true],
        ["the day after", "2027-01-13T00:00:00Z", false],
        ["long after", "2028-06-01T00:00:00Z", false],
      ])("flag on, %s: live is %s", (_label, iso, expected) => {
        process.env[ADVISORY_FLAG] = "true";
        expect(isAdvisoryCheckLive(new Date(iso))).toBe(expected);
        vi.setSystemTime(new Date(iso));
        expect(isAdvisoryCheckLive()).toBe(expected);
        expect(isSoftLaunchLive(FindingType.APP_INCIDENT_ADVISORY)).toBe(expected);
      });

      it("flag off: never live, expired or not", () => {
        expect(isAdvisoryCheckLive(new Date("2026-10-20T00:00:00Z"))).toBe(false);
        expect(isAdvisoryCheckLive(new Date("2027-06-01T00:00:00Z"))).toBe(false);
      });

      it("after expiry the type drops out of the live set; no other type does", () => {
        process.env[ADVISORY_FLAG] = "true";
        const live = () => Object.values(FindingType).filter((t) => isSoftLaunchLive(t));
        const before = live();
        vi.setSystemTime(new Date("2027-01-13T00:00:00Z"));
        const after = live();
        expect(before).toContain(FindingType.APP_INCIDENT_ADVISORY);
        expect(after).toEqual(before.filter((t) => t !== FindingType.APP_INCIDENT_ADVISORY));
      });

      it("is safe as a filter callback (the array index is not read as a clock)", () => {
        process.env[ADVISORY_FLAG] = "true";
        expect(
          [FindingType.GHOST_SCRIPT, FindingType.APP_INCIDENT_ADVISORY].filter(isSoftLaunchLive),
        ).toEqual([FindingType.GHOST_SCRIPT, FindingType.APP_INCIDENT_ADVISORY]);
      });
    });

    it("has its own flag, shared with no other type", () => {
      expect(SOFT_LAUNCH_FLAGS[FindingType.APP_INCIDENT_ADVISORY]).toBe(ADVISORY_FLAG);
      const sharing = Object.entries(SOFT_LAUNCH_FLAGS).filter(
        ([, flag]) => flag === ADVISORY_FLAG,
      );
      expect(sharing.map(([type]) => type)).toEqual(["APP_INCIDENT_ADVISORY"]);
    });

    it.each([[undefined], [""], ["false"], ["1"], ["TRUE"], [" true"], ["true "]])(
      'is dark for %j (the production default; only the exact string "true" enables it)',
      (value) => {
        if (value !== undefined) process.env[ADVISORY_FLAG] = value;
        expect(isSoftLaunchLive(FindingType.APP_INCIDENT_ADVISORY)).toBe(false);
      },
    );

    it('is live for "true", and switches nothing else on', () => {
      process.env[ADVISORY_FLAG] = "true";
      expect(isSoftLaunchLive(FindingType.APP_INCIDENT_ADVISORY)).toBe(true);
      expect(isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET)).toBe(false);
      expect(isSoftLaunchLive(FindingType.APP_EMBED_OFF)).toBe(false);
      expect(isScriptTagSunsetLive()).toBe(false);
    });

    it("another flag does not switch it on, and MALICIOUS_SCRIPT has no flag at all", () => {
      process.env[FLAG] = "true";
      expect(isSoftLaunchLive(FindingType.APP_INCIDENT_ADVISORY)).toBe(false);
      expect(SOFT_LAUNCH_FLAGS[FindingType.MALICIOUS_SCRIPT]).toBeUndefined();
      expect(isSoftLaunchLive(FindingType.MALICIOUS_SCRIPT)).toBe(true);
    });
  });

  it('enables SCRIPT_TAG_SUNSET for "true", through the same helper', () => {
    process.env[FLAG] = "true";
    expect(isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET)).toBe(true);
    expect(isScriptTagSunsetLive()).toBe(true);
  });
});

describe("isRuntimeMaliciousCheckLive (gc-0htk)", () => {
  afterEach(() => {
    delete process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED;
  });

  it("is live only when RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED is exactly 'true'", () => {
    expect(isRuntimeMaliciousCheckLive()).toBe(false);
    for (const v of ["false", "1", "TRUE", " true", ""]) {
      process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED = v;
      expect(isRuntimeMaliciousCheckLive(), v).toBe(false);
    }
    process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED = "true";
    expect(isRuntimeMaliciousCheckLive()).toBe(true);
  });

  it("never soft-launches MALICIOUS_SCRIPT itself: the theme detector stays live with the flag off", () => {
    expect(SOFT_LAUNCH_FLAGS).not.toHaveProperty(FindingType.MALICIOUS_SCRIPT);
    expect(isSoftLaunchLive(FindingType.MALICIOUS_SCRIPT)).toBe(true);
  });
});

describe("isHomepageMaliciousCheckLive (gc-0htk, gc-3y89 #6)", () => {
  afterEach(() => {
    delete process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED;
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])("runtime %s, script-tag audit %s: %s", (runtime, scriptTags, expected) => {
    if (runtime) process.env.RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED = "true";
    if (scriptTags) process.env[FLAG] = "true";
    expect(isHomepageMaliciousCheckLive()).toBe(expected);
  });
});
