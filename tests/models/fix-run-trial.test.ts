/**
 * gc-tib.22: the free-trial limit inside createFixRun (same per-shop lock as
 * the one-active rule), and trial runs that hold a removal are never pruned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ fake: null as unknown as { db: unknown } }));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.fake.db;
  },
}));

import {
  ACTIVE_RUN_STALE_MS,
  countTrialRemovals,
  createFixRun,
  decideFixItems,
  FIX_RUNS_KEEP_PER_SHOP,
  markFixRunFailed,
  type FixItemInput,
} from "../../app/models/fix-run.server";
import { createFakeDb, type FakeDb } from "../services/clean-copy.fakes";

let fake: FakeDb;

const item = (id: string): FixItemInput => ({
  findingId: id,
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  spanStart: 0,
  spanEnd: 10,
  spanSha256: "h",
  preMd5: "pre",
});
const items = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => item(`${prefix}${i}`));

const create = (n: number, trialLimit?: number, shopId = "shop-1", prefix = `f${Math.random()}-`) =>
  createFixRun({
    shopId,
    scanId: "scan-1",
    sourceThemeId: "gid://shopify/OnlineStoreTheme/1",
    items: items(prefix, n),
    ...(trialLimit !== undefined ? { trialLimit } : {}),
  });

async function runId(res: Awaited<ReturnType<typeof createFixRun>>): Promise<string> {
  if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
  return res.runId;
}

const itemsOf = (id: string) => fake.state.fixItems.filter((i) => i.fixRunId === id);

/** End a run: `removed` of its items removed, the rest decided `other`. */
async function finish(id: string, removed: number, other: "skipped" | "failed" = "skipped") {
  await decideFixItems(
    id,
    itemsOf(id).map((i, n) => ({
      itemId: i.id as string,
      status: n < removed ? "removed" : other,
      reasonCode: n < removed ? null : "FILE_CHANGED",
    })),
  );
  await markFixRunFailed(id, "TEST_DONE");
  // markFixRunFailed only touches active runs; force terminal for the test.
  fake.state.fixRuns.find((r) => r.id === id)!.status = removed > 0 ? "partial" : "failed";
}

beforeEach(() => {
  fake = createFakeDb();
  holder.fake = fake;
});

describe("createFixRun trial limit", () => {
  it("marks a trial run duringTrial and a paid run not", async () => {
    const trial = await runId(await create(2, 5));
    await finish(trial, 2);
    const paid = await runId(await create(2));
    expect(fake.state.fixRuns.find((r) => r.id === trial)?.duringTrial).toBe(true);
    expect(fake.state.fixRuns.find((r) => r.id === paid)?.duringTrial).toBe(false);
  });

  it("allows exactly the limit, refuses one more", async () => {
    expect((await create(6, 5)).ok).toBe(false);
    expect(await create(6, 5)).toMatchObject({
      ok: false,
      reason: "TRIAL_LIMIT",
      used: 0,
      limit: 5,
    });
    const id = await runId(await create(5, 5));
    await finish(id, 5);
    expect(await create(1, 5)).toEqual({ ok: false, reason: "TRIAL_LIMIT", used: 5, limit: 5 });
    expect(fake.state.fixRuns).toHaveLength(1);
  });

  it("counts removals across runs (five runs of one, not five of five)", async () => {
    for (let n = 0; n < 5; n++) await finish(await runId(await create(1, 5)), 1);
    expect(await countTrialRemovals("shop-1")).toBe(5);
    expect(await create(1, 5)).toMatchObject({ reason: "TRIAL_LIMIT", used: 5 });
  });

  it("skipped and failed items give the limit back", async () => {
    const a = await runId(await create(5, 5));
    await finish(a, 2, "skipped");
    const b = await runId(await create(3, 5));
    await finish(b, 0, "failed");
    expect(await countTrialRemovals("shop-1")).toBe(2);
    expect((await create(3, 5)).ok).toBe(true);
  });

  it("pending items count, so a run in flight can't be double-spent", async () => {
    const a = await runId(await create(4, 5));
    expect(await countTrialRemovals("shop-1")).toBe(4);
    // Lift the one-active rule to reach the count: items still pending.
    fake.state.fixRuns.find((r) => r.id === a)!.status = "partial";
    expect(await create(2, 5)).toMatchObject({ reason: "TRIAL_LIMIT", used: 4 });
    expect((await create(1, 5)).ok).toBe(true);
  });

  it("two concurrent trial creates for one shop: exactly one is made", async () => {
    const [r1, r2] = await Promise.all([create(3, 5), create(3, 5)]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ reason: "RUN_ACTIVE" });
  });

  it("a stale trial run's pending items stop counting once swept", async () => {
    const a = await runId(await create(5, 5));
    const run = fake.state.fixRuns.find((r) => r.id === a)!;
    run.updatedAt = new Date(Date.now() - ACTIVE_RUN_STALE_MS - 60_000);
    run.createdAt = run.updatedAt;
    const res = await create(5, 5);
    expect(res.ok).toBe(true);
    expect(fake.state.fixRuns.find((r) => r.id === a)?.status).toBe("failed");
  });

  it("paid runs never count toward the limit", async () => {
    await finish(await runId(await create(5)), 5);
    expect(await countTrialRemovals("shop-1")).toBe(0);
    expect((await create(5, 5)).ok).toBe(true);
  });

  it("another shop's trial removals don't count", async () => {
    await finish(await runId(await create(5, 5, "shop-2")), 5);
    expect(await countTrialRemovals("shop-1")).toBe(0);
    expect((await create(5, 5)).ok).toBe(true);
  });

  it("a paid run is never refused by earlier trial removals", async () => {
    await finish(await runId(await create(5, 5)), 5);
    expect((await create(50)).ok).toBe(true);
  });
});

describe("pruning keeps trial runs that hold a removal", () => {
  it("20 empty trial runs can't push out the run that used the limit", async () => {
    const first = await runId(await create(4, 5));
    await finish(first, 4);
    for (let n = 0; n < FIX_RUNS_KEEP_PER_SHOP + 5; n++) {
      await finish(await runId(await create(1, 5)), 0, "failed");
    }
    expect(fake.state.fixRuns.some((r) => r.id === first)).toBe(true);
    expect(await countTrialRemovals("shop-1")).toBe(4);
    expect(await create(2, 5)).toMatchObject({ reason: "TRIAL_LIMIT", used: 4 });
  });

  it("other runs are still pruned to the newest 20 (plus protected trial runs)", async () => {
    const kept = await runId(await create(1, 5));
    await finish(kept, 1);
    for (let n = 0; n < FIX_RUNS_KEEP_PER_SHOP + 5; n++) {
      await finish(await runId(await create(1)), 1);
    }
    expect(fake.state.fixRuns).toHaveLength(FIX_RUNS_KEEP_PER_SHOP + 1);
    expect(fake.state.fixRuns.some((r) => r.id === kept)).toBe(true);
  });

  it("a trial run with nothing removed is pruned like any other", async () => {
    const empty = await runId(await create(1, 5));
    await finish(empty, 0, "failed");
    for (let n = 0; n < FIX_RUNS_KEEP_PER_SHOP; n++) await finish(await runId(await create(1)), 1);
    expect(fake.state.fixRuns.some((r) => r.id === empty)).toBe(false);
  });
});
