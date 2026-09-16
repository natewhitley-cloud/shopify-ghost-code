import db from "../db.server";

/**
 * A single third-party (non-Shopify) host referenced by a theme, deduped across
 * the surfaces that referenced it, produced by the scan-engine during scanning
 * and persisted here (Feature 1 of the scan-observability spec).
 *
 * Single source of truth: the scan-engine imports this type rather than
 * redeclaring it, so the collector output and the persistence input can never
 * drift. (`appName` is present-but-null when unmatched, matching the nullable
 * `ScanDomain.appName` column.)
 */
export type ThirdPartyDomainRef = {
  domain: string;
  sources: string[];
  refCount: number;
  matched: boolean;
  appName: string | null;
  benign: boolean;
};

/**
 * Batch-insert the third-party domains for a completed scan.
 *
 * Idempotency guard:
 *   Mirrors createUnknownScripts. This runs inside the single scan step, which
 *   Inngest re-runs wholesale on retry, so a bare createMany would double-insert
 *   if the step retried after this write committed. A deleteMany is issued before
 *   createMany inside a $transaction: a retry deletes any previously-created rows
 *   and re-inserts them, producing the same final state instead of duplicates.
 *
 *   The deleteMany runs unconditionally (even for empty input) so a retry
 *   carrying fewer/zero domains than a prior partial attempt still clears stale
 *   rows. ScanDomain rows are only ever written here during the scan step, so
 *   nothing else can be clobbered.
 */
export async function createScanDomains(scanId: string, domains: ThirdPartyDomainRef[]) {
  return db.$transaction(async (tx) => {
    // Idempotency guard: clear any rows from a previous partial attempt.
    await tx.scanDomain.deleteMany({ where: { scanId } });

    if (domains.length === 0) {
      return { count: 0 };
    }

    return tx.scanDomain.createMany({
      data: domains.map((d) => ({ ...d, scanId })),
    });
  });
}

/**
 * Get the third-party domains recorded for a scan (oldest first).
 */
export async function getDomainsForScan(scanId: string) {
  return db.scanDomain.findMany({
    where: { scanId },
    orderBy: { createdAt: "asc" },
  });
}
