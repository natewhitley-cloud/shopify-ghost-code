/**
 * Free-tier preview rows (gc-97k.10): the bounded DB read behind the pure
 * freePreviewCount / pickFreePreviewFindings in app/lib/free-preview.ts.
 *
 * Why top-N per (lane, urgency) bucket (and not, say, the top 50 by
 * severity): the picker is a round-robin across consequence lanes that shows
 * at most `count` (<= 5) rows, so it can never take more than `count` rows from
 * any one lane, and those are the lane's best `count` by the shared importance
 * ranking (severity, urgency, lane, createdAt, id; gc-bn0x). Inside one
 * (lane, urgency) bucket that ranking is exactly the DB order (severity,
 * createdAt, id), so the top `count` rows of each bucket contain every row the
 * pick can use. That is at most 9 buckets x 5 rows however large the scan is
 * (one query per bucket with findings; per lane alone is no longer enough,
 * because a lane's more urgent type must not lose to an older, less urgent
 * one). A single global top-50 read would be cheaper by a few queries but can
 * miss a lane entirely (e.g. 50 HIGH Speed findings hide the one
 * Discoverability finding), which breaks one-per-lane. Only buckets the
 * summary says are non-empty are queried.
 *
 * Suppressions (E2.2): an INSTANCE ignore is a computed fingerprint, not a
 * column, so ignored rows cannot be excluded in SQL, and any number of a lane's
 * top rows may be ignored. For a shop WITH ignores the candidates are therefore
 * the scan's full non-ignored findings, which the page's summary read already
 * loaded (getFilteredFindingSummaryAndKept): the caller passes them in, so the
 * scan's findings are never read twice (audit 1 #7). Shops without ignores
 * (the common case) stay on the bounded path.
 */
import type { FindingType } from "@prisma/client";

import type { FindingRow } from "./finding-aggregation.server";
import { CONSEQUENCE_MAP } from "../lib/finding-consequence";
import { freePreviewCount, pickFreePreviewFindings } from "../lib/free-preview";
import { getTopFindingsOfTypes } from "../models/finding.server";

/**
 * Non-malicious finding types grouped by (primary lane, urgency): the unit of
 * the bounded read (see the file header). Derived from CONSEQUENCE_MAP, so a
 * remapped type moves buckets on its own.
 */
export const PREVIEW_READ_BUCKETS: FindingType[][] = (() => {
  const buckets = new Map<string, FindingType[]>();
  for (const type of Object.keys(CONSEQUENCE_MAP) as FindingType[]) {
    if (type === "MALICIOUS_SCRIPT") continue;
    const { primary, urgency } = CONSEQUENCE_MAP[type];
    const key = `${primary}|${urgency}`;
    buckets.set(key, [...(buckets.get(key) ?? []), type]);
  }
  return [...buckets.values()];
})();

/**
 * The Free view's preview rows for a successful scan, best first.
 *
 * `byType` is the page's (ignore-filtered) summary aggregate; the formula's
 * total is its non-malicious sum, so malicious findings never raise the count.
 *
 * `keptFindings` is the `keptFindings` of getFilteredFindingSummaryAndKept:
 * the scan's non-ignored findings when the shop HAS ignores (picked from
 * directly, no query), or null when it has none (the bounded per-lane read).
 *
 * `withheld` is findingTypesWithheldByPlan for the shop's CURRENT plan: types
 * the plan may not see in full (a downgraded shop's old Broken links or
 * checkout-sunset findings). They are never picked, but they stay in the
 * formula's total and in the teaser as locked findings, so the counts do not
 * change. A scan whose only findings are withheld can therefore return no
 * rows; the scan page then shows the teaser without a preview table.
 */
export async function getFreePreviewFindings(
  scanId: string,
  byType: Partial<Record<FindingType, number>>,
  keptFindings: readonly FindingRow[] | null,
  withheld: readonly FindingType[],
) {
  const total = (Object.entries(byType) as [FindingType, number][])
    .filter(([type]) => type !== "MALICIOUS_SCRIPT")
    .reduce((sum, [, n]) => sum + n, 0);
  const count = freePreviewCount(total);
  if (count === 0) return [];

  const visible = (type: FindingType) => !withheld.includes(type);

  if (keptFindings !== null) {
    return pickFreePreviewFindings(
      keptFindings.filter((f) => visible(f.findingType)),
      count,
    );
  }

  const bucketsWithFindings = PREVIEW_READ_BUCKETS.map((types) => types.filter(visible)).filter(
    (types) => types.some((t) => (byType[t] ?? 0) > 0),
  );
  const perBucket = await Promise.all(
    bucketsWithFindings.map((types) => getTopFindingsOfTypes(scanId, types, count)),
  );
  return pickFreePreviewFindings(perBucket.flat(), count);
}
