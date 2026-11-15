import { describe, expect, it } from "vitest";

import { pickScanNotice, SCAN_NOTICE_PRIORITY } from "../../app/lib/scan-notice";

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
