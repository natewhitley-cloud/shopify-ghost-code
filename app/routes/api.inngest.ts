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

import { scanTheme } from "../../inngest/functions/scan-theme";
import { pollThemeChanges } from "../../inngest/functions/poll-theme-changes";
import { pollCheckShop } from "../../inngest/functions/poll-check-shop";
import { weeklyScan } from "../../inngest/functions/weekly-scan";

const handler = serve({
  client: inngest,
  functions: [scanTheme, pollThemeChanges, pollCheckShop, weeklyScan],
});

export { handler as loader, handler as action };
