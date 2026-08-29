import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ScanStatus } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { logger } from "../lib/logger.server";
import { FIVE_MINUTES_MS } from "../lib/safe-session-storage.server";
import { CRON_HEARTBEAT_EXPECTATIONS, getStaleCrons } from "../models/ops-event.server";
import { DEFAULT_STALE_SCAN_THRESHOLDS } from "../models/scan.server";

/**
 * Deep post-deploy health probe (Tier 3 smoke test).
 *
 * Unlike /health (a bare DB liveness probe that external monitoring hits), this
 * ops endpoint runs READ-ONLY checks for the two silent-failure modes that
 * shipped to production before we had verification for them:
 *   - expired offline Shopify sessions -> merchant auth redirect loop (GC-07t)
 *   - Inngest unconfigured/unreachable -> scans stuck PENDING then watchdog-expired
 *
 * The body carries AGGREGATE COUNTS ONLY (no shop domains, no PII). A degraded
 * condition returns 503 so CI fails loudly on a bad deploy.
 *
 * Access is token-gated via the `x-health-token` header (HEALTH_CHECK_TOKEN).
 */

// SHA written by CI into .deploy-sha before `railway up`. Read per-request
// (health is an infrequent ops endpoint, not a hot path). Returns null when
// the file is missing or empty — normal for local dev builds.
function readDeployedSha(): string | null {
  try {
    const content = readFileSync(join(process.cwd(), ".deploy-sha"), "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

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

// Intentionally unauthenticated by Shopify session — this is an ops endpoint,
// gated by HEALTH_CHECK_TOKEN rather than an embedded-app session token.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // --- Token gate (fail closed in production) ---------------------------------
  const expectedToken = process.env.HEALTH_CHECK_TOKEN;
  if (!expectedToken) {
    if (process.env.NODE_ENV === "production") {
      logger.error("Deep health check rejected: HEALTH_CHECK_TOKEN not configured");
      return Response.json(
        { status: "error", message: "health token not configured" },
        { status: 503 },
      );
    }
    // Dev convenience: allow when the token is unset outside production.
  } else if (request.headers.get("x-health-token") !== expectedToken) {
    return Response.json({ status: "error", message: "unauthorized" }, { status: 401 });
  }

  // --- Read-only checks --------------------------------------------------------
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

  const checks = {
    db: { ok: dbOk },
    inngest: { ok: inngestOk, envOk: inngestEnvOk, overdueCrons },
    sessions: { expiredOffline },
    scans: { stuckPending },
  };

  const degraded = !inngestOk || expiredOffline > 0 || stuckPending > 0;
  const status = !dbOk ? "error" : degraded ? "degraded" : "ok";
  const httpStatus = status === "ok" ? 200 : 503;

  return Response.json(
    { status, timestamp: new Date().toISOString(), deployedSha: readDeployedSha(), checks },
    { status: httpStatus },
  );
};
