/**
 * Theme health checklist for Home (gc-i6du): gathers what the pure builder
 * (app/lib/theme-health.ts) needs for the latest successful scan.
 *
 * Cost per Home load, and only for a successful latest scan (never on the 3s
 * poll while a scan runs): one small read of the unpublished themes' latest
 * scans, only when the store has unpublished themes. Everything else comes
 * from data the loader already holds. No speed-report data is read here: Home
 * stays decoupled from it (tests/integration/speed-report-decoupling).
 * Never throws: a failed lookup drops that one detail and the rest renders;
 * any other failure yields no rows (and a warning), never an error.
 */

import { FindingType } from "@prisma/client";

import { parseLiveFindingTypes } from "./scan-differ.server";
import { SCRIPT_TAG_SUNSET_AT_MS } from "./script-tag-sunset-detector.server";
import { isSoftLaunchLive } from "./soft-launch-flags.server";
import type { ThemeSummary } from "./theme-fetcher.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { findingTypesWithheldByPlan } from "../lib/plan-finding-types";
import { safeErrorFields } from "../lib/safe-error";
import {
  advisoryHealthRow,
  buildThemeHealthChecklist,
  type HealthRow,
  type ThemeInventoryItem,
} from "../lib/theme-health";
import { parseThemeInfo } from "../lib/theme-info";
import { getLatestScanFindingCountsByTheme } from "../models/scan.server";

/** The scan columns the checklist reads. */
export interface ThemeHealthScan {
  id: string;
  themeId: string;
  themeName: string;
  skippedCategories: readonly string[];
  cappedCategories: readonly string[];
  unreachableCategories: readonly string[];
  liveFindingTypes: unknown;
  themeInfo: unknown;
}

const LOG_FN = "theme-health";

/** What loadThemeHealth needs for one scan. */
export type LoadThemeHealthInput = {
  shop: { id: string; plan: string };
  scan: ThemeHealthScan;
  /**
   * The scan's (ignore-filtered) finding counts per type. MALICIOUS_SCRIPT is
   * the exception: pass what the scan found, ignored findings included.
   */
  typeCounts: Partial<Record<FindingType, number>>;
  /** The published theme's id; null = not known. */
  mainThemeId: string | null;
  /** The store's themes; null = the list was not available. */
  themes: readonly ThemeSummary[] | null;
  now: Date;
};

/**
 * The checklist rows for Home. NEVER throws: any failure is logged by error
 * name and yields no rows.
 */
export async function loadThemeHealth(input: LoadThemeHealthInput): Promise<HealthRow[]> {
  try {
    return await buildRows(input);
  } catch (err) {
    // The checklist is an extra on Home: a bug in it (a malformed stored
    // value, a builder error) must never 500 the page. No rows = no section.
    logger.warn("theme health: checklist unavailable", {
      function: LOG_FN,
      shopId: input.shop.id,
      ...safeErrorFields(err),
    });
    return [];
  }
}

async function buildRows(input: LoadThemeHealthInput): Promise<HealthRow[]> {
  const { shop, scan, typeCounts } = input;
  const features = getPlanFeatures(shop.plan);

  let inventory: ThemeInventoryItem[] | null = null;
  if (input.themes !== null) {
    const unpublishedIds = input.themes
      .filter((t) => t.role !== "MAIN" && t.role !== "DEVELOPMENT")
      .map((t) => t.id);
    let counts = new Map<string, number>();
    try {
      counts = await getLatestScanFindingCountsByTheme(shop.id, unpublishedIds);
    } catch (err) {
      logger.warn("theme health: unpublished theme scans unavailable", {
        function: LOG_FN,
        shopId: shop.id,
        ...safeErrorFields(err),
      });
    }
    inventory = input.themes.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      lastScanFindingCount: t.role === "MAIN" ? null : (counts.get(t.id) ?? null),
    }));
  }

  const coverage = {
    skippedCategories: scan.skippedCategories,
    cappedCategories: scan.cappedCategories,
    unreachableCategories: scan.unreachableCategories,
    liveTypes: parseLiveFindingTypes(scan.liveFindingTypes),
    liveNow: new Set<string>(Object.values(FindingType).filter(isSoftLaunchLive)),
    planWithheld: findingTypesWithheldByPlan(features),
    isPublishedTheme: input.mainThemeId === null ? null : scan.themeId === input.mainThemeId,
  };
  const rows = buildThemeHealthChecklist({
    scanId: scan.id,
    typeCounts,
    coverage,
    fullList: Boolean(features.showFindingDetails),
    themeInfo: parseThemeInfo(scan.themeInfo),
    scanThemeName: scan.themeName,
    themes: inventory,
    scriptTagsStopped: input.now.getTime() >= SCRIPT_TAG_SUNSET_AT_MS,
  });
  // The "App security advisories" check (gc-q5z8), from the ignore-filtered
  // advisory count: an advisory honours ignores.
  const advisory = advisoryHealthRow(scan.id, typeCounts.APP_INCIDENT_ADVISORY ?? 0, coverage);
  return advisory ? [...rows, advisory] : rows;
}
