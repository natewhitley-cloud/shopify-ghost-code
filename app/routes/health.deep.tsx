import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LoaderFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { performDeepHealthChecks } from "../services/deep-health.server";

/**
 * Deep post-deploy health probe (Tier 3 smoke test).
 *
 * Unlike /health (a bare DB liveness probe that external monitoring hits), this
 * ops endpoint runs READ-ONLY checks for the two silent-failure modes that
 * shipped to production before we had verification for them:
 *   - expired offline Shopify sessions -> merchant auth redirect loop (GC-07t)
 *   - Inngest unconfigured/unreachable -> scans stuck PENDING then watchdog-expired
 *
 * The actual checks live in app/services/deep-health.server.ts so the internal
 * continuous-monitor cron (monitor-deep-health) runs the SAME implementation
 * (gc-06e.13). This route owns only the token gate, deployedSha, and HTTP status.
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

  // --- Read-only checks (shared with the monitor-deep-health cron) -------------
  const { status, checks } = await performDeepHealthChecks();
  const httpStatus = status === "ok" ? 200 : 503;

  return Response.json(
    { status, timestamp: new Date().toISOString(), deployedSha: readDeployedSha(), checks },
    { status: httpStatus },
  );
};
