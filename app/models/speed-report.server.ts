/**
 * Store speed report data access (gc-wt3y): SpeedReport rows, the global
 * PageSpeed daily call budget and the "Run speed test now" 24h claim.
 */

import { Prisma } from "@prisma/client";

import db from "../db.server";
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
      completedAt: true,
    },
  });
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
