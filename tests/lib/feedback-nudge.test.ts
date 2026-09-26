/**
 * Tests for app/lib/feedback-nudge.ts (gc-97k.3): the feedback-nudge gate, the
 * one-prompt-per-page picker, and the neutral review-ask copy.
 */
import { describe, it, expect } from "vitest";

import {
  APP_STORE_REVIEW_URL,
  feedbackNudgeInstallAgeReached,
  FEEDBACK_NUDGE_COPY,
  FEEDBACK_NUDGE_HREF,
  FEEDBACK_THANKS_COPY,
  shouldShowFeedbackNudge,
} from "../../app/lib/feedback-nudge";
import type { FeedbackNudgeGateInput } from "../../app/lib/feedback-nudge";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NOW = new Date("2026-09-24T12:00:00Z");

/** Eligible baseline: installed 20 days ago, first scan 3 days ago. */
function gate(overrides: Partial<FeedbackNudgeGateInput> = {}): FeedbackNudgeGateInput {
  return {
    installedAt: new Date(NOW.getTime() - 20 * DAY),
    firstSuccessfulScanAt: new Date(NOW.getTime() - 3 * DAY),
    feedbackNudgeDismissedAt: null,
    feedbackSubmittedAt: null,
    ...overrides,
  };
}

describe("feedbackNudgeInstallAgeReached", () => {
  it("is false below 7 days and true from exactly 7 days (inclusive)", () => {
    expect(feedbackNudgeInstallAgeReached(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe(false);
    expect(feedbackNudgeInstallAgeReached(new Date(NOW.getTime() - 7 * DAY + HOUR), NOW)).toBe(
      false,
    );
    expect(feedbackNudgeInstallAgeReached(new Date(NOW.getTime() - 7 * DAY), NOW)).toBe(true);
    expect(feedbackNudgeInstallAgeReached(new Date(NOW.getTime() - 8 * DAY), NOW)).toBe(true);
  });
});

describe("shouldShowFeedbackNudge", () => {
  it("is true when every condition holds", () => {
    expect(shouldShowFeedbackNudge(gate(), NOW)).toBe(true);
  });

  describe("install age (>= 7 days)", () => {
    it("is false at 6 days 23 hours", () => {
      expect(
        shouldShowFeedbackNudge(
          gate({ installedAt: new Date(NOW.getTime() - 7 * DAY + HOUR) }),
          NOW,
        ),
      ).toBe(false);
    });

    it("is false 1 ms short of 7 days", () => {
      expect(
        shouldShowFeedbackNudge(gate({ installedAt: new Date(NOW.getTime() - 7 * DAY + 1) }), NOW),
      ).toBe(false);
    });

    it("is true at exactly 7 days", () => {
      expect(
        shouldShowFeedbackNudge(gate({ installedAt: new Date(NOW.getTime() - 7 * DAY) }), NOW),
      ).toBe(true);
    });
  });

  describe("return visit (later UTC day than the first successful scan)", () => {
    it("is false later on the same UTC day as the first scan", () => {
      const firstSuccessfulScanAt = new Date("2026-09-24T00:00:00Z");
      expect(shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt }), NOW)).toBe(false);
    });

    it("is false when the visit is the same instant as the scan", () => {
      expect(shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt: NOW }), NOW)).toBe(false);
    });

    it("is true on the next UTC day, even two minutes later (23:59Z scan, 00:01Z visit)", () => {
      const firstSuccessfulScanAt = new Date("2026-09-23T23:59:00Z");
      const visit = new Date("2026-09-24T00:01:00Z");
      expect(shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt }), visit)).toBe(true);
    });

    it("is false at 23:59:59.999Z on the scan's own UTC day (00:00Z scan)", () => {
      const firstSuccessfulScanAt = new Date("2026-09-24T00:00:00Z");
      const visit = new Date("2026-09-24T23:59:59.999Z");
      expect(shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt }), visit)).toBe(false);
    });

    it("uses UTC, not local time: a scan at 23:30Z and a visit at 00:10Z next day qualifies", () => {
      const firstSuccessfulScanAt = new Date("2026-09-23T23:30:00Z");
      expect(
        shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt }), new Date("2026-09-24T00:10:00Z")),
      ).toBe(true);
    });
  });

  it("is false with no successful scan", () => {
    expect(shouldShowFeedbackNudge(gate({ firstSuccessfulScanAt: null }), NOW)).toBe(false);
  });

  it("is false once dismissed", () => {
    expect(
      shouldShowFeedbackNudge(
        gate({ feedbackNudgeDismissedAt: new Date(NOW.getTime() - DAY) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false once submitted", () => {
    expect(
      shouldShowFeedbackNudge(gate({ feedbackSubmittedAt: new Date(NOW.getTime() - DAY) }), NOW),
    ).toBe(false);
  });
});

describe("merchant-facing copy", () => {
  const allCopy = [...Object.values(FEEDBACK_NUDGE_COPY), ...Object.values(FEEDBACK_THANKS_COPY)];

  it("review asks are neutral: no satisfaction-targeting phrasing", () => {
    for (const text of [FEEDBACK_THANKS_COPY.body]) {
      expect(text.toLowerCase()).not.toContain("if this was helpful");
      expect(text.toLowerCase()).not.toMatch(/if you (like|love|enjoy)/);
      expect(text).toContain("Shopify App Store");
    }
  });

  it("contains no em or en dashes", () => {
    for (const text of allCopy) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("links to the ghost-code listing's write-review modal and the nudge-marked form", () => {
    expect(APP_STORE_REVIEW_URL).toBe(
      "https://apps.shopify.com/ghost-code#modal-show=WriteReviewModal",
    );
    expect(FEEDBACK_NUDGE_HREF).toBe("/app/feedback?src=nudge");
  });
});
