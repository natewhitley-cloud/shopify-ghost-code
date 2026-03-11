/**
 * Structured JSON logger for server-side webhook and service code.
 *
 * Emits newline-delimited JSON objects to stdout/stderr so that Railway
 * (and other log aggregators) can parse log levels and context fields
 * without regex-scraping raw strings.
 *
 * Usage:
 *   import { logger } from "../lib/logger.server";
 *   logger.info("Webhook received", { topic, shop });
 *   logger.warn("Shop not found", { shop });
 *   logger.error("GraphQL error", { shop, error: err.message });
 */

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };
  // Route warn/error to stderr so Railway surfaces them at the correct severity.
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};
