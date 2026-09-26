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
import { PLANS } from "./plans";
import { FREE_TRIAL_DAYS, upgradeCtaLabel } from "./trial-cta";

/**
 * Every Free upgrade ask, by its NUDGE_KEYS value: the inline teaser (gc-97k.4)
 * and the return-visit banner (gc-97k.9). The /app/upgrade click ping accepts
 * exactly these as `src`, and a Free -> paid upgrade converts each one the
 * merchant was shown.
 */
export const UPGRADE_ASK_KEYS = ["upgrade_preview", "upgrade_return"] as const;

export type UpgradeAskKey = (typeof UPGRADE_ASK_KEYS)[number];

export function isUpgradeAskKey(value: unknown): value is UpgradeAskKey {
  return typeof value === "string" && (UPGRADE_ASK_KEYS as readonly string[]).includes(value);
}

/** Most entries the breakdown lists; any overflow folds into one "Other" entry. */
export const UPGRADE_PREVIEW_MAX_GROUPS = 4;

export const UPGRADE_PREVIEW_OTHER_LABEL = "Other";

export type UpgradePreviewGroup = { label: string; count: number };

export type UpgradePreview = {
  /** Findings hidden from this Free shop (excludes the preview rows and all malicious). */
  hiddenCount: number;
  /** Per-lane counts, largest first; sums to hiddenCount. */
  groups: UpgradePreviewGroup[];
};

/**
 * Build the teaser data from the scan's per-type counts (the loader's existing
 * groupBy aggregate, which already excludes ignored findings) and the types of
 * the preview findings the Free view does show (gc-97k.10: up to five). Each
 * preview row is subtracted from its own type, so hiddenCount = total - shown
 * and every lane in the breakdown excludes exactly the rows shown from it.
 *
 * Returns null when nothing is hidden, so the caller renders no teaser and
 * emits no `shown` event.
 */
export function buildUpgradePreview(
  byType: Partial<Record<FindingType, number>>,
  previewFindingTypes: readonly FindingType[],
): UpgradePreview | null {
  const hidden: Partial<Record<FindingType, number>> = { ...byType, MALICIOUS_SCRIPT: 0 };
  for (const type of previewFindingTypes) {
    const count = hidden[type] ?? 0;
    if (count > 0) hidden[type] = count - 1;
  }

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

/**
 * The teaser's body and button (gc-97k.8). Trial framing for a shop that can
 * still get the trial, plain upgrade framing for one that has had a paid plan:
 *   trial:    "<headline> Try Standard free for 7 days to see every file, line, and fix."
 *   fallback: "<headline> Upgrade to Standard to see every file, line, and fix."
 */
export function upgradePreviewCopy(
  preview: UpgradePreview,
  trialEligible: boolean,
): { body: string; cta: string } {
  const ask = trialEligible
    ? `Try ${PLANS.STANDARD} free for ${FREE_TRIAL_DAYS} days`
    : `Upgrade to ${PLANS.STANDARD}`;
  return {
    body: `${upgradePreviewHeadline(preview)} ${ask} to see every file, line, and fix.`,
    cta: upgradeCtaLabel(PLANS.STANDARD, trialEligible),
  };
}
