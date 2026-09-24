/**
 * Tests for app/lib/upgrade-preview.ts (gc-97k.4): the free-tier teaser's
 * hidden-finding count + per-lane breakdown, and its headline copy.
 *
 * Lanes used below (primary lane per finding-consequence.ts):
 *   GHOST_SCRIPT, GHOST_STYLE      -> Speed
 *   GHOST_HREFLANG, DUPLICATE_META -> Found by Google & AI
 *   GHOST_SNIPPET                  -> Customers see it
 *   GHOST_PIXEL                    -> Still tracking you
 *   ORPHAN_ASSET, SETTINGS_DRIFT   -> Housekeeping
 *   MALICIOUS_SCRIPT               -> (privacy lane, but NEVER counted as hidden)
 */
import { describe, it, expect } from "vitest";

import {
  buildUpgradePreview,
  UPGRADE_PREVIEW_MAX_GROUPS,
  upgradePreviewHeadline,
} from "../../app/lib/upgrade-preview";

describe("buildUpgradePreview", () => {
  it("breaks mixed categories down by lane, largest first, excluding the preview row", () => {
    // 13 findings; the preview (a GHOST_SCRIPT) is shown, so 12 are hidden.
    const preview = buildUpgradePreview(
      { GHOST_SCRIPT: 3, GHOST_STYLE: 2, GHOST_HREFLANG: 4, DUPLICATE_META: 1, ORPHAN_ASSET: 3 },
      "GHOST_SCRIPT",
    );
    expect(preview).toEqual({
      hiddenCount: 12,
      groups: [
        { label: "Found by Google & AI", count: 5 },
        { label: "Speed", count: 4 },
        { label: "Housekeeping", count: 3 },
      ],
    });
  });

  it("returns a single group when every hidden finding is in one lane", () => {
    expect(buildUpgradePreview({ GHOST_SCRIPT: 4, GHOST_STYLE: 3 }, "GHOST_STYLE")).toEqual({
      hiddenCount: 6,
      groups: [{ label: "Speed", count: 6 }],
    });
  });

  it("lists exactly four lanes by name when four lanes have hidden findings", () => {
    const preview = buildUpgradePreview(
      { GHOST_SCRIPT: 5, GHOST_HREFLANG: 4, GHOST_SNIPPET: 3, ORPHAN_ASSET: 2 },
      "GHOST_SCRIPT",
    );
    expect(preview?.groups.map((g) => g.label)).toEqual([
      "Found by Google & AI",
      "Speed",
      "Customers see it",
      "Housekeeping",
    ]);
    expect(preview?.groups).toHaveLength(UPGRADE_PREVIEW_MAX_GROUPS);
  });

  it("folds the smallest lanes into 'Other' when more than four lanes have hidden findings", () => {
    const preview = buildUpgradePreview(
      { GHOST_SCRIPT: 6, GHOST_HREFLANG: 5, GHOST_SNIPPET: 4, GHOST_PIXEL: 2, ORPHAN_ASSET: 1 },
      "GHOST_SCRIPT",
    );
    expect(preview).toEqual({
      hiddenCount: 17,
      groups: [
        // Speed and Google & AI tie at 5: canonical lane order puts Google & AI first.
        { label: "Found by Google & AI", count: 5 },
        { label: "Speed", count: 5 },
        { label: "Customers see it", count: 4 },
        { label: "Other", count: 3 },
      ],
    });
    // The groups always sum to the headline count.
    const sum = preview!.groups.reduce((n, g) => n + g.count, 0);
    expect(sum).toBe(preview!.hiddenCount);
  });

  it("breaks count ties by the canonical lane order (Customers see it before Speed)", () => {
    const preview = buildUpgradePreview({ GHOST_SCRIPT: 2, GHOST_SNIPPET: 3 }, "GHOST_SNIPPET");
    expect(preview?.groups).toEqual([
      { label: "Customers see it", count: 2 },
      { label: "Speed", count: 2 },
    ]);
  });

  describe("MALICIOUS_SCRIPT is never paywalled", () => {
    it("excludes malicious findings from the hidden count and the breakdown", () => {
      const preview = buildUpgradePreview(
        { MALICIOUS_SCRIPT: 7, GHOST_PIXEL: 2, GHOST_SCRIPT: 2 },
        "GHOST_SCRIPT",
      );
      // Without the exclusion, privacy ("Still tracking you") would read 9.
      expect(preview).toEqual({
        hiddenCount: 3,
        groups: [
          { label: "Still tracking you", count: 2 },
          { label: "Speed", count: 1 },
        ],
      });
    });

    it("hides nothing when the only other findings are malicious (3 malicious + 1 preview)", () => {
      expect(buildUpgradePreview({ MALICIOUS_SCRIPT: 3, GHOST_SCRIPT: 1 }, "GHOST_SCRIPT")).toBe(
        null,
      );
    });

    it("hides nothing when every finding is malicious", () => {
      expect(buildUpgradePreview({ MALICIOUS_SCRIPT: 5 }, "MALICIOUS_SCRIPT")).toBeNull();
    });
  });

  it("returns null when the preview is the only finding (zero hidden, so no teaser)", () => {
    expect(buildUpgradePreview({ GHOST_SCRIPT: 1 }, "GHOST_SCRIPT")).toBeNull();
  });

  it("returns null for an empty or all-zero summary and never goes negative", () => {
    expect(buildUpgradePreview({}, "GHOST_SCRIPT")).toBeNull();
    expect(buildUpgradePreview({ GHOST_SCRIPT: 0, GHOST_STYLE: 0 }, "GHOST_SCRIPT")).toBeNull();
  });

  it("does not mutate the caller's counts", () => {
    const byType = { GHOST_SCRIPT: 3, MALICIOUS_SCRIPT: 2 };
    buildUpgradePreview(byType, "GHOST_SCRIPT");
    expect(byType).toEqual({ GHOST_SCRIPT: 3, MALICIOUS_SCRIPT: 2 });
  });
});

describe("upgradePreviewHeadline", () => {
  it("pluralizes and lists each lane with its count", () => {
    expect(
      upgradePreviewHeadline({
        hiddenCount: 12,
        groups: [
          { label: "Found by Google & AI", count: 5 },
          { label: "Speed", count: 4 },
          { label: "Housekeeping", count: 3 },
        ],
      }),
    ).toBe("12 more findings on Standard: Found by Google & AI (5), Speed (4), Housekeeping (3).");
  });

  it("uses the singular for exactly one hidden finding", () => {
    expect(upgradePreviewHeadline({ hiddenCount: 1, groups: [{ label: "Speed", count: 1 }] })).toBe(
      "1 more finding on Standard: Speed (1).",
    );
  });

  it("renders the Other bucket like any lane", () => {
    expect(
      upgradePreviewHeadline({
        hiddenCount: 9,
        groups: [
          { label: "Speed", count: 4 },
          { label: "Other", count: 5 },
        ],
      }),
    ).toBe("9 more findings on Standard: Speed (4), Other (5).");
  });

  it("never contains an em dash or mentions security or malicious alerts", () => {
    const text = upgradePreviewHeadline(
      buildUpgradePreview(
        { MALICIOUS_SCRIPT: 2, GHOST_PIXEL: 3, GHOST_SCRIPT: 2, GHOST_HREFLANG: 1 },
        "GHOST_SCRIPT",
      )!,
    );
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/malicious|security|attack|threat/i);
  });
});
