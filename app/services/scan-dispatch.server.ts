/**
 * Request-context scan dispatch (QLT-7).
 *
 * All request-context callers (routes and webhook handlers) must go through
 * this helper instead of calling createScan + inngest.send inline. Eliminates
 * the duplicated trio and ensures consistent failure handling at every call site.
 *
 * NOT for use inside Inngest step functions. Inngest workers must split
 * createScan and step.sendEvent into SEPARATE Inngest steps so that a
 * transient send failure retries only the send — never re-runs createScan —
 * preventing orphan PENDING scans and the "already in progress" poisoned-retry
 * loop (LOG-8 fix lives in poll-check-shop, steps 4 and 5).
 *
 * Failure semantics
 * -----------------
 * createScan throws (active scan already exists, quota exceeded):
 *   Propagated to the caller. The caller decides how to surface the error
 *   (return { error } for routes; return 200 for webhook handlers).
 *
 * inngest.send fails (transient network error, unconfigured EVENT_KEY):
 *   Logged and swallowed. The scan record stays in PENDING state; the
 *   stale-scan watchdog (watch-stale-scans) expires it to FAILED after the
 *   pending threshold (15 min default). Callers can still redirect to or
 *   acknowledge the scan record — the PENDING scan is immediately visible in
 *   the merchant's scan history.
 */

import { inngest } from "../../inngest/client";
import { logger } from "../lib/logger.server";
import type { ScanQuota } from "../models/scan.server";
import { createScan } from "../models/scan.server";

/**
 * Create a scan record and fire the `scan/requested` Inngest event.
 *
 * @param shopId   - Internal shop DB id.
 * @param themeId  - Shopify theme GID (e.g. `gid://shopify/Theme/123`).
 * @param themeName - Human-readable theme name stored on the scan record.
 * @param options.quota - Optional quota to enforce atomically inside the
 *   createScan transaction. Pass `null` / omit for unlimited plans.
 *
 * @returns `{ scan }` — the newly created scan record.
 * @throws  If createScan throws (active scan, quota exceeded). Callers must
 *   catch and decide how to surface the failure.
 */
export async function dispatchScan(
  shopId: string,
  themeId: string,
  themeName: string,
  options?: { quota?: ScanQuota },
): Promise<{ scan: Awaited<ReturnType<typeof createScan>> }> {
  // createScan is atomic: checks active scan + quota in one transaction.
  // Throws on conflict — let that propagate so callers can handle it cleanly.
  const scan = await createScan(shopId, themeId, themeName, options?.quota);

  // Best-effort dispatch. A transient inngest.send failure leaves the scan
  // PENDING; the watchdog expires it. We do NOT throw here so callers (routes,
  // webhooks) can still redirect to the newly-created scan page.
  try {
    await inngest.send({
      name: "scan/requested",
      data: { shopId, themeId, scanId: scan.id },
    });
  } catch (err) {
    logger.error("scan/requested dispatch failed — scan stays PENDING, watchdog will expire", {
      scanId: scan.id,
      shopId,
      themeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { scan };
}
