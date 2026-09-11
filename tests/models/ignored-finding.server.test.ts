/**
 * Tests for app/models/ignored-finding.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control IgnoredFinding reads/writes.
 *   - Verify INSTANCE and APP creates upsert on the correct compound unique key
 *     with the right scope (idempotency: duplicate ignore refreshes, not throws).
 *   - Verify un-ignore deletes by id.
 *   - Verify the combined read partitions rows into fingerprint + appName sets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  ignoredFinding: {
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  deleteIgnoredFinding,
  deleteIgnoredFindingForShop,
  getIgnoredFindingsForShop,
  ignoreFindingApp,
  ignoreFindingInstance,
  listIgnoredFindings,
} from "../../app/models/ignored-finding.server";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ignoreFindingInstance (INSTANCE scope)
// ---------------------------------------------------------------------------

describe("ignoreFindingInstance", () => {
  it("upserts on (shopId, fingerprint) with INSTANCE scope", async () => {
    mockDb.ignoredFinding.upsert.mockResolvedValue({ id: "i1" });

    await ignoreFindingInstance({
      shopId: "s1",
      fingerprint: "deadbeef",
      reason: "false positive",
    });

    expect(mockDb.ignoredFinding.upsert).toHaveBeenCalledWith({
      where: { shopId_fingerprint: { shopId: "s1", fingerprint: "deadbeef" } },
      create: {
        shopId: "s1",
        fingerprint: "deadbeef",
        reason: "false positive",
        scope: "INSTANCE",
      },
      update: { reason: "false positive" },
    });
  });

  it("defaults reason to null when omitted", async () => {
    mockDb.ignoredFinding.upsert.mockResolvedValue({ id: "i1" });

    await ignoreFindingInstance({ shopId: "s1", fingerprint: "deadbeef" });

    const arg = mockDb.ignoredFinding.upsert.mock.calls[0][0];
    expect(arg.create.reason).toBeNull();
    expect(arg.update.reason).toBeNull();
  });

  it("is idempotent — a duplicate ignore upserts on the same unique key (no throw)", async () => {
    mockDb.ignoredFinding.upsert.mockResolvedValue({ id: "i1" });

    await ignoreFindingInstance({ shopId: "s1", fingerprint: "deadbeef" });
    await ignoreFindingInstance({ shopId: "s1", fingerprint: "deadbeef" });

    // Both calls target the same compound unique; upsert makes the second a no-op-ish update.
    expect(mockDb.ignoredFinding.upsert).toHaveBeenCalledTimes(2);
    expect(mockDb.ignoredFinding.upsert.mock.calls[0][0].where).toEqual(
      mockDb.ignoredFinding.upsert.mock.calls[1][0].where,
    );
  });
});

// ---------------------------------------------------------------------------
// ignoreFindingApp (APP scope)
// ---------------------------------------------------------------------------

describe("ignoreFindingApp", () => {
  it("upserts on (shopId, appName) with APP scope", async () => {
    mockDb.ignoredFinding.upsert.mockResolvedValue({ id: "a1" });

    await ignoreFindingApp({ shopId: "s1", appName: "Judge.me", reason: "known good" });

    expect(mockDb.ignoredFinding.upsert).toHaveBeenCalledWith({
      where: { shopId_appName: { shopId: "s1", appName: "Judge.me" } },
      create: { shopId: "s1", appName: "Judge.me", reason: "known good", scope: "APP" },
      update: { reason: "known good" },
    });
  });

  it("defaults reason to null when omitted", async () => {
    mockDb.ignoredFinding.upsert.mockResolvedValue({ id: "a1" });

    await ignoreFindingApp({ shopId: "s1", appName: "Judge.me" });

    const arg = mockDb.ignoredFinding.upsert.mock.calls[0][0];
    expect(arg.create.reason).toBeNull();
    expect(arg.update.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteIgnoredFinding (un-ignore)
// ---------------------------------------------------------------------------

describe("deleteIgnoredFinding", () => {
  it("deletes the suppression row by id", async () => {
    mockDb.ignoredFinding.delete.mockResolvedValue({ id: "i1" });

    const result = await deleteIgnoredFinding("i1");

    expect(mockDb.ignoredFinding.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
    expect(result).toEqual({ id: "i1" });
  });
});

// ---------------------------------------------------------------------------
// deleteIgnoredFindingForShop (tenant-safe un-ignore)
// ---------------------------------------------------------------------------

describe("deleteIgnoredFindingForShop", () => {
  it("deletes only when the row belongs to the shop (compound where)", async () => {
    mockDb.ignoredFinding.deleteMany.mockResolvedValue({ count: 1 });

    const result = await deleteIgnoredFindingForShop("i1", "s1");

    expect(mockDb.ignoredFinding.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", shopId: "s1" },
    });
    expect(result).toEqual({ count: 1 });
  });

  it("returns count 0 for a foreign id (no cross-tenant delete)", async () => {
    mockDb.ignoredFinding.deleteMany.mockResolvedValue({ count: 0 });

    const result = await deleteIgnoredFindingForShop("other-shops-row", "s1");

    expect(result).toEqual({ count: 0 });
  });
});

// ---------------------------------------------------------------------------
// listIgnoredFindings (full rows for the management view)
// ---------------------------------------------------------------------------

describe("listIgnoredFindings", () => {
  it("returns all rows for the shop, newest first", async () => {
    const rows = [
      { id: "a1", scope: "APP", fingerprint: null, appName: "Judge.me", reason: null },
      { id: "i1", scope: "INSTANCE", fingerprint: "deadbeef", appName: null, reason: "fp" },
    ];
    mockDb.ignoredFinding.findMany.mockResolvedValue(rows);

    const result = await listIgnoredFindings("s1");

    expect(mockDb.ignoredFinding.findMany).toHaveBeenCalledWith({
      where: { shopId: "s1" },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toEqual(rows);
  });

  it("returns an empty array when the shop has no suppressions", async () => {
    mockDb.ignoredFinding.findMany.mockResolvedValue([]);

    const result = await listIgnoredFindings("s1");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getIgnoredFindingsForShop (combined read — E2.2 contract)
// ---------------------------------------------------------------------------

describe("getIgnoredFindingsForShop", () => {
  it("queries only the two key columns scoped to the shop", async () => {
    mockDb.ignoredFinding.findMany.mockResolvedValue([]);

    await getIgnoredFindingsForShop("s1");

    expect(mockDb.ignoredFinding.findMany).toHaveBeenCalledWith({
      where: { shopId: "s1" },
      select: { fingerprint: true, appName: true },
    });
  });

  it("partitions rows into fingerprint and appName sets", async () => {
    mockDb.ignoredFinding.findMany.mockResolvedValue([
      { fingerprint: "deadbeef", appName: null }, // INSTANCE
      { fingerprint: "cafebabe", appName: null }, // INSTANCE
      { fingerprint: null, appName: "Judge.me" }, // APP
      { fingerprint: null, appName: "Klaviyo" }, // APP
    ]);

    const result = await getIgnoredFindingsForShop("s1");

    expect(result.fingerprints).toEqual(new Set(["deadbeef", "cafebabe"]));
    expect(result.appNames).toEqual(new Set(["Judge.me", "Klaviyo"]));
  });

  it("returns empty sets when the shop has no suppressions", async () => {
    mockDb.ignoredFinding.findMany.mockResolvedValue([]);

    const result = await getIgnoredFindingsForShop("s1");

    expect(result.fingerprints.size).toBe(0);
    expect(result.appNames.size).toBe(0);
  });
});
