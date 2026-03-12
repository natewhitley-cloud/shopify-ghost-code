import { describe, it, expect } from "vitest";

import { formatDate, statusTone, statusLabel } from "../../app/lib/format";
import type { ScanStatus } from "../../app/lib/format";

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  // -------------------------------------------------------------------------
  // Null / undefined / falsy inputs
  // -------------------------------------------------------------------------

  it("returns em-dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns em-dash for empty string", () => {
    // Empty string is falsy — treated the same as null/undefined.
    expect(formatDate("")).toBe("—");
  });

  // -------------------------------------------------------------------------
  // Date object inputs
  // -------------------------------------------------------------------------

  it("formats a Date object without time by default", () => {
    // Jan 15 2025 — deterministic, unambiguous date.
    const d = new Date(2025, 0, 15); // month is 0-indexed
    const result = formatDate(d);
    expect(result).toBe("Jan 15, 2025");
  });

  it("formats a Date object with time when includeTime is true", () => {
    // 2025-01-15T09:05:00 local time.
    const d = new Date(2025, 0, 15, 9, 5);
    const result = formatDate(d, true);
    // Should contain the date portion and a time portion (AM/PM format).
    expect(result).toContain("Jan 15, 2025");
    expect(result).toMatch(/\d{2}:\d{2}\s?(AM|PM)/i);
  });

  it("formats a Date object with includeTime explicitly false (same as default)", () => {
    const d = new Date(2025, 5, 1); // Jun 1 2025
    expect(formatDate(d, false)).toBe("Jun 1, 2025");
    expect(formatDate(d, false)).toBe(formatDate(d));
  });

  // -------------------------------------------------------------------------
  // ISO string inputs
  // -------------------------------------------------------------------------

  it("formats an ISO date-time string without time by default", () => {
    // Use a UTC noon time to minimise timezone-induced date shifts.
    const result = formatDate("2025-03-10T12:00:00.000Z");
    // Exact date may shift by timezone, but the result must be a valid formatted string.
    expect(result).toMatch(/\w{3} \d{1,2}, \d{4}/);
  });

  it("formats an ISO date-time string with time included", () => {
    const result = formatDate("2025-03-10T12:00:00.000Z", true);
    expect(result).toMatch(/\w{3} \d{1,2}, \d{4}/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("formats a plain date string (YYYY-MM-DD)", () => {
    // new Date("2025-06-15") is parsed as UTC midnight; may show Jun 14 in UTC-offset zones.
    // We assert the shape rather than a specific date to keep the test portable.
    const result = formatDate("2025-06-15");
    expect(result).toMatch(/\w{3} \d{1,2}, \d{4}/);
  });

  // -------------------------------------------------------------------------
  // Edge-case dates
  // -------------------------------------------------------------------------

  it("formats the Unix epoch date (Date object)", () => {
    const epoch = new Date(0); // 1970-01-01T00:00:00.000Z
    const result = formatDate(epoch);
    // Must not return the em-dash — epoch is a valid Date.
    expect(result).not.toBe("—");
    expect(result).toMatch(/\w{3} \d{1,2}, \d{4}/);
  });

  it("formats an end-of-year date correctly", () => {
    const d = new Date(2024, 11, 31); // Dec 31 2024
    expect(formatDate(d)).toBe("Dec 31, 2024");
  });
});

// ---------------------------------------------------------------------------
// statusTone
// ---------------------------------------------------------------------------

describe("statusTone", () => {
  it("returns 'info' for PENDING", () => {
    expect(statusTone("PENDING")).toBe("info");
  });

  it("returns 'caution' for IN_PROGRESS", () => {
    expect(statusTone("IN_PROGRESS")).toBe("caution");
  });

  it("returns 'success' for COMPLETED", () => {
    expect(statusTone("COMPLETED")).toBe("success");
  });

  it("returns 'critical' for FAILED", () => {
    expect(statusTone("FAILED")).toBe("critical");
  });

  it("covers all four ScanStatus values exhaustively", () => {
    // If a new status is added to the union type in the future, this assertion
    // will still pass, but the switch in format.ts will be incomplete — TypeScript
    // will catch it at compile time.
    const allStatuses: ScanStatus[] = [
      "PENDING",
      "IN_PROGRESS",
      "COMPLETED",
      "FAILED",
    ];
    const validTones = new Set(["info", "caution", "success", "critical"]);
    for (const status of allStatuses) {
      expect(validTones.has(statusTone(status))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel", () => {
  it("returns 'Pending' for PENDING", () => {
    expect(statusLabel("PENDING")).toBe("Pending");
  });

  it("returns 'In Progress' for IN_PROGRESS", () => {
    expect(statusLabel("IN_PROGRESS")).toBe("In Progress");
  });

  it("returns 'Completed' for COMPLETED", () => {
    expect(statusLabel("COMPLETED")).toBe("Completed");
  });

  it("returns 'Failed' for FAILED", () => {
    expect(statusLabel("FAILED")).toBe("Failed");
  });

  it("returns a non-empty string for every known ScanStatus value", () => {
    const allStatuses: ScanStatus[] = [
      "PENDING",
      "IN_PROGRESS",
      "COMPLETED",
      "FAILED",
    ];
    for (const status of allStatuses) {
      const label = statusLabel(status);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
