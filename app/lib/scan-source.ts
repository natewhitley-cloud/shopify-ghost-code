/**
 * Scan start source (telemetry only).
 *
 * Pure and client-safe. Every UI that starts a merchant (MANUAL) scan posts to
 * Home's action with a `source` field naming the page it was started from; the
 * action normalizes it here and the value is stored on Scan.requestedFrom for
 * the operator digest. It is client-supplied, so it is NEVER used for gating,
 * quota, or anything but telemetry.
 */

export const SCAN_SOURCES = {
  HOME: "home",
  SCAN_PAGE: "scan_page",
  UNKNOWN: "unknown",
} as const;

export type ScanRequestSource = (typeof SCAN_SOURCES)[keyof typeof SCAN_SOURCES];

const ALLOWED: readonly string[] = Object.values(SCAN_SOURCES);

/**
 * Normalize a submitted `source` form field. An exact allowlisted value is
 * kept; anything else (missing, non-string, unknown, differently cased or
 * padded) becomes "unknown", so the stored value is always one of three.
 */
export function parseScanSource(raw: FormDataEntryValue | null | undefined): ScanRequestSource {
  return typeof raw === "string" && ALLOWED.includes(raw)
    ? (raw as ScanRequestSource)
    : SCAN_SOURCES.UNKNOWN;
}

/** Form payload for every scan-start control on Home (all post `source: home`). */
export function homeScanStartPayload(themeId: string): { themeId: string; source: "home" } {
  return { themeId, source: SCAN_SOURCES.HOME };
}

/** Form payload for the scan page's "Rescan now" (posts to Home's action). */
export const SCAN_PAGE_RESCAN_PAYLOAD: { source: "scan_page" } = {
  source: SCAN_SOURCES.SCAN_PAGE,
};
