/**
 * Checkout guard Inngest quota tripwire (gc-1q1s.9).
 *
 * Inngest Free meters every run and every step against a 50k/month quota
 * shared by three apps. One guard run costs about 2 steps (the run and the
 * select step) + one per chunk + one per notify step. This projects the run
 * just finished over a month of hourly runs and, when that passes the
 * threshold, pages the operator through the ops-alert channel, at most once
 * a day.
 *
 * Threshold: STOREFRONT_GUARD_MONTHLY_STEP_ALERT (a positive integer),
 * default GUARD_MONTHLY_STEP_ALERT_DEFAULT (20k, the guard's share).
 *
 * Once a day: the last alert is an OpsEvent row (`guard_quota_alert`) keyed on
 * the CONSTANT "storefront-guard" with counts-only metadata. No shop domain or
 * other per-shop data, so deleteShopData (which purges by domain) needs no new
 * clause; at most one row a day, so pruneOpsEvents needs none either (like
 * reconcile_summary).
 *
 * NEVER THROWS (recordOpsEvent and sendOpsAlert never throw).
 */
import { sendOpsAlert } from "./ops-alert.server";
import { getLatestOpsEvent, OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";

/** Default monthly step budget for the guard before the operator is paged. */
export const GUARD_MONTHLY_STEP_ALERT_DEFAULT = 20_000;
/** Hourly runs in a 30-day month. */
export const GUARD_RUNS_PER_MONTH = 24 * 30;
/** The OpsEvent key of the alert row (a constant, never a shop). */
export const GUARD_QUOTA_ALERT_KEY = "storefront-guard";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The alert threshold: the env value when it is a positive integer, else the default. */
export function guardMonthlyStepAlert(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STOREFRONT_GUARD_MONTHLY_STEP_ALERT?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : GUARD_MONTHLY_STEP_ALERT_DEFAULT;
}

/** Steps one run cost: the run and the select step, one per chunk, one per notify step. */
export function guardRunSteps(run: { chunks: number; notifySteps: number }): number {
  return 2 + run.chunks + run.notifySteps;
}

/** A run's steps as a month of hourly runs. */
export function projectGuardMonthlySteps(runSteps: number): number {
  return runSteps * GUARD_RUNS_PER_MONTH;
}

export type GuardQuotaAlertOutcome = "alerted" | "already_alerted_today";

/**
 * Page the operator that the guard's projected monthly steps passed the
 * threshold, unless an alert went out in the last 24 h. The row is written
 * before the send, so a retried step never pages twice.
 */
export async function alertGuardQuotaOnce(input: {
  projected: number;
  threshold: number;
  runSteps: number;
  due: number;
  now: Date;
}): Promise<GuardQuotaAlertOutcome> {
  const last = await getLatestOpsEvent(OPS_EVENT_TYPES.GUARD_QUOTA_ALERT, GUARD_QUOTA_ALERT_KEY);
  if (last && input.now.getTime() - last.createdAt.getTime() < DAY_MS) {
    return "already_alerted_today";
  }
  const metadata = {
    projected: input.projected,
    threshold: input.threshold,
    runSteps: input.runSteps,
    due: input.due,
  };
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.GUARD_QUOTA_ALERT,
    key: GUARD_QUOTA_ALERT_KEY,
    metadata,
  });
  await sendOpsAlert(
    "Checkout guard: Inngest step budget",
    [
      `The checkout guard's last run used about ${input.runSteps} Inngest steps for ${input.due} shops.`,
      `As hourly runs that is about ${input.projected} steps a month, over the guard's budget of ${input.threshold}.`,
      "Inngest Free allows 50,000 runs and steps a month across all three apps.",
      "Options: raise GUARD_CHUNK_SIZE, move to a paid Inngest plan, or raise STOREFRONT_GUARD_MONTHLY_STEP_ALERT.",
      "This alert repeats at most once a day.",
    ].join("\n"),
  );
  return "alerted";
}
