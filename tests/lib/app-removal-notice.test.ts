/**
 * Tests for app/lib/app-removal-notice.ts (gc-frda UI): which apps Home's
 * banner shows and every merchant-facing line about them.
 */
import { describe, it, expect } from "vitest";

import {
  buildRemovalNotice,
  itemCount,
  newlyInactiveBadge,
  REMOVAL_NOTICE_MAX_APPS,
  removalAppHref,
  removalContextBody,
  removalContextTitle,
  removalNoticeAppLine,
  removalNoticeBody,
  removalNoticeHeading,
  removalNoticeOverflow,
  removalNoticePrimaryLabel,
  scopedFindingsHeading,
} from "../../app/lib/app-removal-notice";
import type { RemovalNotice, RemovalNoticeInput } from "../../app/lib/app-removal-notice";

const row = (appName: string, leftoverCount: number, state = "REMOVED"): RemovalNoticeInput => ({
  appName,
  leftoverCount,
  state,
});

describe("buildRemovalNotice", () => {
  it("no rows: nothing to show", () => {
    expect(buildRemovalNotice([])).toBeNull();
  });

  it("one REMOVED row: an inactive notice for that app", () => {
    expect(buildRemovalNotice([row("Yotpo", 3)])).toEqual({
      kind: "inactive",
      apps: [{ appName: "Yotpo", count: 3 }],
      total: 3,
    });
  });

  it("sorts apps by count (largest first), then name", () => {
    const notice = buildRemovalNotice([
      row("Privy", 2),
      row("Yotpo", 5),
      row("Klaviyo", 2),
      row("Avada", 1),
    ]);
    expect(notice?.apps.map((a) => a.appName)).toEqual(["Yotpo", "Klaviyo", "Privy", "Avada"]);
    expect(notice?.total).toBe(10);
  });

  it("inactive wins over cleaned when both happened on the scan", () => {
    const notice = buildRemovalNotice([row("Yotpo", 3), row("Privy", 2, "CLEANED")]);
    expect(notice?.kind).toBe("inactive");
    expect(notice?.apps).toEqual([{ appName: "Yotpo", count: 3 }]);
  });

  it("only CLEANED rows: a cleaned notice", () => {
    expect(buildRemovalNotice([row("Privy", 2, "CLEANED")])).toEqual({
      kind: "cleaned",
      apps: [{ appName: "Privy", count: 2 }],
      total: 2,
    });
  });

  it("REINSTALLED rows never show", () => {
    expect(buildRemovalNotice([row("Yotpo", 3, "REINSTALLED")])).toBeNull();
  });

  it("a row with no items never shows (nothing to tell the merchant)", () => {
    expect(buildRemovalNotice([row("Yotpo", 0)])).toBeNull();
    expect(buildRemovalNotice([row("Yotpo", 0), row("Privy", 0, "CLEANED")])).toBeNull();
  });
});

const notice = (kind: RemovalNotice["kind"], counts: Record<string, number>): RemovalNotice =>
  buildRemovalNotice(
    Object.entries(counts).map(([a, n]) => row(a, n, kind === "inactive" ? "REMOVED" : "CLEANED")),
  )!;

describe("copy", () => {
  it("one inactive app: heading, body, paid and Free primary labels", () => {
    const n = notice("inactive", { Yotpo: 3 });
    expect(removalNoticeHeading(n)).toBe("Yotpo is no longer active in your store");
    expect(removalNoticeBody(n)).toBe("It left 3 items behind.");
    expect(removalNoticePrimaryLabel(n, true)).toBe("Review 3 items");
    expect(removalNoticePrimaryLabel(n, false)).toBe("See what Yotpo left");
  });

  it("singular item", () => {
    const n = notice("inactive", { Yotpo: 1 });
    expect(removalNoticeBody(n)).toBe("It left 1 item behind.");
    expect(removalNoticePrimaryLabel(n, true)).toBe("Review 1 item");
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(2)).toBe("2 items");
  });

  it("several inactive apps: heading, body, list lines, primary names the first app", () => {
    const n = notice("inactive", { Yotpo: 5, Privy: 2 });
    expect(removalNoticeHeading(n)).toBe("2 apps are no longer active in your store");
    expect(removalNoticeBody(n)).toBe("Together they left 7 items behind.");
    expect(removalNoticeAppLine(n.apps[0])).toBe("Yotpo: 5 items");
    expect(removalNoticeAppLine({ appName: "Privy", count: 1 })).toBe("Privy: 1 item");
    expect(removalNoticePrimaryLabel(n, true)).toBe("Review Yotpo");
    expect(removalNoticePrimaryLabel(n, false)).toBe("Review Yotpo");
  });

  it("overflow: 'and N more' only past the cap of 5", () => {
    const five = notice("inactive", { A: 1, B: 1, C: 1, D: 1, E: 1 });
    expect(REMOVAL_NOTICE_MAX_APPS).toBe(5);
    expect(removalNoticeOverflow(five)).toBeNull();
    const seven = notice("inactive", { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1 });
    expect(removalNoticeOverflow(seven)).toBe("and 2 more");
  });

  it("cleaned: one app and several", () => {
    const one = notice("cleaned", { Privy: 2 });
    expect(removalNoticeHeading(one)).toBe("Privy's leftovers are cleaned up");
    expect(removalNoticeBody(one)).toBe("The 2 items Privy left behind are gone as of this scan.");
    expect(removalNoticeBody(notice("cleaned", { Privy: 1 }))).toBe(
      "The 1 item Privy left behind is gone as of this scan.",
    );
    const two = notice("cleaned", { Privy: 2, Yotpo: 3 });
    expect(removalNoticeHeading(two)).toBe("2 apps' leftovers are cleaned up");
    expect(removalNoticeBody(two)).toBe("The 5 items they left behind are gone as of this scan.");
  });

  it("scan page: context title, body with and without the previous date, scoped heading", () => {
    expect(removalContextTitle("Yotpo")).toBe("Yotpo is no longer active in your store");
    const withDate = removalContextBody("Yotpo", 3, true);
    expect(`${withDate.before}Oct 2, 2026${withDate.after}`).toBe(
      "Yotpo was active at your previous scan (Oct 2, 2026) and isn't now. It left 3 items behind. This code stays in your theme until it's cleaned up.",
    );
    const noDate = removalContextBody("Yotpo", 1, false);
    expect(noDate.before + noDate.after).toBe(
      "Yotpo was active at your previous scan and isn't now. It left 1 item behind. This code stays in your theme until it's cleaned up.",
    );
    expect(scopedFindingsHeading("Yotpo", 3)).toBe("3 findings from Yotpo");
    expect(scopedFindingsHeading("Yotpo", 1)).toBe("1 finding from Yotpo");
    expect(newlyInactiveBadge("Yotpo")).toBe("New · Yotpo");
  });

  it("links to the app's filtered scan view, keeping the embedded params", () => {
    expect(removalAppHref("scan-1", "Judge.me Reviews")).toBe(
      "/app/scans/scan-1?app=Judge.me+Reviews",
    );
    const current = new URLSearchParams({ host: "abc", shop: "s.myshopify.com" });
    expect(removalAppHref("scan-1", "A&B", current)).toBe(
      "/app/scans/scan-1?host=abc&shop=s.myshopify.com&app=A%26B",
    );
  });
});

describe("copy rules (decided: never 'removed'/'uninstalled', no dashes)", () => {
  const strings = (): string[] => {
    const out: string[] = [];
    for (const kind of ["inactive", "cleaned"] as const) {
      const fixtures: Array<Record<string, number>> = [
        { Yotpo: 1 },
        { Yotpo: 3 },
        { A: 2, B: 1, C: 1, D: 1, E: 1, F: 1 },
      ];
      for (const counts of fixtures) {
        const n = notice(kind, counts);
        out.push(removalNoticeHeading(n), removalNoticeBody(n));
        out.push(removalNoticePrimaryLabel(n, true), removalNoticePrimaryLabel(n, false));
        out.push(...n.apps.map(removalNoticeAppLine));
        const overflow = removalNoticeOverflow(n);
        if (overflow) out.push(overflow);
      }
    }
    for (const d of [true, false]) {
      const b = removalContextBody("Yotpo", 3, d);
      out.push(b.before, b.after);
    }
    out.push(removalContextTitle("Yotpo"), scopedFindingsHeading("Yotpo", 2));
    return out;
  };

  it("no line says the merchant removed or uninstalled the app", () => {
    for (const s of strings()) expect(s).not.toMatch(/remov|uninstall/i);
  });

  it("no line uses an em or en dash", () => {
    for (const s of strings()) expect(s).not.toMatch(/[–—]/);
  });
});
