/**
 * Inngest serve endpoint — handles all Inngest SDK communication
 * (function registration, event delivery, health checks).
 *
 * React Router v7 uses the same loader/action export pattern as Remix,
 * so the `inngest/remix` adapter is the correct choice here.
 *
 * Local dev: Inngest Dev Server polls this route automatically.
 * Production: Inngest cloud syncs against this endpoint after deploy.
 */
import { serve } from "inngest/remix";

import { inngest } from "../../inngest/client";
import { monitorScanFailures } from "../../inngest/functions/monitor-scan-failures";
import { pollCheckShop } from "../../inngest/functions/poll-check-shop";
import { pollThemeChanges } from "../../inngest/functions/poll-theme-changes";
import { scanTheme } from "../../inngest/functions/scan-theme";
import { snapshotMetrics } from "../../inngest/functions/snapshot-metrics";
import { watchStaleScans } from "../../inngest/functions/watch-stale-scans";
import { weeklyScan } from "../../inngest/functions/weekly-scan";

const handler = serve({
  client: inngest,
  // Pass the signing key explicitly so signature enforcement does not depend
  // solely on the SDK's implicit cloud-mode detection. inngest@3.54 skips
  // signature validation entirely when it does not infer cloud mode; wiring the
  // key in directly closes that gap and fails closed if it is missing.
  signingKey: process.env.INNGEST_SIGNING_KEY,
  functions: [
    scanTheme,
    pollThemeChanges,
    pollCheckShop,
    weeklyScan,
    monitorScanFailures,
    watchStaleScans,
    snapshotMetrics,
  ],
});

export { handler as loader, handler as action };
