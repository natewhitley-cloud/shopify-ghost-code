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
 * Fallback:
 *   If the pool throws (worker missing, spawn failure, task timeout), a warning
 *   is logged and scanThemeFiles() is called inline.  This ensures a scan never
 *   fails outright due to worker infrastructure.  The fallback is logged
 *   distinctly so a broken worker path is never silently masked.
 */

import os from "node:os";
import { join } from "node:path";

import Piscina from "piscina";

import { scanThemeFiles, type ScanResult, type ThemeFile } from "./scan-engine.server";
import { logger } from "../lib/logger.server";

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
 * Run scanThemeFiles in a worker thread from the pool.
 *
 * Falls back to the inline synchronous scan if the pool fails (missing worker
 * file, spawn error, task timeout).  Fallback is logged as a warning with a
 * distinct message so ops can detect it without mistaking it for a silent skip.
 */
export async function scanThemeFilesInPool(files: ThemeFile[]): Promise<ScanResult> {
  try {
    const result = await getPool().run(
      { files },
      { signal: AbortSignal.timeout(30_000) }, // generous ceiling; scans are ~100ms
    );
    return result as ScanResult;
  } catch (err) {
    logger.warn("scan-pool: worker run failed — falling back to inline scan", {
      service: "scan-pool",
      event: "worker_fallback",
      error: err instanceof Error ? err.message : String(err),
      fileCount: files.length,
    });
    return scanThemeFiles(files);
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
