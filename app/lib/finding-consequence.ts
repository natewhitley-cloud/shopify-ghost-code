/**
 * Finding CONSEQUENCE mapping — the single source of truth for the
 * consequence-axis dashboard reframe.
 *
 * Where finding-classification.ts answers "how was this detected / can a shopper
 * see it", this module answers the merchant-facing question: "so what — what
 * does this cost me, and how urgently should I care?" Every FindingType is
 * mapped to a merchant CONSEQUENCE lane, an urgency tier, and whether it matters
 * for AI-agent / LLM discoverability ("agentic").
 *
 * This is the ONE canonical map. Two downstream slices consume it and MUST agree:
 *   - Slice 2 (dashboard lanes): groups findings into lanes, picks lane urgency,
 *     and derives the "start here" / "most of the damage is in X" reads.
 *   - Slice 3 (scan-detail lane filter): the `?lane=` deep-link filter matches
 *     findings whose PRIMARY lane === the requested lane, so lane counts on the
 *     dashboard and the filtered detail view agree exactly.
 *
 * Because both a route loader (server) and client components import it, this
 * module is intentionally PURE and UI-free: no React, no server imports, no
 * `.server.ts` suffix. Rendering (labels aside), colors, and copy live in the
 * consuming components, not here.
 *
 * The lane/urgency/agentic assignments below are grounded in how each type is
 * actually detected (see the detectors in scan-engine.server.ts and the
 * Admin-API detectors). Do not change an assignment without re-grounding it.
 */

import { FindingType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Core keys
// ---------------------------------------------------------------------------

/**
 * A merchant CONSEQUENCE lane — the "so what" bucket a finding falls into.
 * These are merchant-facing groupings, NOT detection categories.
 */
export type LaneKey = "customers-see-it" | "discoverability" | "speed" | "privacy" | "housekeeping";

/**
 * How urgently the merchant should act. Ordered by urgency via URGENCY_RANK
 * (lower rank = more urgent).
 *   - "act-now":      live customer-visible / privacy / performance harm today.
 *   - "compounding":  quietly gets worse over time (SEO/discoverability decay).
 *   - "whenever":     cleanup / hygiene with no live harm; do it when convenient.
 */
export type UrgencyKey = "act-now" | "compounding" | "whenever";

/**
 * Urgency ordering. Lower number = more urgent. Used to pick the most-urgent
 * urgency across a lane's contributing types and to drive the "start here" read.
 */
export const URGENCY_RANK: Record<UrgencyKey, number> = {
  "act-now": 0,
  compounding: 1,
  whenever: 2,
};

// ---------------------------------------------------------------------------
// Lane metadata
// ---------------------------------------------------------------------------

/**
 * Fixed display order + merchant-facing label + a one-line default "so what"
 * template for each lane. Consumers render in this order; `order` is the array
 * index (also surfaced on computeLaneSummary rows for stable sorting).
 *
 * Labels are load-bearing merchant copy — do not edit without design sign-off.
 */
export const LANES: ReadonlyArray<{
  key: LaneKey;
  label: string;
  soWhat: string;
}> = [
  {
    key: "customers-see-it",
    label: "Customers see it",
    soWhat: "Shoppers can see this on your live storefront right now.",
  },
  {
    key: "discoverability",
    label: "Found by Google & AI",
    soWhat: "This shapes how Google and AI assistants read and rank your store.",
  },
  {
    key: "speed",
    label: "Speed",
    soWhat: "This is loading extra code that slows your storefront down.",
  },
  {
    key: "privacy",
    label: "Still tracking you",
    soWhat: "A removed app is still collecting or sending shopper data.",
  },
  {
    key: "housekeeping",
    label: "Housekeeping",
    soWhat: "Leftover clutter with no live impact — clean up when convenient.",
  },
];

// ---------------------------------------------------------------------------
// THE MAPPING — single source of truth
// ---------------------------------------------------------------------------

/**
 * Exhaustive map from every FindingType to its consequence metadata:
 *   - primary:   the lane this finding is counted and filtered under (Slice 3's
 *                `?lane=` deep link matches on primary only).
 *   - secondary: additional lanes the finding also touches, for richer detail
 *                copy. NOT used for counting or filtering.
 *   - urgency:   how soon the merchant should act.
 *   - agentic:   true if this finding affects AI-agent / LLM discoverability of
 *                the store (structured data, canonical/robots, prices, pages…).
 *
 * Typed as `Record<FindingType, ...>` so the TS compiler forces completeness —
 * a new enum member fails to compile until it is mapped here (mirrors the
 * exhaustive Records in severity-classifier.server.ts / finding.server.ts).
 */
export const CONSEQUENCE_MAP: Record<
  FindingType,
  { primary: LaneKey; secondary: LaneKey[]; urgency: UrgencyKey; agentic: boolean }
> = {
  [FindingType.GHOST_SCRIPT]: {
    primary: "speed",
    secondary: ["privacy"],
    urgency: "act-now",
    agentic: false,
  },
  [FindingType.GHOST_STYLE]: {
    primary: "speed",
    secondary: ["customers-see-it"],
    urgency: "act-now",
    agentic: false,
  },
  [FindingType.GHOST_SNIPPET]: {
    primary: "customers-see-it",
    secondary: ["speed"],
    urgency: "act-now",
    agentic: false,
  },
  [FindingType.GHOST_SECTION]: {
    primary: "customers-see-it",
    secondary: [],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_HREFLANG]: {
    primary: "discoverability",
    secondary: [],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.ORPHAN_ASSET]: {
    primary: "housekeeping",
    secondary: ["speed"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.DUPLICATE_META]: {
    primary: "discoverability",
    secondary: [],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_JSON_LD]: {
    primary: "discoverability",
    secondary: [],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_TEXT]: {
    primary: "customers-see-it",
    secondary: [],
    urgency: "act-now",
    agentic: true,
  },
  [FindingType.GHOST_TRANSLATION]: {
    primary: "housekeeping",
    secondary: ["customers-see-it"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.SETTINGS_DRIFT]: {
    primary: "housekeeping",
    secondary: [],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_PIXEL]: {
    primary: "privacy",
    secondary: ["speed"],
    urgency: "act-now",
    agentic: false,
  },
  [FindingType.JSON_LD_CONFLICT]: {
    primary: "discoverability",
    secondary: [],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_LAYOUT]: {
    primary: "customers-see-it",
    secondary: ["housekeeping"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_TAG]: {
    primary: "housekeeping",
    secondary: ["customers-see-it"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_PRICE]: {
    primary: "customers-see-it",
    secondary: ["discoverability"],
    urgency: "act-now",
    agentic: true,
  },
  [FindingType.GHOST_PAGE]: {
    primary: "customers-see-it",
    secondary: ["discoverability"],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_METAFIELD]: {
    primary: "housekeeping",
    secondary: ["customers-see-it"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_REDIRECT]: {
    primary: "discoverability",
    secondary: ["customers-see-it"],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_ROBOTS]: {
    primary: "discoverability",
    secondary: [],
    urgency: "act-now",
    agentic: true,
  },
  [FindingType.GHOST_CANONICAL]: {
    primary: "discoverability",
    secondary: [],
    urgency: "act-now",
    agentic: true,
  },
  [FindingType.GHOST_TITLE]: {
    primary: "discoverability",
    secondary: ["customers-see-it"],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_OG]: {
    primary: "discoverability",
    secondary: ["customers-see-it"],
    urgency: "compounding",
    agentic: true,
  },
  [FindingType.GHOST_PRECONNECT]: {
    primary: "speed",
    secondary: [],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_FONT]: {
    primary: "speed",
    secondary: ["customers-see-it"],
    urgency: "whenever",
    agentic: false,
  },
  [FindingType.GHOST_AJAX]: {
    primary: "speed",
    secondary: ["privacy", "customers-see-it"],
    urgency: "act-now",
    agentic: false,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the PRIMARY consequence lane for a finding type. */
export function laneForType(type: FindingType): LaneKey {
  return CONSEQUENCE_MAP[type].primary;
}

/**
 * All finding types whose PRIMARY lane === `lane`.
 *
 * This defines exactly what the Slice 3 `?lane=` deep-link filter matches:
 * primary-only, so the dashboard lane counts (which also count by primary) and
 * the filtered scan-detail view agree exactly. A type's secondary lanes do NOT
 * make it appear in another lane's filter.
 */
export function typesForLane(lane: LaneKey): FindingType[] {
  return (Object.keys(CONSEQUENCE_MAP) as FindingType[]).filter(
    (type) => CONSEQUENCE_MAP[type].primary === lane,
  );
}

/** A summarized lane row produced by computeLaneSummary. */
export interface LaneSummaryRow {
  lane: LaneKey;
  label: string;
  count: number;
  urgency: UrgencyKey;
  hasAgentic: boolean;
  order: number;
}

/**
 * Rolls per-type finding counts up into per-lane summary rows, grouped by
 * PRIMARY lane.
 *
 * For each lane, across the contributing types with count > 0:
 *   - count:      the summed finding count.
 *   - urgency:    the MOST-URGENT urgency among them (min URGENCY_RANK).
 *   - hasAgentic: true if any contributing type is agentic.
 *
 * Rows are returned in LANES display order (`order` = LANES index).
 *
 * NOTE: zero-count lanes are OMITTED — a lane with no findings produces no row.
 * (Counts for a type not present in `typeCounts`, or present with 0/undefined,
 * do not contribute.) An empty / all-zero input yields an empty array. Callers
 * that want a fixed 5-lane layout should re-project onto LANES themselves.
 */
export function computeLaneSummary(
  typeCounts: Partial<Record<FindingType, number>>,
): LaneSummaryRow[] {
  const rows: LaneSummaryRow[] = [];

  LANES.forEach((laneMeta, order) => {
    let count = 0;
    let urgencyRank = Infinity;
    let hasAgentic = false;

    for (const type of typesForLane(laneMeta.key)) {
      const typeCount = typeCounts[type] ?? 0;
      if (typeCount <= 0) continue;

      const entry = CONSEQUENCE_MAP[type];
      count += typeCount;
      urgencyRank = Math.min(urgencyRank, URGENCY_RANK[entry.urgency]);
      if (entry.agentic) hasAgentic = true;
    }

    if (count <= 0) return; // omit zero-count lanes

    rows.push({
      lane: laneMeta.key,
      label: laneMeta.label,
      count,
      urgency: rankToUrgency(urgencyRank),
      hasAgentic,
      order,
    });
  });

  return rows;
}

/**
 * The lane to guide the merchant to first ("start here"): among lanes with
 * count > 0, the most-urgent one (min URGENCY_RANK), tie-broken by highest
 * count. Returns null when there are no findings.
 */
export function startHereLane(summary: LaneSummaryRow[]): LaneKey | null {
  if (summary.length === 0) return null;

  return summary.reduce((best, row) => {
    const bestRank = URGENCY_RANK[best.urgency];
    const rowRank = URGENCY_RANK[row.urgency];
    if (rowRank < bestRank) return row;
    if (rowRank === bestRank && row.count > best.count) return row;
    return best;
  }).lane;
}

/**
 * The lane holding the most findings ("most of the damage is in X"): highest
 * count, tie-broken by most-urgent urgency (min URGENCY_RANK). Returns null
 * when there are no findings.
 */
export function dominantLane(summary: LaneSummaryRow[]): LaneKey | null {
  if (summary.length === 0) return null;

  return summary.reduce((best, row) => {
    if (row.count > best.count) return row;
    if (row.count === best.count && URGENCY_RANK[row.urgency] < URGENCY_RANK[best.urgency]) {
      return row;
    }
    return best;
  }).lane;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Inverse of URGENCY_RANK — maps a rank back to its UrgencyKey. */
function rankToUrgency(rank: number): UrgencyKey {
  const match = (Object.keys(URGENCY_RANK) as UrgencyKey[]).find(
    (key) => URGENCY_RANK[key] === rank,
  );
  // Every rank produced by computeLaneSummary comes from URGENCY_RANK, so a row
  // with count > 0 always resolves. Fall back to the least-urgent tier defensively.
  return match ?? "whenever";
}
