/**
 * Tests for app/lib/upgrade-return.ts (gc-97k.9): when the Free return-visit
 * upgrade banner may show, before the cross-prompt cap.
 */
import { describe, it, expect } from "vitest";

import { PROMPT_CAP_WINDOW_MS } from "../../app/lib/prompt-cap";
import {
  isUpgradeReturnEligible,
  isUpgradeReturnEpisodeOpen,
  UPGRADE_RETURN_DISMISS_LABEL,
  UPGRADE_RETURN_HEADING,
  UPGRADE_RETURN_MAX_DISMISSALS,
  UPGRADE_RETURN_MIN_AGE_MS,
  UPGRADE_RETURN_RESHOW_MS,
} from "../../app/lib/upgrade-return";
import type { UpgradeReturnState } from "../../app/lib/upgrade-return";

const NOW = new Date("2026-09-26T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A Free shop whose first scan was 3 days ago, never shown the banner. */
function state(overrides: Partial<UpgradeReturnState> = {}): UpgradeReturnState {
  return {
    plan: "free",
    firstSuccessfulScanAt: ago(3 * DAY),
    upgradeReturnLastShownAt: null,
    upgradeReturnLastDismissedAt: null,
    upgradeReturnDismissCount: 0,
    ...overrides,
  };
}

const eligible = (s: UpgradeReturnState) => isUpgradeReturnEligible(s, NOW);

describe("constants", () => {
  it("are 24h, 7d and 3 dismissals, with neutral copy and no em dash", () => {
    expect(UPGRADE_RETURN_MIN_AGE_MS).toBe(DAY);
    expect(UPGRADE_RETURN_RESHOW_MS).toBe(7 * DAY);
    expect(UPGRADE_RETURN_MAX_DISMISSALS).toBe(3);
    expect(UPGRADE_RETURN_HEADING).toBe("Ready to clean up the rest?");
    expect(UPGRADE_RETURN_DISMISS_LABEL).toBe("Not now");
    expect(`${UPGRADE_RETURN_HEADING}${UPGRADE_RETURN_DISMISS_LABEL}`).not.toMatch(/[–—]/);
  });
});

describe("isUpgradeReturnEligible", () => {
  it("is eligible for a Free shop 24h+ after its first successful scan, never shown", () => {
    expect(eligible(state())).toBe(true);
  });

  describe("first successful scan age", () => {
    it("is eligible at exactly 24h", () => {
      expect(eligible(state({ firstSuccessfulScanAt: ago(DAY) }))).toBe(true);
    });

    it("is not eligible at 23h59m", () => {
      expect(eligible(state({ firstSuccessfulScanAt: ago(DAY - MIN) }))).toBe(false);
    });

    it("is not eligible 1ms short of 24h", () => {
      expect(eligible(state({ firstSuccessfulScanAt: ago(DAY - 1) }))).toBe(false);
    });

    it("is not eligible with no successful scan", () => {
      expect(eligible(state({ firstSuccessfulScanAt: null }))).toBe(false);
    });
  });

  it.each(["Standard", "Professional", "standard", ""])("is never eligible on plan %j", (plan) => {
    expect(eligible(state({ plan }))).toBe(false);
  });

  // Hidden findings are no longer part of the SHOP-level rule (owner decision
  // 1A): whether a page has something to show is page renderability, pinned in
  // tests/lib/prompt-cap.test.ts (scanResultsPrompts).

  describe("dismissals", () => {
    it.each([0, 1, 2])("is eligible after %i dismissals", (count) => {
      expect(eligible(state({ upgradeReturnDismissCount: count }))).toBe(true);
    });

    it.each([3, 4, 99])("is retired after %i dismissals", (count) => {
      expect(eligible(state({ upgradeReturnDismissCount: count }))).toBe(false);
    });

    it("is retired at 3 even inside an open episode", () => {
      expect(
        eligible(state({ upgradeReturnDismissCount: 3, upgradeReturnLastShownAt: ago(HOUR) })),
      ).toBe(false);
    });
  });

  describe("weekly re-show", () => {
    it("starts a new episode exactly 7 days after the last one started", () => {
      expect(eligible(state({ upgradeReturnLastShownAt: ago(7 * DAY) }))).toBe(true);
    });

    it("does not start a new episode 1ms short of 7 days", () => {
      expect(eligible(state({ upgradeReturnLastShownAt: ago(7 * DAY - 1) }))).toBe(false);
    });

    it("does not re-show after the episode's 24h has passed (day 2 through day 6)", () => {
      for (const d of [1, 2, 6]) {
        expect(eligible(state({ upgradeReturnLastShownAt: ago(d * DAY) }))).toBe(false);
      }
    });

    it("re-shows weekly after a dismissal, while under the retirement count", () => {
      expect(
        eligible(
          state({
            upgradeReturnLastShownAt: ago(8 * DAY),
            upgradeReturnLastDismissedAt: ago(8 * DAY - HOUR),
            upgradeReturnDismissCount: 2,
          }),
        ),
      ).toBe(true);
    });
  });

  describe("reload persistence inside an episode", () => {
    it("stays eligible within 24h of the episode start (so reloads keep it)", () => {
      expect(eligible(state({ upgradeReturnLastShownAt: ago(23 * HOUR) }))).toBe(true);
    });

    it("stops being eligible once dismissed in this episode", () => {
      expect(
        eligible(
          state({
            upgradeReturnLastShownAt: ago(2 * HOUR),
            upgradeReturnLastDismissedAt: ago(HOUR),
            upgradeReturnDismissCount: 1,
          }),
        ),
      ).toBe(false);
    });
  });
});

describe("isUpgradeReturnEpisodeOpen", () => {
  const episode = (lastShown: Date | null, lastDismissed: Date | null = null) =>
    isUpgradeReturnEpisodeOpen(
      { upgradeReturnLastShownAt: lastShown, upgradeReturnLastDismissedAt: lastDismissed },
      NOW,
    );

  it("is closed when never shown", () => {
    expect(episode(null)).toBe(false);
  });

  it("is open just under the 24h cap window and closed at exactly 24h", () => {
    expect(episode(ago(PROMPT_CAP_WINDOW_MS - 1))).toBe(true);
    expect(episode(ago(PROMPT_CAP_WINDOW_MS))).toBe(false);
  });

  it("is closed by a dismissal at or after its start, open if the dismissal predates it", () => {
    expect(episode(ago(2 * HOUR), ago(HOUR))).toBe(false);
    expect(episode(ago(2 * HOUR), ago(2 * HOUR))).toBe(false);
    expect(episode(ago(2 * HOUR), ago(8 * DAY))).toBe(true);
  });
});
