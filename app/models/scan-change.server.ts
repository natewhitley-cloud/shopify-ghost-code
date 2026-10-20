import { Prisma, ScanStatus } from "@prisma/client";

import db from "../db.server";
import { CHANGE_SET_VERSION } from "../lib/change-log";
import type {
  ChangeCounts,
  ChangeFootnotes,
  ChangeRow,
  ChangeSetKind,
  CheckKind,
} from "../lib/change-log";

/**
 * Data access for ScanChangeSet (gc-rrh.4): what changed at one check,
 * computed once at scan time by app/services/change-log.server.ts. Rows hold
 * file paths, app names and hostnames only, never code. Cascades Shop -> Scan
 * -> ScanChangeSet, so shop/redact needs no clause of its own.
 */

/** Scan states a change can be computed for (as getPreviousScanForTheme). */
const SUCCESSFUL: ScanStatus[] = [ScanStatus.COMPLETED, ScanStatus.PARTIAL];

/**
 * Everything the change computation reads from one scan (current or
 * baseline): coverage, live set, hooks, signature versions, theme info, the
 * findings (diff fields only), the unknown scripts and the third-party
 * domains. One query. Null when the scan is missing or did not succeed.
 */
export async function getScanForChangeLog(scanId: string) {
  const scan = await db.scan.findUnique({
    where: { id: scanId },
    select: {
      id: true,
      shopId: true,
      themeId: true,
      themeName: true,
      status: true,
      origin: true,
      createdAt: true,
      skippedCategories: true,
      cappedCategories: true,
      unreachableCategories: true,
      skippedFiles: true,
      liveFindingTypes: true,
      walkCoverage: true,
      liveAppHooks: true,
      appSignatureFingerprints: true,
      themeInfo: true,
      shop: { select: { plan: true } },
      findings: {
        select: {
          filename: true,
          lineNumber: true,
          codeSnippet: true,
          findingType: true,
          severity: true,
          appName: true,
          description: true,
        },
      },
      unknownScripts: {
        select: { filename: true, lineNumber: true, url: true, domain: true },
      },
      scanDomains: { select: { domain: true, matched: true, benign: true } },
    },
  });
  if (!scan || !SUCCESSFUL.includes(scan.status)) return null;
  return scan;
}

export type ChangeLogScanRow = NonNullable<Awaited<ReturnType<typeof getScanForChangeLog>>>;

/**
 * The theme of the shop's latest published-theme change set from a scan
 * created before `before` (spec 2.2, theme switch), excluding `excludeScanId`
 * (the current scan, on a recompute). Null when there is none.
 *
 * "Latest" is by the SCAN's createdAt, the same clock as the `before` filter,
 * never the change set's own createdAt (its compute time): a cron scan of
 * theme A that started before the merchant published B but finished after B's
 * scan computed must not sort as the newest published check, or B's next scan
 * would record a false second theme switch.
 */
export async function getLatestPublishedChangeSetBefore(
  shopId: string,
  before: Date,
  excludeScanId: string,
): Promise<{ scanId: string; themeId: string } | null> {
  return db.scanChangeSet.findFirst({
    where: {
      shopId,
      onPublishedTheme: true,
      scanId: { not: excludeScanId },
      scan: { createdAt: { lt: before } },
    },
    orderBy: [{ scan: { createdAt: "desc" } }, { scanId: "desc" }],
    select: { scanId: true, themeId: true },
  });
}

export type ChangeSetWrite = {
  shopId: string;
  themeId: string;
  baselineScanId: string | null;
  kind: ChangeSetKind;
  checkKind: CheckKind;
  onPublishedTheme: boolean;
  themeName: string | null;
  themeVersion: string | null;
  changeCount: number;
  worthALookCount: number;
  checksRan: number;
  counts: ChangeCounts;
  rows: ChangeRow[];
  footnotes: ChangeFootnotes;
};

/**
 * Write the scan's change set. Upserts on the scan id, so an Inngest retry of
 * the compute step rewrites the one row instead of failing on the primary key
 * or adding a second.
 */
export async function upsertScanChangeSet(scanId: string, input: ChangeSetWrite) {
  const data = {
    ...input,
    version: CHANGE_SET_VERSION,
    counts: input.counts as unknown as Prisma.InputJsonValue,
    rows: input.rows as unknown as Prisma.InputJsonValue,
    footnotes: input.footnotes as unknown as Prisma.InputJsonValue,
  };
  return db.scanChangeSet.upsert({
    where: { scanId },
    create: { scanId, ...data },
    update: data,
    select: { scanId: true },
  });
}
