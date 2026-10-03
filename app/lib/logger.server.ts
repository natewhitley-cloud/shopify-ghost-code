/**
 * Structured JSON logger for server-side webhook and service code.
 *
 * Emits newline-delimited JSON objects to stdout/stderr so that Railway
 * (and other log aggregators) can parse log levels and context fields
 * without regex-scraping raw strings.
 *
 * EVERY entry passes through the PII scrub (gc-t7o2, ported from FraudPilot
 * ft-h6o/ft-edm): the message, each context value, and an Error's message +
 * stack. A log call never throws into its caller.
 *
 * Usage:
 *   import { logger } from "../lib/logger.server";
 *   logger.info("Webhook received", { topic, shop });
 *   logger.warn("Shop not found", { shop });
 *   logger.error("GraphQL error", { shop, error: err.message });
 */
import { MAX_LOG_META_BYTES, scrubContext, scrubStack, scrubString } from "./scrub";

type LogLevel = "info" | "warn" | "error";

function serializeError(err: Error): Record<string, string | undefined> {
  return {
    name: err.name,
    message: scrubString(err.message),
    stack: err.stack ? scrubStack(err.stack) : undefined,
  };
}

function buildEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  // Most callers pass `error: err.message` (a string): that stays a string via
  // scrubContext. Only a real Error gets name/message/stack (it would
  // otherwise serialize as {}).
  const { error, ...rest } = context ?? {};
  // If the scrub fails, emit a marker line instead of the (unscrubbed) entry.
  try {
    return {
      level,
      message: scrubString(message),
      timestamp,
      ...scrubContext(error instanceof Error ? rest : (context ?? {}), MAX_LOG_META_BYTES),
      ...(error instanceof Error ? { error: serializeError(error) } : {}),
    };
  } catch {
    return { level, message: "[log entry dropped: scrub failed]", timestamp };
  }
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify(buildEntry(level, message, context));
  // Route warn/error to stderr so Railway surfaces them at the correct severity.
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};
