/**
 * Free-tier upgrade preview (gc-97k.4): what the scan-page teaser says is
 * hidden behind the paywall, broken down by consequence lane.
 *
 * Pure and UI-free (like finding-consequence.ts) so the loader, the component
 * and tests share one computation.
 *
 * HARD RULE: MALICIOUS_SCRIPT findings are never paywalled. They are shown in
 * full on every plan by the scan page's security alert, so they are excluded
 * from both the hidden count and the breakdown here.
 */
import type { FindingType } from "@prisma/client";

import { computeLaneSummary } from "./finding-consequence";

/** Most entries the breakdown lists; any overflow folds into one "Other" entry. */
export const UPGRADE_PREVIEW_MAX_GROUPS = 4;

export const UPGRADE_PREVIEW_OTHER_LABEL = "Other";

export type UpgradePreviewGroup = { label: string; count: number };

export type UpgradePreview = {
  /** Findings hidden from this Free shop (excludes the preview row and all malicious). */
  hiddenCount: number;
  /** Per-lane counts, largest first; sums to hiddenCount. */
  groups: UpgradePreviewGroup[];
};

/**
 * Build the teaser data from the scan's per-type counts (the loader's existing
 * groupBy aggregate, which already excludes ignored findings) and the type of
 * the one preview finding the Free view does show.
 *
 * Returns null when nothing is hidden, so the caller renders no teaser and
 * emits no `shown` event.
 */
export function buildUpgradePreview(
  byType: Partial<Record<FindingType, number>>,
  previewFindingType: FindingType,
): UpgradePreview | null {
  const hidden: Partial<Record<FindingType, number>> = { ...byType, MALICIOUS_SCRIPT: 0 };
  const previewTypeCount = hidden[previewFindingType] ?? 0;
  if (previewTypeCount > 0) hidden[previewFindingType] = previewTypeCount - 1;

  // Largest lane first; equal counts keep the canonical LANES display order.
  const lanes = computeLaneSummary(hidden).sort((a, b) => b.count - a.count || a.order - b.order);
  const hiddenCount = lanes.reduce((sum, lane) => sum + lane.count, 0);
  if (hiddenCount === 0) return null;

  if (lanes.length <= UPGRADE_PREVIEW_MAX_GROUPS) {
    return { hiddenCount, groups: lanes.map(({ label, count }) => ({ label, count })) };
  }
  const named = lanes.slice(0, UPGRADE_PREVIEW_MAX_GROUPS - 1);
  const otherCount = lanes
    .slice(UPGRADE_PREVIEW_MAX_GROUPS - 1)
    .reduce((sum, lane) => sum + lane.count, 0);
  return {
    hiddenCount,
    groups: [
      ...named.map(({ label, count }) => ({ label, count })),
      { label: UPGRADE_PREVIEW_OTHER_LABEL, count: otherCount },
    ],
  };
}

/**
 * Teaser headline, e.g.
 * "12 more findings on Standard: Found by Google & AI (5), Speed (4), Housekeeping (3)."
 */
export function upgradePreviewHeadline(preview: UpgradePreview): string {
  const noun = preview.hiddenCount === 1 ? "finding" : "findings";
  const breakdown = preview.groups.map((g) => `${g.label} (${g.count})`).join(", ");
  return `${preview.hiddenCount} more ${noun} on Standard: ${breakdown}.`;
}
