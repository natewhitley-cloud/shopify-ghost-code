/**
 * Cron heartbeat wrapper (gc-06e.1).
 *
 * withCronHeartbeat wraps an Inngest cron handler so that a `cron_heartbeat`
 * OpsEvent is written after every SUCCESSFUL run — including handlers that
 * early-return (e.g. watch-stale-scans returning immediately when nothing is
 * stale). Wrapping at the handler boundary is why this is a wrapper and not a
 * copy-pasted line: it records on every return path without each cron having to
 * remember to do so, and it never records on the failure path (a throwing
 * handler rejects before the heartbeat, so a failed run is never counted live).
 *
 * The heartbeat write is a plain best-effort call (recordCronHeartbeat never
 * throws), not an Inngest step: it runs once, after the handler's final step,
 * and must never add a step that could fail or change a function's step graph.
 *
 * The dead-man's-switch (getStaleCrons) reads the latest heartbeat per key; a
 * scheduler that silently stops leaves its heartbeat aging past the interval,
 * which /health/deep surfaces as degraded.
 */

import type { GetFunctionInput } from "inngest";

import { recordCronHeartbeat } from "../../app/models/ops-event.server";
import type { inngest } from "../client";

// The full handler context Inngest injects (step, event, logger, runId, ...),
// typed against this app's client so wrapped handlers keep their real types.
// `import type` keeps the client reference type-only — no runtime coupling.
type CronContext = GetFunctionInput<typeof inngest>;

export function withCronHeartbeat<R>(
  key: string,
  handler: (ctx: CronContext) => Promise<R>,
): (ctx: CronContext) => Promise<R> {
  return async (ctx: CronContext) => {
    const result = await handler(ctx);
    // Best-effort: recordCronHeartbeat swallows its own errors, so a heartbeat
    // failure can never turn a successful cron run into a failure.
    await recordCronHeartbeat(key);
    return result;
  };
}
