/**
 * Shared error wrapper for the Sidekick resource routes (gc-5nok), copied
 * from FraudPilot (ft-68j) / ClearSignal (ba-lgun).
 *
 * Auth stays OUTSIDE this wrapper, so a thrown Response from
 * authenticate.admin (401 etc.) propagates unchanged. Only a failure of the
 * data read lands here: it is logged and recorded as an `api_error` OpsEvent
 * (GhostCode's observability since the Sentry removal, counted by the
 * operator digest), and answered with the same
 * `{ results: [{ status: "error", message }] }` shape the extension's
 * fetchTool returns for any failure, under the app's CORS headers. Status
 * 500: the failure is ours, and the extension treats any non-200 (or this
 * body) as "could not read this data right now".
 */
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { recordApiError } from "../models/ops-event.server";

export const SIDEKICK_ERROR_MESSAGE = "GhostCode could not read this data right now.";

export const SIDEKICK_ERROR_BODY = {
  results: [{ status: "error", message: SIDEKICK_ERROR_MESSAGE }],
};

export type SidekickErrorCode = "sidekick_latest_scan_failed" | "sidekick_speed_failed";

export async function respondWithSidekickSummary(
  cors: (response: Response) => Response,
  code: SidekickErrorCode,
  shopDomain: string,
  read: () => Promise<unknown>,
): Promise<Response> {
  try {
    // `results` is the envelope Sidekick expects; the summary is its one entry.
    return cors(Response.json({ results: [await read()] }));
  } catch (error) {
    // Error code + shop domain only: never the error message (a Prisma error
    // can embed query data), no tokens, no request data.
    logger.error(code, { shop: shopDomain, ...safeErrorFields(error) });
    try {
      await recordApiError({
        level: "error",
        code,
        shopDomain,
        message: "Sidekick data read failed",
      });
    } catch {
      // Recording is best-effort: never replace the answer with a new failure.
    }
    return cors(Response.json(SIDEKICK_ERROR_BODY, { status: 500 }));
  }
}
