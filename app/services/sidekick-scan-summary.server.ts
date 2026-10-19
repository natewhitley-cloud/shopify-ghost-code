/**
 * Sidekick data extension (gc-5nok): the read-only summary of a shop's latest
 * successful scan, behind GET /api/sidekick/latest-scan
 * (extensions/sidekick-tools). Reused from the spike (spike/sidekick-extension,
 * c5892d1) and brought up to current main.
 *
 * Plan safety: this MIRRORS Home's call path and adds no ranking or gating of
 * its own.
 *   - Counts (total, byImpact) are the ignore-filtered summary every plan sees
 *     on Home: the total and the consequence lanes ("Customers see it",
 *     "Found by Google & AI", "Speed", ...), from the same computeLaneSummary.
 *     Impact areas, not severity: the app leads with what a finding costs.
 *   - Top findings are Home's "Start here" rows: getFullListTopFindings
 *     (`showFindingDetails`: Standard / Professional) or getFreeTopFindings
 *     (Free: only its preview rows plus the never-paywalled findings, all
 *     shown in full to a Free shop), then toTopFindingViews with Home's
 *     advisoryStartHereCopy (an advisory names its app and its report).
 *   - Known malicious code is listed IN FULL on EVERY plan and regardless of
 *     ignores, exactly as the scan page's security alert lists it (and its
 *     count is what the scan FOUND, as Home's critical line counts it).
 *     Security findings are never paywalled.
 *   - Theme health is Home's checklist (loadThemeHealth + maliciousHealthRow
 *     + groupHealthRows + themeHealthVerdict): the same verdict sentence, the
 *     clean checks and the checks that did not fully run. Counts and fixed
 *     copy only, the same on every plan. No score.
 *   - Allow-listed fields only: never codeSnippet (merchant theme source, and
 *     it would blow Sidekick's 4,000-token response limit), never ids beyond
 *     the scan link, never hrefs.
 */
import type { FindingType } from "@prisma/client";

import { getFilteredFindingSummaryAndKept } from "./finding-aggregation.server";
import { advisoryStartHereCopy } from "./security-risk.server";
import { getCachedAllThemes, getCachedMainTheme } from "./theme-cache.server";
import { loadThemeHealth } from "./theme-health.server";
import { getFreeTopFindings, getFullListTopFindings } from "./top-findings.server";
import { getPlanFeatures } from "../lib/billing.server";
import { computeLaneSummary, laneLabelForLane, soWhatForLane } from "../lib/finding-consequence";
import { buildFindingsTile } from "../lib/findings-tile";
import { isSuccessfulScan } from "../lib/format";
import { findingTypesWithheldByPlan } from "../lib/plan-finding-types";
import {
  groupGapsByReason,
  groupHealthRows,
  maliciousHealthRow,
  themeHealthVerdict,
} from "../lib/theme-health";
import { findingLocation, toTopFindingViews } from "../lib/top-findings";
import { getTopFindingsInGroup, getTypeCountsForScan } from "../models/finding.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { getCompletedScansForShop, getScanById, getScansForShop } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import type { AdminApiContext } from "../types/shopify";

/** One consequence lane with findings: its label, count and one-line "so what". */
export type SidekickImpactArea = { area: string; count: number; meaning: string };

export type SidekickTopFinding = {
  type: string;
  /** The finding's impact area (e.g. "Speed"), or "Security advisory". */
  impact: string;
  app: string | null;
  location: string;
  description: string;
};

export type SidekickMaliciousFinding = {
  location: string;
  app: string | null;
  description: string;
};

export type SidekickThemeHealth = {
  /** Home's one-sentence verdict. Never a score. */
  verdict: string;
  /** Checks that ran in full and found nothing. */
  cleanChecks: string[];
  /** Checks that did not (fully) run, grouped by the reason. */
  checksNotFullyRun: { checks: string[]; reason: string | null }[];
  /** The theme type and version row ("Online Store 2.0: Dawn 15.2.0 by Shopify"). */
  theme: string | null;
  /** The theme library line (how many themes, unpublished themes' last findings). */
  unpublishedThemes: string | null;
};

export type SidekickScanSummary =
  | { status: "no_data"; message: string }
  | {
      status: "ok";
      scanDate: string;
      themeName: string;
      totalFindings: number;
      /** Impact areas that have findings, in the app's display order. */
      byImpact: SidekickImpactArea[];
      /** Affected-app security advisories (in no impact area). */
      appSecurityAdvisories: number;
      /** Home's "Start here" findings (at most 3). */
      topFindings: SidekickTopFinding[];
      /** Known malicious code: shown in full on every plan. */
      maliciousCode: {
        found: number;
        findings: SidekickMaliciousFinding[];
        /** True when more were found than are listed here. */
        moreNotListed: boolean;
      };
      /** Null when the checklist could not be built for this scan. */
      themeHealth: SidekickThemeHealth | null;
      /** True when a newer scan is running and this summary is from the one before it. */
      newerScanInProgress: boolean;
      /** Deep link to the scan in the app (`app://` scheme, resolved by Shopify admin). */
      url: string;
    };

/** Malicious findings listed in one response (keeps it far below 4,000 tokens). */
export const MAX_MALICIOUS_LISTED = 10;

export const NO_SCANS_MESSAGE = "No GhostCode scan has been run for this store yet.";
export const FIRST_SCAN_RUNNING_MESSAGE =
  "The first GhostCode scan for this store is still running.";
export const NO_COMPLETED_SCAN_MESSAGE = "No GhostCode scan has completed for this store yet.";

/**
 * Home names the plans that run a check in full ("Checked in full on Standard
 * and Professional."). A Sidekick answer must not read as a plan pitch (App
 * Store rules 2.2.8 / 2.2.9), so such a reason is replaced by this one.
 */
export const PLAN_GAP_REASON = "Not included in the current plan.";
const PLAN_NAME = /\b(?:Standard|Professional)\b/;

/** The verdict when Home's critical malicious line shows (that line IS the verdict). */
export const MALICIOUS_VERDICT = "Known malicious code was found in this theme.";

async function readScan(shopId: string) {
  const [latest, completed] = await Promise.all([
    getScansForShop(shopId, { limit: 1 }),
    getCompletedScansForShop(shopId, { limit: 1 }),
  ]);
  const latestScan = latest.items[0] ?? null;
  const completedRef = completed[0] ?? null;
  // The latest row already is the full scan when it is the latest successful one.
  const scan =
    completedRef === null
      ? null
      : latestScan && latestScan.id === completedRef.id
        ? latestScan
        : await getScanById(completedRef.id, { includeFindings: false });
  return { latestScan, scan };
}

export async function getSidekickScanSummary(
  admin: AdminApiContext,
  shopDomain: string,
): Promise<SidekickScanSummary> {
  const shop = await getShopMetadata(shopDomain);
  if (!shop) return { status: "no_data", message: NO_SCANS_MESSAGE };

  const { latestScan, scan } = await readScan(shop.id);
  if (!latestScan) return { status: "no_data", message: NO_SCANS_MESSAGE };
  const latestIsRunning = latestScan.status === "PENDING" || latestScan.status === "IN_PROGRESS";
  if (!scan || !scan.completedAt || !isSuccessfulScan(scan.status)) {
    return {
      status: "no_data",
      message: latestIsRunning ? FIRST_SCAN_RUNNING_MESSAGE : NO_COMPLETED_SCAN_MESSAGE,
    };
  }

  const features = getPlanFeatures(shop.plan);
  const fullList = Boolean(features.showFindingDetails);
  const [ignores, foundTypeCounts] = await Promise.all([
    getIgnoredFindingsForShop(shop.id),
    getTypeCountsForScan(scan.id),
  ]);
  const { summary, keptFindings } = await getFilteredFindingSummaryAndKept(scan.id, ignores);

  // Malicious: what the scan FOUND (ignored included), as Home and the scan
  // page's security alert count and list it.
  const maliciousFound = foundTypeCounts.MALICIOUS_SCRIPT ?? 0;
  const [topFindingRows, maliciousRows] = await Promise.all([
    fullList
      ? getFullListTopFindings(scan.id, keptFindings)
      : getFreeTopFindings(
          scan.id,
          summary.byType,
          keptFindings,
          findingTypesWithheldByPlan(features),
        ),
    // Bounded: a compromised theme can hold thousands of hits.
    maliciousFound > 0
      ? getTopFindingsInGroup(scan.id, "MALICIOUS_SCRIPT", null, MAX_MALICIOUS_LISTED)
      : Promise.resolve([]),
  ]);

  // gc-q5z8, as Home passes it: an advisory row names its app and the entry's
  // own wording. A stored advisory has no appName, so the entry supplies it.
  const advisoryCopy = advisoryStartHereCopy(topFindingRows);

  const themeHealth = await readThemeHealth(admin, shopDomain, shop, scan, {
    ...summary.byType,
    MALICIOUS_SCRIPT: maliciousFound,
  });

  return {
    status: "ok",
    scanDate: scan.completedAt.toISOString(),
    themeName: scan.themeName,
    // Home's findings tile: ignored malicious findings are added back.
    totalFindings: buildFindingsTile({
      filteredTotal: summary.total,
      maliciousFound,
      maliciousKept: summary.byType.MALICIOUS_SCRIPT ?? 0,
    }).total,
    byImpact: computeLaneSummary(summary.byType).map((row) => ({
      area: row.label,
      count: row.count,
      meaning: soWhatForLane(row.lane),
    })),
    appSecurityAdvisories: summary.byType.APP_INCIDENT_ADVISORY ?? 0,
    topFindings: toTopFindingViews(scan.id, topFindingRows, fullList, advisoryCopy).map((f) => ({
      type: f.title ?? f.typeLabel,
      impact: f.lane ? laneLabelForLane(f.lane) : "Security advisory",
      app: f.appName ?? advisoryCopy[f.id]?.appName ?? null,
      location: f.location,
      description: f.cost,
    })),
    maliciousCode: {
      found: maliciousFound,
      findings: maliciousRows.map((f) => ({
        location: findingLocation(f),
        app: f.appName,
        description: f.description,
      })),
      moreNotListed: maliciousFound > maliciousRows.length,
    },
    themeHealth,
    newerScanInProgress: latestIsRunning && latestScan.id !== scan.id,
    url: `app://app/scans/${scan.id}`,
  };
}

type ScanRow = NonNullable<Awaited<ReturnType<typeof getScanById>>>;

/**
 * Home's theme health section as data. Theme reads go through Home's 60s
 * cache; a failed read only drops that detail (loadThemeHealth never throws).
 */
async function readThemeHealth(
  admin: AdminApiContext,
  shopDomain: string,
  shop: { id: string; plan: string },
  scan: ScanRow,
  typeCounts: Partial<Record<FindingType, number>>,
): Promise<SidekickThemeHealth | null> {
  const [mainTheme, themes] = await Promise.all([
    getCachedMainTheme(admin, shopDomain).catch(() => null),
    getCachedAllThemes(admin, shopDomain).catch(() => null),
  ]);
  const rows = await loadThemeHealth({
    shop,
    scan,
    typeCounts,
    mainThemeId: mainTheme?.id ?? null,
    themes,
    now: new Date(),
  });
  const malicious = maliciousHealthRow(scan.id, typeCounts.MALICIOUS_SCRIPT ?? 0);
  if (rows.length === 0 && !malicious) return null;

  const groups = groupHealthRows(rows, malicious);
  const verdict = themeHealthVerdict(groups);
  return {
    verdict: verdict?.text ?? MALICIOUS_VERDICT,
    cleanChecks: groups.clean.map((row) => row.label),
    checksNotFullyRun: groupGapsByReason(groups.gaps).map(({ labels, reason }) => ({
      checks: labels,
      reason: reason !== null && PLAN_NAME.test(reason) ? PLAN_GAP_REASON : reason,
    })),
    theme: groups.theme
      ? [groups.theme.statusLabel, groups.theme.detail].filter(Boolean).join(": ")
      : null,
    unpublishedThemes: groups.unpublished?.detail ?? null,
  };
}
