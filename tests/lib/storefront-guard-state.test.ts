/**
 * Checkout guard state machine (gc-1q1s.4): baseline learning, 2-of-3
 * debounce, loader confirmation, immediate known-malicious, resolve after two
 * clean checks, 7-day flap window, decay, auto-merge, backoff.
 */
import { describe, it, expect } from "vitest";

import {
  acknowledgeNewHost,
  applyGuardCheck,
  AUTO_MERGE_MS,
  BASELINE_DECAY_MS,
  backoffDelayMs,
  capGuardSightings,
  EMPTY_GUARD_STATE,
  FLAP_WINDOW_MS,
  MAX_BASELINE_HOSTS,
  MAX_HOSTS_PER_CHECK,
  MAX_LIVE_SCRIPT_LOADERS,
  MAX_LOADERS_PER_CHECK,
  newHostFingerprint,
  PARTIAL_HOME_AUTHORITY,
  PAUSED_RECHECK_MS,
  type GuardCheckInput,
  type GuardHostSighting,
  type GuardIncident,
  type GuardSighting,
  type GuardStateData,
} from "../../app/lib/storefront-guard-state";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-10-27T00:17:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const MAL: GuardSighting = {
  kind: "KNOWN_MALICIOUS",
  fingerprint: "KNOWN_MALICIOUS:cartassure.top",
  host: "cartassure.top",
  page: "home",
  sourceLabel: "Loaded by a script tag in the page",
};
const LOADER: GuardSighting = {
  kind: "SCRIPT_LOADER",
  fingerprint: "SCRIPT_LOADER:evil.example",
  host: "evil.example",
  page: "cart",
  sourceLabel: "Code in an onerror attribute",
};
const host = (h: string, page: "home" | "cart" = "home"): GuardHostSighting => ({
  host: h,
  page,
  sourceLabel: "Loaded by a script tag in the page",
});

function ok(
  opts: { sightings?: GuardSighting[]; hosts?: string[]; complete?: boolean } = {},
): GuardCheckInput {
  return {
    outcome: "ok",
    complete: opts.complete ?? true,
    sightings: opts.sightings ?? [],
    hosts: (opts.hosts ?? []).map((h) => host(h)),
  };
}

/** Run checks in sequence, one hour apart, carrying state and incidents. */
function run(
  checks: GuardCheckInput[],
  start: { state?: GuardStateData; incidents?: GuardIncident[]; t?: number } = {},
) {
  let state = start.state ?? EMPTY_GUARD_STATE;
  const incidents = new Map((start.incidents ?? []).map((i) => [i.fingerprint, i]));
  const opened: GuardIncident[][] = [];
  let t = start.t ?? 0;
  for (const check of checks) {
    const r = applyGuardCheck(state, [...incidents.values()], check, at(t));
    state = r.state;
    for (const i of r.changed) incidents.set(i.fingerprint, i);
    opened.push(r.opened);
    t += HOUR;
  }
  return { state, incidents, opened, t };
}

/** A state past learning with `baseline` hosts seen at T0. */
function learned(baseline: string[] = ["cdn.app.com"]): GuardStateData {
  return {
    ...EMPTY_GUARD_STATE,
    readableChecks: 3,
    lastCheckedAt: T0,
    baselineHosts: Object.fromEntries(baseline.map((h) => [h, T0.toISOString()])),
    recentHostSets: [],
  };
}

describe("KNOWN_MALICIOUS", () => {
  it("opens on the first sighting, even during learning", () => {
    const { incidents, opened } = run([ok({ sightings: [MAL] })]);
    const i = incidents.get(MAL.fingerprint)!;
    expect(i.state).toBe("open");
    expect(i.openedAt).toEqual(T0);
    expect(opened[0].map((x) => x.fingerprint)).toEqual([MAL.fingerprint]);
  });

  it("records both pages when home and cart both show it", () => {
    const { incidents } = run([ok({ sightings: [MAL, { ...MAL, page: "cart" }] })]);
    expect(incidents.get(MAL.fingerprint)!.page).toBe("both");
  });

  it("stays one open incident across sightings (no second opening)", () => {
    const { incidents, opened } = run([ok({ sightings: [MAL] }), ok({ sightings: [MAL] })]);
    expect(opened[1]).toEqual([]);
    expect(incidents.get(MAL.fingerprint)!.seenCount).toBe(2);
  });

  it("resolves after two complete clean checks, not one", () => {
    const r1 = run([ok({ sightings: [MAL] }), ok()]);
    expect(r1.incidents.get(MAL.fingerprint)!.state).toBe("open");
    expect(r1.incidents.get(MAL.fingerprint)!.cleanStreak).toBe(1);
    const r2 = run([ok({ sightings: [MAL] }), ok(), ok()]);
    const i = r2.incidents.get(MAL.fingerprint)!;
    expect(i.state).toBe("resolved");
    expect(i.resolution).toBe("clean");
  });

  it("a sighting between clean checks resets the clean streak", () => {
    const { incidents } = run([ok({ sightings: [MAL] }), ok(), ok({ sightings: [MAL] }), ok()]);
    expect(incidents.get(MAL.fingerprint)!.state).toBe("open");
  });
});

describe("unreadable checks are never clean and never a hit", () => {
  const nonOk: GuardCheckInput[] = [
    { outcome: "paused_password" },
    { outcome: "paused_redirect", redirectHost: "shop.example.ca" },
    { outcome: "unreachable", reason: "timeout", challenged: false },
    { outcome: "unreachable", reason: "http_status", challenged: true },
    { outcome: "error" },
  ];

  it.each(nonOk)("$outcome changes no incident", (check) => {
    const first = run([ok({ sightings: [MAL] })]);
    const r = applyGuardCheck(first.state, [...first.incidents.values()], check, at(HOUR));
    expect(r.changed).toEqual([]);
    expect(r.opened).toEqual([]);
  });

  it("an open incident does not resolve across password pauses", () => {
    const { incidents } = run([
      ok({ sightings: [MAL] }),
      { outcome: "paused_password" },
      { outcome: "paused_password" },
      { outcome: "paused_password" },
    ]);
    expect(incidents.get(MAL.fingerprint)!.state).toBe("open");
  });

  it("partial checks (cart unread) add sightings but never count as clean", () => {
    const { incidents } = run([
      ok({ sightings: [LOADER] }),
      ok({ complete: false }),
      ok({ complete: false }),
    ]);
    // Still pending: a partial check cannot drop or resolve it.
    expect(incidents.get(LOADER.fingerprint)!.state).toBe("pending");
  });

  it("records the outcome, redirect host and never touches readableChecks", () => {
    const r = run([{ outcome: "paused_redirect", redirectHost: "shop.example.ca" }]);
    expect(r.state.lastOutcome).toBe("paused_redirect");
    expect(r.state.lastRedirectHost).toBe("shop.example.ca");
    expect(r.state.readableChecks).toBe(0);
    expect(r.state.lastReadableAt).toBeNull();
  });
});

describe("SCRIPT_LOADER", () => {
  it("is pending after one sighting and opens on the second readable sighting", () => {
    const r = run([ok({ sightings: [LOADER] })]);
    expect(r.incidents.get(LOADER.fingerprint)!.state).toBe("pending");
    expect(r.opened[0]).toEqual([]);
    const r2 = run([ok({ sightings: [LOADER] }), ok({ sightings: [LOADER] })]);
    expect(r2.incidents.get(LOADER.fingerprint)!.state).toBe("open");
    expect(r2.opened[1].map((i) => i.kind)).toEqual(["SCRIPT_LOADER"]);
  });

  it("an unreachable check between sightings does not break the pair", () => {
    const r = run([
      ok({ sightings: [LOADER] }),
      { outcome: "unreachable", reason: "timeout", challenged: false },
      ok({ sightings: [LOADER] }),
    ]);
    expect(r.incidents.get(LOADER.fingerprint)!.state).toBe("open");
  });

  it("a complete clean check drops the candidate (lapsed, never opened)", () => {
    const r = run([ok({ sightings: [LOADER] }), ok(), ok({ sightings: [LOADER] })]);
    const i = r.incidents.get(LOADER.fingerprint)!;
    // Third check: a fresh candidate again, not open.
    expect(i.state).toBe("pending");
    expect(r.opened.flat()).toEqual([]);
  });
});

describe("flapping (7-day window)", () => {
  it("a reappearance within 7 days reopens the SAME episode: no new opening", () => {
    const first = run([ok({ sightings: [MAL] }), ok(), ok()]);
    const before = first.incidents.get(MAL.fingerprint)!;
    expect(before.state).toBe("resolved");
    const again = run([ok({ sightings: [MAL] })], {
      state: first.state,
      incidents: [...first.incidents.values()],
      t: 3 * DAY,
    });
    const i = again.incidents.get(MAL.fingerprint)!;
    expect(i.state).toBe("open");
    expect(i.openedAt).toEqual(T0);
    expect(again.opened[0]).toEqual([]);
    expect(i.seenCount).toBe(2);
  });

  it("a reappearance after 7 days clean is a new episode (new openedAt, opened)", () => {
    const first = run([ok({ sightings: [MAL] }), ok(), ok()]);
    const resolvedAt = first.incidents.get(MAL.fingerprint)!.resolvedAt!;
    const t = resolvedAt.getTime() - T0.getTime() + FLAP_WINDOW_MS;
    const again = run([ok({ sightings: [MAL] })], {
      state: first.state,
      incidents: [...first.incidents.values()],
      t,
    });
    const i = again.incidents.get(MAL.fingerprint)!;
    expect(i.openedAt).toEqual(at(t));
    expect(again.opened[0]).toHaveLength(1);
    expect(i.firstSeenAt).toEqual(T0);
  });

  it("a flapping loader reopens at once inside the window (no second pending)", () => {
    const first = run([ok({ sightings: [LOADER] }), ok({ sightings: [LOADER] }), ok(), ok()]);
    expect(first.incidents.get(LOADER.fingerprint)!.state).toBe("resolved");
    const again = run([ok({ sightings: [LOADER] })], {
      state: first.state,
      incidents: [...first.incidents.values()],
      t: DAY,
    });
    expect(again.incidents.get(LOADER.fingerprint)!.state).toBe("open");
    expect(again.opened[0]).toEqual([]);
  });

  it("keeps emailedOpenedAt across a same-episode reopen", () => {
    const first = run([ok({ sightings: [MAL] }), ok(), ok()]);
    const emailed = { ...first.incidents.get(MAL.fingerprint)!, emailedOpenedAt: T0 };
    const again = run([ok({ sightings: [MAL] })], {
      state: first.state,
      incidents: [emailed],
      t: DAY,
    });
    expect(again.incidents.get(MAL.fingerprint)!.emailedOpenedAt).toEqual(T0);
  });
});

describe("NEW_SCRIPT_HOST baseline and debounce", () => {
  it("the first 3 complete checks only learn: no incident, union baseline", () => {
    const r = run([ok({ hosts: ["a.com"] }), ok({ hosts: ["b.com"] }), ok({ hosts: ["c.com"] })]);
    expect(r.incidents.size).toBe(0);
    expect(Object.keys(r.state.baselineHosts).sort()).toEqual(["a.com", "b.com", "c.com"]);
    expect(r.state.readableChecks).toBe(3);
  });

  it("partial checks do not count toward learning", () => {
    const r = run([ok({ hosts: ["a.com"], complete: false })]);
    expect(r.state.readableChecks).toBe(0);
    expect(r.state.baselineHosts).toEqual({});
  });

  it("a new host seen once is a candidate only; twice in 3 checks opens", () => {
    const r1 = run([ok({ hosts: ["new.io"] })], { state: learned() });
    expect(r1.incidents.size).toBe(0);
    const r2 = run([ok({ hosts: ["new.io"] }), ok({ hosts: ["new.io"] })], { state: learned() });
    const i = r2.incidents.get(newHostFingerprint("new.io"))!;
    expect(i.state).toBe("open");
    expect(i.kind).toBe("NEW_SCRIPT_HOST");
    expect(r2.opened[1]).toHaveLength(1);
  });

  it("2 of 3 opens even with a gap (seen, not seen, seen)", () => {
    const r = run([ok({ hosts: ["new.io"] }), ok(), ok({ hosts: ["new.io"] })], {
      state: learned(),
    });
    expect(r.incidents.get(newHostFingerprint("new.io"))?.state).toBe("open");
  });

  it("1 of 3 (flicker) never opens", () => {
    const r = run([ok({ hosts: ["new.io"] }), ok(), ok(), ok({ hosts: ["new.io"] })], {
      state: learned(),
    });
    expect(r.incidents.has(newHostFingerprint("new.io"))).toBe(false);
  });

  it("baseline hosts never open and their lastSeen is refreshed", () => {
    const r = run([ok({ hosts: ["cdn.app.com"] }), ok({ hosts: ["cdn.app.com"] })], {
      state: learned(),
    });
    expect(r.incidents.size).toBe(0);
    expect(r.state.baselineHosts["cdn.app.com"]).toBe(at(HOUR).toISOString());
  });

  it("a host that is also a known-malicious sighting gets no separate new-host incident", () => {
    const r = run(
      [
        ok({ sightings: [MAL], hosts: ["cartassure.top"] }),
        ok({ sightings: [MAL], hosts: ["cartassure.top"] }),
      ],
      { state: learned() },
    );
    expect(r.incidents.has(newHostFingerprint("cartassure.top"))).toBe(false);
    expect(r.incidents.get(MAL.fingerprint)!.state).toBe("open");
  });

  it("a baseline host unseen for 30 days decays out", () => {
    const state = learned(["old.com"]);
    const r = run([ok({ hosts: [] })], { state, t: BASELINE_DECAY_MS });
    expect(r.state.baselineHosts).toEqual({});
  });

  it("a host open and still seen 14 days later auto-merges into the baseline", () => {
    const opened = run([ok({ hosts: ["new.io"] }), ok({ hosts: ["new.io"] })], {
      state: learned(),
    });
    const r = run([ok({ hosts: ["new.io"] })], {
      state: opened.state,
      incidents: [...opened.incidents.values()],
      t: HOUR + AUTO_MERGE_MS,
    });
    const i = r.incidents.get(newHostFingerprint("new.io"))!;
    expect(i.state).toBe("resolved");
    expect(i.resolution).toBe("auto_merged");
    expect(r.state.baselineHosts["new.io"]).toBeDefined();
  });

  it("reports how many host candidates the per-check cap dropped (gc-njwa #4)", () => {
    const hosts = Array.from({ length: MAX_HOSTS_PER_CHECK + 7 }, (_, n) => ({
      host: `h${String(n).padStart(4, "0")}.example`,
      page: "home" as const,
      sourceLabel: "Loaded by a script tag in the page",
    }));
    const check: GuardCheckInput = { outcome: "ok", complete: true, sightings: [], hosts };
    expect(applyGuardCheck(EMPTY_GUARD_STATE, [], check, new Date(0)).droppedHosts).toBe(7);
    const few: GuardCheckInput = {
      outcome: "ok",
      complete: true,
      sightings: [],
      hosts: hosts.slice(0, 3),
    };
    expect(applyGuardCheck(EMPTY_GUARD_STATE, [], few, new Date(0)).droppedHosts).toBe(0);
    const down: GuardCheckInput = { outcome: "unreachable", reason: "timeout", challenged: false };
    expect(applyGuardCheck(EMPTY_GUARD_STATE, [], down, new Date(0)).droppedHosts).toBe(0);
  });

  it("caps the hosts kept per check and the baseline size", () => {
    const many = Array.from({ length: MAX_BASELINE_HOSTS + 50 }, (_, n) => `h${n}.example`);
    const r = run([ok({ hosts: many })]);
    expect(Object.keys(r.state.baselineHosts).length).toBeLessThanOrEqual(MAX_HOSTS_PER_CHECK);
    expect(Object.keys(r.state.baselineHosts).length).toBeLessThanOrEqual(MAX_BASELINE_HOSTS);
  });

  it("empty check on an empty state is a no-op apart from counters", () => {
    const r = applyGuardCheck(EMPTY_GUARD_STATE, [], ok(), T0);
    expect(r.changed).toEqual([]);
    expect(r.state.readableChecks).toBe(1);
    expect(r.state.lastOutcome).toBe("ok");
  });

  it("does not mutate its inputs", () => {
    const state = learned(["cdn.app.com"]);
    const snapshot = JSON.stringify(state);
    applyGuardCheck(state, [], ok({ hosts: ["x.io"] }), at(DAY * 40));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("acknowledgeNewHost (This is expected)", () => {
  it("moves the host into the baseline and resolves the incident", () => {
    const opened = run([ok({ hosts: ["new.io"] }), ok({ hosts: ["new.io"] })], {
      state: learned(),
    });
    const incident = opened.incidents.get(newHostFingerprint("new.io"))!;
    const ack = acknowledgeNewHost(opened.state, incident, at(DAY))!;
    expect(ack.incident.state).toBe("resolved");
    expect(ack.incident.resolution).toBe("acknowledged");
    expect(ack.incident.acknowledgedAt).toEqual(at(DAY));
    expect(ack.state.baselineHosts["new.io"]).toBeDefined();
    // And the next sighting is quiet (baseline), not a flap reopen.
    const next = applyGuardCheck(
      ack.state,
      [ack.incident],
      ok({ hosts: ["new.io"] }),
      at(DAY + HOUR),
    );
    expect(next.changed).toEqual([]);
  });

  it("refuses other kinds and resolved incidents", () => {
    const mal = run([ok({ sightings: [MAL] })]).incidents.get(MAL.fingerprint)!;
    expect(acknowledgeNewHost(learned(), mal, T0)).toBeNull();
  });
});

describe("backoff", () => {
  it("grows from the third unreachable check in a row, capped at 24h", () => {
    expect(backoffDelayMs(1)).toBe(0);
    expect(backoffDelayMs(2)).toBe(0);
    expect(backoffDelayMs(3)).toBe(HOUR);
    expect(backoffDelayMs(4)).toBe(2 * HOUR);
    expect(backoffDelayMs(20)).toBe(DAY);
  });

  it("sets backoffUntil on the third unreachable check, and a readable check clears it", () => {
    const down = { outcome: "unreachable", reason: "timeout", challenged: false } as const;
    const r = run([down, down, down]);
    expect(r.state.consecutiveUnreachable).toBe(3);
    expect(r.state.backoffUntil).toEqual(at(2 * HOUR + HOUR));
    const back = run([ok()], { state: r.state, t: r.t });
    expect(back.state.consecutiveUnreachable).toBe(0);
    expect(back.state.backoffUntil).toBeNull();
  });

  it("a challenged check (403/429) backs off at once", () => {
    const r = run([{ outcome: "unreachable", reason: "http_status", challenged: true }]);
    expect(r.state.backoffUntil).toEqual(at(HOUR));
    expect(r.state.lastOutcome).toBe("unreachable:http_status");
  });

  it("password pauses never grow the backoff", () => {
    const r = run([
      { outcome: "paused_password" },
      { outcome: "paused_password" },
      { outcome: "paused_password" },
    ]);
    expect(r.state.consecutiveUnreachable).toBe(0);
    // The last pause (at T0 + 2 h) sets the fixed recheck floor, nothing more.
    expect(r.state.backoffUntil).toEqual(at(2 * HOUR + PAUSED_RECHECK_MS));
  });

  // Audit fix: a paused store was re-read every hour forever.
  it.each([
    { outcome: "paused_password" } as const,
    { outcome: "paused_redirect", redirectHost: "other.example" } as const,
  ])("a $outcome store is not read again for PAUSED_RECHECK_MS", (check) => {
    const r = applyGuardCheck(EMPTY_GUARD_STATE, [], check, T0);
    expect(PAUSED_RECHECK_MS).toBe(6 * HOUR);
    expect(r.state.backoffUntil).toEqual(at(PAUSED_RECHECK_MS));
  });

  it("a pause never shortens a longer unreachable backoff", () => {
    const later = at(DAY);
    const r = applyGuardCheck(
      { ...EMPTY_GUARD_STATE, backoffUntil: later },
      [],
      { outcome: "paused_password" },
      T0,
    );
    expect(r.state.backoffUntil).toEqual(later);
  });

  it("a readable check clears the pause", () => {
    const r = run([{ outcome: "paused_password" }, ok()]);
    expect(r.state.backoffUntil).toBeNull();
  });
});

describe("a store whose /cart never reads (audit fix)", () => {
  it("home-only incidents resolve once the homepage has been authoritative long enough", () => {
    const partial = ok({ complete: false });
    const r = run([
      ok({ sightings: [MAL], complete: false }),
      ...Array(PARTIAL_HOME_AUTHORITY + 2).fill(partial),
    ]);
    const i = r.incidents.get(MAL.fingerprint)!;
    expect(i.state).toBe("resolved");
    expect(i.resolution).toBe("clean");
  });

  it("before that, partial checks never clear it", () => {
    const partial = ok({ complete: false });
    const r = run([ok({ sightings: [MAL], complete: false }), partial, partial]);
    expect(r.incidents.get(MAL.fingerprint)!.state).toBe("open");
  });

  it("incidents seen on /cart still need a complete check", () => {
    const partial = ok({ complete: false });
    const r = run([
      ok({ sightings: [{ ...MAL, page: "cart" }] }),
      ...Array(PARTIAL_HOME_AUTHORITY + 3).fill(partial),
    ]);
    expect(r.incidents.get(MAL.fingerprint)!.state).toBe("open");
  });

  // Audit fix (M6): /cart is treated as absent after the threshold.
  it("an incident seen on both pages resolves on homepage evidence once /cart is absent", () => {
    const partial = ok({ complete: false });
    const r = run([
      ok({ sightings: [MAL, { ...MAL, page: "cart" }] }),
      ...Array(PARTIAL_HOME_AUTHORITY + 2).fill(partial),
    ]);
    const i = r.incidents.get(MAL.fingerprint)!;
    expect(i.page).toBe("both");
    expect(i.state).toBe("resolved");
    expect(i.resolution).toBe("clean");
  });

  it("learning completes on the homepage once /cart is absent", () => {
    const partial = (hosts: string[]) => ok({ hosts, complete: false });
    const r = run([
      ...Array(PARTIAL_HOME_AUTHORITY - 1).fill(partial(["a.com"])),
      partial(["a.com"]),
      partial(["b.com"]),
      partial(["c.com"]),
    ]);
    expect(r.state.readableChecks).toBe(3);
    expect(Object.keys(r.state.baselineHosts).sort()).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("then a new homepage host opens after the 2-of-3 debounce", () => {
    const partial = (hosts: string[]) => ok({ hosts, complete: false });
    const r = run([
      ...Array(PARTIAL_HOME_AUTHORITY + 3).fill(partial([])),
      partial(["new.io"]),
      partial(["new.io"]),
    ]);
    expect(r.incidents.get(newHostFingerprint("new.io"))?.state).toBe("open");
  });

  it("a complete check resets the partial run", () => {
    const r = run([ok({ complete: false }), ok({ complete: false }), ok()]);
    expect(r.state.consecutivePartial).toBe(0);
  });
});

describe("flap reopen past the auto-merge age", () => {
  it("a new-host incident reopened inside the flap window more than 14 days after opening merges at once", () => {
    const opened = run([ok({ hosts: ["new.io"] }), ok({ hosts: ["new.io"] }), ok(), ok()], {
      state: learned(),
    });
    const i = opened.incidents.get(newHostFingerprint("new.io"))!;
    expect(i.state).toBe("resolved");
    // Resolved 14 days after it opened, seen again a day later (inside the
    // 7-day flap window): the same episode reopens, now past the merge age.
    const lateResolved = { ...i, resolvedAt: at(AUTO_MERGE_MS) };
    const r = run([ok({ hosts: ["new.io"] })], {
      state: opened.state,
      incidents: [lateResolved],
      t: AUTO_MERGE_MS + DAY,
    });
    const after = r.incidents.get(newHostFingerprint("new.io"))!;
    expect(after.resolution).toBe("auto_merged");
    expect(r.state.baselineHosts["new.io"]).toBeDefined();
  });
});

describe("SCRIPT_LOADER caps (wave 4 H1)", () => {
  const loaderAt = (i: number, over: Partial<GuardSighting> = {}): GuardSighting => ({
    kind: "SCRIPT_LOADER",
    fingerprint: `SCRIPT_LOADER:h${String(i).padStart(5, "0")}.evil.example`,
    host: `h${String(i).padStart(5, "0")}.evil.example`,
    page: "home",
    sourceLabel: "Code in an onerror attribute in the page",
    region: null,
    reason: "external_url",
    ...over,
  });
  const flood = (n: number) => Array.from({ length: n }, (_, i) => loaderAt(i));
  const fps = (input: GuardCheckInput) =>
    input.outcome === "ok" ? input.sightings.map((s) => s.fingerprint) : [];

  it("keeps every KNOWN_MALICIOUS, first, and at most MAX_LOADERS_PER_CHECK loaders", () => {
    expect(MAX_LOADERS_PER_CHECK).toBe(50);
    const input = ok({ sightings: [...flood(40_000), MAL, { ...MAL, page: "cart" }] });
    const { input: out, droppedLoaders } = capGuardSightings(input, []);
    expect(droppedLoaders).toBe(40_000 - 50);
    const kept = fps(out);
    expect(kept.slice(0, 2)).toEqual([MAL.fingerprint, MAL.fingerprint]);
    expect(new Set(kept.filter((f) => f.startsWith("SCRIPT_LOADER:"))).size).toBe(50);
    const unread = out.outcome === "ok" ? (out.unread ?? []) : [];
    expect(unread.filter((f) => f.startsWith("SCRIPT_LOADER:"))).toHaveLength(40_000 - 50);
  });

  it("is deterministic: the same page keeps the same loaders in any order", () => {
    const a = capGuardSightings(ok({ sightings: flood(500) }), []).input;
    const b = capGuardSightings(ok({ sightings: [...flood(500)].reverse() }), []).input;
    expect(new Set(fps(a))).toEqual(new Set(fps(b)));
  });

  it("ranks live incidents, then checkout, then menu, then spread over reasons", () => {
    const openRow: GuardIncident = {
      kind: "SCRIPT_LOADER",
      fingerprint: loaderAt(39_999).fingerprint,
      host: loaderAt(39_999).host,
      page: "home",
      sourceLabel: "x",
      state: "open",
      openedAt: T0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      seenCount: 2,
      cleanStreak: 0,
      resolvedAt: null,
      resolution: null,
      acknowledgedAt: null,
      emailedOpenedAt: null,
    };
    const sightings = [
      ...flood(40_000),
      loaderAt(90_001, { region: "checkout" }),
      loaderAt(90_002, { region: "menu" }),
      loaderAt(90_003, { reason: "creates_script" }),
      loaderAt(90_004, { reason: "eval" }),
    ];
    const kept = fps(capGuardSightings(ok({ sightings }), [openRow]).input);
    expect(kept.slice(0, 6)).toEqual([
      openRow.fingerprint,
      loaderAt(90_001).fingerprint,
      loaderAt(90_002).fingerprint,
      // Each reason's first fingerprint before any reason's second.
      loaderAt(0).fingerprint,
      loaderAt(90_003).fingerprint,
      loaderAt(90_004).fingerprint,
    ]);
    expect(kept[6]).toBe(loaderAt(1).fingerprint);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain(loaderAt(49).fingerprint);
  });

  it("a page under the cap is passed through whole", () => {
    const input = ok({ sightings: [...flood(50), MAL] });
    const { input: out, droppedLoaders } = capGuardSightings(input, []);
    expect(droppedLoaders).toBe(0);
    expect(fps(out)).toHaveLength(51);
    expect(out.outcome === "ok" && out.unread).toBeFalsy();
  });

  it("a dropped loader is neither seen nor clean: its open incident stays open", () => {
    const start = run([ok({ sightings: [loaderAt(7)] }), ok({ sightings: [loaderAt(7)] })]);
    const fp = loaderAt(7).fingerprint;
    expect(start.incidents.get(fp)!.state).toBe("open");
    const check: GuardCheckInput = {
      outcome: "ok",
      complete: true,
      sightings: [],
      hosts: [],
      unread: [fp],
    };
    const after = run([check, check, check], {
      state: start.state,
      incidents: [...start.incidents.values()],
      t: start.t,
    });
    expect(after.incidents.get(fp)!.state).toBe("open");
    expect(after.incidents.get(fp)!.cleanStreak).toBe(0);
  });

  it("a dropped loader's host is never a new-host candidate instead", () => {
    const sightings = flood(60);
    const input: GuardCheckInput = {
      outcome: "ok",
      complete: true,
      sightings,
      hosts: sightings.map((s) => host(s.host!)),
    };
    const out = capGuardSightings(input, []).input;
    expect(out.outcome === "ok" && out.hosts.map((h) => h.host)).toEqual(
      sightings.slice(0, 50).map((s) => s.host),
    );
  });

  const openRow = (fingerprint: string, h: string, over: Partial<GuardIncident> = {}) =>
    ({
      kind: fingerprint.startsWith("NEW_SCRIPT_HOST:") ? "NEW_SCRIPT_HOST" : "SCRIPT_LOADER",
      fingerprint,
      host: h,
      page: "home",
      sourceLabel: "x",
      state: "open",
      openedAt: T0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      seenCount: 2,
      cleanStreak: 0,
      resolvedAt: null,
      resolution: null,
      acknowledgedAt: null,
      emailedOpenedAt: null,
      ...over,
    }) satisfies GuardIncident as GuardIncident;

  it("a dropped loader's host keeps its open NEW_SCRIPT_HOST incident open (not clean)", () => {
    const sightings = flood(60);
    const droppedHost = loaderAt(59).host!;
    const fp = newHostFingerprint(droppedHost);
    let state = learned();
    const incidents = new Map([[fp, openRow(fp, droppedHost)]]);
    for (let n = 0; n < 3; n++) {
      const raw: GuardCheckInput = {
        outcome: "ok",
        complete: true,
        sightings,
        hosts: sightings.map((s) => host(s.host!)),
      };
      const capped = capGuardSightings(raw, [...incidents.values()]).input;
      const r = applyGuardCheck(state, [...incidents.values()], capped, at((n + 1) * HOUR));
      state = r.state;
      for (const i of r.changed) incidents.set(i.fingerprint, i);
    }
    expect(incidents.get(fp)!.state).toBe("open");
    expect(incidents.get(fp)!.cleanStreak).toBe(0);
  });

  it("a dropped loader's host that a kept sighting covers is not unread as a new host", () => {
    // A second fingerprint on loaderAt(0)'s host sorts last and is dropped;
    // loaderAt(0) itself is kept, so that host is read (as uncapped).
    const extra = { ...loaderAt(0), fingerprint: "SCRIPT_LOADER:zzz" };
    const out = capGuardSightings(ok({ sightings: [...flood(60), extra] }), []).input;
    const unread = out.outcome === "ok" ? (out.unread ?? []) : [];
    expect(unread).toContain(extra.fingerprint);
    expect(unread.filter((f) => f.startsWith("NEW_SCRIPT_HOST:"))).toEqual(
      flood(60)
        .slice(50)
        .map((s) => newHostFingerprint(s.host!)),
    );
  });

  it("open loaders that resolve on this check free their live slots for a new loader", () => {
    // 50 open loaders one clean check from resolving; a new checkout loader appears.
    const rows = flood(50).map((s) => openRow(s.fingerprint, s.host!, { cleanStreak: 1 }));
    const fresh = loaderAt(90_000, { region: "checkout" });
    const r = applyGuardCheck(learned(), rows, ok({ sightings: [fresh] }), at(HOUR));
    expect(r.droppedLoaders).toBe(0);
    expect(r.changed.find((i) => i.fingerprint === fresh.fingerprint)?.state).toBe("pending");
    const live = r.changed.filter((i) => i.kind === "SCRIPT_LOADER" && i.state !== "resolved");
    expect(live.map((i) => i.fingerprint)).toEqual([fresh.fingerprint]);
  });

  it("open loaders that stay open (streak not complete, or a partial check) still hold their slots", () => {
    const fresh = loaderAt(90_000, { region: "checkout" });
    const notYet = flood(50).map((s) => openRow(s.fingerprint, s.host!, { cleanStreak: 0 }));
    expect(
      applyGuardCheck(learned(), notYet, ok({ sightings: [fresh] }), at(HOUR)).droppedLoaders,
    ).toBe(1);
    const due = flood(50).map((s) => openRow(s.fingerprint, s.host!, { cleanStreak: 1 }));
    const partial = ok({ sightings: [fresh], complete: false });
    expect(applyGuardCheck(learned(), due, partial, at(HOUR)).droppedLoaders).toBe(1);
  });

  it("never more than MAX_LIVE_SCRIPT_LOADERS live loader incidents per shop; KNOWN_MALICIOUS still opens", () => {
    expect(MAX_LIVE_SCRIPT_LOADERS).toBe(50);
    // 50 loaders confirmed, then 50 different ones while the first stay open.
    const first = run([ok({ sightings: flood(50) }), ok({ sightings: flood(50) })]);
    const next = flood(100).slice(50);
    const r = applyGuardCheck(
      first.state,
      [...first.incidents.values()],
      ok({ sightings: [...next, MAL] }),
      at(first.t),
    );
    expect(r.droppedLoaders).toBe(50);
    expect(r.opened.map((i) => i.fingerprint)).toEqual([MAL.fingerprint]);
    const live = [...first.incidents.values(), ...r.changed].filter(
      (i) => i.kind === "SCRIPT_LOADER" && i.state !== "resolved",
    );
    expect(new Set(live.map((i) => i.fingerprint)).size).toBe(50);
    // The held-back loaders are not counted clean either (no lapsed rows made).
    expect(r.changed.filter((i) => next.some((n) => n.fingerprint === i.fingerprint))).toEqual([]);
  });
});
