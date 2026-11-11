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
 *     create; items cascade).
 *   - A terminal run is never revived, and a decided item is never re-decided:
 *     every transition is a conditional updateMany.
 *   - finalize never reports completed while an item is still pending.
 */

import db from "../db.server";

export const ACTIVE_FIX_RUN_STATUSES = ["pending", "duplicating", "writing"] as const;
export type ActiveFixRunStatus = (typeof ACTIVE_FIX_RUN_STATUSES)[number];
export type FixRunStatus = ActiveFixRunStatus | "completed" | "partial" | "failed";
export type FixItemStatus = "pending" | "removed" | "skipped" | "failed";

export const FIX_RUNS_KEEP_PER_SHOP = 20;
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
  | { ok: false; reason: "RUN_ACTIVE"; activeRunId: string };

export async function createFixRun(
  input: { shopId: string; scanId: string; sourceThemeId: string; items: FixItemInput[] },
  now: Date = new Date(),
): Promise<CreateFixRunResult> {
  const { shopId } = input;
  return db.$transaction(async (tx) => {
    // Serialize run creation per shop (namespace distinct from createScan's).
    const lockKey = `fix-run:${shopId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    await tx.fixRun.updateMany({
      where: {
        shopId,
        status: { in: [...ACTIVE_FIX_RUN_STATUSES] },
        updatedAt: { lt: new Date(now.getTime() - ACTIVE_RUN_STALE_MS) },
      },
      data: { status: "failed", failureReason: "STALE", completedAt: now },
    });

    const active = await tx.fixRun.findFirst({
      where: { shopId, status: { in: [...ACTIVE_FIX_RUN_STATUSES] } },
      select: { id: true },
    });
    if (active)
      return { ok: false as const, reason: "RUN_ACTIVE" as const, activeRunId: active.id };

    const run = await tx.fixRun.create({
      data: {
        shopId,
        scanId: input.scanId,
        sourceThemeId: input.sourceThemeId,
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
    if (old.length > 0) {
      await tx.fixRun.deleteMany({
        where: { shopId, id: { in: old.map((r) => r.id) }, NOT: { id: run.id } },
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

/** Decide pending items (one transaction). Already-decided items are left alone. */
export async function decideFixItems(runId: string, decisions: ItemDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  await db.$transaction(
    decisions.map((d) =>
      db.fixItem.updateMany({
        where: { id: d.itemId, fixRunId: runId, status: "pending" },
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
    where: { id: { in: itemIds }, fixRunId: runId, status: "pending" },
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
