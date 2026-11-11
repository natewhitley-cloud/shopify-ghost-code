/**
 * gc-tib.8: the one-active-run-per-shop rule against REAL Postgres (the other
 * tests prove it only against the in-memory fake's lock). createFixRun takes
 * pg_advisory_xact_lock(hashtextextended('fix-run:<shop>', 0)) inside its
 * transaction; without it, concurrent creates under READ COMMITTED both see
 * "no active run" and both insert.
 *
 * Skipped unless GC_PG_TEST_URL is set. Run it with `scripts/test-pg-lock.sh`,
 * which starts a throwaway local Postgres, applies the migrations, runs this
 * file and deletes the server. The URL must be local and the database name
 * must start with gc_lock_test, so this can never touch a real database.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.GC_PG_TEST_URL;

function safeTestUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!local || !dbName.startsWith("gc_lock_test")) {
    throw new Error("GC_PG_TEST_URL must be a local gc_lock_test* database");
  }
  return raw;
}

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.client;
  },
}));

import { createFixRun, type FixItemInput } from "../../app/models/fix-run.server";

const testUrl = safeTestUrl(url);

const item = (id: string): FixItemInput => ({
  findingId: id,
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  spanStart: 0,
  spanEnd: 10,
  spanSha256: "h",
  preMd5: "pre",
});

const input = (shopId: string) => ({
  shopId,
  scanId: "scan-1",
  sourceThemeId: "gid://shopify/OnlineStoreTheme/1",
  items: [item("f1")],
});

describe.skipIf(!testUrl)("createFixRun one-active-run lock (real Postgres)", () => {
  let prisma: PrismaClient;
  const shops: string[] = [];

  beforeAll(async () => {
    // Enough connections for every concurrent create to hold its own transaction.
    prisma = new PrismaClient({
      datasources: { db: { url: `${testUrl}?connection_limit=20` } },
    });
    holder.client = prisma;
    for (const domain of ["lock-a.myshopify.com", "lock-b.myshopify.com"]) {
      const shop = await prisma.shop.create({ data: { domain } });
      shops.push(shop.id);
    }
  });

  beforeEach(async () => {
    await prisma.fixItem.deleteMany({});
    await prisma.fixRun.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const activeRuns = (shopId: string) =>
    prisma.fixRun.count({
      where: { shopId, status: { in: ["pending", "duplicating", "writing"] } },
    });

  it("10 concurrent creates for one shop: exactly one run, the rest RUN_ACTIVE naming it", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createFixRun(input(shops[0]))),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winnerId = (winners[0] as { runId: string }).runId;
    for (const r of results.filter((x) => !x.ok)) {
      expect(r).toEqual({ ok: false, reason: "RUN_ACTIVE", activeRunId: winnerId });
    }
    expect(await activeRuns(shops[0])).toBe(1);
  });

  it("different shops don't block each other", async () => {
    const [a, b] = await Promise.all([
      createFixRun(input(shops[0])),
      createFixRun(input(shops[1])),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await activeRuns(shops[0])).toBe(1);
    expect(await activeRuns(shops[1])).toBe(1);
  });

  it("repeated rounds never produce two active runs", async () => {
    for (let round = 0; round < 5; round++) {
      await prisma.fixItem.deleteMany({});
      await prisma.fixRun.deleteMany({});
      await Promise.all(Array.from({ length: 6 }, () => createFixRun(input(shops[0]))));
      expect(await activeRuns(shops[0])).toBe(1);
    }
  });
});
