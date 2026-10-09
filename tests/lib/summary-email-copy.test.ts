/**
 * Tests for app/lib/summary-email-copy.ts (gc-ol95): the in-app summary-email
 * copy and the "effectively on" rule the Settings checkbox shows.
 */
import { describe, it, expect } from "vitest";

import {
  SUMMARY_COMING_SOON,
  SUMMARY_FREE_PARAGRAPH,
  SUMMARY_NOTICE_HEADING,
  summaryEffectivelyOn,
  summaryLiveParagraph,
  summaryNoticeLead,
  summaryToggleLabel,
} from "../../app/lib/summary-email-copy";

describe("summaryEffectivelyOn", () => {
  const at = new Date("2026-10-09T00:00:00Z");
  it.each([
    [true, null, at, null, true],
    [true, null, null, at, true],
    // Notice pending (upgraded, or opted in while dark): on, told before any email.
    [true, at, null, null, true],
    // Legacy paid shop: toggle at its default ON, never told, nothing owed -> off.
    [true, null, null, null, false],
    [false, at, at, at, false],
    [false, null, null, null, false],
  ])(
    "alertsEnabled=%s pending=%s shown=%s optedIn=%s => %s",
    (alertsEnabled, pending, shown, optedIn, expected) => {
      expect(
        summaryEffectivelyOn({
          alertsEnabled,
          summaryNoticePendingAt: pending,
          summaryNoticeShownAt: shown,
          summaryOptedInAt: optedIn,
        }),
      ).toBe(expected);
    },
  );
});

describe("copy", () => {
  it("notice", () => {
    expect(SUMMARY_NOTICE_HEADING).toBe("Summary emails are on");
    expect(summaryNoticeLead("a@b.co", "weekly")).toBe(
      "We'll email a@b.co a summary after each weekly scan, only when something changed. You can turn this off in",
    );
    expect(summaryNoticeLead(null, "monthly")).toBe(
      "We'll email your store owner email a summary after each monthly scan, only when something changed. You can turn this off in",
    );
  });

  it("Settings card", () => {
    expect(summaryToggleLabel("weekly")).toBe("Email me a summary after each weekly scan");
    expect(summaryLiveParagraph("a@b.co")).toBe(
      "We email a@b.co only when something changed: new or fixed findings, or an app that is no longer active.",
    );
    expect(SUMMARY_COMING_SOON).toBe(
      "Summary emails are coming soon. We'll let you know before any are sent.",
    );
    expect(SUMMARY_FREE_PARAGRAPH).toBe(
      "Summary emails are included with Standard (monthly) and Professional (weekly).",
    );
  });

  it("no em or en dash, no 'removed'/'uninstalled' claims", () => {
    const all = [
      summaryNoticeLead("a@b.co", "weekly"),
      summaryLiveParagraph(null),
      SUMMARY_COMING_SOON,
      SUMMARY_FREE_PARAGRAPH,
    ].join(" ");
    expect(all).not.toMatch(/[—–]/);
    expect(all).not.toMatch(/\b(removed|uninstalled)\b/i);
  });
});
