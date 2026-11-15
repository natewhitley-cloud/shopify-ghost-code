/**
 * gc-np1d.2: the value-action card for each plan and state (docs/ux/page-map.md,
 * approved mockup v3, Nathan 2026-11-14). One card per page, by plan:
 *   Professional: remove it for you (trial-capped; scan first when stale).
 *   Standard: fix it yourself first, upgrade to have it removed second (4B).
 *   Free: we found it, upgrade to have it removed.
 *   Nothing found: all clear, with the reason to scan again.
 * Written before the module.
 */
import { describe, expect, it } from "vitest";

import {
  isValueActionPingKey,
  valueActionCard,
  type ValueActionInput,
} from "../../app/lib/value-action";

const APPS = [
  { name: "Judge.me", count: 3 },
  { name: "Loox", count: 4 },
  { name: "Privy", count: 3 },
  { name: "Translate & Adapt", count: 2 },
];

const base: ValueActionInput = {
  plan: "professional",
  cleanCopyOn: true,
  hasCompletedScan: true,
  themeName: "Dawn",
  leftovers: { total: 12, apps: APPS, removable: 12, securityFound: false },
  cleanCopy: { state: "ready", count: 12 },
  trial: null,
  lastScanDaysAgo: 2,
  themeChangedSinceScan: false,
};

/** Merchant copy: no machine codes, no em dash, no "ghost code". */
function expectMerchantCopy(text: string) {
  expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  expect(text).not.toContain("—");
  expect(text.toLowerCase()).not.toContain("ghost code");
}

describe("valueActionCard", () => {
  it("shows nothing before the first finished scan (onboarding owns that)", () => {
    expect(valueActionCard({ ...base, hasCompletedScan: false })).toBeNull();
  });

  describe("Professional", () => {
    it("offers to remove it for you, with the store's own counts and apps", () => {
      const card = valueActionCard(base)!;
      expect(card.kind).toBe("clean_copy");
      expect(card.heading).toBe("Remove 12 pieces of leftover code for you");
      expect(card.body).toContain("4 apps you uninstalled");
      expect(card.body).toContain("Your live theme isn't changed");
      expect(card.apps).toEqual(APPS);
      expect(card.primary).toEqual({ label: "Make a clean copy", action: "clean_copy" });
      expect(card.telemetryKey).toBe("clean_copy_action");
    });

    it("says 1 piece and 1 app in the singular", () => {
      const card = valueActionCard({
        ...base,
        leftovers: {
          total: 1,
          apps: [{ name: "Privy", count: 1 }],
          removable: 1,
          securityFound: false,
        },
        cleanCopy: { state: "ready", count: 1 },
      })!;
      expect(card.heading).toBe("Remove 1 piece of leftover code for you");
      expect(card.body).toContain("An app you uninstalled");
    });

    it("counts what Clean copy can remove, not every leftover", () => {
      const card = valueActionCard({ ...base, cleanCopy: { state: "ready", count: 9 } })!;
      expect(card.heading).toBe("Remove 9 pieces of leftover code for you");
    });

    it("during the trial offers what is left and names the unlock date", () => {
      const card = valueActionCard({
        ...base,
        trial: { remaining: 5, unlocksOn: "Nov 21" },
      })!;
      expect(card.heading).toBe("Remove up to 5 pieces of leftover code now");
      expect(card.body).toContain("The other 7 unlock on Nov 21");
      expect(card.primary?.action).toBe("clean_copy");
    });

    it("during the trial with nothing left says when the rest unlock, and offers no button", () => {
      const card = valueActionCard({ ...base, trial: { remaining: 0, unlocksOn: "Nov 21" } })!;
      expect(card.heading).toBe("12 pieces of leftover code unlock on Nov 21");
      expect(card.primary).toBeNull();
    });

    it("during the trial with room for all of it reads like the paid card", () => {
      const card = valueActionCard({
        ...base,
        trial: { remaining: 5, unlocksOn: "Nov 21" },
        cleanCopy: { state: "ready", count: 3 },
      })!;
      expect(card.heading).toBe("Remove 3 pieces of leftover code for you");
    });

    it("asks for a new scan first when the scan is too old to remove from", () => {
      const card = valueActionCard({ ...base, cleanCopy: { state: "stale", count: 0 } })!;
      expect(card.heading).toBe("Scan again to remove 12 pieces of leftover code");
      expect(card.primary).toEqual({ label: "Scan now", action: "scan" });
      expect(card.telemetryKey).toBeNull();
    });

    it("falls back to fixing it yourself when Clean copy can't remove any of it", () => {
      const card = valueActionCard({ ...base, cleanCopy: { state: "none", count: 0 } })!;
      expect(card.kind).toBe("diy");
      expect(card.primary).toEqual({ label: "See how to fix them", action: "diy" });
      expect(card.secondary).toBeNull();
    });

    it("falls back to fixing it yourself while Clean copy is off for the shop", () => {
      const card = valueActionCard({ ...base, cleanCopyOn: false })!;
      expect(card.kind).toBe("diy");
      expect(card.secondary).toBeNull();
    });
  });

  describe("Standard (4B: do it yourself first, upgrade second)", () => {
    const std: ValueActionInput = { ...base, plan: "standard", cleanCopy: null };

    it("leads with fixing it yourself and offers the upgrade second", () => {
      const card = valueActionCard(std)!;
      expect(card.kind).toBe("diy");
      expect(card.heading).toBe("Fix 12 pieces of leftover code");
      expect(card.primary).toEqual({ label: "See how to fix them", action: "diy" });
      expect(card.secondary).toEqual({
        label: "Upgrade to Professional to remove them for you",
        action: "upgrade",
      });
      expect(card.telemetryKey).toBe("clean_copy_diy");
      expect(card.upsellKey).toBe("clean_copy_upsell");
    });

    it("leaves out the upgrade while Clean copy is off", () => {
      const card = valueActionCard({ ...std, cleanCopyOn: false })!;
      expect(card.secondary).toBeNull();
      expect(card.upsellKey).toBeNull();
    });
  });

  describe("Free", () => {
    const free: ValueActionInput = { ...base, plan: "free", cleanCopy: null };

    it("names what was found and offers the upgrade", () => {
      const card = valueActionCard(free)!;
      expect(card.kind).toBe("upsell");
      expect(card.heading).toBe("We found 12 pieces of leftover code from 4 apps");
      expect(card.primary).toEqual({ label: "Upgrade to Professional", action: "upgrade" });
      expect(card.secondary).toEqual({ label: "Compare plans", action: "plans" });
      expect(card.telemetryKey).toBe("clean_copy_upsell");
    });

    it("shows no card while Clean copy is off (the existing upgrade asks cover Free)", () => {
      expect(valueActionCard({ ...free, cleanCopyOn: false })).toBeNull();
    });
  });

  describe("nothing found", () => {
    const clear: ValueActionInput = {
      ...base,
      leftovers: { total: 0, apps: [], removable: 0, securityFound: false },
      cleanCopy: { state: "none", count: 0 },
    };

    it("says all clear and gives the theme-changed reason to scan again", () => {
      const card = valueActionCard({ ...clear, themeChangedSinceScan: true })!;
      expect(card.kind).toBe("clear");
      expect(card.heading).toBe("All clear: no leftover code in Dawn");
      expect(card.body).toBe("Your theme changed after your last scan. Scan again to check it.");
      expect(card.primary).toEqual({ label: "Scan now", action: "scan" });
    });

    it("gives the age reason after 30 days", () => {
      const card = valueActionCard({ ...clear, lastScanDaysAgo: 34 })!;
      expect(card.body).toBe(
        "Your last scan was 34 days ago. Scan again to check for anything new.",
      );
      expect(card.primary?.action).toBe("scan");
    });

    it("offers no button when there is no reason to scan again", () => {
      const card = valueActionCard(clear)!;
      expect(card.primary).toBeNull();
    });

    it("is the same on every plan", () => {
      for (const plan of ["free", "standard", "professional"] as const) {
        expect(valueActionCard({ ...clear, plan })!.kind).toBe("clear");
      }
    });
  });

  it("writes merchant copy on every card", () => {
    const inputs: ValueActionInput[] = [
      base,
      { ...base, trial: { remaining: 2, unlocksOn: "Nov 21" } },
      { ...base, trial: { remaining: 0, unlocksOn: "Nov 21" } },
      { ...base, cleanCopy: { state: "stale", count: 0 } },
      { ...base, plan: "standard", cleanCopy: null },
      { ...base, plan: "free", cleanCopy: null },
      {
        ...base,
        leftovers: { total: 0, apps: [], removable: 0, securityFound: false },
        lastScanDaysAgo: 40,
      },
    ];
    for (const input of inputs) {
      const card = valueActionCard(input)!;
      for (const text of [
        card.heading,
        card.body,
        card.primary?.label ?? "",
        card.secondary?.label ?? "",
      ]) {
        expectMerchantCopy(text);
      }
    }
  });
});

describe("isValueActionPingKey", () => {
  it("allows only the card, do-it-yourself and Preview keys", () => {
    for (const k of ["clean_copy_action", "clean_copy_diy", "clean_copy_preview"]) {
      expect(isValueActionPingKey(k)).toBe(true);
    }
    for (const k of [null, 1, "", "clean_copy_upsell", "scan_header", "upgrade_preview"]) {
      expect(isValueActionPingKey(k)).toBe(false);
    }
  });
});

// Audit r1 (2026-11-14) regressions.
describe("valueActionCard: audit r1 fixes", () => {
  it("M2: the Professional card's body and chips are the offered findings, not every leftover", () => {
    const card = valueActionCard({
      ...base,
      leftovers: {
        total: 10,
        apps: [
          { name: "A", count: 5 },
          { name: "B", count: 3 },
          { name: "C", count: 2 },
        ],
        removable: 2,
        securityFound: false,
      },
      cleanCopy: { state: "ready", count: 2, apps: [{ name: "A", count: 2 }] },
    })!;
    expect(card.heading).toBe("Remove 2 pieces of leftover code for you");
    expect(card.body).toContain("An app you uninstalled left code");
    expect(card.apps).toEqual([{ name: "A", count: 2 }]);
  });

  it("M2: the trial body counts only the offered apps", () => {
    const card = valueActionCard({
      ...base,
      leftovers: {
        total: 10,
        apps: [
          { name: "A", count: 5 },
          { name: "B", count: 5 },
        ],
        removable: 2,
        securityFound: false,
      },
      cleanCopy: { state: "ready", count: 2, apps: [{ name: "A", count: 2 }] },
      trial: { remaining: 1, unlocksOn: "November 28" },
    })!;
    expect(card.body).toContain("An app you uninstalled left 2 pieces of code");
    expect(card.body).toContain("The other 1 unlocks on November 28");
  });

  it("L8: singular unlock wording when trial removals are used up", () => {
    const card = valueActionCard({
      ...base,
      cleanCopy: { state: "ready", count: 1, apps: [{ name: "A", count: 1 }] },
      trial: { remaining: 0, unlocksOn: "November 28" },
    })!;
    expect(card.heading).toBe("1 piece of leftover code unlocks on November 28");
  });

  it("M7: unknown-app-only leftovers never say 0 apps", () => {
    const unknown = { total: 3, apps: [], removable: 3, securityFound: false };
    for (const plan of ["free", "standard"] as const) {
      const card = valueActionCard({ ...base, plan, leftovers: unknown, cleanCopy: null })!;
      expect(`${card.heading} ${card.body}`).not.toMatch(/\b0 apps?\b/);
    }
    expect(
      valueActionCard({ ...base, plan: "free", leftovers: unknown, cleanCopy: null })!.heading,
    ).toBe("We found 3 pieces of leftover code");
  });

  it("L8: Free body agrees in number with the count", () => {
    const one = valueActionCard({
      ...base,
      plan: "free",
      leftovers: { total: 1, apps: [{ name: "A", count: 1 }], removable: 1, securityFound: false },
      cleanCopy: null,
    })!;
    expect(one.body).toContain("It slows your pages and confuses");
    const many = valueActionCard({ ...base, plan: "free", cleanCopy: null })!;
    expect(many.body).toContain("They slow your pages and confuse Google");
  });

  it("L15: Professional's do-it-yourself fallback records no Standard do-it-yourself stamp", () => {
    const card = valueActionCard({ ...base, cleanCopy: { state: "none", count: 0 } })!;
    expect(card.kind).toBe("diy");
    expect(card.telemetryKey).toBeNull();
    expect(valueActionCard({ ...base, plan: "standard", cleanCopy: null })!.telemetryKey).toBe(
      "clean_copy_diy",
    );
  });
});

// Audit r2 (2026-11-14): security findings are not leftover code.
describe("valueActionCard: audit r2 fixes", () => {
  const only = (over: Partial<ValueActionInput["leftovers"]>) => ({
    total: 0,
    apps: [],
    removable: 0,
    securityFound: false,
    ...over,
  });

  it("H2: no All clear while a security finding is on the page (even ignored malicious code), on every plan", () => {
    for (const plan of ["free", "standard", "professional"] as const) {
      expect(
        valueActionCard({ ...base, plan, leftovers: only({ securityFound: true }) }),
      ).toBeNull();
    }
    expect(valueActionCard({ ...base, leftovers: only({}) })!.kind).toBe("clear");
  });

  it("H1: Free and Standard never promise removal when nothing is removable", () => {
    const nothingRemovable = only({ total: 4, apps: [{ name: "A", count: 4 }], removable: 0 });
    expect(
      valueActionCard({ ...base, plan: "free", leftovers: nothingRemovable, cleanCopy: null }),
    ).toBeNull();
    const std = valueActionCard({
      ...base,
      plan: "standard",
      leftovers: nothingRemovable,
      cleanCopy: null,
    })!;
    expect(std.kind).toBe("diy");
    expect(std.secondary).toBeNull();
    expect(std.upsellKey).toBeNull();
  });
});
