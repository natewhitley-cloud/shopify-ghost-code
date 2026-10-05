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

  it('enables SCRIPT_TAG_SUNSET for "true", through the same helper', () => {
    process.env[FLAG] = "true";
    expect(isSoftLaunchLive(FindingType.SCRIPT_TAG_SUNSET)).toBe(true);
    expect(isScriptTagSunsetLive()).toBe(true);
  });
});
