/**
 * Checkout guard copy (gc-1q1s.6): spike section B rules and the merge with
 * scan banners by domain.
 */
import { describe, it, expect } from "vitest";

import {
  guardIncidentBody,
  guardIncidentsToShow,
  guardIncidentTitle,
  guardPagesLabel,
  guardSightingsLead,
  guardStatusWords,
  GUARD_CHECK_STEPS,
  mergeGuardWithScanRisks,
  type GuardIncidentView,
  type GuardStatusView,
} from "../../app/lib/storefront-guard-copy";

const base: GuardIncidentView = {
  id: "i1",
  kind: "KNOWN_MALICIOUS",
  host: "cdn.cartassure.top",
  domain: "cartassure.top",
  note: "checkout-phishing domain",
  pages: "home",
  sourceLabel: "Loaded by a script tag in the page",
  openedAt: "2026-10-27T01:00:00.000Z",
  lastSeenAt: "2026-10-27T03:00:00.000Z",
  seenCount: 1,
};
const kinds: GuardIncidentView[] = [
  base,
  { ...base, kind: "SCRIPT_LOADER", domain: null, note: null, host: "x.example" },
  { ...base, kind: "SCRIPT_LOADER", domain: null, note: null, host: null },
  { ...base, kind: "NEW_SCRIPT_HOST", domain: null, note: null, host: "new.example" },
];

describe("incident copy", () => {
  it.each(kinds)("$kind: no dashes, never claims a hijacked checkout", (i) => {
    const text = `${guardIncidentTitle(i)} ${guardIncidentBody(i)} ${GUARD_CHECK_STEPS.join(" ")}`;
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/hijack/i);
  });

  it("known malicious: names the listed domain, the host as seen and that the code still runs", () => {
    expect(guardIncidentTitle(base)).toBe(
      "Your live store loads code from cartassure.top, a domain linked to malicious code",
    );
    const body = guardIncidentBody(base);
    expect(body).toContain(
      "saw it as cdn.cartassure.top on your homepage (loaded by a script tag in the page)",
    );
    expect(body).toContain(
      "GhostCode lists cartassure.top as a source of malicious code (checkout-phishing domain).",
    );
    expect(body).toContain("Shopify may block shoppers");
    expect(body).toContain("this code still runs on your store");
  });

  it("host-less loader title", () => {
    expect(guardIncidentTitle(kinds[2])).toBe(
      "Code on your live store builds a script in an unusual way",
    );
  });

  it("pages and sightings", () => {
    expect(guardPagesLabel("both")).toBe("your homepage and cart page");
    expect(guardPagesLabel("cart")).toBe("your cart page");
    expect(guardSightingsLead(base)).toBeNull();
    expect(guardSightingsLead({ ...base, seenCount: 4 })).toBe("Seen 4 times, last on");
  });
});

describe("status words", () => {
  const s = (over: Partial<GuardStatusView>): GuardStatusView => ({
    state: "ok",
    cadence: "hourly",
    date: "2026-10-27T03:00:00.000Z",
    primaryHost: "shop.example.com",
    redirectHost: null,
    ...over,
  });
  it("names the cadence", () => {
    expect(guardStatusWords(s({})).tail).toContain("every hour");
    expect(guardStatusWords(s({ cadence: "daily" })).tail).toContain("once a day");
    expect(guardStatusWords(s({ state: "waiting", cadence: "daily" })).lead).toContain(
      "within a day",
    );
  });
  it("says when the cart page could not be read (audit fix)", () => {
    const words = guardStatusWords(s({ cartUnread: true }));
    expect(words.tail).toBe(
      ". It checks your homepage every hour. Your cart page could not be read, so it is not checked.",
    );
    expect(guardStatusWords(s({})).tail).toContain("homepage and cart page");
  });
  it("redirect names both hosts (host only)", () => {
    expect(
      guardStatusWords(s({ state: "paused_redirect", redirectHost: "shop.example.ca" })).lead,
    ).toBe(
      "Checkout guard reads shop.example.com, but your store sends our US-based check to shop.example.ca, so it can't check your storefront.",
    );
  });
  it("unreachable with and without a last readable date", () => {
    expect(guardStatusWords(s({ state: "unreachable" })).lead).toBe(
      "Checkout guard couldn't read your storefront since",
    );
    expect(guardStatusWords(s({ state: "unreachable", date: null })).lead).toContain("yet");
  });
});

describe("mergeGuardWithScanRisks", () => {
  it("folds a known-malicious incident into the scan banner for the same domain", () => {
    const out = mergeGuardWithScanRisks(kinds, new Set(["cartassure.top"]));
    expect(out.standalone.map((i) => i.kind)).toEqual([
      "SCRIPT_LOADER",
      "SCRIPT_LOADER",
      "NEW_SCRIPT_HOST",
    ]);
    expect(out.seenByGuard).toEqual({ "cartassure.top": base.lastSeenAt });
  });
  it("keeps it standalone when no scan banner names the domain", () => {
    const out = mergeGuardWithScanRisks([base], new Set(["jsdeliver.cloud"]));
    expect(out.standalone).toEqual([base]);
    expect(out.seenByGuard).toEqual({});
  });
  it("empty in, empty out", () => {
    expect(mergeGuardWithScanRisks([], new Set())).toEqual({ standalone: [], seenByGuard: {} });
  });
});

describe("guardIncidentsToShow (This is expected, optimistic)", () => {
  const a = { ...base, id: "a" };
  const b = { ...base, id: "b" };

  it("hides incidents acknowledged on this page", () => {
    expect(guardIncidentsToShow([a, b], new Set(["a"]), null)).toEqual([b]);
    expect(
      guardIncidentsToShow([a, b], new Set(["a"]), { acknowledged: true, incidentId: "a" }),
    ).toEqual([b]);
  });

  it("shows an incident again when the server refused to acknowledge it (audit fix)", () => {
    expect(
      guardIncidentsToShow([a, b], new Set(["a", "b"]), { acknowledged: false, incidentId: "a" }),
    ).toEqual([a]);
  });

  it("an unrelated reply changes nothing", () => {
    expect(guardIncidentsToShow([a, b], new Set(), { ignored: true } as never)).toEqual([a, b]);
  });
});
