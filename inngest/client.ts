import { EventSchemas, Inngest } from "inngest";

import type { Events } from "./events";
import { failureLoggingMiddleware, loggingMiddleware, sentryMiddleware } from "./middleware";

/**
 * Fail-fast guard for Inngest credentials.
 *
 * Inngest reads INNGEST_EVENT_KEY (to authenticate event sends) and
 * INNGEST_SIGNING_KEY (to verify inbound invocations of the /api/inngest
 * serve endpoint) from the environment. If either is missing in production,
 * the SDK does NOT error at boot — it silently degrades: event sends and
 * signature validation fail at runtime, so scans sit in PENDING forever and
 * even the watch-stale-scans safety-net cron (served via the same endpoint)
 * stops firing. We convert that silent outage into a deploy-time failure.
 *
 * In development the Inngest Dev Server does not require these keys, so the
 * guard only fires in production. This mirrors the SENTRY_DSN philosophy
 * (optional in dev, required in prod) and the fail-fast style in
 * app/shopify.server.ts.
 */
if (process.env.NODE_ENV === "production") {
  if (!process.env.INNGEST_EVENT_KEY) {
    throw new Error("INNGEST_EVENT_KEY environment variable must be set in production");
  }
  if (!process.env.INNGEST_SIGNING_KEY) {
    throw new Error("INNGEST_SIGNING_KEY environment variable must be set in production");
  }
}

export const inngest = new Inngest({
  id: "ghost-code",
  schemas: new EventSchemas().fromRecord<Events>(),
  middleware: [loggingMiddleware, sentryMiddleware, failureLoggingMiddleware],
  // Pass the event key explicitly rather than relying solely on the SDK's
  // implicit env lookup. The value is identical, but explicit wiring makes the
  // credential dependency visible at the call site and keeps client config in
  // step with the explicit signingKey passed to serve() in api.inngest.ts.
  eventKey: process.env.INNGEST_EVENT_KEY,
});
