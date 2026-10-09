import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

/**
 * Shared in-progress poll for the scan detail page and Home: while the scan is
 * PENDING or IN_PROGRESS, revalidate the route's loaders every 3s so the page
 * swaps to results on its own, giving up after MAX_POLL_COUNT polls (~10 min).
 *
 * Each poll re-runs the parent app.tsx loader too; its page_visit write is
 * deduped per shop + path per 10 minutes and its lastSeenAt / firstOpenedAt
 * stamps are freshness- or once-gated, so a poll adds no telemetry rows.
 */

/** Delay between polls. */
export const SCAN_POLL_INTERVAL_MS = 3_000;

/** Maximum number of polls before we give up (~10 minutes at 3s). */
export const MAX_POLL_COUNT = 200;

/** Home's notice once polling has stopped at the cap. */
export const HOME_POLL_TIMEOUT_MESSAGE =
  "This scan is taking longer than usual. Refresh the page to check its status.";

/** True while a scan can still change (PENDING / IN_PROGRESS). */
export function isScanRunning(status: string | null | undefined): boolean {
  return status === "PENDING" || status === "IN_PROGRESS";
}

/**
 * Start the poll interval. `pollCount` is shared across restarts so a restart
 * never extends the cap; the tick that reaches MAX_POLL_COUNT clears the
 * interval and calls `onTimeout` instead of revalidating. Returns the cleanup.
 *
 * A tick is skipped while the previous revalidation is still running
 * (`isIdle` false), so a slow loader is never cancelled by the next tick.
 * Skipped ticks still COUNT toward the cap: the cap bounds wall-clock time
 * (~10 minutes), so a slow loader cannot keep a page polling longer.
 */
export function startScanPolling(opts: {
  pollCount: { current: number };
  revalidate: () => void;
  onTimeout: () => void;
  isIdle: () => boolean;
}): () => void {
  const interval = setInterval(() => {
    opts.pollCount.current += 1;
    if (opts.pollCount.current >= MAX_POLL_COUNT) {
      clearInterval(interval);
      opts.onTimeout();
      return;
    }
    if (opts.isIdle()) opts.revalidate();
  }, SCAN_POLL_INTERVAL_MS);
  return () => clearInterval(interval);
}

/**
 * Poll while `status` is running; stop on a terminal status (and reset the
 * counter so a later scan starts fresh) or at the cap.
 */
export function useScanPolling(status: string | null | undefined): { pollingTimedOut: boolean } {
  const revalidator = useRevalidator();
  // Latest revalidator each render, so the interval reads its CURRENT state.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const pollCount = useRef(0);
  const [pollingTimedOut, setPollingTimedOut] = useState(false);
  const running = isScanRunning(status);

  useEffect(() => {
    if (!running) {
      pollCount.current = 0;
      return undefined;
    }
    // Already timed out: never restart polling.
    if (pollingTimedOut) return undefined;
    return startScanPolling({
      pollCount,
      revalidate: () => void revalidatorRef.current.revalidate(),
      onTimeout: () => setPollingTimedOut(true),
      isIdle: () => revalidatorRef.current.state === "idle",
    });
  }, [running, pollingTimedOut]);

  return { pollingTimedOut };
}
