/**
 * Tests for app/lib/summary-optin.ts (gc-xorg): who is asked by Home's one-time
 * summary-email opt-in. Every gate, both paid plans, and the happy path.
 */
import { describe, it, expect } from "vitest";

import { isSummaryOptInEligible, SUMMARY_OPTIN_OFFER_MS } from "../../app/lib/summary-optin";
import type { SummaryOptInState } from "../../app/lib/summary-optin";

const T = new Date("2026-10-01T00:00:00Z");
const NOW = new Date("2026-10-11T12:00:00Z");

/** A legacy Professional shop: paid before gc-ol95, no consent decision of any kind. */
function legacy(overrides: Partial<SummaryOptInState> = {}): SummaryOptInState {
  return {
    summaryCadence: "weekly",
    summarySendingConfigured: true,
    alertsEnabled: true,
    uninstalledAt: null,
    summaryNoticePendingAt: null,
    summaryNoticeShownAt: null,
    summaryOptedInAt: null,
    summaryOptInDeclinedAt: null,
    summaryOptInFirstShownAt: null,
    ...overrides,
  };
}

describe("isSummaryOptInEligible", () => {
  it("happy path: a legacy Professional shop (weekly) is asked", () => {
    expect(isSummaryOptInEligible(legacy(), NOW)).toBe(true);
  });

  it("a legacy Standard shop (monthly) is asked too", () => {
    expect(isSummaryOptInEligible(legacy({ summaryCadence: "monthly" }), NOW)).toBe(true);
  });

  it("Free (no summaries in the plan): never", () => {
    expect(isSummaryOptInEligible(legacy({ summaryCadence: "none" }), NOW)).toBe(false);
  });

  it("sending not configured (dark): never (nothing to turn on yet)", () => {
    expect(isSummaryOptInEligible(legacy({ summarySendingConfigured: false }), NOW)).toBe(false);
  });

  it("alertsEnabled false (turned off in Settings or unsubscribed): never nag", () => {
    expect(isSummaryOptInEligible(legacy({ alertsEnabled: false }), NOW)).toBe(false);
  });

  it("uninstalled: never", () => {
    expect(isSummaryOptInEligible(legacy({ uninstalledAt: T }), NOW)).toBe(false);
  });

  it.each([
    ["the Free -> paid notice is owed (it covers this shop)", "summaryNoticePendingAt"],
    ["the notice was already shown (it knows)", "summaryNoticeShownAt"],
    ["it already opted in (consented)", "summaryOptedInAt"],
    ["it said No thanks", "summaryOptInDeclinedAt"],
  ] as const)("never when %s", (_label, stamp) => {
    expect(isSummaryOptInEligible(legacy({ [stamp]: T }), NOW)).toBe(false);
  });

  it("a missing (undefined) stamp counts as set: incomplete data never asks", () => {
    const partial = { ...legacy() } as Partial<SummaryOptInState>;
    delete partial.summaryOptInDeclinedAt;
    expect(isSummaryOptInEligible(partial as SummaryOptInState, NOW)).toBe(false);
  });

  it("every gate is independent: flipping any one alone turns it off", () => {
    const offs: Array<Partial<SummaryOptInState>> = [
      { summaryCadence: "none" },
      { summarySendingConfigured: false },
      { alertsEnabled: false },
      { uninstalledAt: T },
      { summaryNoticePendingAt: T },
      { summaryNoticeShownAt: T },
      { summaryOptedInAt: T },
      { summaryOptInDeclinedAt: T },
      { summaryOptInFirstShownAt: new Date(NOW.getTime() - SUMMARY_OPTIN_OFFER_MS) },
    ];
    for (const off of offs) expect(isSummaryOptInEligible(legacy(off), NOW)).toBe(false);
  });
});

describe("isSummaryOptInEligible: the 14-day offer (gc-rxq0)", () => {
  const shownAgo = (ms: number) =>
    legacy({ summaryOptInFirstShownAt: new Date(NOW.getTime() - ms) });

  it("offers for exactly 14 days", () => {
    expect(SUMMARY_OPTIN_OFFER_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("never shown (null stamp): eligible", () => {
    expect(isSummaryOptInEligible(legacy({ summaryOptInFirstShownAt: null }), NOW)).toBe(true);
  });

  it("first shown just now: eligible", () => {
    expect(isSummaryOptInEligible(shownAgo(0), NOW)).toBe(true);
  });

  it("first shown 14 days minus 1 ms ago: still eligible", () => {
    expect(isSummaryOptInEligible(shownAgo(SUMMARY_OPTIN_OFFER_MS - 1), NOW)).toBe(true);
  });

  it("first shown exactly 14 days ago: retired", () => {
    expect(isSummaryOptInEligible(shownAgo(SUMMARY_OPTIN_OFFER_MS), NOW)).toBe(false);
  });

  it("first shown long ago: retired", () => {
    expect(isSummaryOptInEligible(shownAgo(90 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
  });

  it("the window counts from the stamp to `now` (the same stamp is eligible earlier)", () => {
    const state = legacy({ summaryOptInFirstShownAt: T });
    expect(isSummaryOptInEligible(state, new Date(T.getTime() + SUMMARY_OPTIN_OFFER_MS - 1))).toBe(
      true,
    );
    expect(isSummaryOptInEligible(state, new Date(T.getTime() + SUMMARY_OPTIN_OFFER_MS))).toBe(
      false,
    );
  });

  it("a missing (undefined) first-shown stamp never asks", () => {
    const partial = { ...legacy() } as Partial<SummaryOptInState>;
    delete partial.summaryOptInFirstShownAt;
    expect(isSummaryOptInEligible(partial as SummaryOptInState, NOW)).toBe(false);
  });
});
