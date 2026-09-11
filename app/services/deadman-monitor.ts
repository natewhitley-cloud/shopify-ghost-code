/**
 * External dead-man's-switch runner for the Inngest cron fleet (gc-1we).
 *
 * The in-app dead-man's-switch (getStaleCrons) is evaluated INSIDE the
 * monitor-deep-health Inngest cron. That is fine for a single stuck cron, but
 * it has a blind spot: if Inngest itself is fully down (e.g. signing-key drift
 * silently stops every scheduled function), the evaluator never runs and the
 * outage is invisible. This entrypoint closes that gap — it is a standalone
 * Node process, run by an EXTERNAL Railway cron, that evaluates the switch
 * independent of Inngest and pages via the existing Resend ops-alert channel.
 *
 * It mirrors the worker entrypoint (scan-engine.worker.ts): a top-level module
 * with NO `.server` suffix because it is executed directly, not imported by a
 * route. It is pre-bundled to build/server/deadman-monitor.js by
 * `npm run build:deadman` (esbuild) so it runs under `npm ci --omit=dev`, where
 * tsx is not available.
 *
 * Because sendOpsAlert never throws, a tripped switch is a NORMAL exit(0) — the
 * alert email IS the signal, not the exit code. A non-zero exit is reserved for
 * an unexpected failure of the runner itself, so Railway surfaces it as failed.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getOpsAlertConfigStatus, sendOpsAlert } from "./ops-alert.server";
import db from "../db.server";
import { logger as defaultLogger } from "../lib/logger.server";
import {
  CRON_HEARTBEAT_EXPECTATIONS,
  getStaleCrons as defaultGetStaleCrons,
  type StaleCron,
} from "../models/ops-event.server";

/**
 * Render a duration in whole minutes/hours for the alert body. Precision below
 * a minute is noise for a switch whose fastest threshold is ~20 minutes.
 */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
}

/**
 * Pure helper: build the operator alert for a set of stale crons, or null when
 * none are stale. Separated from the orchestration so it is trivially testable.
 */
export function buildStaleAlert(stale: StaleCron[]): { subject: string; body: string } | null {
  if (stale.length === 0) return null;

  const subject = `Cron dead-man's-switch tripped: ${stale.length} cron(s) overdue`;

  const lines = [
    `${stale.length} scheduled Inngest cron(s) have not recorded a heartbeat within their expected window.`,
    "",
    "This check runs OUTSIDE Inngest (an external Railway cron), so an overdue",
    "switch most likely points to a TOTAL Inngest outage — e.g. signing-key",
    "drift that silently stops every cron — rather than one failing function.",
    "",
    "Overdue crons:",
  ];

  for (const cron of stale) {
    lines.push(
      `  - ${cron.key}: last heartbeat ${cron.lastHeartbeatAt.toISOString()} ` +
        `(${formatDuration(cron.ageMs)} ago, threshold ${formatDuration(cron.thresholdMs)})`,
    );
  }

  return { subject, body: lines.join("\n") };
}

export interface RunDeadmanDeps {
  getStaleCrons: typeof defaultGetStaleCrons;
  sendOpsAlert: typeof sendOpsAlert;
  getOpsAlertConfigStatus: typeof getOpsAlertConfigStatus;
  logger: typeof defaultLogger;
}

/**
 * Evaluate the dead-man's-switch and page if any cron is overdue.
 *
 * Dependencies are injected (defaulting to the real ones) so tests can exercise
 * the orchestration without touching the database or the network.
 *
 * @returns a summary — how many crons were stale and whether an alert was sent.
 */
export async function runDeadmanCheck(
  deps: Partial<RunDeadmanDeps> = {},
): Promise<{ staleCount: number; alertSent: boolean }> {
  const {
    getStaleCrons = defaultGetStaleCrons,
    sendOpsAlert: send = sendOpsAlert,
    getOpsAlertConfigStatus: getConfig = getOpsAlertConfigStatus,
    logger = defaultLogger,
  } = deps;

  const stale = await getStaleCrons(CRON_HEARTBEAT_EXPECTATIONS);

  // Surface a misconfigured alert channel, but still proceed: a tripped switch
  // that only reaches the logs is more useful than skipping the check entirely.
  const config = getConfig();
  if (!config.configured) {
    logger.warn("deadman-monitor: ops-alert channel not configured — alert would be log-only", {
      context: "deadman-monitor",
      reason: config.reason,
    });
  }

  const alert = buildStaleAlert(stale);
  if (!alert) {
    logger.info("deadman-monitor: all crons healthy", {
      context: "deadman-monitor",
      checked: CRON_HEARTBEAT_EXPECTATIONS.length,
    });
    return { staleCount: 0, alertSent: false };
  }

  const result = await send(alert.subject, alert.body);
  logger.error("deadman-monitor: cron dead-man's-switch tripped", {
    context: "deadman-monitor",
    staleCount: stale.length,
    staleKeys: stale.map((cron) => cron.key),
    alertSent: result.sent,
    alertReason: result.reason,
  });

  return { staleCount: stale.length, alertSent: result.sent };
}

/**
 * Overall watchdog for main(). getStaleCrons is a single Prisma groupBy and the
 * alert send is capped at ~5s, so 30s is generous — if we blow past it the DB
 * connection is HANGING (not erroring), which would otherwise leave the cron a
 * silent zombie that never resolves and never exits.
 */
const RUN_TIMEOUT_MS = 30_000;

/**
 * Process entrypoint. Runs the check, disconnects Prisma, and exits. A tripped
 * switch exits 0 (the alert is the signal); only an unexpected runner failure
 * exits 1 so Railway marks the run failed and it stays visible.
 *
 * runDeadmanCheck is raced against RUN_TIMEOUT_MS so a hung DB connection is
 * surfaced as a failed run (exit 1) instead of a zombie process — the timeout
 * is handled by the same catch path as any other unexpected failure.
 */
async function main(): Promise<void> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(
        () => reject(new Error(`deadman-monitor timed out after ${RUN_TIMEOUT_MS}ms`)),
        RUN_TIMEOUT_MS,
      );
    });
    await Promise.race([runDeadmanCheck(), timeout]);
    clearTimeout(watchdog);
    await db.$disconnect();
    process.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    defaultLogger.error("deadman-monitor: unexpected failure", {
      context: "deadman-monitor",
      error: error instanceof Error ? error.message : String(error),
    });
    await db.$disconnect().catch(() => {});
    process.exit(1);
  }
}

/**
 * Run only when executed directly (node build/server/deadman-monitor.js), not
 * when imported by a test. We compare REALPATHS on both sides: node resolves
 * `import.meta.url` through symlinks (realpath) while `process.argv[1]` may be a
 * symlink (e.g. if Railway ever invokes via one), so a raw URL compare could be
 * false and silently skip main() — the worst outcome for a dead-man's-switch.
 */
function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    const thisPath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(argvPath);
    return thisPath === invokedPath;
  } catch {
    return false;
  }
}

if (isMainModule()) void main();
