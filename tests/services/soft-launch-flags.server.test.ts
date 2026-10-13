import { FindingType } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import {
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
    afterEach(() => {
      delete process.env[ADVISORY_FLAG];
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
