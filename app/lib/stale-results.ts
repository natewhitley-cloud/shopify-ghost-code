/**
 * Stale results after a theme change (gc-mgi).
 *
 * Pure and client-safe. ONE definition of "the theme changed since this scan",
 * used by Home's theme-change nudge (against the latest scan) and by the scan
 * results page's stale-results banner (against the scan being viewed).
 *
 * Owner decision 1A, motivated by the sex-eshop uninstall (2026-09-26): the
 * merchant came back to results from before their new theme, could not rescan
 * on the Free quota, and nothing told them the results were old or when they
 * could scan again.
 */
import { isSuccessfulScan } from "./format";
import { PLANS } from "./plans";
import { FREE_TRIAL_DAYS } from "./trial-cta";

export type StaleScanInput = {
  /**
   * The plan auto-rescans on theme publish (Professional). Its results are
   * refreshed automatically, so they are never reported as stale.
   */
  autoRescan: boolean;
  /** Shop.lastThemePublishAt (Date, or its serialized string). */
  lastThemePublishAt: Date | string | null;
  /** The scan to judge, or null when there is none. */
  scan: { status: string; completedAt: Date | string | null } | null;
};

/**
 * True when a theme was published strictly after a SUCCESSFUL scan completed,
 * on a plan without auto-rescan.
 */
export function isScanStaleAfterThemeChange({
  autoRescan,
  lastThemePublishAt,
  scan,
}: StaleScanInput): boolean {
  return (
    !autoRescan &&
    lastThemePublishAt != null &&
    scan !== null &&
    isSuccessfulScan(scan.status) &&
    scan.completedAt !== null &&
    new Date(lastThemePublishAt) > new Date(scan.completedAt)
  );
}

/**
 * The banner's upgrade sentence for a quota-blocked Free shop. Trial framing
 * only for a shop that can still get the trial (trial-cta.ts); the button label
 * comes from upgradeCtaLabel.
 */
export function staleResultsUpgradeAsk(trialEligible: boolean): string {
  const ask = trialEligible
    ? `Try ${PLANS.STANDARD} free for ${FREE_TRIAL_DAYS} days`
    : `Upgrade to ${PLANS.STANDARD}`;
  return `${ask} to scan every week.`;
}
