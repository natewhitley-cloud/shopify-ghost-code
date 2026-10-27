/**
 * Checkout guard state machine (gc-1q1s.4). Pure and client-safe: no I/O, no clock (the
 * caller passes `now`). Spike: docs/spikes/gc-1q1s-checkout-guard-tier1-spike.md
 * sections A3, A5, A6, A8.
 *
 * One check goes in; the shop's next guard state, the incident rows it
 * changed, and the incident episodes it OPENED come out.
 *
 * Signals and when an incident opens:
 *   - KNOWN_MALICIOUS: a loading host on a listed domain. Opens on the first
 *     sighting.
 *   - SCRIPT_LOADER: loader markup (an on*= handler that builds or loads code,
 *     a script in nav or checkout-button markup). The first sighting makes a
 *     PENDING row; it opens when the next readable check sees it again. A
 *     complete check without it drops the candidate (resolved, never opened).
 *   - NEW_SCRIPT_HOST: a loading host outside the learned baseline. The first
 *     LEARNING_CHECKS complete checks build the baseline (no incidents). After
 *     that a host opens an incident once it is in 2 of the last 3 complete
 *     checks.
 *
 * Which checks count:
 *   - Only an `ok` check changes incidents. Paused, unreachable and error
 *     checks are never clean and never a hit.
 *   - A PARTIAL ok check (/cart unread) adds sightings but is never clean, and
 *     never teaches or debounces new hosts (a cart-only host would look gone),
 *     until PARTIAL_HOME_AUTHORITY partial checks in a row: from then on /cart
 *     is treated as absent (audit fix: a store whose /cart never reads never
 *     finished learning and never resolved a `both` incident). The homepage
 *     alone then teaches and debounces new hosts and clears home and `both`
 *     incidents; an incident seen only on /cart still needs a complete check.
 *
 * Resolve, flap, merge, decay:
 *   - An open incident resolves after RESOLVE_CLEAN_CHECKS complete checks in
 *     a row without it.
 *   - Seen again within FLAP_WINDOW_MS of resolving: the SAME episode reopens
 *     (openedAt kept, so no second email; Home says "seen again").
 *     Later than that: a new episode (new openedAt, email-eligible again).
 *   - A NEW_SCRIPT_HOST still seen AUTO_MERGE_MS after it opened moves into the
 *     baseline and resolves (auto_merged), so it never nags forever. "This is
 *     expected" (acknowledgeNewHost) does the same at once.
 *   - A baseline host unseen for BASELINE_DECAY_MS drops out.
 *
 * Backoff (A3): unreachable checks in a row; from the third, the shop is not
 * checked again until now + min(2^(n-3) h, 24 h). A challenged check (403,
 * 429) backs off at once. Password and redirect pauses never grow it, but a
 * paused store is not read again for PAUSED_RECHECK_MS (audit fix: it was
 * re-read every hour for as long as it stayed paused).
 *
 * Only hostnames and fixed labels are kept: never paths, query strings or HTML.
 */

/** Which storefront page a signal was seen on. */
export type GuardPage = "home" | "cart";

export const LEARNING_CHECKS = 3;
export const DEBOUNCE_WINDOW = 3;
export const DEBOUNCE_HITS = 2;
export const RESOLVE_CLEAN_CHECKS = 2;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const FLAP_WINDOW_MS = 7 * DAY_MS;
export const AUTO_MERGE_MS = 14 * DAY_MS;
export const BASELINE_DECAY_MS = 30 * DAY_MS;
export const BACKOFF_AFTER = 3;
/**
 * From this many partial checks in a row (homepage read, /cart not), /cart is
 * treated as absent: the homepage alone completes learning, debounces new
 * hosts and clears incidents seen on the homepage (home or both), so a store
 * whose /cart never reads still learns and never keeps a resolved incident
 * open forever. An incident seen only on /cart still needs a complete check.
 */
export const PARTIAL_HOME_AUTHORITY = 3;
export const MAX_BACKOFF_MS = DAY_MS;
/** A password-protected or redirecting store is read again after this long. */
export const PAUSED_RECHECK_MS = 6 * HOUR_MS;
/** Bounds on stored host lists (a page with thousands of hosts stays small). */
export const MAX_HOSTS_PER_CHECK = 200;
export const MAX_BASELINE_HOSTS = 500;
/**
 * At most this many distinct SCRIPT_LOADER fingerprints are processed per
 * check (wave 4 H1: a page of 40,000 distinct loader hosts made 40,000 rows
 * per check, and the write timed out every hour, so a KNOWN_MALICIOUS on the
 * same page was never recorded). KNOWN_MALICIOUS is never capped.
 */
export const MAX_LOADERS_PER_CHECK = 50;
/** At most this many live (open or pending) SCRIPT_LOADER incidents per shop. */
export const MAX_LIVE_SCRIPT_LOADERS = 50;

export type IncidentKind = "KNOWN_MALICIOUS" | "SCRIPT_LOADER" | "NEW_SCRIPT_HOST";
export type IncidentState = "pending" | "open" | "resolved";
export type IncidentPages = "home" | "cart" | "both";
export type IncidentResolution = "clean" | "lapsed" | "acknowledged" | "auto_merged";

/** The kinds that may email (paid, consented). NEW_SCRIPT_HOST is in-app only (D3). */
export const EMAIL_INCIDENT_KINDS: ReadonlySet<IncidentKind> = new Set([
  "KNOWN_MALICIOUS",
  "SCRIPT_LOADER",
]);

export interface GuardIncident {
  /** Absent on a row this check created. */
  id?: string;
  kind: IncidentKind;
  /** `${kind}:${host}` (or a payload key for a host-less loader). Unique per shop. */
  fingerprint: string;
  host: string | null;
  page: IncidentPages;
  /** Fixed merchant-facing label of where it was seen (never page text). */
  sourceLabel: string;
  state: IncidentState;
  /** The current episode's start; null while pending or for a lapsed candidate. */
  openedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  cleanStreak: number;
  resolvedAt: Date | null;
  resolution: IncidentResolution | null;
  acknowledgedAt: Date | null;
  /** The openedAt of the episode that was emailed (one email per episode). */
  emailedOpenedAt: Date | null;
}

export interface GuardStateData {
  lastCheckedAt: Date | null;
  /** ok | partial | paused_password | paused_redirect | unreachable:<reason> | error */
  lastOutcome: string | null;
  lastReadableAt: Date | null;
  lastRedirectHost: string | null;
  consecutiveUnreachable: number;
  /** ok checks in a row whose /cart was unreadable (reset by a complete one). */
  consecutivePartial: number;
  backoffUntil: Date | null;
  /** Complete ok checks so far (learning ends at LEARNING_CHECKS). */
  readableChecks: number;
  /** host -> last seen (ISO). */
  baselineHosts: Record<string, string>;
  /** The non-baseline hosts of the last DEBOUNCE_WINDOW complete checks, newest last. */
  recentHostSets: string[][];
}

export const EMPTY_GUARD_STATE: GuardStateData = {
  lastCheckedAt: null,
  lastOutcome: null,
  lastReadableAt: null,
  lastRedirectHost: null,
  consecutiveUnreachable: 0,
  consecutivePartial: 0,
  backoffUntil: null,
  readableChecks: 0,
  baselineHosts: {},
  recentHostSets: [],
};

/** One KNOWN_MALICIOUS or SCRIPT_LOADER signal on one page. */
export interface GuardSighting {
  kind: "KNOWN_MALICIOUS" | "SCRIPT_LOADER";
  fingerprint: string;
  host: string | null;
  page: GuardPage;
  sourceLabel: string;
  /** A loader's guard region (capGuardSightings ranks checkout > menu > none). */
  region?: "checkout" | "menu" | null;
  /** A loader's reason (capGuardSightings spreads the kept set over reasons). */
  reason?: string;
}

/** A loading host on one page, already filtered of suppressed hosts. */
export interface GuardHostSighting {
  host: string;
  page: GuardPage;
  sourceLabel: string;
}

export type GuardCheckInput =
  | {
      outcome: "ok";
      complete: boolean;
      sightings: readonly GuardSighting[];
      hosts: readonly GuardHostSighting[];
      /**
       * Fingerprints this check saw but did not process (capGuardSightings):
       * neither a sighting nor a clean check for their incidents.
       */
      unread?: readonly string[];
    }
  | { outcome: "paused_password" }
  | { outcome: "paused_redirect"; redirectHost: string | null }
  | { outcome: "unreachable"; reason: string; challenged: boolean }
  | { outcome: "error" };

/** One signal as this check saw it (pages merged across home and cart). */
type Seen = {
  kind: IncidentKind;
  fingerprint: string;
  host: string | null;
  sourceLabel: string;
  pages: IncidentPages;
};

export interface GuardCheckResult {
  state: GuardStateData;
  /** Every incident row this check created or changed. */
  changed: GuardIncident[];
  /** Incidents whose episode opened on this check (state open, openedAt = now). */
  opened: GuardIncident[];
  /**
   * New-host candidates past MAX_HOSTS_PER_CHECK that this check did not
   * consider (alphabetically last; gc-njwa #4). 0 when none were dropped.
   */
  droppedHosts: number;
  /** New SCRIPT_LOADER incidents not created: the shop is at MAX_LIVE_SCRIPT_LOADERS. */
  droppedLoaders: number;
}

/** Backoff delay after `n` unreachable checks in a row (0 before BACKOFF_AFTER). */
export function backoffDelayMs(n: number): number {
  if (n < BACKOFF_AFTER) return 0;
  return Math.min(2 ** (n - BACKOFF_AFTER) * HOUR_MS, MAX_BACKOFF_MS);
}

function mergePages(a: IncidentPages, b: IncidentPages): IncidentPages {
  return a === b ? a : "both";
}

export function newHostFingerprint(host: string): string {
  return `NEW_SCRIPT_HOST:${host}`;
}

/** Apply one check. Pure; inputs are not mutated. */
export function applyGuardCheck(
  prev: GuardStateData,
  incidents: readonly GuardIncident[],
  check: GuardCheckInput,
  now: Date,
): GuardCheckResult {
  const base: GuardStateData = {
    ...prev,
    baselineHosts: { ...prev.baselineHosts },
    recentHostSets: prev.recentHostSets.map((s) => [...s]),
    lastCheckedAt: now,
  };

  if (check.outcome !== "ok") {
    return {
      state: applyNonOk(base, check, now),
      changed: [],
      opened: [],
      droppedHosts: 0,
      droppedLoaders: 0,
    };
  }

  const state: GuardStateData = {
    ...base,
    lastOutcome: check.complete ? "ok" : "partial",
    lastReadableAt: now,
    lastRedirectHost: null,
    consecutiveUnreachable: 0,
    consecutivePartial: check.complete ? 0 : prev.consecutivePartial + 1,
    backoffUntil: null,
  };
  const byFingerprint = new Map(incidents.map((i) => [i.fingerprint, { ...i }]));
  const changed = new Map<string, GuardIncident>();
  const opened: GuardIncident[] = [];
  let droppedHosts = 0;
  let droppedLoaders = 0;
  const unread = new Set(check.unread ?? []);
  const touch = (i: GuardIncident) => {
    byFingerprint.set(i.fingerprint, i);
    changed.set(i.fingerprint, i);
  };

  // --- Sightings (KNOWN_MALICIOUS, SCRIPT_LOADER, and new hosts below) ------
  const seen = new Map<string, Seen>();
  for (const s of check.sightings) {
    const prior = seen.get(s.fingerprint);
    seen.set(s.fingerprint, {
      kind: s.kind,
      fingerprint: s.fingerprint,
      host: s.host,
      sourceLabel: s.sourceLabel,
      pages: prior ? mergePages(prior.pages, s.page) : s.page,
    });
  }

  const sightedHosts = new Set(
    check.sightings.map((s) => s.host).filter((h): h is string => h !== null),
  );

  // After PARTIAL_HOME_AUTHORITY partial checks in a row, /cart is absent and
  // the homepage reads as the whole storefront.
  const homeAuthoritative = !check.complete && state.consecutivePartial >= PARTIAL_HOME_AUTHORITY;

  // --- New hosts (complete checks, or the homepage once /cart is absent) -----
  if (check.complete || homeAuthoritative) {
    const hostPages = new Map<string, { page: IncidentPages; sourceLabel: string }>();
    for (const h of check.hosts) {
      if (sightedHosts.has(h.host)) continue; // already its own (stronger) incident
      const prior = hostPages.get(h.host);
      hostPages.set(h.host, {
        page: prior ? mergePages(prior.page, h.page) : h.page,
        sourceLabel: prior?.sourceLabel ?? h.sourceLabel,
      });
    }
    const hosts = [...hostPages.keys()].sort().slice(0, MAX_HOSTS_PER_CHECK);
    droppedHosts = hostPages.size - hosts.length;
    const learning = state.readableChecks < LEARNING_CHECKS;
    const nowIso = now.toISOString();
    const fresh: string[] = [];
    for (const host of hosts) {
      if (learning || host in state.baselineHosts) state.baselineHosts[host] = nowIso;
      else fresh.push(host);
    }
    state.readableChecks += 1;
    if (!learning) {
      state.recentHostSets = [...state.recentHostSets, fresh].slice(-DEBOUNCE_WINDOW);
      for (const host of fresh) {
        const hits = state.recentHostSets.filter((set) => set.includes(host)).length;
        const fp = newHostFingerprint(host);
        const existing = byFingerprint.get(fp);
        // An open (or flap-window) incident is a plain sighting; a new one waits
        // for the debounce.
        const live =
          existing &&
          (existing.state === "open" ||
            (existing.state === "resolved" && withinFlapWindow(existing, now)));
        if (hits >= DEBOUNCE_HITS || live) {
          const info = hostPages.get(host)!;
          seen.set(fp, {
            kind: "NEW_SCRIPT_HOST",
            fingerprint: fp,
            host,
            sourceLabel: info.sourceLabel,
            pages: info.page,
          });
        }
      }
    }
    // Decay: baseline hosts unseen for BASELINE_DECAY_MS drop out.
    for (const [host, iso] of Object.entries(state.baselineHosts)) {
      if (now.getTime() - Date.parse(iso) >= BASELINE_DECAY_MS) delete state.baselineHosts[host];
    }
    capBaseline(state);
  }

  // --- Apply sightings --------------------------------------------------------
  // Live SCRIPT_LOADER rows after this check: open ones that do not resolve
  // below, and pending ones seen again (a pending row not seen lapses below).
  // A new one past MAX_LIVE_SCRIPT_LOADERS is not created (wave 4 H1);
  // KNOWN_MALICIOUS and existing loader episodes are never held back.
  const cleanCheck = check.complete || homeAuthoritative;
  let liveLoaders = 0;
  for (const i of byFingerprint.values()) {
    if (i.kind !== "SCRIPT_LOADER") continue;
    const isSeen = seen.has(i.fingerprint);
    if (i.state === "pending" && isSeen) liveLoaders++;
    if (i.state !== "open") continue;
    // Mirrors the clean-streak pass: an unseen, unread open row whose streak
    // completes on this check resolves, so its slot is free.
    const resolvesNow =
      cleanCheck &&
      !isSeen &&
      !unread.has(i.fingerprint) &&
      (check.complete || i.page !== "cart") &&
      i.cleanStreak + 1 >= RESOLVE_CLEAN_CHECKS;
    if (!resolvesNow) liveLoaders++;
  }
  for (const [fp, s] of seen) {
    const existing = byFingerprint.get(fp);
    if (s.kind === "SCRIPT_LOADER" && !isLive(existing, now)) {
      if (liveLoaders >= MAX_LIVE_SCRIPT_LOADERS) {
        droppedLoaders++;
        unread.add(fp);
        continue;
      }
      liveLoaders++;
    }
    const result = sight(existing, s, now);
    touch(result.incident);
    if (result.opened) opened.push(result.incident);
  }

  // --- Auto-merge long-open new hosts still seen ------------------------------
  for (const i of byFingerprint.values()) {
    if (
      i.kind === "NEW_SCRIPT_HOST" &&
      i.state === "open" &&
      i.host &&
      seen.has(i.fingerprint) &&
      i.openedAt &&
      now.getTime() - i.openedAt.getTime() >= AUTO_MERGE_MS
    ) {
      state.baselineHosts[i.host] = now.toISOString();
      touch(resolve(i, now, "auto_merged"));
    }
  }

  // --- Clean streaks (complete checks; home and both incidents once /cart is
  // absent, see PARTIAL_HOME_AUTHORITY) ----------------------------------------
  if (check.complete || homeAuthoritative) {
    for (const i of byFingerprint.values()) {
      if (seen.has(i.fingerprint) || unread.has(i.fingerprint)) continue;
      if (!check.complete && i.page === "cart") continue;
      if (i.state === "pending") {
        touch(resolve(i, now, "lapsed"));
      } else if (i.state === "open") {
        const cleanStreak = i.cleanStreak + 1;
        touch(
          cleanStreak >= RESOLVE_CLEAN_CHECKS
            ? resolve({ ...i, cleanStreak }, now, "clean")
            : { ...i, cleanStreak },
        );
      }
    }
  }

  return { state, changed: [...changed.values()], opened, droppedHosts, droppedLoaders };
}

/** An incident a sighting continues (open, pending, or reopenable in the flap window). */
function isLive(i: GuardIncident | undefined, now: Date): boolean {
  if (!i) return false;
  return i.state !== "resolved" || withinFlapWindow(i, now);
}

const REGION_RANK = { checkout: 0, menu: 1 } as const;

/**
 * Bound one check's SCRIPT_LOADER sightings to MAX_LOADERS_PER_CHECK distinct
 * fingerprints (wave 4 H1), deterministically. Every KNOWN_MALICIOUS sighting
 * is kept and put first. Loaders are kept in this order:
 *   1. the shop's live loader incidents (open, then pending), so a confirmed
 *      episode is never lost to the cap;
 *   2. region: checkout button, then menu, then elsewhere;
 *   3. spread over reasons (each reason's first fingerprint before any
 *      reason's second);
 *   4. fingerprint.
 * Dropped fingerprints go to `unread` (their incidents are neither seen nor
 * clean), and their hosts leave `hosts` (never a new-host candidate instead)
 * and, unless a kept sighting covers them, their NEW_SCRIPT_HOST fingerprints
 * go to `unread` too (an open new-host incident there is not read as clean).
 */
export function capGuardSightings(
  input: GuardCheckInput,
  incidents: readonly GuardIncident[],
): { input: GuardCheckInput; droppedLoaders: number } {
  if (input.outcome !== "ok") return { input, droppedLoaders: 0 };
  const malicious = input.sightings.filter((s) => s.kind === "KNOWN_MALICIOUS");
  const loaderSightings = input.sightings.filter((s) => s.kind === "SCRIPT_LOADER");
  type Rank = { fp: string; region: number; reason: string };
  const ranks = new Map<string, Rank>();
  for (const s of loaderSightings) {
    const region = s.region ? REGION_RANK[s.region] : 2;
    const prior = ranks.get(s.fingerprint);
    if (!prior || region < prior.region) {
      ranks.set(s.fingerprint, { fp: s.fingerprint, region, reason: s.reason ?? "" });
    }
  }
  if (ranks.size <= MAX_LOADERS_PER_CHECK) {
    return {
      input: { ...input, sightings: [...malicious, ...loaderSightings] },
      droppedLoaders: 0,
    };
  }
  const liveRank = new Map<string, number>();
  for (const i of incidents) {
    if (i.kind !== "SCRIPT_LOADER") continue;
    if (i.state === "open") liveRank.set(i.fingerprint, 0);
    else if (i.state === "pending") liveRank.set(i.fingerprint, 1);
  }
  // Each fingerprint's position among its region's same-reason fingerprints.
  const sorted = [...ranks.values()].sort((a, b) => cmp(a.fp, b.fp));
  const spread = new Map<string, number>();
  const perReason = new Map<string, number>();
  for (const r of sorted) {
    const key = `${r.region}|${r.reason}`;
    const n = perReason.get(key) ?? 0;
    spread.set(r.fp, n);
    perReason.set(key, n + 1);
  }
  const ordered = sorted.sort(
    (a, b) =>
      (liveRank.get(a.fp) ?? 2) - (liveRank.get(b.fp) ?? 2) ||
      a.region - b.region ||
      spread.get(a.fp)! - spread.get(b.fp)! ||
      cmp(a.fp, b.fp),
  );
  // Kept in priority order: applyGuardCheck fills the shop's live-loader
  // slots (MAX_LIVE_SCRIPT_LOADERS) in this order too.
  const position = new Map(ordered.map((r, n) => [r.fp, n]));
  const kept = new Set(ordered.slice(0, MAX_LOADERS_PER_CHECK).map((r) => r.fp));
  const dropped = ordered.slice(MAX_LOADERS_PER_CHECK).map((r) => r.fp);
  const droppedHosts = new Set(
    loaderSightings
      .filter((s) => !kept.has(s.fingerprint) && s.host !== null)
      .map((s) => s.host as string),
  );
  // A dropped host no kept sighting covers is unread as a new host too: its
  // open NEW_SCRIPT_HOST incident is neither seen nor clean (it would
  // otherwise count this check clean and falsely resolve).
  const keptHosts = new Set(
    [...malicious, ...loaderSightings.filter((s) => kept.has(s.fingerprint))]
      .map((s) => s.host)
      .filter((h): h is string => h !== null),
  );
  const unreadHosts = [...droppedHosts]
    .filter((h) => !keptHosts.has(h))
    .sort()
    .map(newHostFingerprint);
  return {
    input: {
      ...input,
      sightings: [
        ...malicious,
        ...loaderSightings
          .filter((s) => kept.has(s.fingerprint))
          .sort((a, b) => position.get(a.fingerprint)! - position.get(b.fingerprint)!),
      ],
      hosts: input.hosts.filter((h) => !droppedHosts.has(h.host)),
      unread: [...(input.unread ?? []), ...dropped, ...unreadHosts],
    },
    droppedLoaders: dropped.length,
  };
}

/** Plain code-unit order (locale-independent, deterministic). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function applyNonOk(
  state: GuardStateData,
  check: Exclude<GuardCheckInput, { outcome: "ok" }>,
  now: Date,
): GuardStateData {
  switch (check.outcome) {
    case "paused_password":
      return {
        ...state,
        lastOutcome: "paused_password",
        lastRedirectHost: null,
        backoffUntil: pausedUntil(state, now),
      };
    case "paused_redirect":
      return {
        ...state,
        lastOutcome: "paused_redirect",
        lastRedirectHost: check.redirectHost,
        backoffUntil: pausedUntil(state, now),
      };
    case "error":
      // Our own analyzer failed: never the store's fault, so no backoff.
      return { ...state, lastOutcome: "error" };
    case "unreachable": {
      const n = state.consecutiveUnreachable + 1;
      const delay = check.challenged
        ? backoffDelayMs(Math.max(n, BACKOFF_AFTER))
        : backoffDelayMs(n);
      return {
        ...state,
        lastOutcome: `unreachable:${check.reason}`,
        lastRedirectHost: null,
        consecutiveUnreachable: n,
        backoffUntil: delay > 0 ? new Date(now.getTime() + delay) : state.backoffUntil,
      };
    }
  }
}

/** A paused store's next read: PAUSED_RECHECK_MS out, never shortening a longer backoff. */
function pausedUntil(state: GuardStateData, now: Date): Date {
  const floor = new Date(now.getTime() + PAUSED_RECHECK_MS);
  return state.backoffUntil && state.backoffUntil > floor ? state.backoffUntil : floor;
}

function withinFlapWindow(i: GuardIncident, now: Date): boolean {
  return (
    i.openedAt !== null &&
    i.resolvedAt !== null &&
    i.resolution !== "acknowledged" &&
    i.resolution !== "auto_merged" &&
    now.getTime() - i.resolvedAt.getTime() < FLAP_WINDOW_MS
  );
}

function resolve(i: GuardIncident, now: Date, resolution: IncidentResolution): GuardIncident {
  return { ...i, state: "resolved", resolvedAt: now, resolution };
}

/** One sighting of an incident's signal: create, advance, reopen or open it. */
function sight(
  existing: GuardIncident | undefined,
  s: Seen,
  now: Date,
): { incident: GuardIncident; opened: boolean } {
  const opensAtOnce = s.kind !== "SCRIPT_LOADER";
  const openNew = (prior: GuardIncident | undefined): GuardIncident => ({
    ...(prior ?? {}),
    kind: s.kind,
    fingerprint: s.fingerprint,
    host: s.host,
    page: s.pages,
    sourceLabel: s.sourceLabel,
    state: opensAtOnce ? "open" : "pending",
    openedAt: opensAtOnce ? now : null,
    firstSeenAt: prior?.firstSeenAt ?? now,
    lastSeenAt: now,
    seenCount: (prior?.seenCount ?? 0) + 1,
    cleanStreak: 0,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: prior?.acknowledgedAt ?? null,
    emailedOpenedAt: prior?.emailedOpenedAt ?? null,
  });

  if (!existing) {
    const incident = openNew(undefined);
    return { incident, opened: incident.state === "open" };
  }
  const advanced = {
    ...existing,
    page: mergePages(existing.page, s.pages),
    sourceLabel: s.sourceLabel,
    lastSeenAt: now,
    seenCount: existing.seenCount + 1,
    cleanStreak: 0,
  };
  if (existing.state === "open") return { incident: advanced, opened: false };
  if (existing.state === "pending") {
    // Second readable sighting in a row: the loader is confirmed.
    return { incident: { ...advanced, state: "open", openedAt: now }, opened: true };
  }
  // Resolved: the same episode within the flap window, else a new one.
  if (withinFlapWindow(existing, now)) {
    return {
      incident: { ...advanced, state: "open", resolvedAt: null, resolution: null },
      opened: false,
    };
  }
  const incident = openNew(existing);
  return { incident, opened: incident.state === "open" };
}

function capBaseline(state: GuardStateData): void {
  const entries = Object.entries(state.baselineHosts);
  if (entries.length <= MAX_BASELINE_HOSTS) return;
  // Keep the most recently seen hosts.
  entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]) || a[0].localeCompare(b[0]));
  state.baselineHosts = Object.fromEntries(entries.slice(0, MAX_BASELINE_HOSTS));
}

/**
 * "This is expected" on a NEW_SCRIPT_HOST incident: its host joins the
 * baseline and the incident resolves (acknowledged). Null when the incident is
 * not an open or pending new-host incident (nothing to do).
 */
export function acknowledgeNewHost(
  state: GuardStateData,
  incident: GuardIncident,
  now: Date,
): { state: GuardStateData; incident: GuardIncident } | null {
  if (incident.kind !== "NEW_SCRIPT_HOST" || incident.state === "resolved" || !incident.host) {
    return null;
  }
  const next: GuardStateData = {
    ...state,
    baselineHosts: { ...state.baselineHosts, [incident.host]: now.toISOString() },
    recentHostSets: state.recentHostSets.map((set) => set.filter((h) => h !== incident.host)),
  };
  capBaseline(next);
  return {
    state: next,
    incident: { ...resolve(incident, now, "acknowledged"), acknowledgedAt: now },
  };
}
