/**
 * Resource route: /app/scans/:scanId/diff
 *
 * Computes the diff between a scan and its immediately-preceding scan for plans
 * that support scan diffing. Returns JSON so the scan-detail component can load
 * it lazily via useFetcher without blocking the main page render.
 *
 * No default component is exported — this is a loader-only resource route.
 *
 * Why this exists (PRF-2):
 *   The scan-detail loader previously loaded ALL previous-scan findings on every
 *   page view in order to compute the diff inline. Moving the diff here means
 *   the main loader never touches the previous scan's findings; the diff loads
 *   once after the page mounts and is null until it arrives.
 */

import type { LoaderFunctionArgs } from "react-router";

import { sortDiffFindingsBySeverity } from "../lib/finding-sort";
import { isSuccessfulScan } from "../lib/format";
import { canUseScanDiffing } from "../lib/plan-gating.server";
import { getFindingsForScan } from "../models/finding.server";
import { getScanById, getPreviousScanForTheme } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { diffScans } from "../services/scan-differ.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { scanId } = params;

  if (!scanId) {
    return new Response("Scan ID is required", { status: 400 });
  }

  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return new Response("Not found", { status: 404 });
  }

  // Short-circuit: plan does not support diffing.
  if (!canUseScanDiffing(shop.plan)) {
    return { scanDiff: null as ScanDiff | null };
  }

  const scan = await getScanById(scanId, { includeFindings: false });
  if (!scan || scan.shopId !== shop.id) {
    return new Response("Not found", { status: 404 });
  }

  // Diff only applies to successfully-completed scans.
  if (!isSuccessfulScan(scan.status)) {
    return { scanDiff: null as ScanDiff | null };
  }

  const previousScan = await getPreviousScanForTheme(scan.shopId, scan.themeId, scan.createdAt);
  if (!previousScan) {
    return { scanDiff: null as ScanDiff | null };
  }

  // Load all current findings — the full set is required for accurate diffing
  // (we must fingerprint every current finding to determine which are new vs.
  // unchanged, and which previous findings were resolved).
  const currentFindings = await getFindingsForScan(scanId);

  const scanDiff: ScanDiff = diffScans(currentFindings, previousScan.findings, {
    // Exclude prior findings in categories the current scan skipped (missing
    // scope) so they are never reported as falsely "resolved" (LOG-4).
    skippedCategories: scan.skippedCategories,
    // Likewise exclude prior findings in files the current scan skipped for
    // exceeding the size cap — an unscanned file is unknown, not fixed
    // (gc-06e.19).
    skippedFiles: scan.skippedFiles,
  });

  // Sort diff arrays for consistent display order in the UI.
  sortDiffFindingsBySeverity(scanDiff.newFindings);
  sortDiffFindingsBySeverity(scanDiff.resolvedFindings);

  return { scanDiff };
};
