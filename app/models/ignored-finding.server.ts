/**
 * Ignored-finding model (E2 false-positive suppression, gc-bn7).
 *
 * Data-access layer for the `IgnoredFinding` table. A merchant suppresses a
 * finding they've judged a false positive at one of two granularities:
 *
 *   - INSTANCE: one specific finding, keyed by `(shopId, fingerprint)`. The
 *     fingerprint is the stable hex string from `fingerprintFinding` in
 *     scan-differ.server.ts — the SAME identity the diff engine uses, so the
 *     suppression survives re-scans as long as the finding's identity does.
 *   - APP: every finding attributed to an app, keyed by `(shopId, appName)`
 *     (maps to `Finding.appName`). This is the M2 bulk-suppression mechanism.
 *
 * Suppression is additive and reversible: deleting a row un-ignores. No
 * aggregation/filtering logic lives here — E2.2 calls getIgnoredFindingsForShop
 * (its single choke point) and filters a scan's findings itself.
 *
 * Available to all plans (E2 is not plan-gated).
 */

import { IgnoreScope } from "@prisma/client";
import type { IgnoredFinding } from "@prisma/client";

import db from "../db.server";

/**
 * Everything E2.2 needs to filter a shop's scan findings in one pass:
 *   - `fingerprints`: INSTANCE-scoped fingerprints to drop (match against
 *     fingerprintFinding(...) of each finding).
 *   - `appNames`: APP-scoped app names to drop (match against Finding.appName).
 */
export interface ShopIgnores {
  fingerprints: Set<string>;
  appNames: Set<string>;
}

/**
 * Suppress a single finding for a shop (INSTANCE scope).
 *
 * `fingerprint` MUST be produced by fingerprintFinding(filename, findingType,
 * codeSnippet, lineNumber) so it matches the diff engine's identity. Idempotent:
 * a repeat ignore of the same (shopId, fingerprint) refreshes `reason` rather
 * than throwing on the unique constraint.
 */
export async function ignoreFindingInstance(input: {
  shopId: string;
  fingerprint: string;
  reason?: string;
}) {
  const { shopId, fingerprint, reason } = input;
  return db.ignoredFinding.upsert({
    where: { shopId_fingerprint: { shopId, fingerprint } },
    create: { shopId, fingerprint, reason: reason ?? null, scope: IgnoreScope.INSTANCE },
    update: { reason: reason ?? null },
  });
}

/**
 * Bulk-suppress every finding attributed to an app for a shop (APP scope).
 *
 * `appName` maps to Finding.appName. Idempotent: a repeat ignore of the same
 * (shopId, appName) refreshes `reason` rather than throwing.
 */
export async function ignoreFindingApp(input: {
  shopId: string;
  appName: string;
  reason?: string;
}) {
  const { shopId, appName, reason } = input;
  return db.ignoredFinding.upsert({
    where: { shopId_appName: { shopId, appName } },
    create: { shopId, appName, reason: reason ?? null, scope: IgnoreScope.APP },
    update: { reason: reason ?? null },
  });
}

/**
 * Un-ignore: delete a suppression row by id. Returns the deleted row.
 */
export async function deleteIgnoredFinding(id: string) {
  return db.ignoredFinding.delete({ where: { id } });
}

/**
 * Tenant-safe un-ignore: delete a suppression row ONLY if it belongs to the
 * given shop. Uses deleteMany with a compound `(id, shopId)` where so a merchant
 * can never remove another shop's suppression by guessing an id — a foreign id
 * matches nothing and returns `{ count: 0 }`. This is the delete the management
 * route action calls; `deleteIgnoredFinding` (id-only) stays for internal use.
 */
export async function deleteIgnoredFindingForShop(
  id: string,
  shopId: string,
): Promise<{ count: number }> {
  return db.ignoredFinding.deleteMany({ where: { id, shopId } });
}

/**
 * Full suppression rows for a shop's management view (E2.3): every ignore the
 * shop has created, newest first. Unlike getIgnoredFindingsForShop (which
 * returns only the two key SETS the aggregation choke point needs), this returns
 * the whole rows — id (for un-ignore), scope, fingerprint/appName, reason, and
 * createdAt — so the UI can list each suppression and offer a per-row un-ignore.
 *
 * APP-scoped rows are returned even when the shop currently has zero findings
 * from that app: a suppression is a standing rule, not a per-finding flag, so it
 * must remain visible and removable regardless of the latest scan's contents.
 */
export async function listIgnoredFindings(shopId: string): Promise<IgnoredFinding[]> {
  return db.ignoredFinding.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Combined read for the aggregation choke point (E2.2): return the set of
 * ignored fingerprints AND the set of ignored app names for a shop in ONE query.
 *
 * A row contributes to exactly one set based on which key column is non-null
 * (INSTANCE rows carry fingerprint, APP rows carry appName), so `scope` is not
 * needed at read time. Returns empty sets when the shop has no suppressions.
 */
export async function getIgnoredFindingsForShop(shopId: string): Promise<ShopIgnores> {
  const rows = await db.ignoredFinding.findMany({
    where: { shopId },
    select: { fingerprint: true, appName: true },
  });

  const fingerprints = new Set<string>();
  const appNames = new Set<string>();
  for (const row of rows) {
    if (row.fingerprint !== null) fingerprints.add(row.fingerprint);
    if (row.appName !== null) appNames.add(row.appName);
  }
  return { fingerprints, appNames };
}
