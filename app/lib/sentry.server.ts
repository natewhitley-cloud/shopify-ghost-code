/**
 * Sentry error tracking integration — server-side only.
 *
 * Initializes Sentry when SENTRY_DSN is set. When DSN is absent the module
 * exports no-op wrappers so callers never need to guard against Sentry being
 * unconfigured.
 *
 * Usage:
 *   import { captureException, captureMessage } from "~/lib/sentry.server";
 *   captureException(err, { shop, scanId });
 *   captureMessage("Scan quota exceeded", "warning", { shop });
 */

import * as Sentry from "@sentry/node";

type SentryLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";
type Context = Record<string, unknown>;

let initialized = false;

/**
 * Called once at server startup. Safe to call multiple times — subsequent
 * calls are no-ops when already initialized.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No DSN configured — run in no-op mode. App behavior is unchanged.
    initialized = true;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "production",
    // TODO: Set release to the deployed git SHA (e.g. process.env.RAILWAY_GIT_COMMIT_SHA)
    // release: process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
  });
  initialized = true;
}

// Initialize eagerly when the module is first imported so loaders and services
// don't need to call initSentry() manually.
initSentry();

/**
 * Capture an exception and send to Sentry. No-ops when DSN is not configured.
 *
 * @param error  The thrown error (any type — Sentry handles non-Error values)
 * @param context  Optional key/value pairs attached as "extra" context in Sentry
 */
export function captureException(error: unknown, context?: Context): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(error);
  });
}

/**
 * Capture a message (non-error event) and send to Sentry.
 * No-ops when DSN is not configured.
 *
 * @param message  Human-readable description
 * @param level    Sentry severity level (defaults to "info")
 * @param context  Optional key/value pairs attached as "extra" context in Sentry
 */
export function captureMessage(
  message: string,
  level: SentryLevel = "info",
  context?: Context,
): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureMessage(message, level);
  });
}
