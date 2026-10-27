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
  EMPTY_GUARD_STATE,
  FLAP_WINDOW_MS,
  MAX_BASELINE_HOSTS,
  MAX_HOSTS_PER_CHECK,
  newHostFingerprint,
  PARTIAL_HOME_AUTHORITY,
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
