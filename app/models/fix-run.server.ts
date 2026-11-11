/**
 * FixRun / FixItem data access (gc-tib slice 4, clean copy).
 *
 * Statuses are plain strings (see prisma/schema.prisma):
 *   FixRun:  pending | duplicating | writing | completed | partial | failed
 *   FixItem: pending | removed | skipped | failed
 *
 * Invariants kept here:
 *   - One ACTIVE run (pending | duplicating | writing) per shop, enforced inside
 *     a per-shop advisory-locked transaction (two concurrent creates: one wins).
 *     An active run untouched for ACTIVE_RUN_STALE_MS is failed STALE first, so
 *     a lost event can never block the shop forever.
 *   - Only the newest FIX_RUNS_KEEP_PER_SHOP runs per shop are kept (pruned on
 *     create; items cascade), except trial runs holding a trial removal.
 *   - Trial limit (gc-tib.22): a run made during the free trial is created only
 *     while the shop's trial items (removed, pending, or sent to Shopify) plus
 *     the new items stay within the limit, checked under the same lock. Only
 *     run creation adds pending items, so the count can't be raced.
 *   - A terminal run is never revived, and a decided item is never re-decided:
 *     every transition is a conditional updateMany.
 *   - finalize never reports completed while an item is still pending.
 */

import db from "../db.server";
import {
  cleanCopyRunLines,
  type CleanCopyRunLine,
  type RecentCleanCopyRun,
} from "../lib/clean-copy-view";
import { logger } from "../lib/logger.server";

export const ACTIVE_FIX_RUN_STATUSES = ["pending", "duplicating", "writing"] as const;
export type ActiveFixRunStatus = (typeof ACTIVE_FIX_RUN_STATUSES)[number];
export type FixRunStatus = ActiveFixRunStatus | "completed" | "partial" | "failed";
export type FixItemStatus = "pending" | "removed" | "skipped" | "failed";

export const FIX_RUNS_KEEP_PER_SHOP = 20;

/** Relation filter: item writes apply only while the run is active (audit M-j). */
const ACTIVE_RUN = { status: { in: [...ACTIVE_FIX_RUN_STATUSES] } };
/** An active run with no update for this long is presumed lost. */
export const ACTIVE_RUN_STALE_MS = 60 * 60 * 1000;

export type FixItemInput = {
  findingId: string;
  findingType: string;
  filename: string;
  spanStart: number;
  spanEnd: number;
  spanSha256: string;
  /** The scan manifest's md5 for the file: the copy must still match it. */
  preMd5: string;
};

export type CreateFixRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "RUN_ACTIVE"; activeRunId: string }
  | { ok: false; reason: "TRIAL_LIMIT"; used: number; limit: number };

/**
 * Item statuses that use up the trial limit: removed, or still in flight. An
 * item with postMd5 recorded counts too, whatever its status (see below).
 */
const TRIAL_COUNTED_ITEM_STATUSES = ["removed", "pending"] as const;

/**
 * The shop's items that count against the trial limit (gc-tib.22): items of
 * runs made during a trial that are removed, still pending, or whose upsert
 * may have been sent (an expected md5 was recorded before it), whatever they
 * ended as. A write that failed or timed out after sending can still be in
 * the copy, so it counts (audit r8 F1, hard limit). At most the limit, so small.
 */
async function trialCountedItems(
  client: Pick<typeof db, "fixItem">,
  shopId: string,
): Promise<Array<{ fixRunId: string }>> {
  return client.fixItem.findMany({
    where: {
      fixRun: { shopId, duringTrial: true },
      OR: [{ status: { in: [...TRIAL_COUNTED_ITEM_STATUSES] } }, { postMd5: { not: null } }],
    },
    select: { fixRunId: true },
  });
}

/** Trial items the shop has used so far (for the select page's "N of 5"). */
export async function countTrialRemovals(shopId: string): Promise<number> {
  return (await trialCountedItems(db, shopId)).length;
}

export async function createFixRun(
  input: {
    shopId: string;
    scanId: string;
    sourceThemeId: string;
    items: FixItemInput[];
    /** Set while the shop is in its free trial: the most items it may use (gc-tib.22). */
    trialLimit?: number;
  },
  now: Date = new Date(),
): Promise<CreateFixRunResult> {
  const { shopId } = input;
  return db.$transaction(async (tx) => {
    // Serialize run creation per shop (namespace distinct from createScan's).
    const lockKey = `fix-run:${shopId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    // A lost run: fail it AND its pending items (audit M-j), so nothing of it
    // reads as still in progress.
    const stale = await tx.fixRun.findMany({
      where: {
        shopId,
        status: { in: [...ACTIVE_FIX_RUN_STATUSES] },
        updatedAt: { lt: new Date(now.getTime() - ACTIVE_RUN_STALE_MS) },
      },
      select: { id: true },
    });
    if (stale.length > 0) {
      const ids = stale.map((r) => r.id);
      await tx.fixRun.updateMany({
        where: { id: { in: ids }, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
        data: { status: "failed", failureReason: "STALE", completedAt: now },
      });
      await tx.fixItem.updateMany({
        where: { fixRunId: { in: ids }, status: "pending" },
        data: { status: "failed", reasonCode: "STALE" },
      });
    }

    const active = await tx.fixRun.findFirst({
      where: { shopId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
      select: { id: true },
    });
    if (active)
      return { ok: false as const, reason: "RUN_ACTIVE" as const, activeRunId: active.id };

    // After the stale sweep, so a lost run's items no longer count.
    const trialItems = await trialCountedItems(tx, shopId);
    const duringTrial = input.trialLimit !== undefined;
    if (duringTrial && trialItems.length + input.items.length > (input.trialLimit as number)) {
      return {
        ok: false as const,
        reason: "TRIAL_LIMIT" as const,
        used: trialItems.length,
        limit: input.trialLimit as number,
      };
    }

    const run = await tx.fixRun.create({
      data: {
        shopId,
        scanId: input.scanId,
        sourceThemeId: input.sourceThemeId,
        duringTrial,
        items: {
          create: input.items.map((item) => ({
            findingId: item.findingId,
            findingType: item.findingType,
            filename: item.filename,
            spanStart: item.spanStart,
            spanEnd: item.spanEnd,
            spanSha256: item.spanSha256,
            preMd5: item.preMd5,
          })),
        },
      },
      select: { id: true },
    });

    const old = await tx.fixRun.findMany({
      where: { shopId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: FIX_RUNS_KEEP_PER_SHOP,
      select: { id: true },
    });
    // A trial run holding a removal is never pruned: deleting it would hand
    // the trial limit back (gc-tib.22). There are at most `limit` of them.
    const keep = new Set(trialItems.map((i) => i.fixRunId));
    const doomed = old.map((r) => r.id).filter((id) => !keep.has(id));
    if (doomed.length > 0) {
      await tx.fixRun.deleteMany({
        where: { shopId, id: { in: doomed }, NOT: { id: run.id } },
      });
    }
    return { ok: true as const, runId: run.id };
  });
}

export async function getFixRunWithItems(runId: string) {
  return db.fixRun.findUnique({
    where: { id: runId },
    include: { items: { orderBy: [{ filename: "asc" }, { spanStart: "asc" }] } },
  });
}

/**
 * The status and reason a run is shown with: an active run nobody has touched
 * for the stale threshold was lost, so it reads as failed STALE (the next
 * request's sweep fails it for real, audit M-j). Used by the result page and
 * the run lines alike (r1).
 */
export function displayedRunState(
  run: { status: string; failureReason: string | null; updatedAt: Date },
  now: Date = new Date(),
): { status: string; failureReason: string | null } {
  return isStaleActiveRun(run, now)
    ? { status: "failed", failureReason: "STALE" }
    : { status: run.status, failureReason: run.failureReason };
}

/**
 * The shop's kept runs, newest first, for the "last clean copy" lines on the
 * scan and select pages (gc-tib.20), with the displayed status.
 */
export async function getRecentFixRunsForShop(
  shopId: string,
  now: Date = new Date(),
): Promise<RecentCleanCopyRun[]> {
  const runs = await db.fixRun.findMany({
    where: { shopId },
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
  return runs.map((run) => ({ ...run, ...displayedRunState(run, now) }));
}

/**
 * The lines linking back to recent runs' result pages. Never throws (r1): a
 * failed read hides the lines instead of failing the scan page; the run's own
 * result page still shows its warning.
 */
export async function loadCleanCopyRunLines(shopId: string): Promise<CleanCopyRunLine[]> {
  try {
    return cleanCopyRunLines(await getRecentFixRunsForShop(shopId));
  } catch (error) {
    logger.error("clean-copy recent runs read failed", {
      shopId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Record that the run's copy theme was deleted (once; the first sighting wins). */
export async function markFixRunCopyGone(runId: string, at: Date = new Date()): Promise<void> {
  await db.fixRun.updateMany({ where: { id: runId, copyGoneAt: null }, data: { copyGoneAt: at } });
}

/** An active run untouched for ACTIVE_RUN_STALE_MS (the status page shows it as stopped). */
export function isStaleActiveRun(
  run: { status: string; updatedAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    (ACTIVE_FIX_RUN_STATUSES as readonly string[]).includes(run.status) &&
    now.getTime() - run.updatedAt.getTime() > ACTIVE_RUN_STALE_MS
  );
}

/** Whether the run is still active (re-checked right before a write, audit sec 7). */
export async function isFixRunActive(runId: string): Promise<boolean> {
  const run = await db.fixRun.findFirst({
    where: { id: runId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
    select: { id: true },
  });
  return run !== null;
}

/**
 * Flag do-not-publish when a FAILED run has a copy and any item recorded an
 * expected post-write md5: a write may have landed unverified (audit M-d).
 */
export async function markDoNotPublishIfWritten(runId: string): Promise<boolean> {
  const run = await db.fixRun.findUnique({
    where: { id: runId },
    select: { status: true, copyThemeId: true, items: { select: { postMd5: true } } },
  });
  // Only a failed run: a completed / partial run verified every write it made.
  if (run?.status !== "failed" || !run.copyThemeId) return false;
  if (!run.items.some((i) => i.postMd5 !== null)) return false;
  await db.fixRun.update({ where: { id: runId }, data: { doNotPublish: true } });
  return true;
}

export type FixRunWithItems = NonNullable<Awaited<ReturnType<typeof getFixRunWithItems>>>;

/** Move an active run to another active status. False if it is no longer active. */
export async function setFixRunActiveStatus(
  runId: string,
  status: ActiveFixRunStatus,
): Promise<boolean> {
  const res = await db.fixRun.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
    data: { status },
  });
  return res.count === 1;
}

/** Persist the copy's deterministic name BEFORE the duplicate mutation (adoption key). */
export async function setFixRunCopyName(runId: string, copyThemeName: string): Promise<void> {
  await db.fixRun.updateMany({
    where: { id: runId, copyThemeName: null },
    data: { copyThemeName },
  });
}

export async function setFixRunCopyTheme(
  runId: string,
  copy: { copyThemeId: string; copyCreatedAt: Date },
): Promise<void> {
  await db.fixRun.updateMany({
    where: { id: runId, copyThemeId: null },
    data: copy,
  });
}

/** Fail an active run. A terminal run keeps its status and reason. */
export async function markFixRunFailed(
  runId: string,
  failureReason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await db.fixRun.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
    data: { status: "failed", failureReason, completedAt: now },
  });
  return res.count === 1;
}

export async function setFixRunDoNotPublish(runId: string): Promise<void> {
  await db.fixRun.update({ where: { id: runId }, data: { doNotPublish: true } });
}

export type ItemDecision = {
  itemId: string;
  status: Exclude<FixItemStatus, "pending">;
  reasonCode?: string | null;
  postMd5?: string | null;
};

/**
 * Decide pending items (one transaction). Already-decided items, and items of
 * a run that is no longer active, are left alone.
 */
export async function decideFixItems(runId: string, decisions: ItemDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  await db.$transaction(
    decisions.map((d) =>
      db.fixItem.updateMany({
        where: { id: d.itemId, fixRunId: runId, status: "pending", fixRun: ACTIVE_RUN },
        data: {
          status: d.status,
          reasonCode: d.reasonCode ?? null,
          ...(d.postMd5 !== undefined ? { postMd5: d.postMd5 } : {}),
        },
      }),
    ),
  );
}

/**
 * Record the expected post-write md5 on pending items BEFORE the upsert. The
 * items stay pending; a retry that finds the file at this md5 marks them removed.
 */
export async function recordExpectedPostMd5(
  runId: string,
  itemIds: string[],
  postMd5: string,
): Promise<void> {
  if (itemIds.length === 0) return;
  await db.fixItem.updateMany({
    where: { id: { in: itemIds }, fixRunId: runId, status: "pending", fixRun: ACTIVE_RUN },
    data: { postMd5 },
  });
}

export type FinalizeResult = {
  status: "completed" | "partial" | "failed";
  failureReason: string | null;
  removed: number;
  total: number;
};

/**
 * Terminal status from this run's items only: completed when every item was
 * removed; partial when some were; failed when none were. Any item still
 * pending -> failed INCOMPLETE (it is marked failed INCOMPLETE too), so a run
 * is never reported completed with undecided items.
 */
export async function finalizeFixRun(
  runId: string,
  now: Date = new Date(),
): Promise<FinalizeResult | null> {
  return db.$transaction(async (tx) => {
    const run = await tx.fixRun.findUnique({
      where: { id: runId },
      select: { status: true, items: { select: { status: true } } },
    });
    // Missing, or already terminal (e.g. failed by onFailure): nothing to do.
    if (!run || !(ACTIVE_FIX_RUN_STATUSES as readonly string[]).includes(run.status)) return null;
    const items = run.items;
    const removed = items.filter((i) => i.status === "removed").length;
    const pending = items.filter((i) => i.status === "pending").length;

    let status: FinalizeResult["status"];
    let failureReason: string | null = null;
    if (pending > 0) {
      status = "failed";
      failureReason = "INCOMPLETE";
      await tx.fixItem.updateMany({
        where: { fixRunId: runId, status: "pending" },
        data: { status: "failed", reasonCode: "INCOMPLETE" },
      });
    } else if (items.length > 0 && removed === items.length) {
      status = "completed";
    } else if (removed > 0) {
      status = "partial";
    } else {
      status = "failed";
      failureReason = "NOTHING_REMOVED";
    }

    await tx.fixRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
      data: { status, failureReason, completedAt: now },
    });
    return { status, failureReason, removed, total: items.length };
  });
}
