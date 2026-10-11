/**
 * Tests for app/lib/summary-optin.ts (gc-xorg): who is asked by Home's one-time
 * summary-email opt-in. Every gate, both paid plans, and the happy path.
 */
import { describe, it, expect } from "vitest";

import { isSummaryOptInEligible } from "../../app/lib/summary-optin";
import type { SummaryOptInState } from "../../app/lib/summary-optin";

const T = new Date("2026-10-01T00:00:00Z");

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
    ...overrides,
  };
}

describe("isSummaryOptInEligible", () => {
  it("happy path: a legacy Professional shop (weekly) is asked", () => {
    expect(isSummaryOptInEligible(legacy())).toBe(true);
  });

  it("a legacy Standard shop (monthly) is asked too", () => {
    expect(isSummaryOptInEligible(legacy({ summaryCadence: "monthly" }))).toBe(true);
  });

  it("Free (no summaries in the plan): never", () => {
    expect(isSummaryOptInEligible(legacy({ summaryCadence: "none" }))).toBe(false);
  });

  it("sending not configured (dark): never (nothing to turn on yet)", () => {
    expect(isSummaryOptInEligible(legacy({ summarySendingConfigured: false }))).toBe(false);
  });

  it("alertsEnabled false (turned off in Settings or unsubscribed): never nag", () => {
    expect(isSummaryOptInEligible(legacy({ alertsEnabled: false }))).toBe(false);
  });

  it("uninstalled: never", () => {
    expect(isSummaryOptInEligible(legacy({ uninstalledAt: T }))).toBe(false);
  });

  it.each([
    ["the Free -> paid notice is owed (it covers this shop)", "summaryNoticePendingAt"],
    ["the notice was already shown (it knows)", "summaryNoticeShownAt"],
    ["it already opted in (consented)", "summaryOptedInAt"],
    ["it said No thanks", "summaryOptInDeclinedAt"],
  ] as const)("never when %s", (_label, stamp) => {
    expect(isSummaryOptInEligible(legacy({ [stamp]: T }))).toBe(false);
  });

  it("a missing (undefined) stamp counts as set: incomplete data never asks", () => {
    const partial = { ...legacy() } as Partial<SummaryOptInState>;
    delete partial.summaryOptInDeclinedAt;
    expect(isSummaryOptInEligible(partial as SummaryOptInState)).toBe(false);
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
    ];
    for (const off of offs) expect(isSummaryOptInEligible(legacy(off))).toBe(false);
  });
});
