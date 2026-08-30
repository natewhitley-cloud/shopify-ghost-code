/**
 * Deep-health check logic (gc-06e.13, sub-item 1).
 *
 * The read-only checks that back the /health/deep probe, extracted here so BOTH
 * the route (app/routes/health.deep.tsx, hit at deploy by the smoke gate) and the
 * internal continuous-monitor cron (inngest/functions/monitor-deep-health.ts, hit
 * every 15 min) run ONE implementation. The route owns transport concerns (token
 * gate, deployedSha, HTTP status); this module owns the checks and the derived
 * status only.
 *
 * Checks (same silent-failure modes the route documented):
 *   - DB liveness (timed probe)
 *   - Inngest env presence AND cron dead-man's-switch (getStaleCrons)
 *   - offline sessions stuck expired past grace with no refreshToken (GC-07t)
 *   - PENDING scans older than the watchdog's cutoff
 *
 * Aggregate counts only — no shop domains, no PII cross the boundary.
 */

import { ScanStatus } from "@prisma/client";

import db from "../db.server";
import { logger } from "../lib/logger.server";
import { FIVE_MINUTES_MS } from "../lib/safe-session-storage.server";
import { CRON_HEARTBEAT_EXPECTATIONS, getStaleCrons } from "../models/ops-event.server";
import { DEFAULT_STALE_SCAN_THRESHOLDS } from "../models/scan.server";

// Same budget as /health — well under Railway's healthcheckTimeout (30s).
const DB_PROBE_TIMEOUT_MS = 2000;

class HealthCheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`Database liveness probe exceeded ${ms}ms`);
    this.name = "HealthCheckTimeoutError";
  }
}

async function probeDb(): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = db.$queryRaw`SELECT 1`;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new HealthCheckTimeoutError(DB_PROBE_TIMEOUT_MS)),
        DB_PROBE_TIMEOUT_MS,
      );
    });
    await Promise.race([probe, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export interface DeepHealthChecks {
  db: { ok: boolean };
  inngest: { ok: boolean; envOk: boolean; overdueCrons: string[] };
  sessions: { expiredOffline: number };
  scans: { stuckPending: number };
}

export interface DeepHealthResult {
  /** "ok" (200) | "degraded" (503, app up but a check failed) | "error" (503, DB down). */
  status: "ok" | "degraded" | "error";
  checks: DeepHealthChecks;
}

/**
 * Run the read-only deep-health checks and derive the overall status. Never
 * throws: a DB failure resolves to status "error" with dbOk false, and the cron
 * recency probe fails open (a transient hiccup must not false-degrade the deploy
 * smoke gate). The route wraps this with its token gate + HTTP status mapping.
 */
export async function performDeepHealthChecks(): Promise<DeepHealthResult> {
  // Env-var presence is necessary but NOT sufficient: a present-but-stale
  // signing key (the documented worst-case — silent key drift stops every cron)
  // still passes this check. The real liveness signal is heartbeat recency: if a
  // cron has silently stopped, its heartbeat ages past its interval and the
  // dead-man's-switch (getStaleCrons) flags it, making inngestOk false below.
  const inngestEnvOk = Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);

  let dbOk = false;
  let expiredOffline = 0;
  let stuckPending = 0;
  let overdueCrons: string[] = [];
  try {
    await probeDb();
    dbOk = true;

    // Auth-loop precursor (GC-07t): only offline sessions that are stuck.
    // With expiringOfflineAccessTokens enabled, short-lived offline tokens
    // routinely expire and auto-refresh via refreshToken — that's the benign,
    // self-healing majority and must NOT count. The genuinely-stuck state is
    // the exact trigger SafeSessionStorage.loadSession guards against: an
    // offline session expired beyond the FIVE_MINUTES_MS grace window with NO
    // refreshToken to recover it, which drives the reauth bounce loop.
    expiredOffline = await db.session.count({
      where: {
        refreshToken: null,
        expires: { not: null, lt: new Date(Date.now() - FIVE_MINUTES_MS) },
        isOnline: false,
      },
    });

    // "Scans couldn't run": PENDING scans older than the watchdog's pending
    // cutoff (reused from the watchdog so the two can never drift).
    const pendingCutoff = new Date(
      Date.now() - DEFAULT_STALE_SCAN_THRESHOLDS.pendingMaxAgeMinutes * 60 * 1000,
    );
    stuckPending = await db.scan.count({
      where: { status: ScanStatus.PENDING, createdAt: { lt: pendingCutoff } },
    });

    // Cron dead-man's-switch: flag any cron whose latest heartbeat is older than
    // its interval * grace. Fail-open on a query error — env presence remains the
    // signal and a transient recency-probe hiccup must not false-degrade the
    // deploy smoke gate. (Never-seen crons are not flagged; see getStaleCrons.)
    try {
      const stale = await getStaleCrons(CRON_HEARTBEAT_EXPECTATIONS);
      overdueCrons = stale.map((c) => c.key);
    } catch (error) {
      logger.error("Deep health check: cron heartbeat probe failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    logger.error("Deep health check failed: database unreachable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Functional Inngest signal: keys must be present AND no cron overdue.
  const inngestOk = inngestEnvOk && overdueCrons.length === 0;

  const checks: DeepHealthChecks = {
    db: { ok: dbOk },
    inngest: { ok: inngestOk, envOk: inngestEnvOk, overdueCrons },
    sessions: { expiredOffline },
    scans: { stuckPending },
  };

  const degraded = !inngestOk || expiredOffline > 0 || stuckPending > 0;
  const status = !dbOk ? "error" : degraded ? "degraded" : "ok";

  return { status, checks };
}
