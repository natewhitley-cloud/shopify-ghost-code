/**
 * Home's checkout guard view (gc-1q1s.6): status line states, incident order
 * and listed-domain notes, flag behaviour, failure isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const model = vi.hoisted(() => ({ loadGuardForHome: vi.fn() }));
vi.mock("../../app/models/storefront-guard.server", () => model);
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { GuardIncident } from "../../app/lib/storefront-guard-state";
import {
  buildGuardStatus,
  GUARD_UNREADABLE_AFTER_MS,
  loadGuardHome,
  toIncidentView,
} from "../../app/services/storefront-guard-home.server";

const NOW = new Date("2026-10-27T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

function inc(over: Partial<GuardIncident> = {}): GuardIncident & { id: string } {
  return {
    id: "i",
    kind: "KNOWN_MALICIOUS",
    fingerprint: "KNOWN_MALICIOUS:cartassure.top",
    host: "cartassure.top",
    page: "home",
    sourceLabel: "Loaded by a script tag in the page",
    state: "open",
    openedAt: ago(HOUR),
    firstSeenAt: ago(HOUR),
    lastSeenAt: NOW,
    seenCount: 1,
    cleanStreak: 0,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: null,
    emailedOpenedAt: null,
    ...over,
  } as GuardIncident & { id: string };
}

const st = (over: Record<string, unknown> = {}) => ({
  lastCheckedAt: ago(HOUR),
  lastOutcome: "ok",
  lastReadableAt: ago(HOUR),
  primaryHost: "shop.example.com",
  lastRedirectHost: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
});

describe("buildGuardStatus", () => {
  it("waiting before the first check, with the plan's cadence", () => {
    expect(buildGuardStatus(null, "free", NOW)).toMatchObject({
      state: "waiting",
      cadence: "daily",
    });
    expect(buildGuardStatus(null, "Professional", NOW)).toMatchObject({ cadence: "hourly" });
  });
  it("ok and partial read as ok with the last readable date", () => {
    expect(buildGuardStatus(st(), "Standard", NOW)).toMatchObject({
      state: "ok",
      date: ago(HOUR).toISOString(),
    });
    expect(buildGuardStatus(st({ lastOutcome: "partial" }), "Standard", NOW).state).toBe("ok");
  });
  it("a /cart unread past PARTIAL_HOME_AUTHORITY checks says so (audit fix)", () => {
    expect(
      buildGuardStatus(st({ lastOutcome: "partial", consecutivePartial: 3 }), "Standard", NOW),
    ).toMatchObject({ state: "ok", cartUnread: true });
    expect(
      buildGuardStatus(st({ lastOutcome: "partial", consecutivePartial: 2 }), "Standard", NOW)
        .cartUnread,
    ).toBeUndefined();
    expect(buildGuardStatus(st({ consecutivePartial: 0 }), "Standard", NOW).cartUnread).toBe(
      undefined,
    );
  });
  it("password and redirect pauses", () => {
    expect(buildGuardStatus(st({ lastOutcome: "paused_password" }), "free", NOW).state).toBe(
      "paused_password",
    );
    expect(
      buildGuardStatus(
        st({ lastOutcome: "paused_redirect", lastRedirectHost: "shop.example.ca" }),
        "free",
        NOW,
      ),
    ).toMatchObject({ state: "paused_redirect", redirectHost: "shop.example.ca" });
  });
  it("an unreachable check within a day of the last read still reads ok", () => {
    expect(
      buildGuardStatus(st({ lastOutcome: "unreachable:timeout" }), "Standard", NOW).state,
    ).toBe("ok");
  });
  it("unreadable for a day says so", () => {
    const old = ago(GUARD_UNREADABLE_AFTER_MS);
    expect(
      buildGuardStatus(st({ lastOutcome: "error", lastReadableAt: old }), "Standard", NOW),
    ).toMatchObject({ state: "unreachable", date: old.toISOString() });
    expect(
      buildGuardStatus(
        st({ lastOutcome: "unreachable:http_status", lastReadableAt: null }),
        "free",
        NOW,
      ),
    ).toMatchObject({ state: "unreachable", date: null });
  });
});

describe("toIncidentView", () => {
  it("takes the listed domain from the fingerprint and its note from the list", () => {
    const v = toIncidentView(inc({ host: "www.cartassure.top" }));
    expect(v.domain).toBe("cartassure.top");
    expect(v.host).toBe("www.cartassure.top");
    expect(typeof v.note).toBe("string");
  });
  it("other kinds have no domain", () => {
    expect(
      toIncidentView(inc({ kind: "NEW_SCRIPT_HOST", fingerprint: "NEW_SCRIPT_HOST:a.io" })).domain,
    ).toBeNull();
  });
});

describe("loadGuardHome", () => {
  it("orders security incidents first, oldest first, and hides the status while dark", async () => {
    model.loadGuardForHome.mockResolvedValue({
      state: st(),
      incidents: [
        inc({
          id: "n",
          kind: "NEW_SCRIPT_HOST",
          fingerprint: "NEW_SCRIPT_HOST:a.io",
          openedAt: ago(5 * HOUR),
        }),
        inc({
          id: "l",
          kind: "SCRIPT_LOADER",
          fingerprint: "SCRIPT_LOADER:x.io",
          openedAt: ago(2 * HOUR),
        }),
        inc({ id: "m2", openedAt: ago(1 * HOUR) }),
        inc({ id: "m1", openedAt: ago(3 * HOUR) }),
      ],
    });
    const out = await loadGuardHome({ id: "s", plan: "free" }, NOW);
    expect(out.incidents.map((i) => i.id)).toEqual(["m1", "m2", "l", "n"]);
    expect(out.status).toBeNull();
    // Dark: the state row is not read (audit fix); stored incidents still are.
    expect(model.loadGuardForHome).toHaveBeenCalledWith("s", { withState: false });
  });
  it("adds the status line while live", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.loadGuardForHome.mockResolvedValue({ state: null, incidents: [] });
    const out = await loadGuardHome({ id: "s", plan: "Standard" }, NOW);
    expect(out.status?.state).toBe("waiting");
    expect(model.loadGuardForHome).toHaveBeenCalledWith("s", { withState: true });
  });
  it("never throws", async () => {
    model.loadGuardForHome.mockRejectedValue(new Error("db down"));
    expect(await loadGuardHome({ id: "s", plan: "free" }, NOW)).toEqual({
      incidents: [],
      status: null,
    });
  });
});
