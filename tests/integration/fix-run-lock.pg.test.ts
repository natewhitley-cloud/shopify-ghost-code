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

/**
 * The URL, with a connection limit, only if it is a local gc_lock_test*
 * database. Any query string is refused: Prisma reads `?host=` as the real
 * host, so a hostname check alone could be bypassed (audit r1).
 */
export function safeTestUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (
    !["postgresql:", "postgres:"].includes(parsed.protocol) ||
    !local ||
    parsed.search !== "" ||
    !/^gc_lock_test\w*$/.test(dbName)
  ) {
    throw new Error("GC_PG_TEST_URL must be a local gc_lock_test* database with no query string");
  }
  // Enough connections for every concurrent create to hold its own transaction.
  parsed.searchParams.set("connection_limit", "20");
  return parsed.toString();
}

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.client;
  },
}));

import {
  ACTIVE_FIX_RUN_STATUSES,
  createFixRun,
  type FixItemInput,
} from "../../app/models/fix-run.server";

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

// retry: 0 so an intermittent race can't pass on the config's retry.
describe.skipIf(!testUrl)("createFixRun one-active-run lock (real Postgres)", { retry: 0 }, () => {
  let prisma: PrismaClient;
  const shops: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testUrl as string } } });
    holder.client = prisma;
    for (const domain of ["lock-a.myshopify.com", "lock-b.myshopify.com"]) {
      // Upsert: a re-run against the same database must not hit the unique domain.
      const shop = await prisma.shop.upsert({ where: { domain }, update: {}, create: { domain } });
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
      where: { shopId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
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

  // gc-tib.22: the trial count and prune protection on real Postgres (the
  // relation filter and the new column, not just the in-memory fake).
  const trialInput = (shopId: string, n: number, prefix: string) => ({
    shopId,
    scanId: "scan-1",
    sourceThemeId: "gid://shopify/OnlineStoreTheme/1",
    items: Array.from({ length: n }, (_, i) => item(`${prefix}${i}`)),
    trialLimit: 5,
  });
  const finishRemoved = async (runId: string) => {
    await prisma.fixItem.updateMany({ where: { fixRunId: runId }, data: { status: "removed" } });
    await prisma.fixRun.update({ where: { id: runId }, data: { status: "completed" } });
  };

  it("trial limit: 10 concurrent creates of 3 after 3 removed: none made (6 > 5)", async () => {
    const first = await createFixRun(trialInput(shops[0], 3, "a"));
    if (!first.ok) throw new Error(first.reason);
    await finishRemoved(first.runId);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, k) => createFixRun(trialInput(shops[0], 3, `b${k}-`))),
    );
    expect(results.every((r) => !r.ok && r.reason === "TRIAL_LIMIT")).toBe(true);
    expect(await prisma.fixRun.count({ where: { shopId: shops[0] } })).toBe(1);
    const run = await prisma.fixRun.findUnique({ where: { id: first.runId } });
    expect(run?.duringTrial).toBe(true);
  });

  it("trial limit: concurrent creates of 2 after 3 removed: exactly one made", async () => {
    const first = await createFixRun(trialInput(shops[0], 3, "a"));
    if (!first.ok) throw new Error(first.reason);
    await finishRemoved(first.runId);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, k) => createFixRun(trialInput(shops[0], 2, `c${k}-`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const counted = await prisma.fixItem.count({
      where: {
        status: { in: ["removed", "pending"] },
        fixRun: { shopId: shops[0], duringTrial: true },
      },
    });
    expect(counted).toBe(5);
  });

  it("prune keeps a trial run holding removals past the newest 20", async () => {
    const first = await createFixRun(trialInput(shops[0], 4, "p"));
    if (!first.ok) throw new Error(first.reason);
    await finishRemoved(first.runId);
    for (let k = 0; k < 22; k++) {
      const r = await createFixRun(input(shops[0]));
      if (!r.ok) throw new Error(r.reason);
      await prisma.fixRun.update({ where: { id: r.runId }, data: { status: "failed" } });
    }
    expect(await prisma.fixRun.findUnique({ where: { id: first.runId } })).not.toBeNull();
    expect(await prisma.fixRun.count({ where: { shopId: shops[0] } })).toBe(21);
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

describe("safeTestUrl (the guard itself, always runs)", () => {
  it("accepts a local gc_lock_test database and adds the connection limit", () => {
    expect(safeTestUrl("postgresql://postgres@127.0.0.1:54329/gc_lock_test")).toBe(
      "postgresql://postgres@127.0.0.1:54329/gc_lock_test?connection_limit=20",
    );
    expect(safeTestUrl("postgresql://postgres@[::1]:54329/gc_lock_test")).toContain("[::1]");
    expect(safeTestUrl(undefined)).toBeNull();
  });

  it.each([
    "postgresql://u:p@localhost/gc_lock_test?host=db.remote.example",
    "postgresql://u:p@localhost/gc_lock_test?hostaddr=10.0.0.1",
    "postgresql://u:p@localhost/gc_lock_test?sslmode=disable",
    "postgresql://u:p@db.remote.example/gc_lock_test",
    "postgresql://u:p@localhost.evil.com/gc_lock_test",
    "postgresql://u:p@localhost/ghost_code",
    "postgresql://u:p@localhost/gc_lock_test-prod",
    "mysql://u:p@localhost/gc_lock_test",
  ])("refuses %s", (url) => {
    expect(() => safeTestUrl(url)).toThrow(/local gc_lock_test/);
  });
});
