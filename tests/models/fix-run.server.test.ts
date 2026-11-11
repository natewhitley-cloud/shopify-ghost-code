/**
 * Tests for app/models/fix-run.server.ts (gc-tib slice 4).
 *
 * db.server is the in-memory fake from tests/services/clean-copy.fakes.ts
 * (with a real per-key lock behind pg_advisory_xact_lock), so the one-active
 * guard, pruning and finalize rules are checked on resulting state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ fake: null as unknown as { db: unknown } }));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.fake.db;
  },
}));

import {
  ACTIVE_RUN_STALE_MS,
  createFixRun,
  decideFixItems,
  FIX_RUNS_KEEP_PER_SHOP,
  finalizeFixRun,
  getRecentFixRunsForShop,
  loadCleanCopyRunLines,
  markFixRunCopyGone,
  isFixRunActive,
  isStaleActiveRun,
  markDoNotPublishIfWritten,
  markFixRunFailed,
  recordExpectedPostMd5,
  setFixRunActiveStatus,
  type FixItemInput,
} from "../../app/models/fix-run.server";
import { createFakeDb, type FakeDb } from "../services/clean-copy.fakes";

let fake: FakeDb;

const item = (id: string, filename = "layout/theme.liquid"): FixItemInput => ({
  findingId: id,
  findingType: "GHOST_SCRIPT",
  filename,
  spanStart: 0,
  spanEnd: 10,
  spanSha256: "h",
  preMd5: "pre",
});

const input = (shopId = "shop-1", items = [item("f1"), item("f2")]) => ({
  shopId,
  scanId: "scan-1",
  sourceThemeId: "gid://shopify/OnlineStoreTheme/1",
  items,
});

async function created(shopId = "shop-1", items?: FixItemInput[]) {
  const res = await createFixRun(input(shopId, items));
  if (!res.ok) throw new Error("expected create to succeed");
  return res.runId;
}

const itemsOf = (runId: string) => fake.state.fixItems.filter((i) => i.fixRunId === runId);
const runOf = (runId: string) => fake.state.fixRuns.find((r) => r.id === runId)!;

beforeEach(() => {
  fake = createFakeDb();
  holder.fake = fake;
});

describe("createFixRun", () => {
  it("creates the run and its items in one transaction under a per-shop advisory lock", async () => {
    const runId = await created();
    expect(runOf(runId)).toMatchObject({ shopId: "shop-1", status: "pending" });
    expect(itemsOf(runId).map((i) => i.findingId)).toEqual(["f1", "f2"]);
    expect(itemsOf(runId)[0]).toMatchObject({ findingType: "GHOST_SCRIPT", preMd5: "pre" });
    expect(fake.state.lockSql[0]).toContain("pg_advisory_xact_lock(hashtextextended(");
  });

  it("refuses a second run while one is active", async () => {
    const first = await created();
    const second = await createFixRun(input());
    expect(second).toEqual({ ok: false, reason: "RUN_ACTIVE", activeRunId: first });
    expect(fake.state.fixRuns).toHaveLength(1);
  });

  it.each(["duplicating", "writing"] as const)("treats %s as active", async (status) => {
    const first = await created();
    await setFixRunActiveStatus(first, status);
    expect((await createFixRun(input())).ok).toBe(false);
  });

  it("allows a new run once the previous one is terminal", async () => {
    const first = await created();
    await markFixRunFailed(first, "SCAN_STALE");
    expect((await createFixRun(input())).ok).toBe(true);
  });

  it("does not let another shop's active run block this shop", async () => {
    await created("shop-2");
    expect((await createFixRun(input("shop-1"))).ok).toBe(true);
  });

  it("two concurrent creates for one shop: exactly one wins", async () => {
    const results = await Promise.all([createFixRun(input()), createFixRun(input())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ reason: "RUN_ACTIVE" }),
    ]);
    expect(fake.state.fixRuns).toHaveLength(1);
  });

  it("fails a stale active run (lost event) so it cannot block the shop forever", async () => {
    const old = await created();
    runOf(old).updatedAt = new Date(Date.now() - ACTIVE_RUN_STALE_MS - 60_000);
    const res = await createFixRun(input());
    expect(res.ok).toBe(true);
    expect(runOf(old)).toMatchObject({ status: "failed", failureReason: "STALE" });
  });

  it(`keeps only the newest ${FIX_RUNS_KEEP_PER_SHOP} runs per shop, items cascading`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < FIX_RUNS_KEEP_PER_SHOP + 2; i++) {
      const id = await created();
      ids.push(id);
      await markFixRunFailed(id, "TEST");
    }
    await created("shop-2");
    const kept = fake.state.fixRuns.filter((r) => r.shopId === "shop-1").map((r) => r.id);
    expect(kept).toHaveLength(FIX_RUNS_KEEP_PER_SHOP);
    expect(kept).not.toContain(ids[0]);
    expect(kept).not.toContain(ids[1]);
    expect(kept).toContain(ids[ids.length - 1]);
    expect(itemsOf(ids[0])).toHaveLength(0);
    expect(fake.state.fixRuns.filter((r) => r.shopId === "shop-2")).toHaveLength(1);
  });
});

describe("item decisions", () => {
  it("never re-decides an item that is already decided", async () => {
    const runId = await created();
    const [a] = itemsOf(runId);
    await decideFixItems(runId, [{ itemId: a.id as string, status: "removed" }]);
    await decideFixItems(runId, [
      { itemId: a.id as string, status: "failed", reasonCode: "POST_WRITE_MISMATCH" },
    ]);
    expect(a).toMatchObject({ status: "removed", reasonCode: null });
  });

  it("records the expected post md5 while the item stays pending", async () => {
    const runId = await created();
    const ids = itemsOf(runId).map((i) => i.id as string);
    await recordExpectedPostMd5(runId, ids, "expected");
    expect(itemsOf(runId).every((i) => i.status === "pending" && i.postMd5 === "expected")).toBe(
      true,
    );
  });

  it("only touches items of the given run", async () => {
    const r1 = await created();
    await markFixRunFailed(r1, "X");
    const r2 = await created();
    const foreign = itemsOf(r1)[0].id as string;
    await decideFixItems(r2, [{ itemId: foreign, status: "removed" }]);
    expect(itemsOf(r1)[0].status).toBe("pending");
  });
});

describe("finalizeFixRun", () => {
  async function finalizeWith(statuses: Array<"removed" | "skipped" | "failed" | "pending">) {
    const runId = await created(
      "shop-1",
      statuses.map((_, i) => item(`f${i}`)),
    );
    const items = itemsOf(runId);
    await decideFixItems(
      runId,
      statuses.flatMap((s, i) =>
        s === "pending" ? [] : [{ itemId: items[i].id as string, status: s, reasonCode: "R" }],
      ),
    );
    return { runId, result: await finalizeFixRun(runId) };
  }

  it("all removed -> completed", async () => {
    const { runId, result } = await finalizeWith(["removed", "removed"]);
    expect(result).toMatchObject({ status: "completed", removed: 2, total: 2 });
    expect(runOf(runId)).toMatchObject({ status: "completed", failureReason: null });
    expect(runOf(runId).completedAt).toBeInstanceOf(Date);
  });

  it("some removed -> partial", async () => {
    const { runId, result } = await finalizeWith(["removed", "skipped", "failed"]);
    expect(result).toMatchObject({ status: "partial", removed: 1, total: 3 });
    expect(runOf(runId).status).toBe("partial");
  });

  it("none removed -> failed NOTHING_REMOVED", async () => {
    const { runId } = await finalizeWith(["skipped", "failed"]);
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "NOTHING_REMOVED" });
  });

  it("never reports completed with a pending item: failed INCOMPLETE, item failed too", async () => {
    const { runId, result } = await finalizeWith(["removed", "pending"]);
    expect(result?.status).toBe("failed");
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "INCOMPLETE" });
    expect(itemsOf(runId)[1]).toMatchObject({ status: "failed", reasonCode: "INCOMPLETE" });
  });

  it("counts only this run's items (an old run's removed items never count)", async () => {
    const old = await created("shop-1", [item("a"), item("b")]);
    await decideFixItems(
      old,
      itemsOf(old).map((i) => ({ itemId: i.id as string, status: "removed" as const })),
    );
    await finalizeFixRun(old);
    const fresh = await created("shop-1", [item("c")]);
    await decideFixItems(fresh, [{ itemId: itemsOf(fresh)[0].id as string, status: "skipped" }]);
    const res = await finalizeFixRun(fresh);
    expect(res).toMatchObject({ status: "failed", removed: 0, total: 1 });
  });

  it("leaves a terminal run alone (no revival, reason kept)", async () => {
    const runId = await created();
    await markFixRunFailed(runId, "ACCESS_DENIED");
    expect(await finalizeFixRun(runId)).toBeNull();
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "ACCESS_DENIED" });
  });
});

describe("markFixRunFailed", () => {
  it("never overwrites a terminal run", async () => {
    const runId = await created();
    await markFixRunFailed(runId, "SCAN_STALE");
    expect(await markFixRunFailed(runId, "INTERNAL_ERROR")).toBe(false);
    expect(runOf(runId).failureReason).toBe("SCAN_STALE");
  });
});

describe("audit M-j / M-d / sec 7", () => {
  it("the STALE sweep also fails the lost run's pending items", async () => {
    const old = await created();
    runOf(old).updatedAt = new Date(Date.now() - ACTIVE_RUN_STALE_MS - 60_000);
    await createFixRun(input());
    expect(itemsOf(old).map((i) => [i.status, i.reasonCode])).toEqual([
      ["failed", "STALE"],
      ["failed", "STALE"],
    ]);
  });

  it("item decisions and expected md5s are no-ops once the run is no longer active", async () => {
    const runId = await created();
    await markFixRunFailed(runId, "STALE");
    const ids = itemsOf(runId).map((i) => i.id as string);
    await recordExpectedPostMd5(runId, ids, "expected");
    await decideFixItems(runId, [{ itemId: ids[0], status: "removed" }]);
    expect(itemsOf(runId).every((i) => i.status === "pending" && i.postMd5 === null)).toBe(true);
  });

  it("isFixRunActive / isStaleActiveRun", async () => {
    const runId = await created();
    expect(await isFixRunActive(runId)).toBe(true);
    const now = new Date();
    expect(isStaleActiveRun({ status: "writing", updatedAt: now }, now)).toBe(false);
    expect(
      isStaleActiveRun(
        { status: "writing", updatedAt: new Date(now.getTime() - ACTIVE_RUN_STALE_MS - 1) },
        now,
      ),
    ).toBe(true);
    expect(isStaleActiveRun({ status: "failed", updatedAt: new Date(0) }, now)).toBe(false);
    await markFixRunFailed(runId, "X");
    expect(await isFixRunActive(runId)).toBe(false);
  });

  it("markDoNotPublishIfWritten: only a failed run with a copy and a recorded write", async () => {
    const runId = await created();
    await recordExpectedPostMd5(runId, [itemsOf(runId)[0].id as string], "expected");
    // active run: never flagged
    expect(await markDoNotPublishIfWritten(runId)).toBe(false);
    await markFixRunFailed(runId, "INTERNAL_ERROR");
    // no copy yet: nothing could have been written
    expect(await markDoNotPublishIfWritten(runId)).toBe(false);
    runOf(runId).copyThemeId = "gid://shopify/OnlineStoreTheme/9";
    expect(await markDoNotPublishIfWritten(runId)).toBe(true);
    expect(runOf(runId).doNotPublish).toBe(true);

    const clean = await created();
    await markFixRunFailed(clean, "INTERNAL_ERROR");
    runOf(clean).copyThemeId = "gid://shopify/OnlineStoreTheme/10";
    expect(await markDoNotPublishIfWritten(clean)).toBe(false);
  });
});

describe("getRecentFixRunsForShop (gc-tib.20)", () => {
  it("no runs: empty", async () => {
    expect(await getRecentFixRunsForShop("shop-1")).toEqual([]);
  });

  it("this shop's runs only, newest first, as the lines need them", async () => {
    const first = await created();
    await markFixRunFailed(first, "SCAN_STALE");
    await created("shop-2");
    const second = await created();
    runOf(second).doNotPublish = true;
    const runs = await getRecentFixRunsForShop("shop-1");
    expect(runs.map((r) => r.id)).toEqual([second, first]);
    expect(runs[0]).toMatchObject({ status: "pending", doNotPublish: true });
    expect(runs[1]).toMatchObject({ status: "failed", failureReason: "SCAN_STALE" });
    // gc-e28n: updatedAt is kept (a failed run's banner turns quiet with age).
    expect(runs.every((r) => r.updatedAt instanceof Date)).toBe(true);
  });

  it("a stale active run reads as failed STALE, as on its result page; a fresh one stays active", async () => {
    const runId = await created();
    const now = new Date((runOf(runId).updatedAt as Date).getTime() + ACTIVE_RUN_STALE_MS + 1);
    const [stale] = await getRecentFixRunsForShop("shop-1", now);
    expect(stale).toMatchObject({ id: runId, status: "failed", failureReason: "STALE" });
    const [fresh] = await getRecentFixRunsForShop("shop-1");
    expect(fresh).toMatchObject({ id: runId, status: "pending", failureReason: null });
  });

  it("reads at most the kept number of runs", async () => {
    for (let i = 0; i < FIX_RUNS_KEEP_PER_SHOP + 3; i++)
      fake.state.fixRuns.push({
        id: `extra-${i}`,
        shopId: "shop-1",
        status: "completed",
        doNotPublish: false,
        failureReason: null,
        copyThemeId: null,
        copyThemeName: null,
        createdAt: new Date(2026, 0, 1, 0, i),
        updatedAt: new Date(2026, 0, 1, 0, i),
      });
    expect(await getRecentFixRunsForShop("shop-1")).toHaveLength(FIX_RUNS_KEEP_PER_SHOP);
  });
});

describe("gc-tib.20 r1: query shape, never-throw lines, copy gone", () => {
  it("asks the database for this shop, newest first, capped, with only the fields it needs", async () => {
    const spy = vi.spyOn(
      fake.db.fixRun as { findMany: (a: unknown) => Promise<unknown[]> },
      "findMany",
    );
    await getRecentFixRunsForShop("shop-1");
    expect(spy).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: FIX_RUNS_KEEP_PER_SHOP,
      select: {
        id: true,
        status: true,
        doNotPublish: true,
        failureReason: true,
        copyThemeId: true,
        copyThemeName: true,
        copyGoneAt: true,
        completedAt: true,
        updatedAt: true,
      },
    });
  });

  it("loadCleanCopyRunLines: lines on success, [] (never a throw) when the read fails", async () => {
    const runId = await created();
    expect(await loadCleanCopyRunLines("shop-1")).toEqual([
      expect.objectContaining({ runId, tone: "info" }),
    ]);
    vi.spyOn(
      fake.db.fixRun as unknown as { findMany: () => Promise<unknown[]> },
      "findMany",
    ).mockRejectedValue(new Error('relation "FixRun" does not exist'));
    await expect(loadCleanCopyRunLines("shop-1")).resolves.toEqual([]);
  });

  it("markFixRunCopyGone: set once, the first sighting kept", async () => {
    const runId = await created();
    const first = new Date("2026-11-11T10:00:00Z");
    await markFixRunCopyGone(runId, first);
    await markFixRunCopyGone(runId, new Date("2026-11-12T10:00:00Z"));
    expect(runOf(runId).copyGoneAt).toEqual(first);
    const [r] = await getRecentFixRunsForShop("shop-1");
    expect(r.copyGoneAt).toEqual(first);
  });
});

describe("schema comments (audit logic 18)", () => {
  it("the StorefrontIncident doc comment sits directly above its model", () => {
    const schema = readFileSync(join(__dirname, "..", "..", "prisma/schema.prisma"), "utf8");
    const before = schema.slice(0, schema.indexOf("model StorefrontIncident {")).trimEnd();
    expect(before.endsWith("// also deletes it explicitly.")).toBe(true);
    const fixRunHeader = schema.slice(0, schema.indexOf("model FixRun {"));
    expect(fixRunHeader.slice(-900)).not.toContain("Checkout guard incident");
  });
});

describe("migration 20261110210000_gc_tib_fix_item_finding_type", () => {
  it("adds exactly one nullable text column (additive)", () => {
    const sql = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "prisma/migrations/20261110210000_gc_tib_fix_item_finding_type/migration.sql",
      ),
      "utf8",
    );
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(code).toBe('ALTER TABLE "FixItem" ADD COLUMN "findingType" TEXT;');
  });
});

describe("migration 20261111120000_gc_tib_fix_run_copy_gone", () => {
  it("adds exactly one nullable timestamp column (additive), matching the schema", () => {
    const sql = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "prisma/migrations/20261111120000_gc_tib_fix_run_copy_gone/migration.sql",
      ),
      "utf8",
    );
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(code).toBe('ALTER TABLE "FixRun" ADD COLUMN "copyGoneAt" TIMESTAMP(3);');
    const schema = readFileSync(join(__dirname, "..", "..", "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/model FixRun \{[^}]*\n\s*copyGoneAt\s+DateTime\?\n/);
  });
});
