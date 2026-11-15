import { describe, expect, it } from "vitest";

import {
  pickScanNotice,
  SCAN_NOTICE_PRIORITY,
  scanTeaserHeld,
  visibleScanNotice,
} from "../../app/lib/scan-notice";

describe("pickScanNotice (decision A)", () => {
  it("priority: return banner, then teaser, then stale results", () => {
    expect(SCAN_NOTICE_PRIORITY).toEqual(["upgrade_return", "upgrade_preview", "stale_results"]);
  });

  it("nothing wants the slot: null", () => {
    expect(pickScanNotice({})).toBeNull();
    expect(
      pickScanNotice({ upgrade_return: false, upgrade_preview: false, stale_results: false }),
    ).toBeNull();
  });

  it.each([
    [{ upgrade_return: true, upgrade_preview: true }, "upgrade_return"],
    [{ upgrade_return: true, stale_results: true }, "upgrade_return"],
    [{ upgrade_preview: true, stale_results: true }, "upgrade_preview"],
    [{ upgrade_return: true, upgrade_preview: true, stale_results: true }, "upgrade_return"],
  ] as const)("competing %j: %s wins", (candidates, winner) => {
    expect(pickScanNotice(candidates)).toBe(winner);
  });

  it.each(["upgrade_return", "upgrade_preview", "stale_results"] as const)("alone: %s", (key) => {
    expect(pickScanNotice({ [key]: true })).toBe(key);
  });
});

describe("visibleScanNotice (audit r1 M3)", () => {
  it("before Not now: the picked notice", () => {
    for (const key of [...SCAN_NOTICE_PRIORITY, null]) {
      expect(visibleScanNotice(key, false)).toBe(key);
    }
  });

  it.each([...SCAN_NOTICE_PRIORITY, null])(
    "after Not now the slot stays empty, even when %s is picked next",
    (key) => {
      expect(visibleScanNotice(key, true)).toBeNull();
    },
  );
});

describe("scanTeaserHeld (audit r2 M1)", () => {
  const now = new Date("2026-03-25T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const DAY = 24 * 60 * 60 * 1000;

  it("never dismissed: not held", () => {
    expect(scanTeaserHeld(null, now)).toBe(false);
  });

  it("dismissed within the last 24h: held", () => {
    expect(scanTeaserHeld(ago(0), now)).toBe(true);
    expect(scanTeaserHeld(ago(DAY - 1), now)).toBe(true);
  });

  it("exactly 24h or longer ago: no longer held", () => {
    expect(scanTeaserHeld(ago(DAY), now)).toBe(false);
    expect(scanTeaserHeld(ago(3 * DAY), now)).toBe(false);
  });
});
