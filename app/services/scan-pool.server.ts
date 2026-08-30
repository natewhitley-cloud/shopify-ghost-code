/**
 * Worker-thread pool for scan-engine.
 *
 * Offloads the CPU-bound scanThemeFiles() call to a Piscina worker-thread pool
 * so the main event loop is not blocked during theme scans (GC-8uw).
 *
 * Worker resolution:
 *   Both dev and prod resolve the pre-compiled worker at
 *   <process.cwd()>/build/server/scan-engine.worker.js.
 *   In dev, run `npm run build:worker` once to compile it.
 *   In prod, the Dockerfile build stage runs `npm run build:worker` after
 *   `react-router build`, and the runtime stage copies the full build/ dir.
 *
 * Failure handling (gc-06e.2):
 *   If the pool throws (worker missing, spawn failure, task timeout), the run is
 *   retried ONCE in the pool with a stricter timeout.  If it still fails the
 *   error is escalated (logger.error) and re-thrown.  We deliberately do NOT
 *   re-run scanThemeFiles() inline on the main thread: that CPU-bound scan can
 *   catastrophically backtrack on a pathological theme file and, run inline,
 *   would stall the entire multi-tenant event loop (auth, health checks, other
 *   shops' scans, GDPR webhooks).  Re-throwing lets the caller (the scan-theme
 *   Inngest job) mark the scan FAILED via its existing failure path rather than
 *   returning an empty result that would look like a clean theme and wipe prior
 *   findings.  scanThemeFiles is intentionally not imported here so an inline
 *   main-thread fallback is impossible.
 */

import os from "node:os";
import { join } from "node:path";

import Piscina from "piscina";

import { type ScanResult, type ThemeFile } from "./scan-engine.server";
import { logger } from "../lib/logger.server";
import { notifyFunctionFailure } from "../lib/notifications.server";
import {
  countOpsEvents,
  getLatestOpsEvent,
  OPS_EVENT_TYPES,
  recordOpsEvent,
} from "../models/ops-event.server";

// ---------------------------------------------------------------------------
// Pool singleton
// ---------------------------------------------------------------------------

let pool: Piscina | null = null;

/**
 * Resolve the built worker file.
 * process.cwd() is the project root in both dev and in the Railway/Docker
 * runtime (WORKDIR /app), so build/server/scan-engine.worker.js is always
 * the same relative path.
 */
function workerFilePath(): string {
  return join(process.cwd(), "build", "server", "scan-engine.worker.js");
}

// First-attempt ceiling: scans are ~100ms, so 30s is a generous headroom for a
// cold worker or a large theme.  The single retry uses a stricter ceiling since
// a healthy re-run should complete quickly; a slow retry signals a genuinely
// pathological input and should fail fast rather than tie up a worker.
const WORKER_TIMEOUT_MS = 30_000;
const WORKER_RETRY_TIMEOUT_MS = 10_000;

// Worker-fallback escalation (gc-06e.13, sub-item 2).
//
// A single degraded-worker retry is tolerable (transient spawn hiccup, one slow
// theme). A SUSTAINED run of them is a real incident: the worker pool is
// persistently unhealthy and scans are silently taking the slow/retry path. After
// this many WORKER_FALLBACK events within the trailing window, escalate ONCE to a
// function_failure + ops-alert via notifyFunctionFailure.
//
// "N consecutive" is approximated as "N within a trailing window", queried from
// the durable OpsEvent history rather than an in-process counter. Rationale:
//   - The scan path records NO per-run SUCCESS marker (that would add a write to
//     the hot path and grow the OpsEvent table), so there is no success row to
//     reset a strict consecutive counter against.
//   - An in-process counter is unreliable across the Inngest execution model:
//     each scan job runs independently and the process can be replaced (redeploy)
//     or replicated (multiple containers), so a counter would neither persist nor
//     be shared. Querying the DB-backed history is the only reliable mechanism.
// A burst of N fallbacks in the window is exactly the persistent-degradation
// signal worth paging on.
const WORKER_FALLBACK_ESCALATION_THRESHOLD = 3;
const WORKER_FALLBACK_ESCALATION_WINDOW_MS = 30 * 60_000; // 30 minutes

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: workerFilePath(),
      // Single-tenant scan workload: leave at least one core for the event loop
      // and cap threads to avoid over-subscribing Railway's shared container.
      maxThreads: Math.min(4, Math.max(1, os.availableParallelism() - 1)),
      // Idle threads exit after 60s to release memory between scan bursts.
      idleTimeout: 60_000,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Escalate when worker fallbacks are sustained. Called on each fallback; counts
 * WORKER_FALLBACK events in the trailing window and, at/over the threshold, fires
 * ONE function_failure + ops-alert. De-duped within the window via the last
 * function_failure keyed "scan-pool" so a burst pages only once.
 *
 * Best-effort: any error (DB probe, alert) is swallowed to a warn. Escalation is
 * observability and must never add a failure mode to the already-degraded scan
 * path.
 */
async function maybeEscalateWorkerFallbacks(): Promise<void> {
  try {
    const recentFallbacks = await countOpsEvents(
      OPS_EVENT_TYPES.WORKER_FALLBACK,
      WORKER_FALLBACK_ESCALATION_WINDOW_MS,
    );
    if (recentFallbacks < WORKER_FALLBACK_ESCALATION_THRESHOLD) return;

    // De-dupe: escalate at most once per window. notifyFunctionFailure records a
    // function_failure keyed to this same id, so a prior escalation inside the
    // window suppresses a repeat page on every subsequent fallback in the burst.
    const lastEscalation = await getLatestOpsEvent(OPS_EVENT_TYPES.FUNCTION_FAILURE, "scan-pool");
    if (
      lastEscalation &&
      Date.now() - lastEscalation.createdAt.getTime() < WORKER_FALLBACK_ESCALATION_WINDOW_MS
    ) {
      return;
    }

    const windowMinutes = WORKER_FALLBACK_ESCALATION_WINDOW_MS / 60_000;
    await notifyFunctionFailure({
      functionId: "scan-pool",
      eventName: "worker-fallback-escalation",
      error:
        `scan-pool worker fell back ${recentFallbacks} time(s) in the last ${windowMinutes}m ` +
        "-- worker pool is persistently degraded",
      runId: `scan-pool-${Date.now()}`,
    });
  } catch (err) {
    logger.warn("scan-pool: worker-fallback escalation check failed", {
      service: "scan-pool",
      event: "escalation_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Run scanThemeFiles in a worker thread from the pool.
 *
 * On worker failure (missing worker file, spawn error, task timeout) the run is
 * retried ONCE in the pool with a stricter timeout.  If the retry also fails the
 * error is escalated to logger.error and re-thrown — it is NEVER re-run inline on
 * the main thread (see the module header).  The caller marks the scan FAILED.
 */
export async function scanThemeFilesInPool(files: ThemeFile[]): Promise<ScanResult> {
  try {
    const result = await getPool().run(
      { files },
      { signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) },
    );
    return result as ScanResult;
  } catch (firstErr) {
    // Distinct message so ops can detect a degraded worker path without
    // mistaking it for a silent skip.
    logger.warn("scan-pool: worker run failed — retrying once in the pool", {
      service: "scan-pool",
      event: "worker_retry",
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      fileCount: files.length,
    });

    // Record the degraded-worker path for the daily digest's Section-B "worker
    // fallbacks" count. Best-effort: recordOpsEvent NEVER throws, so it cannot
    // add a failure mode to the scan path. The TERMINAL failure (if the retry
    // below also fails) is counted separately as a function_failure by the
    // scan-theme Inngest job's onFailure — do NOT double-count it here.
    await recordOpsEvent({
      eventType: OPS_EVENT_TYPES.WORKER_FALLBACK,
      key: "scan-pool",
      message: firstErr instanceof Error ? firstErr.message : String(firstErr),
      metadata: { event: "worker_retry", fileCount: files.length },
    });

    // Escalate if worker fallbacks are SUSTAINED (see maybeEscalateWorkerFallbacks).
    // Best-effort and never throws, so it cannot affect the retry below.
    await maybeEscalateWorkerFallbacks();

    try {
      const result = await getPool().run(
        { files },
        { signal: AbortSignal.timeout(WORKER_RETRY_TIMEOUT_MS) },
      );
      return result as ScanResult;
    } catch (retryErr) {
      // Escalate and fail: do NOT fall back to an inline main-thread scan. The
      // scan is CPU-bound and can backtrack pathologically; run inline it would
      // stall the whole multi-tenant process. Re-throwing lets the scan-theme
      // Inngest job mark the scan FAILED (rather than returning empty findings,
      // which would look like a clean theme and wipe prior findings).
      // Worker degradation is already recorded as a WORKER_FALLBACK OpsEvent at
      // the retry point above; the terminal failure here is counted as a
      // function_failure by the scan-theme Inngest job's onFailure, so we do not
      // record a second OpsEvent in this block.
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logger.error("scan-pool: worker run failed after retry — failing scan (no inline fallback)", {
        service: "scan-pool",
        event: "worker_failed",
        error: message,
        fileCount: files.length,
      });
      throw new Error(
        `scan-pool: theme scan failed in worker after retry (${message}) — ` +
          "refusing inline main-thread fallback to protect the event loop",
      );
    }
  }
}

/**
 * Destroy the pool and release all worker threads.
 * Called in tests to allow the process to exit cleanly.
 */
export async function destroyPool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
}
