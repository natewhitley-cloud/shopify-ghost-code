/**
 * Stale-results banner (gc-mgi): what the scan results page shows when the
 * theme changed after the scan being viewed completed.
 *
 * "Stale" is isScanStaleAfterThemeChange (app/lib/stale-results), the same
 * condition as Home's theme-change nudge, so Professional (auto-rescan on
 * publish) never sees it. When stale, the banner always states both dates; the
 * ACTION below it depends on where the merchant stands:
 *   - newer_results: this is not the shop's latest successful scan. A rescan
 *     or an upgrade ask belongs on the latest results only (it would repeat on
 *     every old scan otherwise), so this page just links there.
 *   - rescan:        canStartScan allows a scan now (any plan with quota left).
 *   - scan_running:  a scan is already in progress.
 *   - free_blocked:  Free quota used: the next free scan date (nextScanAt from
 *                    canStartScan, single source of the period logic) plus the
 *                    trial-vs-upgrade CTA. The page's ONE upgrade ask.
 *   - paid_blocked:  Standard weekly quota used: the next scan date only.
 *
 * NEVER THROWS: the banner is optional content; a failed read logs and shows
 * no banner rather than breaking the results page.
 */
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { canStartScan } from "../lib/plan-gating.server";
import { PLANS } from "../lib/plans";
import { isScanStaleAfterThemeChange } from "../lib/stale-results";
import { getCompletedScansForShop } from "../models/scan.server";

export type StaleResultsAction =
  | { kind: "rescan" }
  | { kind: "free_blocked"; nextScanAt: Date; trialEligible: boolean }
  | { kind: "paid_blocked"; nextScanAt: Date }
  | { kind: "scan_running" }
  | { kind: "newer_results"; latestScanId: string };

export type StaleResults = {
  scanCompletedAt: Date;
  themePublishedAt: Date;
  action: StaleResultsAction;
};

export type LoadStaleResultsInput = {
  /** session.shop, for logging only. */
  shopDomain: string;
  shop: { id: string; plan: string; lastThemePublishAt: Date | null };
  scan: { id: string; status: string; completedAt: Date | null };
  /** getTrialEligibility for this shop (trial vs "Upgrade to Standard" framing). */
  trialEligible: boolean;
};

/** The banner for this scan's page, or null when its results are not stale. */
export async function loadStaleResults(input: LoadStaleResultsInput): Promise<StaleResults | null> {
  const { shopDomain, shop, scan, trialEligible } = input;
  const stale = isScanStaleAfterThemeChange({
    autoRescan: getPlanFeatures(shop.plan).autoRescan,
    lastThemePublishAt: shop.lastThemePublishAt,
    scan,
  });
  // The null checks only narrow the types: stale implies both are set.
  if (!stale || shop.lastThemePublishAt === null || scan.completedAt === null) return null;

  const base = { scanCompletedAt: scan.completedAt, themePublishedAt: shop.lastThemePublishAt };
  try {
    return { ...base, action: await resolveAction(shop, scan.id, trialEligible) };
  } catch (err) {
    logger.error("stale-results-load-failed", {
      shop: shopDomain,
      scanId: scan.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveAction(
  shop: LoadStaleResultsInput["shop"],
  scanId: string,
  trialEligible: boolean,
): Promise<StaleResultsAction> {
  const [latest] = await getCompletedScansForShop(shop.id, { limit: 1 });
  if (latest !== undefined && latest.id !== scanId) {
    return { kind: "newer_results", latestScanId: latest.id };
  }

  const gate = await canStartScan(shop.id, shop.plan);
  if (gate.allowed) return { kind: "rescan" };
  // Only a quota block carries nextScanAt; otherwise a scan is in progress.
  if (gate.nextScanAt === undefined) return { kind: "scan_running" };
  return shop.plan === PLANS.FREE
    ? { kind: "free_blocked", nextScanAt: gate.nextScanAt, trialEligible }
    : { kind: "paid_blocked", nextScanAt: gate.nextScanAt };
}
