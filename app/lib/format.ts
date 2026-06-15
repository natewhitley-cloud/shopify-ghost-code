// ---------------------------------------------------------------------------
// Shared formatting utilities — client-safe (no .server.ts suffix)
// ---------------------------------------------------------------------------

export type ScanStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "PARTIAL" | "FAILED";

/**
 * True for terminal statuses where the scan succeeded and is usable.
 *
 * PARTIAL is a success: the core theme audit ran; only optional categories
 * whose scope was not granted were skipped. The UI treats PARTIAL like
 * COMPLETED (findings, diffing, health score) — mirrored server-side by
 * SUCCESSFUL_SCAN_STATUSES in scan.server.ts.
 */
export function isSuccessfulScan(status: ScanStatus | string): boolean {
  return status === "COMPLETED" || status === "PARTIAL";
}

/**
 * Format a date value as a human-readable string.
 *
 * @param date       - The date to format (Date, ISO string, null, or undefined).
 * @param includeTime - When true, appends hour and minute to the output.
 *                      Defaults to false (date only).
 */
export function formatDate(date: Date | string | null | undefined, includeTime = false): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  };
  return d.toLocaleDateString("en-US", options);
}

/**
 * Map a scan status to the corresponding Polaris badge tone.
 * Valid tones: info, caution, success, critical (subset of s-badge tone values).
 */
export function statusTone(status: ScanStatus): "info" | "caution" | "success" | "critical" {
  switch (status) {
    case "PENDING":
      return "info";
    case "IN_PROGRESS":
      return "caution";
    case "COMPLETED":
      return "success";
    case "PARTIAL":
      return "caution";
    case "FAILED":
      return "critical";
  }
}

/**
 * Map a scan status to a human-readable label.
 */
export function statusLabel(status: ScanStatus): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "IN_PROGRESS":
      return "In Progress";
    case "COMPLETED":
      return "Completed";
    case "PARTIAL":
      return "Partial";
    case "FAILED":
      return "Failed";
  }
}
