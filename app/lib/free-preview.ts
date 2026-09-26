/**
 * Free-tier preview rows (gc-97k.10): how many full findings a Free shop sees
 * on a scan's results page, and which ones.
 *
 * Pure (no DB, no React) so the loader and tests share one computation. The
 * bounded DB read that feeds pickFreePreviewFindings lives in
 * app/services/free-preview.server.ts.
 *
 * HARD RULE: MALICIOUS_SCRIPT findings are never paywalled. They are shown in
 * full on every plan by the scan page's security alert, so they are neither
 * counted in the formula's total nor ever picked as a preview row here.
 */
import type { FindingType, Severity } from "@prisma/client";

import { LANES, laneForType } from "./finding-consequence";
import type { LaneKey } from "./finding-consequence";

/** Most full findings a Free shop sees. */
export const FREE_PREVIEW_MAX = 5;

/**
 * shown = max(1, min(5, floor(total / 2))), and 0 when total is 0.
 *
 * `total` counts the scan's non-malicious, non-ignored findings. At most half
 * are ever shown (never all of them from 2 up), but always at least one when
 * there is anything to show.
 */
export function freePreviewCount(total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(FREE_PREVIEW_MAX, Math.floor(total / 2)));
}

/**
 * How many of `total` findings the Free view hides behind the paywall:
 * total - freePreviewCount(total). Zero for 0 or 1 finding (the single
 * finding is shown), and positive from 2 up.
 */
export function freePreviewHiddenCount(total: number): number {
  return Math.max(0, total - freePreviewCount(total));
}

/** The fields the picker reads; loader rows carry more and are returned as-is. */
export type PreviewCandidate = {
  id: string;
  severity: Severity;
  findingType: FindingType;
  createdAt: Date;
};

const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Deterministic total order: severity (HIGH first), then createdAt (oldest
 * first), then id. Ids are unique, so no two distinct rows compare equal.
 * Matches the DB read's ORDER BY (severity, createdAt, id).
 */
export function comparePreviewCandidates(a: PreviewCandidate, b: PreviewCandidate): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Pick up to `count` preview rows, spread across consequence lanes.
 *
 * Round-robin by PRIMARY lane (finding-consequence's laneForType, the same
 * lane the teaser breakdown and the ?lane= filter use): each round takes the
 * best remaining row of every lane that still has one, so no lane repeats
 * before every lane with findings has contributed. Within a round the taken
 * rows are ordered by comparePreviewCandidates, so the result reads highest
 * severity first and the most severe finding of the scan is always row one.
 *
 * MALICIOUS_SCRIPT candidates are dropped defensively (see the file header).
 * Returns fewer than `count` only when there are fewer candidates.
 */
export function pickFreePreviewFindings<T extends PreviewCandidate>(
  candidates: readonly T[],
  count: number,
): T[] {
  const byLane = new Map<LaneKey, T[]>();
  for (const c of candidates) {
    if (c.findingType === "MALICIOUS_SCRIPT") continue;
    const lane = laneForType(c.findingType);
    const rows = byLane.get(lane) ?? [];
    rows.push(c);
    byLane.set(lane, rows);
  }
  // Lanes in canonical order so iteration never depends on input order.
  const queues = LANES.map((l) => (byLane.get(l.key) ?? []).sort(comparePreviewCandidates)).filter(
    (q) => q.length > 0,
  );

  const picked: T[] = [];
  for (let round = 0; picked.length < count; round += 1) {
    const heads = queues.filter((q) => q.length > round).map((q) => q[round]);
    if (heads.length === 0) break;
    heads.sort(comparePreviewCandidates);
    picked.push(...heads.slice(0, count - picked.length));
  }
  return picked;
}
