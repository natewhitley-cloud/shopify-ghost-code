import { describe, it, expect } from "vitest";

import {
  HOME_NOTICE_PRIORITY,
  homePromptsHeld,
  pickHomeNotice,
  summaryOptInHoldsSlot,
  type HomeNoticeKey,
} from "../../app/lib/home-notice";
import { PROMPT_CAP_WINDOW_MS } from "../../app/lib/prompt-cap";

describe("pickHomeNotice (gc-np1d.6)", () => {
  it("is in the page map's priority order", () => {
    expect(HOME_NOTICE_PRIORITY).toEqual([
      "guard_email",
      "summary_notice",
      "summary_optin",
      "feedback",
      "multi_theme",
      "app_removed",
      "new_high",
    ]);
  });

  it("nothing to show: null", () => {
    expect(pickHomeNotice({})).toBeNull();
    expect(
      pickHomeNotice(
        Object.fromEntries(HOME_NOTICE_PRIORITY.map((k) => [k, false])) as Record<
          HomeNoticeKey,
          boolean
        >,
      ),
    ).toBeNull();
  });

  it.each(HOME_NOTICE_PRIORITY)("%s alone wins the slot", (key) => {
    expect(pickHomeNotice({ [key]: true })).toBe(key);
  });

  // Every pair of competing notices: the higher one wins, whichever order the
  // candidates are listed in.
  const pairs = HOME_NOTICE_PRIORITY.flatMap((higher, i) =>
    HOME_NOTICE_PRIORITY.slice(i + 1).map((lower) => [higher, lower] as const),
  );
  it.each(pairs)("%s beats %s", (higher, lower) => {
    expect(pickHomeNotice({ [higher]: true, [lower]: true })).toBe(higher);
    expect(pickHomeNotice({ [lower]: true, [higher]: true })).toBe(higher);
  });

  it("covers all 21 pairs", () => {
    expect(pairs).toHaveLength(21);
  });

  it("every notice at once: the guard email notice", () => {
    expect(pickHomeNotice(Object.fromEntries(HOME_NOTICE_PRIORITY.map((k) => [k, true])))).toBe(
      "guard_email",
    );
  });

  it("the feedback ask beats the multi-theme upsell (so it never loses to it)", () => {
    expect(pickHomeNotice({ multi_theme: true, feedback: true })).toBe("feedback");
  });

  it("a winner answered or dismissed hands the slot to the next one", () => {
    expect(pickHomeNotice({ guard_email: false, summary_notice: true, multi_theme: true })).toBe(
      "summary_notice",
    );
  });
});

describe("summaryOptInHoldsSlot", () => {
  it("before an answer: holds the slot while the prompt shows", () => {
    expect(summaryOptInHoldsSlot(true, null)).toBe(true);
    expect(summaryOptInHoldsSlot(false, null)).toBe(false);
  });

  it("after Turn on (confirmed, failed or in flight): keeps the slot even once the loader drops the prompt", () => {
    expect(summaryOptInHoldsSlot(false, "accept")).toBe(true);
  });

  it("after No thanks: frees the slot", () => {
    expect(summaryOptInHoldsSlot(false, "decline")).toBe(false);
  });
});

describe("homePromptsHeld", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const base = {
    guardEmailNoticeOffered: false,
    summaryNoticeOffered: false,
    guardEmailNoticeShownAt: null,
    summaryNoticeShownAt: null,
    now,
  };

  it("no consent notice offered or recently shown: not held", () => {
    expect(homePromptsHeld(base)).toBe(false);
  });

  it("guard email notice offered on this load: held", () => {
    expect(homePromptsHeld({ ...base, guardEmailNoticeOffered: true })).toBe(true);
  });

  it("summary notice offered on this load: held", () => {
    expect(homePromptsHeld({ ...base, summaryNoticeOffered: true })).toBe(true);
  });

  it.each(["guardEmailNoticeShownAt", "summaryNoticeShownAt"] as const)(
    "%s claimed a minute ago (may still be on screen, latched): held",
    (field) => {
      expect(homePromptsHeld({ ...base, [field]: ago(60_000) })).toBe(true);
    },
  );

  it.each(["guardEmailNoticeShownAt", "summaryNoticeShownAt"] as const)(
    "%s claimed exactly 24h ago: no longer held",
    (field) => {
      expect(homePromptsHeld({ ...base, [field]: ago(PROMPT_CAP_WINDOW_MS) })).toBe(false);
      expect(homePromptsHeld({ ...base, [field]: ago(PROMPT_CAP_WINDOW_MS - 1) })).toBe(true);
    },
  );
});
