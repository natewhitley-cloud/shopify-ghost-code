/**
 * Store speed report data access (gc-wt3y): SpeedReport rows, the global
 * PageSpeed daily call budget and the "Run speed test now" 24h claim.
 */

import { Prisma } from "@prisma/client";

import db from "../db.server";
import { OPS_EVENT_TYPES } from "./ops-event.server";
import {
  RUN_NOW_COOLDOWN_MS,
  SPEED_REPORT_STATUS,
  type SpeedFailureCode,
  type SpeedPageResult,
  type SpeedReportOrigin,
  type SpeedReportStatus,
} from "../lib/speed-report";

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Start a report row (RUNNING). */
export async function createSpeedReport(shopId: string, origin: SpeedReportOrigin) {
  return db.speedReport.create({
    data: { shopId, origin, status: SPEED_REPORT_STATUS.RUNNING },
    select: { id: true, createdAt: true },
  });
}

/**
 * The report row for this Inngest run (a run with no Run-now row: the weekly
 * batch), created RUNNING and started now. Keyed on the run (unique `runId`):
 * a retried prepare step finds the row it already made instead of leaving an
 * orphan RUNNING one (gc-wt3y #8).
 */
export async function startSpeedReportForRun(
  shopId: string,
  origin: SpeedReportOrigin,
  runId: string,
  now: Date,
) {
  return db.speedReport.upsert({
    where: { runId },
    create: {
      shopId,
      origin,
      status: SPEED_REPORT_STATUS.RUNNING,
      runId,
      startedAt: now,
    },
    update: {},
    select: { id: true },
  });
}

/**
 * The worker picked up a MANUAL report (created by Run now): stamp its run
 * and start time. False when the row is gone (shop redacted) or no longer
 * RUNNING; nothing is changed then.
 */
export async function startManualSpeedReport(
  reportId: string,
  runId: string,
  now: Date,
): Promise<boolean> {
  const { count } = await db.speedReport.updateMany({
    where: { id: reportId, status: SPEED_REPORT_STATUS.RUNNING },
    data: { runId, startedAt: now },
  });
  return count > 0;
}

/**
 * Close the report a dead or cancelled run left RUNNING (gc-wt3y #2/#3): by
 * the run that owned it, or the MANUAL report id when the run never started.
 * Only a RUNNING row of this shop is touched, so a finished report is never
 * rewritten. Tolerates a missing row (shop redacted): returns the count.
 */
export async function failAbandonedSpeedReport(
  target: { shopId: string; runId: string; reportId?: string },
  failureReason: SpeedFailureCode,
  now: Date,
): Promise<number> {
  const { count } = await db.speedReport.updateMany({
    where: {
      shopId: target.shopId,
      status: SPEED_REPORT_STATUS.RUNNING,
      OR: [{ runId: target.runId }, ...(target.reportId ? [{ id: target.reportId }] : [])],
    },
    data: { status: SPEED_REPORT_STATUS.FAILED, failureReason, completedAt: now },
  });
  return count;
}

/** Write a report's final state. */
export async function finishSpeedReport(
  reportId: string,
  result: {
    status: SpeedReportStatus;
    failureReason: SpeedFailureCode | null;
    pages: SpeedPageResult[] | null;
    psiCalls: number;
  },
) {
  return db.speedReport.update({
    where: { id: reportId },
    data: {
      status: result.status,
      failureReason: result.failureReason,
      pages:
        result.pages === null ? Prisma.DbNull : (result.pages as unknown as Prisma.InputJsonValue),
      psiCalls: result.psiCalls,
      completedAt: new Date(),
    },
    select: { id: true, createdAt: true, completedAt: true },
  });
}

/** How many recent reports the Store speed page reads (latest + a baseline). */
export const SPEED_REPORT_HISTORY_TAKE = 10;

/** The shop's most recent reports, newest first. */
export async function getRecentSpeedReports(shopId: string) {
  return db.speedReport.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: SPEED_REPORT_HISTORY_TAKE,
    select: {
      id: true,
      origin: true,
      status: true,
      failureReason: true,
      pages: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });
}

/**
 * Whether this shop already has a speed_report OpsEvent with `reason` since
 * `since` (used to rate-limit the "not configured" event, gc-wt3y #9).
 */
export async function hasRecentSpeedReportEvent(
  shopDomain: string,
  reason: SpeedFailureCode,
  since: Date,
): Promise<boolean> {
  const count = await db.opsEvent.count({
    where: {
      eventType: OPS_EVENT_TYPES.SPEED_REPORT,
      key: shopDomain,
      createdAt: { gte: since },
      metadata: { path: ["reason"], equals: reason },
    },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Run-now claim (24h per shop)
// ---------------------------------------------------------------------------

/** When the shop last pressed "Run speed test now" (null = never / no shop). */
export async function getSpeedReportRequestedAt(shopId: string): Promise<Date | null> {
  const row = await db.shop.findUnique({
    where: { id: shopId },
    select: { speedReportRequestedAt: true },
  });
  return row?.speedReportRequestedAt ?? null;
}

/**
 * Atomically claim the shop's "Run speed test now" slot: succeeds only when
 * the last claim is null or at least RUN_NOW_COOLDOWN_MS old (so exactly 24h
 * later is allowed). One conditional updateMany, so two concurrent clicks
 * cannot both win.
 */
export async function claimSpeedReportRunNow(shopId: string, now: Date): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      id: shopId,
      OR: [
        { speedReportRequestedAt: null },
        { speedReportRequestedAt: { lte: new Date(now.getTime() - RUN_NOW_COOLDOWN_MS) } },
      ],
    },
    data: { speedReportRequestedAt: now },
  });
  return count > 0;
}

/**
 * Hand a claim back after the run could not be dispatched, restoring the
 * previous value. Conditional on our own claim still being in place.
 */
export async function releaseSpeedReportRunNow(
  shopId: string,
  claimedAt: Date,
  previous: Date | null,
): Promise<void> {
  await db.shop.updateMany({
    where: { id: shopId, speedReportRequestedAt: claimedAt },
    data: { speedReportRequestedAt: previous },
  });
}

// ---------------------------------------------------------------------------
// Global daily PageSpeed budget
// ---------------------------------------------------------------------------

/** The UTC day key ("YYYY-MM-DD") the budget is counted under. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Reserve ONE PageSpeed call against today's (UTC) global budget, BEFORE the
 * call is made. True = reserved (make the call); false = budget exhausted.
 *
 * Atomic: an increment conditional on `calls < budget`. On the day's first
 * call the row does not exist yet, so it is created with calls = 1; if a
 * concurrent first call created it first (unique violation), the conditional
 * increment is retried once. A budget of 0 reserves nothing.
 */
export async function reservePageSpeedCall(budget: number, now: Date): Promise<boolean> {
  if (budget <= 0) return false;
  const day = utcDayKey(now);
  const increment = () =>
    db.pageSpeedDailyUsage.updateMany({
      where: { day, calls: { lt: budget } },
      data: { calls: { increment: 1 } },
    });

  if ((await increment()).count > 0) return true;
  try {
    await db.pageSpeedDailyUsage.create({ data: { day, calls: 1 } });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The row exists: either it is exhausted or a concurrent first call made it.
    return (await increment()).count > 0;
  }
}
