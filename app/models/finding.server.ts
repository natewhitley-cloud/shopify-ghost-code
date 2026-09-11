import { FindingType, Severity } from "@prisma/client";

import db from "../db.server";

/**
 * Shape of a finding before it has a DB id.
 * All fields correspond 1:1 with the Finding model — scanId is passed
 * separately to keep the batch API ergonomic.
 */
export type CreateFindingInput = {
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  findingType: FindingType;
  severity: Severity;
  appName?: string;
  description: string;
};

/**
 * A fresh per-severity counter with HIGH/MEDIUM/LOW seeded to 0.
 * The single source of the zeroed severity shape reused by every severity
 * aggregate (getFindingSummary, getSeverityCountsForScans, and the
 * ignore-filtered rollup in finding-aggregation.server).
 */
export function createZeroSeverityCounts(): Record<Severity, number> {
  return {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };
}

/**
 * A fresh exhaustive per-type counter with every FindingType seeded to 0.
 * Typed as `Record<FindingType, number>` so the compiler forces completeness —
 * a new enum member fails to compile until it is added here. The single source
 * of the zeroed type shape reused by getFindingSummary, getTypeCountsForScan,
 * and the ignore-filtered rollup in finding-aggregation.server.
 */
export function createZeroTypeCounts(): Record<FindingType, number> {
  return {
    [FindingType.GHOST_SCRIPT]: 0,
    [FindingType.GHOST_STYLE]: 0,
    [FindingType.GHOST_SNIPPET]: 0,
    [FindingType.GHOST_SECTION]: 0,
    [FindingType.GHOST_HREFLANG]: 0,
    [FindingType.ORPHAN_ASSET]: 0,
    [FindingType.DUPLICATE_META]: 0,
    [FindingType.GHOST_JSON_LD]: 0,
    [FindingType.GHOST_TEXT]: 0,
    [FindingType.GHOST_TRANSLATION]: 0,
    [FindingType.SETTINGS_DRIFT]: 0,
    [FindingType.GHOST_PIXEL]: 0,
    [FindingType.JSON_LD_CONFLICT]: 0,
    [FindingType.JSON_LD_PRICE_CONFLICT]: 0,
    [FindingType.GHOST_LAYOUT]: 0,
    [FindingType.GHOST_TAG]: 0,
    [FindingType.GHOST_PRICE]: 0,
    [FindingType.GHOST_PAGE]: 0,
    [FindingType.GHOST_METAFIELD]: 0,
    [FindingType.GHOST_REDIRECT]: 0,
    [FindingType.GHOST_ROBOTS]: 0,
    [FindingType.GHOST_CANONICAL]: 0,
    [FindingType.GHOST_TITLE]: 0,
    [FindingType.GHOST_OG]: 0,
    [FindingType.GHOST_PRECONNECT]: 0,
    [FindingType.GHOST_FONT]: 0,
    [FindingType.GHOST_AJAX]: 0,
    [FindingType.DUPLICATE_LIBRARY]: 0,
    [FindingType.DANGLING_REFERENCE]: 0,
  };
}

/**
 * Batch-insert findings for a completed scan.
 * Uses createMany for a single round-trip; skipDuplicates is left false
 * because the scan engine should never produce true duplicates within one scan.
 */
export async function createFindings(scanId: string, findings: CreateFindingInput[]) {
  if (findings.length === 0) return { count: 0 };

  return db.finding.createMany({
    data: findings.map((f) => ({ ...f, scanId })),
  });
}

/**
 * Return findings for a scan with optional filtering by severity and/or type.
 * Results are ordered by severity (HIGH first) then filename for consistent display.
 * Returns an empty array (not null) when no findings match.
 */
export async function getFindingsForScan(
  scanId: string,
  filters?: { severity?: Severity; findingType?: FindingType },
) {
  return db.finding.findMany({
    where: {
      scanId,
      ...(filters?.severity !== undefined ? { severity: filters.severity } : {}),
      ...(filters?.findingType !== undefined ? { findingType: filters.findingType } : {}),
    },
    // Prisma sorts enums by declaration order in the schema, not alphabetically.
    // The Severity enum is declared as HIGH, MEDIUM, LOW — so "asc" produces
    // HIGH → MEDIUM → LOW, which is the correct display order (most severe first).
    // If the schema enum order ever changes this sort will silently break; keep
    // the declaration order in sync with this comment.
    orderBy: [{ severity: "asc" }, { filename: "asc" }],
  });
}

/**
 * Summary aggregate for a scan: total count + breakdown by both axes.
 * Executed as two parallel queries to minimise latency.
 */
export async function getFindingSummary(scanId: string) {
  const [bySeverity, byType] = await Promise.all([
    db.finding.groupBy({
      by: ["severity"],
      where: { scanId },
      _count: { severity: true },
    }),
    db.finding.groupBy({
      by: ["findingType"],
      where: { scanId },
      _count: { findingType: true },
    }),
  ]);

  const severityCounts = createZeroSeverityCounts();
  for (const row of bySeverity) {
    severityCounts[row.severity] = row._count.severity;
  }

  const typeCounts = createZeroTypeCounts();
  for (const row of byType) {
    typeCounts[row.findingType] = row._count.findingType;
  }

  const total =
    severityCounts[Severity.HIGH] + severityCounts[Severity.MEDIUM] + severityCounts[Severity.LOW];

  return { total, bySeverity: severityCounts, byType: typeCounts };
}

/**
 * Batch severity counts: return a per-scan severity breakdown for many scans in
 * a SINGLE groupBy query, avoiding the N+1 pattern of calling getFindingSummary
 * once per scan. This is the lean counterpart to getFindingSummary for callers
 * (e.g. the dashboard) that only need the severity axis and never byType.
 *
 * Every requested scanId is guaranteed a fully-populated Record<Severity, number>
 * with HIGH/MEDIUM/LOW defaulted to 0 — including scans that have zero findings.
 *
 * Returns an empty Map (without querying) when scanIds is empty.
 */
export async function getSeverityCountsForScans(
  scanIds: string[],
): Promise<Map<string, Record<Severity, number>>> {
  const result = new Map<string, Record<Severity, number>>();
  if (scanIds.length === 0) return result;

  // Seed every requested scanId with a zeroed record so scans with no findings
  // still appear in the map. Reuses the same zero-map pattern as getFindingSummary.
  for (const scanId of scanIds) {
    result.set(scanId, createZeroSeverityCounts());
  }

  const rows = await db.finding.groupBy({
    by: ["scanId", "severity"],
    where: { scanId: { in: scanIds } },
    _count: { severity: true },
  });

  for (const row of rows) {
    const counts = result.get(row.scanId);
    if (counts) {
      counts[row.severity] = row._count.severity;
    }
  }

  return result;
}

/**
 * Per-type finding counts for a SINGLE scan: return a fully zero-seeded
 * Record<FindingType, number> from one groupBy query. This is the lean,
 * type-axis counterpart to getSeverityCountsForScans for callers (e.g. the
 * dashboard consequence lanes) that need the byType breakdown for exactly one
 * scan and never the severity axis.
 *
 * Every FindingType enum member is guaranteed present, defaulted to 0 — including
 * for a scan with zero findings — so lane-summary callers can index any type
 * without undefined checks. Reuses the same exhaustive zero-map pattern as
 * getFindingSummary (whose severity groupBy the dashboard already has from the
 * batch severity query, so getFindingSummary is deliberately not reused here).
 */
export async function getTypeCountsForScan(scanId: string): Promise<Record<FindingType, number>> {
  const typeCounts = createZeroTypeCounts();

  const rows = await db.finding.groupBy({
    by: ["findingType"],
    where: { scanId },
    _count: { findingType: true },
  });
  for (const row of rows) {
    typeCounts[row.findingType] = row._count.findingType;
  }
  return typeCounts;
}

/**
 * Return the single highest-severity finding for a scan.
 * Uses Prisma enum sort order (HIGH → MEDIUM → LOW declared in schema) so
 * ascending sort gives the highest-severity row first.
 * Returns null when the scan has no findings.
 */
export async function getHighestSeverityFinding(scanId: string) {
  return db.finding.findFirst({
    where: { scanId },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Look up a single finding by id, scoped to a shop via its parent scan.
 *
 * Returns null when the finding does not exist OR belongs to a scan owned by a
 * different shop — the `scan: { shopId }` relation filter enforces tenant
 * isolation, so the caller can trust any non-null result belongs to `shopId`.
 *
 * Selects only the four fields that feed `fingerprintFinding` plus `appName`, so
 * the ignore action (E2.3) can compute the SAME fingerprint E2.2 filters on
 * without trusting a client-sent value.
 */
export async function getFindingByIdForShop(findingId: string, shopId: string) {
  return db.finding.findFirst({
    where: { id: findingId, scan: { shopId } },
    select: {
      id: true,
      filename: true,
      findingType: true,
      codeSnippet: true,
      lineNumber: true,
      appName: true,
    },
  });
}

/**
 * Return a cursor-paginated page of findings for a scan.
 *
 * Ordered by severity (HIGH first, per schema enum declaration order), then
 * filename, then id. The id tiebreaker ensures a stable and unique cursor
 * position even when multiple findings share the same severity + filename.
 *
 * Follows the same limit+1 over-fetch pattern used by getScansForShop so the
 * caller never needs to know the internals of cursor pagination.
 *
 * Type filtering supports two mutually-exclusive params with a precedence rule:
 *   - `findingType`  — a single type; when set it wins.
 *   - `findingTypes` — a set of types (`findingType IN (...)`); used only when
 *     the single `findingType` is unset and the array is non-empty. This backs
 *     the `?lane=` deep link, which maps one lane to multiple finding types.
 * severity and appName are always ANDed independently of the type filter.
 *
 * @returns { items, hasNextPage, nextCursor } where nextCursor is the last
 *   item's id, or null when there is no further page.
 */
export async function getFindingsPageForScan(
  scanId: string,
  options: {
    limit: number;
    cursor?: string;
    severity?: string;
    findingType?: string;
    findingTypes?: FindingType[];
    appName?: string;
  },
): Promise<{
  items: Awaited<ReturnType<typeof db.finding.findMany>>;
  hasNextPage: boolean;
  nextCursor: string | null;
}> {
  const { limit, cursor, severity, findingType, findingTypes, appName } = options;

  const rows = await db.finding.findMany({
    where: {
      scanId,
      ...(severity ? { severity: severity as Severity } : {}),
      // Type precedence: a single findingType wins; else a non-empty findingTypes
      // set is applied as an IN filter; else no type filter at all.
      ...(findingType
        ? { findingType: findingType as FindingType }
        : findingTypes && findingTypes.length > 0
          ? { findingType: { in: findingTypes } }
          : {}),
      ...(appName ? { appName } : {}),
    },
    // Severity enum declared HIGH, MEDIUM, LOW — ascending = HIGH first.
    orderBy: [{ severity: "asc" }, { filename: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor = hasNextPage ? items[items.length - 1].id : null;
  return { items, hasNextPage, nextCursor };
}

/**
 * Return the minimal attribution data needed for the App Impact Map: which app
 * touched which files and which finding types.
 *
 * Only findings with a non-null appName are included (anonymous findings
 * contribute nothing to the attribution map).
 *
 * Selects only the three fields required to build the map — avoids shipping
 * full finding rows (codeSnippet, description, lineNumber, etc.) for a
 * summary-only view.
 */
export async function getAppAttributionForScan(
  scanId: string,
): Promise<Array<{ appName: string; filename: string; findingType: FindingType }>> {
  const rows = await db.finding.findMany({
    where: { scanId, appName: { not: null } },
    select: { appName: true, filename: true, findingType: true },
  });
  // appName is string | null in Prisma; the where clause guarantees non-null
  // but TypeScript doesn't narrow through Prisma's generated type, so we
  // filter once more at the type level.
  return rows.filter(
    (r): r is { appName: string; filename: string; findingType: FindingType } => r.appName !== null,
  );
}

/**
 * Return the distinct filter option values PRESENT in a scan's findings so the
 * findings-table dropdowns only offer values that actually exist:
 *   - `types`: distinct FindingType values, sorted (Prisma enum-declaration order).
 *   - `apps`: distinct non-null appName values, sorted A→Z.
 *
 * Derived from ALL of the scan's findings (unfiltered), so the dropdowns keep
 * offering every value even while an active filter narrows the visible page.
 * Severity options are the fixed HIGH/MEDIUM/LOW set and need no query, so they
 * are intentionally not returned here.
 *
 * A dedicated distinct query per axis is used rather than reusing
 * getAppAttributionForScan: that helper returns one row per attributed finding
 * (not distinct) and omits the type axis, so it would need client-side dedup
 * and a second query anyway.
 */
export async function getFindingFilterOptionsForScan(
  scanId: string,
): Promise<{ types: FindingType[]; apps: string[] }> {
  const [typeRows, appRows] = await Promise.all([
    db.finding.findMany({
      where: { scanId },
      distinct: ["findingType"],
      select: { findingType: true },
      orderBy: { findingType: "asc" },
    }),
    db.finding.findMany({
      where: { scanId, appName: { not: null } },
      distinct: ["appName"],
      select: { appName: true },
      orderBy: { appName: "asc" },
    }),
  ]);

  return {
    types: typeRows.map((r) => r.findingType),
    // appName is string | null in Prisma; the where clause guarantees non-null
    // but TypeScript does not narrow through the generated type.
    apps: appRows.map((r) => r.appName).filter((a): a is string => a !== null),
  };
}

/**
 * Atomically persist the core theme-scan findings for a scan, WITHOUT marking
 * it terminal. The scan deliberately stays IN_PROGRESS so that the optional
 * audit steps (3–8) can still run and a late failure can still mark the scan
 * FAILED. The terminal status (COMPLETED / PARTIAL) is set only after all audit
 * steps finish — see finalizeScan() in scan.server.ts (LOG-4).
 *
 * Why a transaction is required:
 *   The findings write and the findingCount update are two writes. If the
 *   findings are inserted but the count update fails (network blip, DB error),
 *   Inngest will retry the step and the insert will run again — producing
 *   duplicate rows, since the Finding table has no unique constraint per scan.
 *   Wrapping both in $transaction makes the step idempotency boundary identical
 *   to the DB commit boundary: either both writes land or neither does, so a
 *   retry is always safe.
 *
 * Idempotency guard:
 *   A deleteMany is issued before createMany so that Inngest retries are safe.
 *   If the step commits but Inngest doesn't acknowledge the result, the retry
 *   will delete any previously-created findings and re-insert them, producing
 *   the same final state instead of duplicates. This step runs before any audit
 *   step, so clearing all findings for the scan can never wipe audit findings.
 */
export async function saveThemeFindings(scanId: string, findings: CreateFindingInput[]) {
  return db.$transaction(async (tx) => {
    // Idempotency guard: clear any findings from a previous partial attempt.
    await tx.finding.deleteMany({ where: { scanId } });

    if (findings.length > 0) {
      await tx.finding.createMany({
        data: findings.map((f) => ({ ...f, scanId })),
      });
    }

    // Keep findingCount accurate for in-progress display, but do NOT set a
    // terminal status here — the scan stays IN_PROGRESS until finalizeScan().
    await tx.scan.update({
      where: { id: scanId },
      data: { findingCount: findings.length },
    });
  });
}
