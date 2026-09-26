/**
 * Tests for app/lib/prompt-eligibility.ts (gc-97k.6, owner decision 1A): the
 * ONE shop-level eligibility function both pages use, and the predicate that
 * decides whether the first-successful-scan read is needed at all.
 */
import { describe, it, expect } from "vitest";

import {
  firstSuccessfulScanNeeded,
  shopPromptEligibility,
  upgradeReturnPossible,
} from "../../app/lib/prompt-eligibility";
import type { ShopPromptState } from "../../app/lib/prompt-eligibility";

const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** Just the eligible keys (the eligibleSince half has its own tests). */
const keys = (s: ShopPromptState, now: Date) => shopPromptEligibility(s, now).eligible;

/**
 * A Free shop installed 10 days ago whose first successful scan (and first
 * results view) was 3 days ago: eligible for all three prompts.
 */
function state(overrides: Partial<ShopPromptState> = {}): ShopPromptState {
  return {
    plan: "free",
    installedAt: ago(10 * DAY),
    firstSuccessfulScanAt: ago(3 * DAY),
    latestScanNonMaliciousCount: 10,
    firstResultsViewedAt: ago(3 * DAY),
    reviewPopupRequestedAt: null,
    reviewPopupRetryAfter: null,
    reviewPopupAttemptCount: 0,
    reviewPopupLastAttemptAt: null,
    upgradeReturnLastShownAt: null,
    upgradeReturnLastDismissedAt: null,
    upgradeReturnDismissCount: 0,
    feedbackNudgeDismissedAt: null,
    feedbackSubmittedAt: null,
    ...overrides,
  };
}

describe("shopPromptEligibility", () => {
  it("returns every eligible prompt in priority order", () => {
    expect(keys(state(), NOW)).toEqual(["review_popup", "upgrade_return", "feedback"]);
  });

  it("drops review_popup once requested", () => {
    expect(keys(state({ reviewPopupRequestedAt: ago(DAY) }), NOW)).toEqual([
      "upgrade_return",
      "feedback",
    ]);
  });

  it("drops review_popup before the first results view is 2h old", () => {
    expect(keys(state({ firstResultsViewedAt: ago(2 * HOUR - 1) }), NOW)).not.toContain(
      "review_popup",
    );
  });

  it.each(["Standard", "Professional"])("drops upgrade_return on a paid %s shop", (plan) => {
    expect(keys(state({ plan }), NOW)).toEqual(["review_popup", "feedback"]);
  });

  it("drops upgrade_return after three dismissals", () => {
    expect(keys(state({ upgradeReturnDismissCount: 3 }), NOW)).not.toContain("upgrade_return");
  });

  it("drops feedback once dismissed or submitted", () => {
    expect(keys(state({ feedbackNudgeDismissedAt: ago(DAY) }), NOW)).not.toContain("feedback");
    expect(keys(state({ feedbackSubmittedAt: ago(DAY) }), NOW)).not.toContain("feedback");
  });

  it("drops upgrade_return and feedback when there is no successful scan", () => {
    expect(keys(state({ firstSuccessfulScanAt: null }), NOW)).toEqual(["review_popup"]);
  });

  it("is independent of any page: the same state always yields the same list", () => {
    expect(keys(state(), NOW)).toEqual(keys(state(), NOW));
  });

  it("returns nothing for a brand-new shop", () => {
    expect(
      keys(
        state({ installedAt: NOW, firstSuccessfulScanAt: null, firstResultsViewedAt: null }),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("firstSuccessfulScanNeeded", () => {
  const base = {
    plan: "Standard",
    upgradeReturnDismissCount: 0,
    installedAt: ago(DAY),
    feedbackNudgeDismissedAt: null as Date | null,
    feedbackSubmittedAt: null as Date | null,
  };

  it("is true for a Free shop that has not retired the return banner", () => {
    expect(firstSuccessfulScanNeeded({ ...base, plan: "free" }, NOW)).toBe(true);
    expect(
      firstSuccessfulScanNeeded({ ...base, plan: "free", upgradeReturnDismissCount: 2 }, NOW),
    ).toBe(true);
  });

  it("is false for a Free shop that retired the banner and is too young for feedback", () => {
    expect(
      firstSuccessfulScanNeeded({ ...base, plan: "free", upgradeReturnDismissCount: 3 }, NOW),
    ).toBe(false);
  });

  it("is true for a paid shop old enough for feedback (exactly 7 days)", () => {
    expect(firstSuccessfulScanNeeded({ ...base, installedAt: ago(7 * DAY) }, NOW)).toBe(true);
  });

  it("is false for a paid shop 1ms short of 7 days", () => {
    expect(firstSuccessfulScanNeeded({ ...base, installedAt: ago(7 * DAY - 1) }, NOW)).toBe(false);
  });

  it("is false for a paid shop whose feedback nudge is dismissed or submitted", () => {
    const old = { ...base, installedAt: ago(30 * DAY) };
    expect(firstSuccessfulScanNeeded({ ...old, feedbackNudgeDismissedAt: ago(DAY) }, NOW)).toBe(
      false,
    );
    expect(firstSuccessfulScanNeeded({ ...old, feedbackSubmittedAt: ago(DAY) }, NOW)).toBe(false);
  });

  it("agrees with shopPromptEligibility: skipping the read never changes the result", () => {
    // Every combination where the read is skipped must be ineligible for both
    // scan-dependent prompts whatever the real first-scan time was.
    const combos: ShopPromptState[] = [];
    for (const plan of ["free", "Standard"]) {
      for (const upgradeReturnDismissCount of [0, 3]) {
        for (const installedAt of [ago(DAY), ago(30 * DAY)]) {
          for (const feedbackNudgeDismissedAt of [null, ago(DAY)]) {
            combos.push(
              state({ plan, upgradeReturnDismissCount, installedAt, feedbackNudgeDismissedAt }),
            );
          }
        }
      }
    }
    for (const s of combos) {
      if (firstSuccessfulScanNeeded(s, NOW)) continue;
      const withScan = keys(s, NOW);
      const without = keys({ ...s, firstSuccessfulScanAt: null }, NOW);
      expect(without).toEqual(withScan);
    }
  });
});

describe("shopPromptEligibility: hidden-findings rule for upgrade_return (starvation fix)", () => {
  it.each([
    [null, false],
    [0, false],
    [1, false], // the single finding is shown in full: nothing hidden
    [2, true],
    [40, true],
  ])("latest scan with %s non-malicious findings -> banner eligible %s", (count, expected) => {
    expect(
      keys(state({ latestScanNonMaliciousCount: count }), NOW).includes("upgrade_return"),
    ).toBe(expected);
  });

  it("upgradeReturnPossible: Free and not retired only", () => {
    expect(upgradeReturnPossible({ plan: "free", upgradeReturnDismissCount: 2 })).toBe(true);
    expect(upgradeReturnPossible({ plan: "free", upgradeReturnDismissCount: 3 })).toBe(false);
    expect(upgradeReturnPossible({ plan: "Standard", upgradeReturnDismissCount: 0 })).toBe(false);
  });
});

describe("shopPromptEligibility: eligibleSince (bounded blocking)", () => {
  it("review_popup: first results view + 2h", () => {
    expect(shopPromptEligibility(state(), NOW).eligibleSince.review_popup).toEqual(
      new Date(ago(3 * DAY).getTime() + 2 * HOUR),
    );
  });

  it("review_popup: a later retryAfter wins", () => {
    const retryAfter = ago(HOUR);
    expect(
      shopPromptEligibility(state({ reviewPopupRetryAfter: retryAfter }), NOW).eligibleSince
        .review_popup,
    ).toEqual(retryAfter);
  });

  it("review_popup: the end of the last attempt's 24h cooldown wins when later", () => {
    const last = ago(2 * DAY);
    expect(
      shopPromptEligibility(
        state({ reviewPopupAttemptCount: 1, reviewPopupLastAttemptAt: last }),
        NOW,
      ).eligibleSince.review_popup,
    ).toEqual(new Date(last.getTime() + DAY));
  });

  it("upgrade_return: first successful scan + 24h when never shown", () => {
    expect(shopPromptEligibility(state(), NOW).eligibleSince.upgrade_return).toEqual(
      new Date(ago(3 * DAY).getTime() + DAY),
    );
  });

  it("upgrade_return: the weekly re-show opening (last shown + 7d) when later", () => {
    const shown = ago(9 * DAY);
    expect(
      shopPromptEligibility(
        state({
          firstSuccessfulScanAt: ago(20 * DAY),
          upgradeReturnLastShownAt: shown,
          upgradeReturnLastDismissedAt: ago(9 * DAY - HOUR),
        }),
        NOW,
      ).eligibleSince.upgrade_return,
    ).toEqual(new Date(shown.getTime() + 7 * DAY));
  });

  it("upgrade_return: inside an open episode, the episode start", () => {
    const shown = ago(3 * HOUR);
    expect(
      shopPromptEligibility(state({ upgradeReturnLastShownAt: shown }), NOW).eligibleSince
        .upgrade_return,
    ).toEqual(shown);
  });

  it("feedback never has one, and ineligible prompts have none", () => {
    const e = shopPromptEligibility(state({ reviewPopupRequestedAt: ago(DAY) }), NOW);
    expect(e.eligibleSince).not.toHaveProperty("feedback");
    expect(e.eligibleSince).not.toHaveProperty("review_popup");
  });
});
