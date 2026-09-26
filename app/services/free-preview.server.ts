/**
 * Free-tier preview rows (gc-97k.10): the bounded DB read behind the pure
 * freePreviewCount / pickFreePreviewFindings in app/lib/free-preview.ts.
 *
 * Why top-N per lane (and not, say, the top 50 by severity): the picker is a
 * round-robin across consequence lanes that shows at most `count` (<= 5) rows,
 * so it can never take more than `count` rows from any one lane. The top
 * `count` rows of each lane, in the picker's own order, are therefore exactly
 * enough to reproduce the pick over the whole scan, at most 5 lanes x 5 rows
 * however large the scan is. A single global top-50 read would be cheaper by a
 * few queries but can miss a lane entirely (e.g. 50 HIGH Speed findings hide
 * the one Discoverability finding), which breaks one-per-lane. Only lanes the
 * summary says are non-empty are queried.
 *
 * Suppressions (E2.2): an INSTANCE ignore is a computed fingerprint, not a
 * column, so ignored rows cannot be excluded in SQL, and any number of a lane's
 * top rows may be ignored. For a shop WITH ignores the candidates are therefore
 * the scan's full findings filtered in JS. That is the same full read
 * getFilteredFindingSummary already makes for such shops on this page, so it
 * does not change the page's cost class; shops without ignores (the common
 * case) stay on the bounded path.
 */
import type { FindingType } from "@prisma/client";

import { filterIgnoredFindings } from "./finding-aggregation.server";
import { LANES, typesForLane } from "../lib/finding-consequence";
import { freePreviewCount, pickFreePreviewFindings } from "../lib/free-preview";
import { getFindingsForScan, getTopFindingsOfTypes } from "../models/finding.server";
import type { ShopIgnores } from "../models/ignored-finding.server";

/**
 * The Free view's preview rows for a successful scan, best first.
 *
 * `byType` is the page's (ignore-filtered) summary aggregate; the formula's
 * total is its non-malicious sum, so malicious findings never raise the count.
 */
export async function getFreePreviewFindings(
  scanId: string,
  byType: Partial<Record<FindingType, number>>,
  ignores: ShopIgnores,
) {
  const total = (Object.entries(byType) as [FindingType, number][])
    .filter(([type]) => type !== "MALICIOUS_SCRIPT")
    .reduce((sum, [, n]) => sum + n, 0);
  const count = freePreviewCount(total);
  if (count === 0) return [];

  if (ignores.fingerprints.size > 0 || ignores.appNames.size > 0) {
    const { kept } = filterIgnoredFindings(await getFindingsForScan(scanId), ignores);
    return pickFreePreviewFindings(kept, count);
  }

  const lanesWithFindings = LANES.map((l) => typesForLane(l.key)).filter((types) =>
    types.some((t) => t !== "MALICIOUS_SCRIPT" && (byType[t] ?? 0) > 0),
  );
  const perLane = await Promise.all(
    lanesWithFindings.map((types) => getTopFindingsOfTypes(scanId, types, count)),
  );
  return pickFreePreviewFindings(perLane.flat(), count);
}
