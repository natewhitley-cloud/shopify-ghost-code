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
  storefrontIncident: { findMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { EMPTY_GUARD_STATE, type GuardIncident } from "../../app/lib/storefront-guard-state";
import {
  acknowledgeGuardIncident,
  loadGuard,
  loadGuardForHome,
  markIncidentsEmailed,
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
  mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
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
