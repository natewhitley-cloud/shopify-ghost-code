import db from "../db.server";
import { logger } from "../lib/logger.server";

// How long the DB liveness probe is allowed to take before we consider the
// database unreachable. Kept well under Railway's healthcheckTimeout (30s).
const DB_PROBE_TIMEOUT_MS = 2000;

class HealthCheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`Database liveness probe exceeded ${ms}ms`);
    this.name = "HealthCheckTimeoutError";
  }
}

// Intentionally unauthenticated — external monitoring (Railway) needs to probe this endpoint.
export const loader = async () => {
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
    return Response.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Health check failed: database unreachable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ status: "error" }, { status: 503 });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};
