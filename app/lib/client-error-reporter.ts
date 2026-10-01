/**
 * Browser-side error capture for the embedded app (gc-nn6).
 *
 * Several uninstalls arrived with clean (all-2xx) server logs, so whatever went
 * wrong happened in the browser. This module beacons four signals to
 * POST /app/client-error, best-effort:
 *   - `error`:     window `error` events (uncaught exceptions),
 *   - `rejection`: `unhandledrejection` events,
 *   - `boundary`:  React Router ErrorBoundary renders (reportRouteError, called
 *                  from the boundaries themselves),
 *   - `fetch`:     same-origin app requests that fail at the network level or
 *                  answer 4xx/5xx (except 401).
 *
 * Why wrap `window.fetch` rather than watch React Router's navigation/fetcher
 * state: every in-app request (loader/action `.data` requests, revalidations,
 * the scan page's poll, the keepalive pings, the PDF export) goes through the
 * global fetch, so one wrapper sees them all, including a Railway-edge 502 or a
 * dropped connection that never reaches our server logs. React Router's state
 * only exposes errors it routes to a boundary (already covered by
 * `boundary`), and would need a hook in every route. The wrapper observes
 * only: it returns the original promise untouched (same Response, same
 * rejection), never reads a body, and ignores cross-origin URLs.
 *
 * App Bridge also patches the global fetch (to add the session token). Its CDN
 * script runs before hydration, so this wrapper normally sits outside it and
 * sees each request's final result after App Bridge's 401 re-auth retry. The
 * beacon itself goes through `win.fetch` too, so it carries the session token
 * whatever the wrap order; the wrapper skips the beacon's own path so a failing
 * beacon can never report itself.
 *
 * Privacy and volume: every report goes through the shared sanitizer
 * (app/lib/client-error.ts) and a per-page-load gate (dedupe + at most 5
 * beacons). The server re-sanitizes and rate-limits per shop.
 *
 * Telemetry must never break the page: every path swallows its own errors.
 */
import {
  CLIENT_ERROR_ENDPOINT,
  createReportGate,
  isReportableStatus,
  sanitizeClientErrorReport,
  type ClientErrorKind,
} from "./client-error";

/** The slice of `window` this module touches (injectable for tests). */
export interface ReporterWindow {
  fetch: typeof fetch;
  location: { origin: string; pathname: string };
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
}

interface RawReport {
  kind: ClientErrorKind;
  message: unknown;
  stack?: unknown;
  status?: number;
}

// Page-load scoped: the module lives exactly as long as the document.
const gate = createReportGate();
let installedOn: ReporterWindow | null = null;

function browserWindow(): ReporterWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as ReporterWindow);
}

function isAbortError(value: unknown): boolean {
  return (value as { name?: unknown } | null)?.name === "AbortError";
}

/** Sanitize, gate, and beacon one report. Never throws. */
export function reportClientError(
  raw: RawReport,
  win: ReporterWindow | undefined = browserWindow(),
): void {
  if (!win) return; // SSR
  try {
    const report = sanitizeClientErrorReport({ ...raw, path: win.location.pathname });
    if (!report || !gate.admit(report)) return;

    const body = new URLSearchParams({
      kind: report.kind,
      message: report.message,
      path: report.path,
    });
    if (report.stack !== undefined) body.set("stack", report.stack);
    if (report.status !== undefined) body.set("status", String(report.status));

    win.fetch(CLIENT_ERROR_ENDPOINT, { method: "POST", keepalive: true, body }).catch(() => {});
  } catch {
    // Telemetry must never break the page.
  }
}

/**
 * Report what a route ErrorBoundary is rendering. Called during the
 * boundary's render (it cannot use an effect: the app-level boundary rethrows
 * non-response errors, so an effect would never commit); the per-page gate
 * makes re-renders and StrictMode double renders a no-op. A no-op during SSR.
 *
 * Route error responses (`{ status, statusText }`) report their status and
 * never their `data` (it can echo server-side detail); a 401 is skipped like
 * any other re-auth handshake.
 */
export function reportRouteError(
  error: unknown,
  win: ReporterWindow | undefined = browserWindow(),
): void {
  try {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number") {
      if (!isReportableStatus(status)) return;
      const statusText = (error as { statusText?: unknown }).statusText;
      reportClientError(
        {
          kind: "boundary",
          message: `${status} ${typeof statusText === "string" ? statusText : ""}`,
          status,
        },
        win,
      );
      return;
    }
    const err = error as { message?: unknown; stack?: unknown } | null;
    reportClientError(
      {
        kind: "boundary",
        message: typeof err?.message === "string" ? err.message : String(error),
        stack: err?.stack,
      },
      win,
    );
  } catch {
    // Telemetry must never break the boundary.
  }
}

/** The same-origin pathname a fetch targets, or null to leave it unobserved. */
function observedPath(input: unknown, origin: string): string | null {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as { url?: unknown } | null)?.url;
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.pathname === CLIENT_ERROR_ENDPOINT) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function requestMethod(input: unknown, init: RequestInit | undefined): string {
  const method = init?.method ?? (input as { method?: unknown } | null)?.method;
  return typeof method === "string" ? method.toUpperCase() : "GET";
}

/**
 * Install the window listeners and the fetch wrapper. Idempotent per page
 * load; returns an uninstall function (restores the previous fetch).
 */
export function installClientErrorCapture(
  win: ReporterWindow | undefined = browserWindow(),
): () => void {
  if (!win || installedOn === win) return () => {};
  installedOn = win;

  const onError = (event: {
    message?: unknown;
    error?: { message?: unknown; stack?: unknown };
  }) => {
    reportClientError(
      { kind: "error", message: event.message || event.error?.message, stack: event.error?.stack },
      win,
    );
  };

  const onRejection = (event: { reason?: unknown }) => {
    const reason = event.reason;
    if (isAbortError(reason)) return;
    const message =
      typeof (reason as { message?: unknown } | null)?.message === "string"
        ? (reason as { message: string }).message
        : typeof reason === "string"
          ? reason
          : `Unhandled rejection (${reason === null ? "null" : typeof reason})`;
    reportClientError(
      { kind: "rejection", message, stack: (reason as { stack?: unknown } | null)?.stack },
      win,
    );
  };

  const originalFetch = win.fetch;
  const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const pending = originalFetch.call(win, input, init);
    try {
      const path = observedPath(input, win.location.origin);
      if (path !== null) {
        const label = `${requestMethod(input, init)} ${path}`;
        pending.then(
          (res) => {
            if (res.ok || res.type === "opaqueredirect" || !isReportableStatus(res.status)) return;
            reportClientError(
              { kind: "fetch", message: `${label} -> ${res.status}`, status: res.status },
              win,
            );
          },
          (err: unknown) => {
            if (isAbortError(err)) return;
            const reason = (err as { message?: unknown } | null)?.message;
            reportClientError(
              {
                kind: "fetch",
                message: `${label} failed: ${typeof reason === "string" ? reason : "network error"}`,
                status: 0,
              },
              win,
            );
          },
        );
      }
    } catch {
      // Observation must never change the caller's result.
    }
    return pending;
  }) as typeof fetch;

  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  win.fetch = wrappedFetch;

  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
    if (win.fetch === wrappedFetch) win.fetch = originalFetch;
    if (installedOn === win) installedOn = null;
  };
}
