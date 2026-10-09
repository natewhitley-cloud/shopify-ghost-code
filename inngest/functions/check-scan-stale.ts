/**
 * Inngest function: check-scan-stale (gc-ngx6)
 *
 * Per-scan delayed stale check. Replaces the 10-minute watch-stale-scans cron, which
 * ran ~144x/day to find (almost always) nothing.
 *
 * Trigger: the `scan/requested` event, the single choke point every scan goes
 * through (dispatchScan for the dashboard + theme-publish webhook, and
 * poll-check-shop for the weekly/monthly scheduled paths). Inngest fans one event
 * out to every function listening for it, so scan-theme and this function both
 * start from the same send: no dispatch call site needs to remember to schedule
 * a check, and a new dispatch path is covered automatically. If the send itself
 * fails there is no scan-theme run either; the daily poll-theme-changes sweep
 * (expireStaleScans) remains the backstop for that case.
 *
 * Flow (thresholds + predicate shared with the daily sweep via
 * DEFAULT_STALE_SCAN_THRESHOLDS / buildStaleScanWhere):
 *   1. Sleep for the PENDING threshold, then expireStaleScan(scanId).
 *      - Finished (COMPLETED/PARTIAL/FAILED) or gone: return.
 *      - Expired (still PENDING, never started): return.
 *   2. Still IN_PROGRESS: sleep until startedAt + the IN_PROGRESS threshold,
 *      then check once more.
 * The resurrection guard in finalizeScan covers a scan finishing right as it is
 * expired. Best-effort: errors are logged, never thrown (no retry storm on a
 * transient DB error; the daily sweep is the backstop).
 */

import { logger } from "../../app/lib/logger.server";
import { DEFAULT_STALE_SCAN_THRESHOLDS } from "../../app/models/scan.server";
import { inngest } from "../client";

const STALE_THRESHOLDS = DEFAULT_STALE_SCAN_THRESHOLDS;
const MINUTE_MS = 60_000;

type CheckResult = {
  expired: boolean;
  status: string | null;
  /** ISO string (step output is JSON-serialised) of when to re-check, or null. */
  recheckAt: string | null;
};

export const checkScanStale = inngest.createFunction(
  { id: "check-scan-stale", name: "Check Scan For Staleness (Per-Scan)", retries: 0 },
  { event: "scan/requested" },
  async ({ event, step }) => {
    const { scanId } = event.data as { scanId: string };

    const runCheck = (name: string) =>
      step.run(name, async (): Promise<CheckResult> => {
        try {
          const { expireStaleScan } = await import("../../app/models/scan.server");
          const res = await expireStaleScan(scanId, STALE_THRESHOLDS);
          if (res.expired) {
            logger.warn("check-scan-stale: expired stale scan", { scanId, ...STALE_THRESHOLDS });
          }
          let recheckAt: string | null = null;
          if (res.status === "IN_PROGRESS") {
            const from = res.startedAt ?? res.createdAt ?? new Date();
            recheckAt = new Date(
              Math.max(
                from.getTime() + STALE_THRESHOLDS.inProgressMaxAgeMinutes * MINUTE_MS + 1000,
                Date.now() + 1000,
              ),
            ).toISOString();
          }
          return { expired: res.expired, status: res.status, recheckAt };
        } catch (err) {
          logger.error("check-scan-stale: check failed, daily sweep is the backstop", {
            scanId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { expired: false, status: null, recheckAt: null };
        }
      });

    await step.sleep("wait-pending-threshold", `${STALE_THRESHOLDS.pendingMaxAgeMinutes}m`);
    const first = await runCheck("check-after-pending-threshold");
    if (first.expired || !first.recheckAt) {
      return { scanId, expired: first.expired, checks: 1 };
    }

    await step.sleepUntil("wait-in-progress-threshold", new Date(first.recheckAt));
    const second = await runCheck("check-after-in-progress-threshold");
    return { scanId, expired: second.expired, checks: 2 };
  },
);
