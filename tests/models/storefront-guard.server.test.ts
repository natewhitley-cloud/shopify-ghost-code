/**
 * Checkout guard data access (gc-1q1s.4): optimistic-lock save, row parsing,
 * Home read.
 */
import type { StorefrontGuardState, StorefrontIncident } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = vi.hoisted(() => ({
  storefrontGuardState: { create: vi.fn(), updateMany: vi.fn() },
  storefrontIncident: { upsert: vi.fn() },
}));
const mockDb = vi.hoisted(() => ({
  storefrontGuardState: { findUnique: vi.fn() },
  storefrontIncident: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  shop: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { EMPTY_GUARD_STATE, type GuardIncident } from "../../app/lib/storefront-guard-state";
import {
  acknowledgeGuardIncident,
  getGuardEmailShop,
  loadIncidentsToEmail,
  loadGuard,
  loadGuardForHome,
  loadGuardIncidentsByFingerprint,
  markIncidentsEmailed,
  GUARD_INCIDENT_RETENTION_MS,
  MAX_GUARD_INCIDENTS,
  pruneGuardIncidents,
  saveGuardCheck,
  toGuardIncident,
  toGuardStateData,
} from "../../app/models/storefront-guard.server";

const NOW = new Date("2026-10-27T01:17:00Z");
const DOMAINS = { primaryHost: "a.com", myshopifyHost: "a.myshopify.com", domainsRefreshedAt: NOW };

const INCIDENT: GuardIncident = {
  kind: "KNOWN_MALICIOUS",
  fingerprint: "KNOWN_MALICIOUS:cartassure.top",
  host: "cartassure.top",
  page: "home",
  sourceLabel: "Loaded by a script tag in the page",
  state: "open",
  openedAt: NOW,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  seenCount: 1,
  cleanStreak: 0,
  resolvedAt: null,
  resolution: null,
  acknowledgedAt: null,
  emailedOpenedAt: null,
};

function row(over: Partial<StorefrontIncident> = {}): StorefrontIncident {
  return {
    id: "inc-1",
    shopId: "shop-1",
    ...INCIDENT,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as StorefrontIncident;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Array form (loadGuard's one-snapshot read) or interactive form (saves).
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (t: typeof tx) => unknown)(tx),
  );
  tx.storefrontIncident.upsert.mockImplementation(
    async (args: { create: { fingerprint: string } }) => ({
      id: `id-${args.create.fingerprint}`,
    }),
  );
});

describe("saveGuardCheck", () => {
  it("creates the state row on the first check and upserts incidents by fingerprint", async () => {
    const out = await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: null,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed: [INCIDENT],
    });
    expect(tx.storefrontGuardState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ shopId: "shop-1", primaryHost: "a.com" }),
    });
    expect(tx.storefrontIncident.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_fingerprint: { shopId: "shop-1", fingerprint: INCIDENT.fingerprint } },
      }),
    );
    expect(out.status).toBe("saved");
    if (out.status === "saved") {
      expect(out.incidents.get(INCIDENT.fingerprint)?.id).toBe(`id-${INCIDENT.fingerprint}`);
    }
  });

  it("updates only at the expected version and bumps it", async () => {
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 1 });
    await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: 4,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed: [],
    });
    expect(tx.storefrontGuardState.updateMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", version: 4 },
      data: expect.objectContaining({ version: { increment: 1 } }),
    });
  });

  it("returns stale (and writes no incident) when another write moved the version", async () => {
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 0 });
    const out = await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: 4,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed: [INCIDENT],
    });
    expect(out).toEqual({ status: "stale" });
    expect(tx.storefrontIncident.upsert).not.toHaveBeenCalled();
  });

  it("returns stale when a concurrent first check created the row (P2002)", async () => {
    tx.storefrontGuardState.create.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    const out = await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: null,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed: [],
    });
    expect(out).toEqual({ status: "stale" });
  });

  it("rethrows any other database error", async () => {
    tx.storefrontGuardState.updateMany.mockRejectedValue(new Error("db down"));
    await expect(
      saveGuardCheck({
        shopId: "shop-1",
        expectedVersion: 1,
        state: EMPTY_GUARD_STATE,
        domains: DOMAINS,
        changed: [],
      }),
    ).rejects.toThrow("db down");
  });
});

describe("row parsing", () => {
  it("an absent row is the empty state", () => {
    expect(toGuardStateData(null)).toEqual(EMPTY_GUARD_STATE);
  });

  it("drops malformed JSON entries instead of throwing", () => {
    const state = toGuardStateData({
      baselineHosts: { "a.com": "2026-10-01T00:00:00.000Z", "b.com": 5, "c.com": "nope" },
      recentHostSets: [["x.io", 3], "bad", ["y.io"]],
    } as unknown as StorefrontGuardState);
    expect(state.baselineHosts).toEqual({ "a.com": "2026-10-01T00:00:00.000Z" });
    expect(state.recentHostSets).toEqual([["x.io"], ["y.io"]]);
  });

  it("an unknown kind or state reads as no incident", () => {
    expect(toGuardIncident(row({ kind: "MENU_INJECTION" }))).toBeNull();
    expect(toGuardIncident(row({ state: "weird" }))).toBeNull();
    expect(toGuardIncident(row())?.id).toBe("inc-1");
  });
});

describe("reads", () => {
  it("loadGuard returns version null and empty state for a shop never checked", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    const loaded = await loadGuard("shop-1");
    expect(loaded.version).toBeNull();
    expect(loaded.domains.primaryHost).toBeNull();
    expect(loaded.incidents).toEqual([]);
  });

  // Audit fix (M7): the reads are bounded. Wave 3 B1: only NEW_SCRIPT_HOST
  // rows are capped; every emailable row is read.
  it("loadGuard reads open, pending and flap-window resolved rows, open first; caps new hosts only", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    await loadGuard("shop-1", NOW);
    const live = {
      shopId: "shop-1",
      OR: [
        { state: { not: "resolved" } },
        { resolvedAt: { gte: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    };
    const orderBy = [{ state: "asc" }, { lastSeenAt: "desc" }, { id: "asc" }];
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith({
      where: { ...live, kind: { in: ["KNOWN_MALICIOUS", "SCRIPT_LOADER"] } },
      orderBy,
    });
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith({
      where: { ...live, kind: "NEW_SCRIPT_HOST" },
      orderBy,
      take: MAX_GUARD_INCIDENTS,
    });
    expect(MAX_GUARD_INCIDENTS).toBe(200);
  });

  it("loadGuard never hides an emailable row behind a full page of new hosts (wave 3 B1)", async () => {
    const hosts = Array.from({ length: MAX_GUARD_INCIDENTS }, (_, n) =>
      row({
        id: `h${n}`,
        kind: "NEW_SCRIPT_HOST",
        fingerprint: `NEW_SCRIPT_HOST:h${n}.io`,
        host: `h${n}.io`,
      }),
    );
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockImplementation(
      async (args: { where: { kind: unknown } }) =>
        args.where.kind === "NEW_SCRIPT_HOST" ? hosts : [row()],
    );
    const out = await loadGuard("shop-1", NOW);
    expect(out.incidents.map((i) => i.id)).toContain("inc-1");
    expect(out.incidents).toHaveLength(MAX_GUARD_INCIDENTS + 1);
    expect(out.newHostsCapped).toBe(true);
  });

  it("loadGuard reads state and incidents in ONE repeatable-read snapshot (wave 3 B4)", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    await loadGuard("shop-1", NOW);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    const [queries, opts] = mockDb.$transaction.mock.calls[0];
    expect(Array.isArray(queries)).toBe(true);
    expect(queries).toHaveLength(3);
    expect(opts).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("loadGuardIncidentsByFingerprint reads any state by fingerprint; none asked, no query", async () => {
    mockDb.storefrontIncident.findMany.mockResolvedValue([row({ state: "resolved" })]);
    expect(await loadGuardIncidentsByFingerprint("shop-1", [])).toEqual([]);
    expect(mockDb.storefrontIncident.findMany).not.toHaveBeenCalled();
    const out = await loadGuardIncidentsByFingerprint("shop-1", ["KNOWN_MALICIOUS:cartassure.top"]);
    expect(out.map((i) => i.state)).toEqual(["resolved"]);
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", fingerprint: { in: ["KNOWN_MALICIOUS:cartassure.top"] } },
    });
  });

  it("loadGuardForHome caps its read and skips the state read when asked", async () => {
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    const out = await loadGuardForHome("shop-1", { withState: false });
    expect(mockDb.storefrontGuardState.findUnique).not.toHaveBeenCalled();
    expect(out.state).toBeNull();
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_GUARD_INCIDENTS }),
    );
  });

  it("loadGuardForHome reads open incidents only", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockResolvedValue([row()]);
    const out = await loadGuardForHome("shop-1");
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId: "shop-1", state: "open" } }),
    );
    expect(out.incidents).toHaveLength(1);
  });

  it("markIncidentsEmailed stamps only the episode that was emailed", async () => {
    await markIncidentsEmailed([{ id: "inc-1", openedAt: NOW }]);
    expect(mockDb.storefrontIncident.updateMany).toHaveBeenCalledWith({
      where: { id: "inc-1", openedAt: NOW },
      data: { emailedOpenedAt: NOW },
    });
  });
});

describe("acknowledgeGuardIncident", () => {
  const newHost = row({
    id: "inc-n",
    kind: "NEW_SCRIPT_HOST",
    fingerprint: "NEW_SCRIPT_HOST:new.io",
    host: "new.io",
  });
  const stateRow = {
    shopId: "shop-1",
    version: 7,
    baselineHosts: {},
    recentHostSets: [["new.io"]],
  };

  it("moves the host into the baseline at the current version and resolves the incident", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(stateRow);
    mockDb.storefrontIncident.findMany.mockResolvedValue([newHost]);
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 1 });
    expect(await acknowledgeGuardIncident("shop-1", "inc-n", NOW)).toBe(true);
    const update = tx.storefrontGuardState.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ shopId: "shop-1", version: 7 });
    expect(update.data.baselineHosts).toHaveProperty("new.io");
    expect(update.data.recentHostSets).toEqual([[]]);
    expect(tx.storefrontIncident.upsert.mock.calls[0][0].update).toMatchObject({
      state: "resolved",
      resolution: "acknowledged",
    });
  });

  it("refuses another shop's incident, a known-malicious one, or a shop never checked", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(stateRow);
    mockDb.storefrontIncident.findMany.mockResolvedValue([row()]);
    expect(await acknowledgeGuardIncident("shop-1", "inc-n", NOW)).toBe(false);
    expect(await acknowledgeGuardIncident("shop-1", "inc-1", NOW)).toBe(false);
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(null);
    mockDb.storefrontIncident.findMany.mockResolvedValue([newHost]);
    expect(await acknowledgeGuardIncident("shop-1", "inc-n", NOW)).toBe(false);
    expect(tx.storefrontIncident.upsert).not.toHaveBeenCalled();
  });

  it("retries once after losing a race, then gives up", async () => {
    mockDb.storefrontGuardState.findUnique.mockResolvedValue(stateRow);
    mockDb.storefrontIncident.findMany.mockResolvedValue([newHost]);
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 0 });
    expect(await acknowledgeGuardIncident("shop-1", "inc-n", NOW)).toBe(false);
    expect(tx.storefrontGuardState.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("loadIncidentsToEmail (gc-1q1s.7)", () => {
  it("keeps open, opened, emailable incidents not yet emailed for this episode", async () => {
    const earlier = new Date("2026-10-01T00:00:00Z");
    mockDb.storefrontIncident.findMany.mockResolvedValue([
      row({ id: "a" }),
      row({ id: "b", emailedOpenedAt: NOW }), // this episode already emailed
      row({ id: "c", emailedOpenedAt: earlier }), // an earlier episode was emailed
      row({ id: "d", kind: "NEW_SCRIPT_HOST", fingerprint: "NEW_SCRIPT_HOST:x.io" }),
      row({ id: "e", kind: "SCRIPT_LOADER", openedAt: null, state: "open" }),
    ]);
    const out = await loadIncidentsToEmail("shop-1", ["a", "b", "c", "d", "e"]);
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1", id: { in: ["a", "b", "c", "d", "e"] }, state: "open" },
      }),
    );
  });

  it("no ids: no query", async () => {
    expect(await loadIncidentsToEmail("shop-1", [])).toEqual([]);
    expect(mockDb.storefrontIncident.findMany).not.toHaveBeenCalled();
  });

  it("getGuardEmailShop selects the consent gates and never the access token", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    await getGuardEmailShop("shop-1");
    const select = mockDb.shop.findUnique.mock.calls[0][0].select;
    expect(select).toMatchObject({
      guardEmailNoticeShownAt: true,
      guardEmailOffAt: true,
      alertsEnabled: true,
    });
    expect(select).not.toHaveProperty("accessToken");
  });
});

describe("pruneGuardIncidents (audit fix, M7)", () => {
  it("deletes resolved rows past the retention, never open or pending ones", async () => {
    mockDb.storefrontIncident.deleteMany.mockResolvedValue({ count: 4 });
    expect(await pruneGuardIncidents("shop-1", NOW, false)).toBe(4);
    expect(GUARD_INCIDENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(mockDb.storefrontIncident.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        state: "resolved",
        resolvedAt: { lt: new Date(NOW.getTime() - GUARD_INCIDENT_RETENTION_MS) },
      },
    });
    expect(mockDb.storefrontIncident.findMany).not.toHaveBeenCalled();
  });

  it("over the cap: also deletes resolved rows past the newest MAX_GUARD_INCIDENTS", async () => {
    mockDb.storefrontIncident.deleteMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 2 });
    mockDb.storefrontIncident.findMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);
    expect(await pruneGuardIncidents("shop-1", NOW, true)).toBe(2);
    expect(mockDb.storefrontIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shopId: "shop-1",
          state: "resolved",
          resolvedAt: { lt: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000) },
        },
        skip: MAX_GUARD_INCIDENTS,
      }),
    );
    expect(mockDb.storefrontIncident.deleteMany).toHaveBeenLastCalledWith({
      where: { shopId: "shop-1", state: "resolved", id: { in: ["old-1", "old-2"] } },
    });
  });

  it("over the cap with nothing extra: one delete only", async () => {
    mockDb.storefrontIncident.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    expect(await pruneGuardIncidents("shop-1", NOW, true)).toBe(0);
    expect(mockDb.storefrontIncident.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("pruneGuardIncidents: the flap window survives the cap (wave 3 B2)", () => {
  it("the over-cap branch never selects a row resolved inside the 7-day flap window", async () => {
    mockDb.storefrontIncident.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.storefrontIncident.findMany.mockResolvedValue([]);
    await pruneGuardIncidents("shop-1", NOW, true);
    const where = mockDb.storefrontIncident.findMany.mock.calls[0][0].where;
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    // A row resolved yesterday does not satisfy the filter.
    expect(yesterday < where.resolvedAt.lt).toBe(false);
    expect(where.resolvedAt.lt).toEqual(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));
  });
});

describe("saveGuardCheck: large diffs (wave 3 B3)", () => {
  it("runs with an explicit 15 s transaction budget and writes every changed row", async () => {
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 1 });
    const changed = Array.from({ length: 600 }, (_, n) => ({
      ...INCIDENT,
      kind: "NEW_SCRIPT_HOST" as const,
      fingerprint: `NEW_SCRIPT_HOST:h${n}.io`,
      host: `h${n}.io`,
    }));
    const out = await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: 3,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed,
    });
    expect(out.status).toBe("saved");
    expect(tx.storefrontIncident.upsert).toHaveBeenCalledTimes(600);
    expect(mockDb.$transaction.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 15_000 });
  });

  it("an update never clears an emailed episode's stamp (a hidden row re-sighted, wave 3 B1)", async () => {
    tx.storefrontGuardState.updateMany.mockResolvedValue({ count: 1 });
    await saveGuardCheck({
      shopId: "shop-1",
      expectedVersion: 3,
      state: EMPTY_GUARD_STATE,
      domains: DOMAINS,
      changed: [{ ...INCIDENT, emailedOpenedAt: null }],
    });
    const call = tx.storefrontIncident.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("emailedOpenedAt");
    expect(call.create).toHaveProperty("emailedOpenedAt", null);
  });
});
