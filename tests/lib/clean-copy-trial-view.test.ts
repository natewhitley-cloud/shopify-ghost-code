/** gc-tib.22: the select page's trial copy helpers. */
import { describe, expect, it } from "vitest";

import {
  runRefusalCopy,
  TRIAL_CLEAN_COPY_LIMIT,
  trialNotice,
  trialOverSelectionNote,
  trialRemaining,
  trialUnlockDate,
} from "../../app/lib/clean-copy-view";

const view = (used: number) => ({ used, limit: 5, endsAt: "2026-12-01T00:00:00.000Z" });

describe("trial view helpers", () => {
  it("the limit is 5 (Nathan, pricing 1A)", () => {
    expect(TRIAL_CLEAN_COPY_LIMIT).toBe(5);
  });

  it("remaining: unlimited when not in trial, never below zero", () => {
    expect(trialRemaining(null)).toBe(Number.POSITIVE_INFINITY);
    expect(trialRemaining(view(0))).toBe(5);
    expect(trialRemaining(view(5))).toBe(0);
    expect(trialRemaining(view(7))).toBe(0);
  });

  it("unlock date is read in UTC (00:00 UTC never shows as the day before)", () => {
    expect(trialUnlockDate("2026-12-01T00:00:00.000Z")).toBe("December 1");
  });

  it("notice: info with the count, warning when all used", () => {
    expect(trialNotice(view(2))).toEqual({
      tone: "info",
      text: "During your free trial, you can remove up to 5 pieces of leftover code. 2 of 5 used. The rest unlock on December 1, when your trial ends.",
    });
    expect(trialNotice(view(5))).toEqual({
      tone: "warning",
      text: "You've used all 5 free trial removals. Clean copy unlocks fully on December 1, when your trial ends.",
    });
  });

  it("copy has no em dashes and never says ghost code", () => {
    const all = [
      trialNotice(view(1)).text,
      trialNotice(view(5)).text,
      trialOverSelectionNote(3),
      runRefusalCopy("TRIAL_LIMIT"),
    ].join(" ");
    expect(all).not.toMatch(/—|ghost code/i);
  });
});
