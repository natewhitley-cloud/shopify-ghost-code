import { FindingType, ScanOrigin, Severity } from "@prisma/client";
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import { AppRemovalBanner } from "../components/AppRemovalBanner";
import { FormattedDate } from "../components/FormattedDate";
import {
  HealthScoreTrendChart,
  HealthScoreTrendEmptyState,
} from "../components/HealthScoreTrendChart";
import type { HealthScoreTrend, TrendScoreEntry } from "../components/HealthScoreTrendChart";
import { ScanProgress } from "../components/ScanProgress";
import { SecurityRiskBanner } from "../components/SecurityRiskBanner";
import { ThemeHealthChecklist } from "../components/ThemeHealthChecklist";
import { TopFindings } from "../components/TopFindings";
import { buildRemovalNotice } from "../lib/app-removal-notice";
import type { RemovalNotice } from "../lib/app-removal-notice";
import { getPlanFeatures } from "../lib/billing.server";
import { FEEDBACK_NUDGE_COPY, FEEDBACK_NUDGE_HREF } from "../lib/feedback-nudge";
import {
  computeLaneSummary,
  dominantLane,
  dominantPhraseForLane,
  soWhatForLane,
  startHereLane,
} from "../lib/finding-consequence";
import type { LaneKey, LaneSummaryRow, UrgencyKey } from "../lib/finding-consequence";
import { buildFindingsTile, type FindingsTile } from "../lib/findings-tile";
import { isSuccessfulScan } from "../lib/format";
import { logger } from "../lib/logger.server";
import { mergeSearchParams } from "../lib/merge-search-params";
import { findingTypesWithheldByPlan } from "../lib/plan-finding-types";
import {
  canStartScan,
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
} from "../lib/plan-gating.server";
import { PLANS } from "../lib/plans";
import { HOME_DEFERRED_PROMPTS, HOME_PROMPTS, promptClaimNeeded } from "../lib/prompt-cap";
import { safeErrorFields } from "../lib/safe-error";
import { getNextScanPeriodStart, getScanQuotaPeriod } from "../lib/scan-quota";
import type { ScanQuotaPeriod } from "../lib/scan-quota";
import { homeScanStartPayload, parseScanSource } from "../lib/scan-source";
import {
  findingsTileSubtitle,
  homeRiskSummaryLine,
  securityRiskAnchorId,
  securityRiskSourceWords,
  type SecurityRisk,
  type SecurityRiskSource,
} from "../lib/security-risk";
import { isScanStaleAfterThemeChange } from "../lib/stale-results";
import {
  SUMMARY_NOTICE_DISMISS,
  SUMMARY_NOTICE_HEADING,
  SUMMARY_OPTIN_ACCEPT,
  SUMMARY_OPTIN_DECLINE,
  SUMMARY_OPTIN_FAILED_LEAD,
  SUMMARY_OPTIN_HEADING,
  SUMMARY_OPTIN_SUCCESS_LEAD,
  summaryNoticeLead,
  summaryOptInBody,
} from "../lib/summary-email-copy";
import { maliciousHealthRow } from "../lib/theme-health";
import type { HealthRow } from "../lib/theme-health";
import { toTopFindingViews } from "../lib/top-findings";
import type { TopFindingView } from "../lib/top-findings";
import { useOptionalScopes } from "../lib/use-optional-scopes";
import type { ScopeRequestOutcome } from "../lib/use-optional-scopes";
import { HOME_POLL_TIMEOUT_MESSAGE, useScanPolling } from "../lib/use-scan-polling";
import { getRemovalNoticeRows } from "../models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../models/finding.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { dismissSummaryNotice } from "../models/merchant-alert.server";
import {
  getScanById,
  getScansForShop,
  hasCompletedScans,
  getCompletedScansForShop,
} from "../models/scan.server";
import type { ScanQuota } from "../models/scan.server";
import {
  dismissRemovalNotice,
  getOrCreateShopMetadata,
  getShopMetadata,
} from "../models/shop.server";
import { getFilteredFindingSummaryAndKept } from "../services/finding-aggregation.server";
import type { FindingRow } from "../services/finding-aggregation.server";
import {
  recordJourneyMilestoneOnce,
  recordScanResultsViewOnce,
} from "../services/journey-milestone.server";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { loadShopPromptState, resolvePrompt } from "../services/prompt-cap.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { dispatchScan } from "../services/scan-dispatch.server";
import { advisoryStartHereCopy, loadHomeSecurityRisks } from "../services/security-risk.server";
import { areStoredAdvisoriesShown } from "../services/soft-launch-flags.server";
import { claimSummaryNoticeForHome } from "../services/summary-notice.server";
import type { SummaryNotice } from "../services/summary-notice.server";
import {
  acceptSummaryOptIn,
  declineSummaryOptInForHome,
  summaryOptInForHome,
} from "../services/summary-optin.server";
import type { SummaryOptInPrompt } from "../services/summary-optin.server";
import { getCachedAllThemes, getCachedMainTheme } from "../services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../services/theme-fetcher.server";
import type { ThemeSummary } from "../services/theme-fetcher.server";
import { loadThemeHealth } from "../services/theme-health.server";
import { getFreeTopFindings, getFullListTopFindings } from "../services/top-findings.server";
import { authenticate } from "../shopify.server";
import { LANE_COLOR } from "../styles/lane-colors";
import {
  ACCENT_BORDER,
  ACCENT_FILL,
  ACCENT_INK,
  ACCENT_TINT,
  BG_BADGE_SUCCESS,
  BG_SURFACE,
  BG_SURFACE_ALT,
  BG_WHITE,
  BORDER_DEFAULT,
  BORDER_STRONG,
  COLOR_CRITICAL,
  COLOR_INFO,
  COLOR_SUCCESS,
  COLOR_WARNING,
  CRIT_BD,
  groundStyle,
  hairline,
  INFO_FOCUS_RING,
  sectionCard,
  TEXT_DISABLED,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  tileStatusTintCss,
  WARN_BD,
  WARN_TEXT,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** The finding types behind Home's Security risk banners (gc-q5z8). */
const HOME_SECURITY_TYPES: readonly FindingType[] = [
  FindingType.MALICIOUS_SCRIPT,
  FindingType.APP_INCIDENT_ADVISORY,
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // gc-bj4: get-or-create, NOT a plain read. The parent app.tsx loader creates
  // the Shop row on first visit, but React Router runs it IN PARALLEL with this
  // loader, so on the first post-install load a plain read could miss the row
  // and hide the onboarding card. Ensuring the row here closes that race.
  const shop = await getOrCreateShopMetadata(session.shop);

  const trendChartEnabled = process.env.ENABLE_TREND_CHART === "true";

  if (!shop) {
    // Defensive fallback only: unreachable on an authenticated load unless the
    // row is deleted between create and re-read (e.g. a shop/redact landing in
    // between). Return minimal data so the page renders without crashing. This
    // renders the dashboard shell with a disabled scan button, not onboarding.
    logger.warn("dashboard-shop-missing-after-create", { shop: session.shop });
    return {
      shop: null,
      latestScan: null,
      latestScanId: null,
      canDiffLatest: false,
      findingSummary: null,
      mainTheme: null,
      allThemes: [] as ThemeSummary[],
      canSelectTheme: false,
      scanUsage: null,
      isFirstScan: true,
      hasResults: false,
      showRescanNudge: false,
      showThemeChangeNudge: false,
      showMultiThemeNudge: false,
      showFeedbackNudge: false,
      healthScoreTrend: null,
      showTrendEmptyState: false,
      scansNeeded: 0,
      trendChartEnabled: false,
      laneSummary: [] as LaneSummaryRow[],
      advisoryCount: 0,
      securityRisks: [] as SecurityRisk[],
      securityRiskSource: null as SecurityRiskSource | null,
      riskSummaryLine: null as string | null,
      startHere: null as LaneKey | null,
      dominant: null as LaneKey | null,
      findingTrend: null,
      findingsTile: null as FindingsTile | null,
      topFindings: [] as TopFindingView[],
      removalBanner: null as RemovalBanner | null,
      newlyInactiveApps: [] as string[],
      summaryNotice: null as SummaryNotice | null,
      summaryOptIn: null as SummaryOptInPrompt | null,
      themeHealth: [] as HealthRow[],
      maliciousHealth: null as HealthRow | null,
    };
  }

  const features = getPlanFeatures(shop.plan);
  const canSelectTheme = canUseMultipleThemes(shop.plan);

  // Fetch all themes for Standard and Professional so the picker has options to
  // display even when disabled (Standard teaser). Skip the API call on Free plan
  // since the picker is completely hidden there.
  const shouldFetchThemes = shop.plan === PLANS.STANDARD || shop.plan === PLANS.PROFESSIONAL;

  // Fetch trend data for Standard and Professional — Free plan gets null.
  // Also gated by the ENABLE_TREND_CHART feature flag so the feature can be
  // toggled off without a deploy (zero extra DB cost when disabled).
  const shouldFetchTrendScans =
    trendChartEnabled && (shop.plan === PLANS.STANDARD || shop.plan === PLANS.PROFESSIONAL);

  // Phase 0: fetch theme metadata and recent scans in parallel — none depend on each other.
  // Theme reads go through the ~60s per-shop TTL cache (theme-cache.server) so
  // repeated dashboard navigations don't re-hit the Shopify theme API. Keyed by
  // session.shop. The action's theme validation and the poll cron deliberately
  // call the raw fetchers instead so their reads stay fresh.
  const [mainTheme, allThemes, recentScans, completedScansForTrend] = await Promise.all([
    getCachedMainTheme(admin, session.shop),
    shouldFetchThemes
      ? getCachedAllThemes(admin, session.shop)
      : Promise.resolve([] as ThemeSummary[]),
    getScansForShop(shop.id, { limit: 2 }),
    shouldFetchTrendScans
      ? getCompletedScansForShop(shop.id, { limit: 7 })
      : Promise.resolve([] as Array<{ id: string; completedAt: Date; themeName: string }>),
  ]);

  const [latestScan = null, previousScan = null] = recentScans.items;

  // Union of scan ids the dashboard needs severity counts for: the latest scan,
  // the previous scan (only when it's a successful terminal state), and the
  // trend scans. A single getSeverityCountsForScans call replaces what used to
  // be up to 9 separate getFindingSummary calls (the N+1 fix). getFindingSummary
  // is deliberately not used here — the dashboard never reads the byType axis.
  const severityScanIds = Array.from(
    new Set<string>([
      ...(latestScan ? [latestScan.id] : []),
      ...(previousScan && isSuccessfulScan(previousScan.status) ? [previousScan.id] : []),
      ...completedScansForTrend.map((s) => s.id),
    ]),
  );

  // Phase 1: queries that depend only on Phase 0 results (parallel).
  // typeCounts is fetched here (in parallel) only for a successful latest scan,
  // so it powers the consequence lanes without an extra serial round-trip. It
  // uses getTypeCountsForScan rather than getFindingSummary so we don't re-run
  // the severity groupBy the batch severity query above already covers.
  // The shop's prompt state (gc-97k.6) loads in the same batch: the shared
  // loader reads the first successful scan only when a prompt rule can use it,
  // so a retired or not-yet-eligible shop costs no query.
  // The app-removal rows (gc-frda) load here too, only for a successful latest
  // scan: ONE indexed read (the AppRemoval unique key's shop + theme prefix,
  // a handful of rows), never on the in-progress poll.
  const now = new Date();
  const latestSuccessful = latestScan && isSuccessfulScan(latestScan.status) ? latestScan : null;
  const [severityCounts, usage, completedScanCheck, typeCounts, ignores, promptState, removalRows] =
    await Promise.all([
      getSeverityCountsForScans(severityScanIds),
      getScanUsage(shop.id, shop.plan, now),
      hasCompletedScans(shop.id),
      latestSuccessful ? getTypeCountsForScan(latestSuccessful.id) : Promise.resolve(null),
      getIgnoredFindingsForShop(shop.id),
      loadShopPromptState(shop, now),
      latestSuccessful
        ? getRemovalNoticeRows(shop.id, latestSuccessful.themeId, latestSuccessful.id)
        : Promise.resolve([]),
    ]);

  const zeroSeverityRecord: Record<Severity, number> = {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };

  // Severity + per-type counts for the latest scan, used for the findings
  // count tile and the consequence lanes. Kept in a `bySeverity`-
  // shaped object so the returned findingSummary stays compatible with the
  // component (which reads only findingSummary?.bySeverity?.HIGH/MEDIUM/LOW).
  //
  // E2.2 (gc-57t): the batch severity query and getTypeCountsForScan above are
  // lean groupBy aggregates that CANNOT exclude INSTANCE (fingerprint) ignores.
  // So when this shop has active suppressions we rebuild an ignore-filtered
  // severity map covering EVERY scan the dashboard aggregates — latest, previous,
  // AND the trend scans (exactly `severityScanIds`) — and route the findings tile,
  // the finding-count trend, and the trend chart through that single source so
  // they can never disagree for the same scan. Filtering ALL scans (including
  // historical/previous) by the CURRENT ignore set is the correct, consistent
  // behavior: an ignored fingerprint or app-level rule applies across every scan,
  // so a merchant who suppresses a finding sees it removed from history too.
  // The exception is known malicious code, which shows regardless of ignores:
  // the tile and the trend chart add ignored MALICIOUS_SCRIPT findings back.
  //
  // Cost: shops with NO suppressions skip this entirely and keep the fast batch
  // groupBy path (zero extra queries). When ignores exist, the per-scan filtered
  // load runs once per dashboard load over the already-bounded severityScanIds
  // set (latest + previous + the trend window) — never for scans outside it.
  const hasIgnores = ignores.fingerprints.size > 0 || ignores.appNames.size > 0;
  let filteredSeverityByScanId: Map<string, Record<Severity, number>> | null = null;
  // Ignore-filtered MALICIOUS_SCRIPT count per scan (findings tile, gc-j8xq).
  let filteredMaliciousByScanId: Map<string, number> | null = null;
  // MALICIOUS_SCRIPT findings the ignores dropped, per scan (trend chart, gc-kxfb).
  let ignoredMaliciousByScanId: Map<string, number> | null = null;
  let latestTypeCounts = typeCounts;
  // The latest successful scan's kept (non-ignored) findings, which the
  // filtered summary had to read anyway: the "Start here" ranking reuses them
  // so a shop with ignores never reads that scan's findings twice.
  let latestKeptFindings: FindingRow[] | null = null;
  // Every scan's filtered summary read below, by id: the banners' fallback
  // scan (gc-xtno) reuses its entry instead of reading it again.
  let filteredSummaryByScanId: Map<
    string,
    Awaited<ReturnType<typeof getFilteredFindingSummaryAndKept>>
  > | null = null;
  // The advisory kill switch (gc-5nok): with the flag off a stored advisory
  // is shown nowhere. The lean groupBys above cannot leave it out, so its scan
  // takes the same filtered path as a shop with ignores (only while such a
  // row is stored: the operator's DELETE ends it).
  const hiddenAdvisoryStored =
    !areStoredAdvisoriesShown() && (typeCounts?.APP_INCIDENT_ADVISORY ?? 0) > 0;
  if (hasIgnores || hiddenAdvisoryStored) {
    const summaries = await Promise.all(
      severityScanIds.map(
        async (id) => [id, await getFilteredFindingSummaryAndKept(id, ignores)] as const,
      ),
    );
    filteredSummaryByScanId = new Map(summaries);
    filteredSeverityByScanId = new Map(
      summaries.map(([id, { summary }]) => [id, summary.bySeverity]),
    );
    filteredMaliciousByScanId = new Map(
      summaries.map(([id, { summary }]) => [id, summary.byType?.MALICIOUS_SCRIPT ?? 0]),
    );
    ignoredMaliciousByScanId = new Map(
      summaries.map(([id, { ignoredMalicious }]) => [id, ignoredMalicious]),
    );
    // The latest successful scan's ignore-filtered per-type counts feed the lanes.
    if (latestScan && isSuccessfulScan(latestScan.status)) {
      const latest = summaries.find(([id]) => id === latestScan.id);
      if (latest) {
        latestTypeCounts = latest[1].summary.byType;
        latestKeptFindings = latest[1].keptFindings;
      }
    }
  }

  // Single ignore-aware severity accessor: reads the filtered map when the shop
  // has suppressions, else the lean batch groupBy. Every severity read below
  // (findings tile, finding-count trend, trend chart) goes through this so they
  // stay consistent for any given scan.
  const severityForScan = (scanId: string): Record<Severity, number> =>
    filteredSeverityByScanId?.get(scanId) ?? severityCounts.get(scanId) ?? zeroSeverityRecord;

  const latestSeverity: Record<Severity, number> | null = latestScan
    ? severityForScan(latestScan.id)
    : null;

  // Consequence lanes: roll the latest scan's (ignore-filtered) per-type counts
  // up into merchant "so what" lanes. Empty array when there is no successful
  // scan or no findings.
  const laneSummary: LaneSummaryRow[] = latestTypeCounts
    ? computeLaneSummary(latestTypeCounts)
    : [];
  const dominant: LaneKey | null = dominantLane(laneSummary);
  // Non-ignored affected-app advisories in the latest scan (gc-14x5). They
  // are in no lane, so the top card names them in one line of their own.
  const advisoryCount = latestTypeCounts?.APP_INCIDENT_ADVISORY ?? 0;

  const findingSummary = latestSeverity ? { bySeverity: latestSeverity } : null;

  // "Start here" (gc-bn0x): the latest successful scan's top 3 findings, by the
  // same ranking and plan rules as the scan page (Free ranks only its preview
  // and malicious rows, never a hidden finding). Only for a SUCCESSFUL latest
  // scan, so the 3s poll while a scan runs reads nothing here (its one extra
  // read is the Security risk banners' fallback, gc-xtno). Cost per load, no
  // ignores: full-list plans one (type, severity) groupBy plus a few
  // `take <= 3` reads; Free the preview's bounded per-bucket reads (`take <= 5`)
  // plus one `take 3` malicious read only when the scan has malicious findings.
  // With ignores: no query on full-list plans (the kept rows above), and Free
  // picks its preview from them too.
  const topFindingRows =
    latestScan && isSuccessfulScan(latestScan.status) && latestTypeCounts
      ? features.showFindingDetails
        ? await getFullListTopFindings(latestScan.id, latestKeptFindings)
        : await getFreeTopFindings(
            latestScan.id,
            latestTypeCounts,
            latestKeptFindings,
            findingTypesWithheldByPlan(features),
          )
      : [];
  const topFindings = latestScan
    ? toTopFindingViews(
        latestScan.id,
        topFindingRows,
        Boolean(features.showFindingDetails),
        // gc-q5z8: an advisory row names its app and the entry's own wording.
        advisoryStartHereCopy(topFindingRows),
      )
    : [];

  // The lanes' "Start here" chip follows the block's first finding whenever
  // the block shows (audit fix): both say "Start here", so they must point at
  // the same thing, and the block's ranking is the stronger signal (severity
  // first, then urgency, per finding; startHereLane ranks lanes by urgency then
  // count and ignores severity). With no block, the lane ranking stands alone.
  const blockLane = topFindings[0]?.lane;
  const startHere: LaneKey | null =
    blockLane && laneSummary.some((row) => row.lane === blockLane)
      ? blockLane
      : startHereLane(laneSummary);

  // The results view (findings count, Start here, lanes) renders only for a
  // successful latest scan whose counts loaded.
  const hasResults = Boolean(latestScan && isSuccessfulScan(latestScan.status) && latestSeverity);

  const sumSeverity = (r: Record<Severity, number>) => r.HIGH + r.MEDIUM + r.LOW;

  // Findings tile (gc-j8xq): the ignore-filtered total PLUS the malicious
  // findings the merchant ignored, and never green while the scan found any
  // (see buildFindingsTile). `maliciousCount` is what the scan FOUND, from the
  // unfiltered per-type groupBy already loaded; `latestTypeCounts` holds what
  // is left after ignores (the same object when the shop has none), so the
  // difference is exactly the ignored malicious findings. No extra query.
  const maliciousCount = typeCounts?.MALICIOUS_SCRIPT ?? 0;
  const latestFilteredTotal = latestSeverity ? sumSeverity(latestSeverity) : 0;

  // A security risk found (gc-q5z8): one line under "Most Recent Findings"
  // that accounts for the tile, in place of the leftover-items lead. Its parts
  // add up to the tile: every malicious finding (ignored or not, named on its
  // own), the non-ignored advisories, and the laned findings without the kept
  // malicious ones (the lanes count those too).
  const riskSummaryLine = homeRiskSummaryLine({
    advisories: advisoryCount,
    malicious: maliciousCount,
    leftover:
      laneSummary.reduce((sum, row) => sum + row.count, 0) -
      (latestTypeCounts?.MALICIOUS_SCRIPT ?? 0),
  });

  // Security risk banners (gc-q5z8), at the top of Home on EVERY plan: one
  // per known malicious domain (every malicious finding, ignored or not, like
  // the tile and the scan page's alert) and one per non-ignored affected-app
  // advisory. For a successful latest scan, no query when its counts (loaded
  // above) say there is nothing to show.
  //
  // gc-xtno: from the latest scan when it succeeded; while a scan runs, or
  // after one failed, from the most recent successful scan instead, so known
  // malicious code never vanishes from Home because a rescan is running (the
  // page says which scan they are from).
  //
  // Cost on the in-progress poll (every 3 s): nothing for a first scan (no
  // successful scan: completedScanCheck above); otherwise ONE lean groupBy
  // limited to the two security types on the fallback scan (none when a shop
  // with ignores already read its filtered summary). Only a scan that holds
  // one reads more (loadHomeSecurityRisks' rows). The fallback scan is
  // usually the previous one; when that one did not succeed either, one
  // more indexed read finds the most recent successful scan.
  let securityRisks: SecurityRisk[] = [];
  let securityRiskSource: SecurityRiskSource | null = null;
  // The fallback scan's inputs to loadHomeSecurityRisks, or null when it has
  // no security finding to show (the poll then reads nothing more). Malicious
  // code counts ignored or not; an advisory counts only when shown (gc-5nok)
  // and not ignored, which for a shop with ignores needs its filtered summary
  // (already read when the scan is in severityScanIds).
  const fallbackSecurityCounts = async (scanId: string) => {
    const read = filteredSummaryByScanId?.get(scanId);
    if (!read) {
      const found = await getTypeCountsForScan(scanId, HOME_SECURITY_TYPES);
      const advisories = areStoredAdvisoriesShown() ? found.APP_INCIDENT_ADVISORY : 0;
      if (found.MALICIOUS_SCRIPT === 0 && advisories === 0) return null;
      if (!hasIgnores || advisories === 0) {
        return {
          keptByType: { APP_INCIDENT_ADVISORY: advisories },
          keptFindings: null,
          maliciousFound: found.MALICIOUS_SCRIPT,
        };
      }
    }
    const { summary, keptFindings, ignoredMalicious } =
      read ?? (await getFilteredFindingSummaryAndKept(scanId, ignores));
    const maliciousFound = (summary.byType.MALICIOUS_SCRIPT ?? 0) + ignoredMalicious;
    if (maliciousFound === 0 && (summary.byType.APP_INCIDENT_ADVISORY ?? 0) === 0) return null;
    return { keptByType: summary.byType, keptFindings, maliciousFound };
  };
  if (hasResults && latestScan && latestTypeCounts) {
    securityRisks = await loadHomeSecurityRisks({
      shopId: shop.id,
      scanId: latestScan.id,
      keptByType: latestTypeCounts,
      keptFindings: latestKeptFindings,
      maliciousFound: maliciousCount,
      now,
    });
    securityRiskSource = {
      scanId: latestScan.id,
      scanDate: latestScan.completedAt ?? latestScan.createdAt,
      earlierScan: null,
    };
  } else if (latestScan && completedScanCheck) {
    try {
      const fallback =
        previousScan && isSuccessfulScan(previousScan.status)
          ? { id: previousScan.id, date: previousScan.completedAt ?? previousScan.createdAt }
          : await getCompletedScansForShop(shop.id, { limit: 1 }).then(([scan]) =>
              scan ? { id: scan.id, date: scan.completedAt } : null,
            );
      const counts = fallback ? await fallbackSecurityCounts(fallback.id) : null;
      if (fallback && counts) {
        securityRisks = await loadHomeSecurityRisks({
          shopId: shop.id,
          scanId: fallback.id,
          ...counts,
          now,
        });
        securityRiskSource = {
          scanId: fallback.id,
          // The fallback scan's own date, never the running scan's.
          scanDate: fallback.date,
          earlierScan: latestScan.status === "FAILED" ? "failed" : "running",
        };
      }
    } catch (err) {
      logger.warn("security risk: last successful scan unavailable", {
        function: "loader",
        shopId: shop.id,
        ...safeErrorFields(err),
      });
    }
  }

  const findingsTile: FindingsTile | null = latestSeverity
    ? buildFindingsTile({
        filteredTotal: latestFilteredTotal,
        maliciousFound: maliciousCount,
        maliciousKept: latestTypeCounts?.MALICIOUS_SCRIPT ?? 0,
        // gc-q5z8: a non-ignored advisory is a security risk too (red tile).
        advisoryKept: advisoryCount,
        // gc-xtno: "k security risks" counts the banners, not finding lines.
        distinctRisks: securityRisks.length,
      })
    : null;

  // Finding-count trend: compare the latest scan's total finding count against
  // the previous successful scan's. Fewer findings = improving. Derived from the
  // severity counts already fetched — no extra query. null when there is no
  // successful previous scan to compare against.
  //
  // Both totals are counted the way the tile counts (gc-j8xq), so the line
  // under the tile never contradicts its number, nor the number the previous
  // scan's tile showed. Whenever the shop has ignores, the previous scan needs
  // its own unfiltered malicious count (it may hold ignored malicious findings
  // even when the latest scan has none): one lean per-type groupBy. A shop
  // with no ignores has nothing to add back, so it runs no extra query.
  let findingTrend: {
    direction: "improving" | "declining" | "stable";
    previousTotal: number;
  } | null = null;
  if (findingsTile && previousScan && isSuccessfulScan(previousScan.status)) {
    const currentTotal = findingsTile.total;
    const previousFilteredTotal = sumSeverity(severityForScan(previousScan.id));
    const previousTotal = hasIgnores
      ? buildFindingsTile({
          filteredTotal: previousFilteredTotal,
          maliciousFound: (await getTypeCountsForScan(previousScan.id)).MALICIOUS_SCRIPT ?? 0,
          maliciousKept: filteredMaliciousByScanId?.get(previousScan.id) ?? 0,
        }).total
      : previousFilteredTotal;
    const direction =
      currentTotal < previousTotal
        ? "improving"
        : currentTotal > previousTotal
          ? "declining"
          : "stable";
    findingTrend = { direction, previousTotal };
  }

  // Compute the findings trend — paid plans only, requires >= 3 completed scans.
  // completedScansForTrend is newest-first; we reverse to oldest-first for the chart.
  // Types TrendScoreEntry and HealthScoreTrend are imported from HealthScoreTrendChart.

  const showTrendEmptyState = shouldFetchTrendScans && completedScansForTrend.length < 3;
  const scansNeeded = showTrendEmptyState ? Math.max(0, 3 - completedScansForTrend.length) : 0;

  let healthScoreTrend: HealthScoreTrend | null = null;
  if (shouldFetchTrendScans && completedScansForTrend.length >= 3) {
    // Build score entries paired with their scan metadata, then reverse to
    // oldest-first so the chart reads left-to-right chronologically.
    const scores: TrendScoreEntry[] = completedScansForTrend
      .map((scan) => {
        const counts = severityForScan(scan.id);
        // Counted the way the tile counts (gc-kxfb): ignored malicious
        // findings are added back, and MALICIOUS_SCRIPT is always HIGH.
        const highCount = (counts.HIGH ?? 0) + (ignoredMaliciousByScanId?.get(scan.id) ?? 0);
        const mediumCount = counts.MEDIUM ?? 0;
        const lowCount = counts.LOW ?? 0;
        return {
          scanId: scan.id,
          completedAt: scan.completedAt.toISOString(),
          themeName: scan.themeName,
          highCount,
          mediumCount,
          lowCount,
        };
      })
      .reverse();

    const oldestTotal = scores[0].highCount + scores[0].mediumCount + scores[0].lowCount;
    const newestTotal =
      scores[scores.length - 1].highCount +
      scores[scores.length - 1].mediumCount +
      scores[scores.length - 1].lowCount;
    // Fewer findings = improving
    const delta = oldestTotal - newestTotal;
    const direction: "improving" | "declining" | "stable" =
      delta > 3 ? "improving" : delta < -3 ? "declining" : "stable";

    healthScoreTrend = { scores, direction };
  }

  // Compute scan usage for plans with caps (Free = monthly, Standard = weekly,
  // Professional = daily). nextScanAt: when the next period starts (shown at the cap).
  const isFirstScan = !completedScanCheck;
  const scanUsage: {
    used: number;
    limit: number;
    period: ScanQuotaPeriod;
    nextScanAt: string;
  } | null =
    usage && !isFirstScan
      ? {
          used: usage.used,
          limit: usage.limit,
          period: usage.period,
          nextScanAt: getNextScanPeriodStart(usage.period, usage.periodStart).toISOString(),
        }
      : null;

  // Rescan nudge: show for Standard-plan shops whose last completed scan is
  // older than 30 days and no scan is currently running.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const showRescanNudge =
    shop.plan === PLANS.STANDARD &&
    latestScan !== null &&
    isSuccessfulScan(latestScan.status) &&
    latestScan.completedAt !== null &&
    Date.now() - new Date(latestScan.completedAt).getTime() > THIRTY_DAYS_MS;

  // Theme change nudge: show when a theme was published since the last completed
  // scan, indicating orphaned-code risk may have changed.
  // Suppressed for Professional plan shops — they get auto-rescan instead.
  // Same condition as the scan page's stale-results banner (gc-mgi).
  const showThemeChangeNudge = isScanStaleAfterThemeChange({
    autoRescan: features.autoRescan,
    lastThemePublishAt: shop.lastThemePublishAt,
    scan: latestScan,
  });

  // Multi-theme upgrade nudge: a shop whose plan can't scan multiple themes but
  // whose store HAS more than one theme is missing Professional's flagship
  // unlimited-theme differentiator. allThemes is only populated for Standard and
  // Professional (loader skips the fetch on Free), and Professional passes
  // canUseMultipleThemes, so this naturally targets Standard shops with 2+ themes.
  const showMultiThemeNudge = !canUseMultipleThemes(shop.plan) && allThemes.length > 1;

  // Interruptive prompts (gc-97k.6, strict global priority): Home can render
  // the summary-email opt-in (gc-xorg) and the feedback nudge (gc-97k.3), at
  // most one, the opt-in first. resolvePrompt computes the shop's GLOBAL
  // eligibility, so while a higher-priority prompt (the review popup or the
  // Free return banner, both scan-page only) is pending, Home renders nothing
  // and claims nothing.
  // Whether rendering the opt-in would open a NEW 24h window (read before the
  // claim): its first render in that window, the one telemetry counts.
  const optInOpensWindow = promptClaimNeeded("summary_optin", promptState, now);
  const homePrompt = await resolvePrompt({
    shopDomain: session.shop,
    state: promptState,
    renderable: HOME_PROMPTS,
    deferred: HOME_DEFERRED_PROMPTS,
    now,
  });
  const showFeedbackNudge = homePrompt === "feedback";

  // `shown` counts only a nudge that actually renders, once per merchant. The
  // stamp pre-check skips the claim write on every later load.
  if (showFeedbackNudge && shop.feedbackNudgeShownAt === null) {
    await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "shown", session.shop);
  }

  // "New: summary emails" (gc-xorg): the one-time opt-in for a paid shop that
  // never consented (paid before gc-ol95 shipped). Re-renders inside its 24h
  // window until the merchant answers; an ignored prompt may return on a later
  // visit, until it is retired 14 days after its first render (gc-rxq0, the
  // first render stamps summaryOptInFirstShownAt).
  const summaryOptIn =
    homePrompt === "summary_optin"
      ? await summaryOptInForHome(shop, admin, optInOpensWindow)
      : null;

  // Expose the latest successful scan id and whether this shop+plan can diff it,
  // so the component can lazily fetch the diff resource route (same pattern as
  // the scan-detail page) to surface NEW high-severity findings without loading
  // findings here (avoids the expensive 2-scan full-findings load — see PRF-2).
  const latestScanId = latestScan && isSuccessfulScan(latestScan.status) ? latestScan.id : null;

  // Durable "first viewed results" milestone (gc-dpm.1): Home renders a
  // SUCCESSFUL latest scan's results itself (including when its 3s poll swaps
  // the in-progress card for them), so it stamps like the scan detail page.
  // Gated on the stored value, so an already-stamped shop (every later poll)
  // issues no query; the atomic claim dedupes concurrent loads. Never throws.
  if (latestScanId !== null && shop.firstResultsViewedAt === null) {
    await recordJourneyMilestoneOnce("firstResultsViewedAt", session.shop);
  }
  // Per-scan "viewed on Home" stamp (scan-source telemetry): same render
  // condition, on THAT scan. Gated on the loaded value, so once stamped every
  // later load and 3s poll issues no write; the conditional update dedupes
  // concurrent first loads. Never throws. A Home tab left open while the scan
  // runs stamps it when the poll swaps in the results (counted as a view).
  if (latestScan !== null && latestScanId !== null && latestScan.viewedOnHomeAt === null) {
    await recordScanResultsViewOnce(latestScanId, shop.id, "home", session.shop);
  }
  const canDiffLatest =
    latestScan != null && isSuccessfulScan(latestScan.status) && canUseScanDiffing(shop.plan);

  // App-removal banner (gc-frda): apps the latest successful scan found no
  // longer active (or whose leftovers it found cleaned up). Content, not an
  // interruptive prompt, so no prompt cap; Free sees it in full (decision 4A).
  // Hidden once the merchant dismissed it for THIS scan; a newer scan's
  // removals show again. Start here badges a finding from an app newly
  // inactive on this scan whether or not the banner was dismissed.
  const removalNotice = latestSuccessful ? buildRemovalNotice(removalRows) : null;
  const removalBanner: RemovalBanner | null =
    latestSuccessful && removalNotice && shop.removalNoticeDismissedScanId !== latestSuccessful.id
      ? {
          notice: removalNotice,
          scanId: latestSuccessful.id,
          fullList: Boolean(features.showFindingDetails),
        }
      : null;
  const newlyInactiveApps = removalRows.filter((r) => r.state === "REMOVED").map((r) => r.appName);

  // Theme health checklist (gc-i6du): what the latest successful scan checked
  // and found, by category, plus the theme's type/version and the unpublished
  // themes. Only with results on screen, so the 3s poll while a scan runs reads
  // nothing here. Counts and fixed copy only: nothing here is plan-gated content.
  // The theme list is already loaded for Standard and Professional (the
  // picker); Free reads it here, through the same 60s cache, and a failed read
  // only drops the unpublished-themes row.
  //
  // Known malicious code is the exception to "ignore-filtered counts": its
  // count is what the scan FOUND, ignored findings included (the scan page's
  // security alert lists them regardless of ignores too), so an ignored
  // malicious finding can never read "Clean" here. It comes from `typeCounts`,
  // the unfiltered per-type groupBy already loaded above for a successful
  // latest scan (`maliciousCount`, above): no extra query. The critical line
  // is built from that count alone, outside loadThemeHealth, so it shows even
  // when the checklist fails or has no rows. Same on every plan.
  const maliciousHealth: HealthRow | null =
    hasResults && latestSuccessful
      ? maliciousHealthRow(
          latestSuccessful.id,
          maliciousCount,
          // gc-0htk: code seen on the live homepage is not "in your theme".
          securityRisks.some((r) => r.kind === "malicious" && r.seenIn === "homepage"),
        )
      : null;
  let themeHealth: HealthRow[] = [];
  if (hasResults && latestSuccessful && latestTypeCounts) {
    const themesForHealth: ThemeSummary[] | null = shouldFetchThemes
      ? allThemes
      : await getCachedAllThemes(admin, session.shop).catch((err) => {
          logger.warn("theme health: theme list unavailable", {
            shop: session.shop,
            ...safeErrorFields(err),
          });
          return null;
        });
    // loadThemeHealth does not throw; the catch is a second guard so that a
    // checklist failure can never take Home down with it.
    themeHealth = await loadThemeHealth({
      shop,
      scan: latestSuccessful,
      typeCounts: { ...latestTypeCounts, MALICIOUS_SCRIPT: maliciousCount },
      mainThemeId: mainTheme?.id ?? null,
      themes: themesForHealth,
      now,
    }).catch((err) => {
      logger.warn("theme health: checklist unavailable", {
        shop: session.shop,
        ...safeErrorFields(err),
      });
      return [] as HealthRow[];
    });
  }

  // "Summary emails are on" (gc-ol95): shown ONCE to a shop that owes it (moved
  // Free -> paid, or opted in while sending was dark); the load that wins the
  // claim renders it, and that claim is the merchant's notice. Pre-checked on
  // the loaded row, so every other load (and every 3s poll) issues no query.
  const summaryNotice = await claimSummaryNoticeForHome(shop, admin);

  return {
    shop,
    latestScan,
    latestScanId,
    canDiffLatest,
    findingSummary,
    mainTheme,
    allThemes,
    canSelectTheme,
    scanUsage,
    isFirstScan,
    hasResults,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showFeedbackNudge,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
    laneSummary,
    advisoryCount,
    securityRisks,
    securityRiskSource,
    riskSummaryLine,
    startHere,
    dominant,
    findingTrend,
    findingsTile,
    topFindings,
    removalBanner,
    newlyInactiveApps,
    summaryNotice,
    summaryOptIn,
    themeHealth,
    maliciousHealth,
  };
};

/** Home's app-removal banner data (gc-frda), bound to the scan it describes. */
export type RemovalBanner = { notice: RemovalNotice; scanId: string; fullList: boolean };

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return { error: "Shop not found. Please reinstall the app." };
  }

  // Parse the form body early so we can branch on intent before gating.
  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  // Feedback nudge "Not now" (gc-97k.3): the once-per-merchant claim stamps
  // feedbackNudgeDismissedAt (which retires the nudge) and emits `dismissed`.
  if (intent === "dismiss-feedback-nudge") {
    await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "dismissed", session.shop);
    return { dismissed: true };
  }

  // App-removal banner "Dismiss" (gc-frda): per scan, for the SESSION shop
  // only. The scan id must be one of this shop's scans; anything else is a
  // no-op. Repeating it rewrites the same value (idempotent).
  if (intent === "dismiss-removal-notice") {
    const scanId = formData.get("scanId");
    if (typeof scanId !== "string" || scanId === "") return { ignored: true };
    const scan = await getScanById(scanId, { includeFindings: false });
    if (!scan || scan.shopId !== shop.id) return { ignored: true };
    await dismissRemovalNotice(shop.id, scanId);
    return { dismissed: true };
  }

  // Summary-email notice "Dismiss" (gc-ol95): the notice is no longer owed.
  // Session shop only; idempotent.
  if (intent === "dismiss-summary-notice") {
    await dismissSummaryNotice(shop.id);
    return { dismissed: true };
  }

  // Summary-email opt-in (gc-xorg), session shop only, both idempotent.
  // "Turn on" re-checks full eligibility (plan, sending, the 14-day offer) on
  // the row read above; when that fails nothing is written. "No thanks" stamps the decline once.
  if (intent === "summary-optin-accept") {
    return (await acceptSummaryOptIn(shop, new Date()))
      ? { summaryOptedIn: true }
      : { ignored: true };
  }
  if (intent === "summary-optin-decline") {
    await declineSummaryOptInForHome(session.shop);
    return { dismissed: true };
  }

  // Starting a scan sends NO intent. Any other intent is a no-op, never a scan:
  // e.g. the retired review banner's "dismiss-review-prompt" posted by a tab
  // loaded before that banner was removed (owner decision 2A).
  if (intent !== null) {
    return { ignored: true };
  }

  // Plan-gate: check if this shop is allowed to start a new scan.
  const gate = await canStartScan(shop.id, shop.plan);
  if (!gate.allowed) {
    return { error: gate.reason ?? "Scan limit reached for your current plan." };
  }

  const selectedThemeId = formData.get("themeId") as string | null;
  // Which page started this scan (telemetry only, never trusted for gating).
  // Missing or unrecognized values are stored as "unknown".
  const requestedFrom = parseScanSource(formData.get("source"));

  const allowThemeSelection = canUseMultipleThemes(shop.plan);

  let themeId: string;
  let themeName: string;

  if (selectedThemeId && allowThemeSelection) {
    // Validate the submitted themeId by confirming it exists in the shop's theme list.
    // This prevents spoofed themeIds from being scanned by merchants without the feature.
    const allThemes = await fetchAllThemes(admin);
    const matched = allThemes.find((t) => t.id === selectedThemeId);
    if (!matched) {
      return {
        error: "The selected theme could not be found. Please refresh and try again.",
      };
    }
    themeId = matched.id;
    themeName = matched.name;
  } else {
    // Default: fetch the shop's published (MAIN) theme.
    const mainTheme = await fetchMainTheme(admin);
    if (!mainTheme) {
      return { error: "No published theme found. Please publish a theme before scanning." };
    }
    // mainTheme.id is already the full GID string (e.g. gid://shopify/Theme/123456).
    themeId = mainTheme.id;
    themeName = mainTheme.name;
  }

  // Build quota for atomic enforcement inside createScan's transaction.
  // canStartScan above is an advisory pre-flight check for UX; the
  // authoritative check is inside the transaction to close the TOCTOU gap.
  let quota: ScanQuota = null;
  const quotaPeriod = getScanQuotaPeriod(getPlanFeatures(shop.plan));
  if (quotaPeriod) {
    quota = {
      periodStart: quotaPeriod.periodStart,
      maxScans: quotaPeriod.limit,
      periodLabel: quotaPeriod.period,
      isFirstScan: !(await hasCompletedScans(shop.id)),
    };
  }

  // dispatchScan atomically creates the scan (TOCTOU-safe transaction) then
  // fires scan/requested. createScan errors (active scan, quota exceeded) are
  // propagated and surface as user-facing error strings below. inngest.send
  // failures are logged inside dispatchScan (best-effort) — the scan stays
  // PENDING for the daily sweep to expire, but we still redirect so the merchant
  // can see the queued scan in their history.
  let scan: { id: string };
  try {
    // MANUAL origin: this merchant-initiated scan is the only kind that counts
    // toward the manual daily/weekly/monthly quota (GC-iji). Passed explicitly for clarity.
    ({ scan } = await dispatchScan(shop.id, themeId, themeName, {
      quota,
      origin: ScanOrigin.MANUAL,
      requestedFrom,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create scan.";
    return { error: message };
  }

  return redirect(`/app/scans/${scan.id}`);
};

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

/** The scan control's usage line: "2 of 5 used today" / "1 of 1 used this week". */
export function scanUsageLine(usage: { used: number; limit: number; period: ScanQuotaPeriod }) {
  const when = usage.period === "day" ? "today" : `this ${usage.period}`;
  return `${usage.used} of ${usage.limit} used ${when}`;
}

/**
 * Home's summary-email opt-in banner state (gc-xorg). `answered` is the button
 * the merchant clicked (null: none yet). The banner hides the moment they
 * answer (optimistic). After "Turn on", the server's reply decides the line
 * shown: `{ summaryOptedIn: true }` -> the success line (`confirmed`); any
 * other reply (`{ ignored: true }`, `{ error }`) -> the neutral "couldn't turn
 * on" line (`failed`). Nothing shows while the request is in flight, and a
 * decline shows neither.
 */
export function summaryOptInView(
  prompt: SummaryOptInPrompt | null,
  answered: "accept" | "decline" | null,
  actionData: object | undefined,
): { visible: SummaryOptInPrompt | null; confirmed: boolean; failed: boolean } {
  const acceptReply = answered === "accept" ? actionData : undefined;
  const confirmed = acceptReply !== undefined && "summaryOptedIn" in acceptReply;
  return {
    visible: answered === null ? prompt : null,
    confirmed,
    failed: acceptReply !== undefined && !confirmed,
  };
}

/**
 * The scan id whose diff Home should request now, or null: the latest
 * successful scan's, once per id (loadedFor is the id already requested). Null
 * while a scan runs (no latest successful id) or when the plan cannot diff.
 */
export function diffScanIdToLoad(
  loadedFor: string | null,
  canDiffLatest: boolean,
  latestScanId: string | null,
): string | null {
  if (!canDiffLatest || latestScanId === null || loadedFor === latestScanId) return null;
  return latestScanId;
}

/**
 * The diff Home may show: only one requested for the CURRENT latest scan and
 * finished loading, so scan A's new-findings banner never shows for scan B.
 */
export function visibleScanDiff(
  data: ScanDiff | null | undefined,
  fetcherState: "idle" | "loading" | "submitting",
  loadedFor: string | null,
  latestScanId: string | null,
): ScanDiff | null {
  if (latestScanId === null || loadedFor !== latestScanId || fetcherState !== "idle") return null;
  return data ?? null;
}

/**
 * Home's in-progress card. While polling, the spinner, heading and the shared
 * ScanProgress block (same wait experience as the scan page, live count
 * included). Once polling stops at the cap, no spinner and a heading that
 * matches the timeout notice, so the card never says both "scanning" and
 * "taking longer than usual". The "results will appear" line is hidden too:
 * it stops being true when polling stops.
 */
export function HomeScanInProgress({
  createdAt,
  findingCount,
  pollingTimedOut,
}: {
  createdAt: Date | string;
  findingCount: number;
  pollingTimedOut: boolean;
}) {
  if (pollingTimedOut) {
    return (
      <div className="scan-progress-container">
        <s-heading>Scan still running</s-heading>
        <div style={{ marginTop: "12px" }}>
          <s-banner tone="warning">{HOME_POLL_TIMEOUT_MESSAGE}</s-banner>
        </div>
      </div>
    );
  }
  return (
    <div className="scan-progress-container">
      <s-spinner accessibilityLabel="Scanning theme" size="large" />
      <s-heading>Scanning your theme...</s-heading>
      <div className="scan-progress-text">
        GhostCode is analyzing your theme files for orphaned code. Results will appear here when the
        scan is complete.
      </div>
      <div style={{ marginTop: "12px" }}>
        <ScanProgress createdAt={createdAt} findingCount={findingCount} />
      </div>
    </div>
  );
}

/**
 * The line above Home's Security risk banners when they are from an earlier
 * scan than the latest (gc-xtno): which scan, and why. Renders nothing for
 * the latest scan.
 */
export function SecurityRiskSourceNote({ source }: { source: SecurityRiskSource }) {
  const words = securityRiskSourceWords(source);
  if (words === null) return null;
  return (
    <p style={{ margin: 0, fontSize: "13px", color: TEXT_SUBDUED }}>
      {words.before} <FormattedDate value={source.scanDate} />
      {words.after}
    </p>
  );
}

/** Copy for the welcome card's optional permissions line (gc-4n0y). */
export const OPTIONAL_CHECKS_COPY = {
  lead: "Optional: ",
  link: "allow product, page, redirect, and translation checks",
  tail: " for a deeper first scan.",
  grantedFirst: "Extra checks are on for your first scan.",
  grantedNext: "Extra checks are on for your next scan.",
  declined: "No problem. You can turn these on later in Settings.",
  failed: "Couldn't update permissions. You can grant them later in Settings.",
} as const;

/**
 * The status line after a scopes request. "First scan" only when the grant was
 * confirmed before the first scan started (the scan job reads the granted
 * scopes when it runs); a grant that lands once the scan is starting applies
 * to the next one.
 */
export function optionalChecksMessage(
  outcome: ScopeRequestOutcome | null,
  scanStartedBeforeOutcome: boolean,
): string | null {
  switch (outcome) {
    case "granted":
      return scanStartedBeforeOutcome
        ? OPTIONAL_CHECKS_COPY.grantedNext
        : OPTIONAL_CHECKS_COPY.grantedFirst;
    case "declined":
      return OPTIONAL_CHECKS_COPY.declined;
    case "failed":
      return OPTIONAL_CHECKS_COPY.failed;
    default:
      return null;
  }
}

/**
 * Welcome card's SECONDARY, optional line under "Start First Scan" (gc-4n0y):
 * opens the same App Bridge scopes request as the Settings Permissions card
 * (useOptionalScopes), so a Free merchant can deepen the first scan. Never
 * blocks the primary action, and the link is hidden while the scan is
 * starting (a grant then could miss that scan). The outcome is announced in a
 * polite status region that is always present.
 */
export function OptionalChecksLine({ scanStarting }: { scanStarting: boolean }) {
  const { granted, unsupported, requesting, missing, requestMissing } = useOptionalScopes();
  const [result, setResult] = useState<{
    outcome: ScopeRequestOutcome;
    scanStarted: boolean;
  } | null>(null);
  // Read at the moment the outcome arrives, not when the link was clicked.
  const scanStartingRef = useRef(scanStarting);
  scanStartingRef.current = scanStarting;

  if (unsupported) return null;
  const allGranted = granted !== null && missing.length === 0;
  const message = result ? optionalChecksMessage(result.outcome, result.scanStarted) : null;
  const showLink = !allGranted && !scanStarting;

  return (
    <div style={{ fontSize: "13px", color: TEXT_SUBDUED }}>
      {showLink && (
        <div>
          {OPTIONAL_CHECKS_COPY.lead}
          <button
            type="button"
            onClick={async () => {
              const outcome = await requestMissing();
              if (outcome) setResult({ outcome, scanStarted: scanStartingRef.current });
            }}
            disabled={requesting}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              color: COLOR_INFO,
              textDecoration: "underline",
              cursor: requesting ? "default" : "pointer",
            }}
          >
            {OPTIONAL_CHECKS_COPY.link}
          </button>
          {OPTIONAL_CHECKS_COPY.tail}
        </div>
      )}
      <div
        role="status"
        style={{
          marginTop: message && showLink ? "4px" : 0,
          color: result?.outcome === "granted" ? COLOR_SUCCESS : TEXT_SUBDUED,
        }}
      >
        {message}
      </div>
    </div>
  );
}

/**
 * Per-urgency chip presentation for a consequence lane. Colors come from the
 * shared design tokens — see the CONSEQUENCE_MAP urgency tiers.
 */
const URGENCY_CHIP: Record<
  UrgencyKey,
  { label: string; bg: string; text: string; border?: string }
> = {
  "act-now": { label: "Act now", bg: CRIT_BD, text: COLOR_CRITICAL },
  compounding: { label: "Compounding", bg: WARN_BD, text: WARN_TEXT },
  whenever: { label: "Whenever", bg: BG_SURFACE, text: TEXT_SUBDUED, border: BORDER_DEFAULT },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const {
    shop,
    latestScan,
    latestScanId,
    canDiffLatest,
    findingSummary,
    mainTheme,
    allThemes,
    canSelectTheme,
    scanUsage,
    isFirstScan,
    hasResults,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showFeedbackNudge,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
    laneSummary,
    securityRisks,
    securityRiskSource,
    riskSummaryLine,
    startHere,
    dominant,
    findingTrend,
    findingsTile,
    topFindings,
    removalBanner,
    newlyInactiveApps,
    summaryNotice,
    summaryOptIn,
    themeHealth,
    maliciousHealth,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const dismissFetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Render the start-here lane first, then the remaining lanes in their
  // existing (computeLaneSummary) order.
  const orderedLanes =
    startHere != null
      ? [
          ...laneSummary.filter((row) => row.lane === startHere),
          ...laneSummary.filter((row) => row.lane !== startHere),
        ]
      : laneSummary;

  // Lazily fetch the diff for the latest successful scan via the resource route
  // (same pattern as scan-detail — see app.scans.$scanId.tsx) to surface NEW
  // high-severity findings. The diff is never computed in the loader (PRF-2).
  const diffFetcher = useFetcher<{ scanDiff: ScanDiff | null }>();
  // Which scan's diff was requested: loaded once per latest successful scan id
  // (never on a poll re-render), and again when a newer scan completes.
  const [diffLoadedFor, setDiffLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    const toLoad = diffScanIdToLoad(diffLoadedFor, canDiffLatest, latestScanId);
    if (toLoad === null) return;
    setDiffLoadedFor(toLoad);
    diffFetcher.load(`/app/scans/${toLoad}/diff`);
    // diffFetcher is a stable object; canDiffLatest and latestScanId are the
    // meaningful dependencies here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDiffLatest, latestScanId, diffLoadedFor]);

  // New high-severity findings from the lazily-loaded diff (null until resolved).
  const scanDiff = visibleScanDiff(
    diffFetcher.data?.scanDiff,
    diffFetcher.state,
    diffLoadedFor,
    latestScanId,
  );
  const newHigh = scanDiff ? scanDiff.newFindings.filter((f) => f.severity === "HIGH").length : 0;

  // Optimistically hide the feedback nudge once the merchant clicks "Not now",
  // so it disappears immediately without waiting for the server round-trip.
  const [feedbackNudgeDismissed, setFeedbackNudgeDismissed] = useState(false);
  const showFeedbackBanner = showFeedbackNudge && !feedbackNudgeDismissed;

  const handleDismissFeedbackNudge = () => {
    setFeedbackNudgeDismissed(true);
    dismissFetcher.submit({ intent: "dismiss-feedback-nudge" }, { method: "POST" });
  };

  // App-removal banner "Dismiss" (gc-frda): hide optimistically for the scan
  // it describes (so a newer scan's banner still shows), then persist. Its own
  // fetcher, so it never interrupts a feedback-nudge dismissal in flight.
  const removalDismissFetcher = useFetcher<typeof action>();
  const [removalDismissedFor, setRemovalDismissedFor] = useState<string | null>(null);
  const handleDismissRemovalNotice = (scanId: string) => {
    setRemovalDismissedFor(scanId);
    removalDismissFetcher.submit({ intent: "dismiss-removal-notice", scanId }, { method: "POST" });
  };

  // Summary-email notice (gc-ol95): the loader returns it only on the load that
  // claimed it, so latch it for this page view (the 3s scan poll revalidates
  // the loader) until the merchant dismisses it.
  const summaryNoticeFetcher = useFetcher<typeof action>();
  const [latchedSummaryNotice, setLatchedSummaryNotice] = useState<SummaryNotice | null>(
    summaryNotice,
  );
  const [summaryNoticeDismissed, setSummaryNoticeDismissed] = useState(false);
  useEffect(() => {
    if (summaryNotice) setLatchedSummaryNotice(summaryNotice);
  }, [summaryNotice]);
  const visibleSummaryNotice = summaryNoticeDismissed ? null : latchedSummaryNotice;
  const handleDismissSummaryNotice = () => {
    setSummaryNoticeDismissed(true);
    summaryNoticeFetcher.submit({ intent: "dismiss-summary-notice" }, { method: "POST" });
  };

  // Summary-email opt-in (gc-xorg): hide it the moment the merchant answers
  // (optimistic, like the notice and the feedback nudge). After "Turn on" the
  // server's reply picks the line: success, or a neutral "couldn't turn on"
  // pointing to Settings (e.g. the shop is no longer eligible). Its own fetcher.
  const summaryOptInFetcher = useFetcher<typeof action>();
  const [summaryOptInAnswered, setSummaryOptInAnswered] = useState<"accept" | "decline" | null>(
    null,
  );
  const {
    visible: visibleSummaryOptIn,
    confirmed: summaryOptInConfirmed,
    failed: summaryOptInFailed,
  } = summaryOptInView(summaryOptIn, summaryOptInAnswered, summaryOptInFetcher.data);
  const handleSummaryOptIn = (answer: "accept" | "decline") => {
    setSummaryOptInAnswered(answer);
    summaryOptInFetcher.submit({ intent: `summary-optin-${answer}` }, { method: "POST" });
  };

  // Default the picker to the MAIN theme id. Falls back to empty string when
  // mainTheme is null (no published theme) — the scan button will be disabled.
  const mainThemeId = mainTheme?.id ?? "";
  const [selectedThemeId, setSelectedThemeId] = useState<string>(mainThemeId);

  // Sync selectedThemeId when the loader data changes (e.g. user navigates away
  // and back, or the published theme changes between navigations).
  useEffect(() => {
    setSelectedThemeId(mainThemeId);
  }, [mainThemeId]);

  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";

  const actionError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  // Every scan-start control on Home (onboarding, main button, rescan and
  // theme-change nudges, trend empty state) posts through here: source=home.
  const handleStartScan = () => {
    fetcher.submit(homeScanStartPayload(selectedThemeId), { method: "POST" });
  };

  // Whether the latest scan is still running (findings not yet available).
  const scanInProgress = latestScan?.status === "IN_PROGRESS" || latestScan?.status === "PENDING";

  // Same poll as the scan page: revalidate every 3s while the latest scan runs,
  // so this card turns into the results on its own; stops on a terminal status
  // or at the ~10 minute cap. Each poll re-runs this loader, whose writes are
  // all once- or freshness-gated (feedback nudge "shown" stamp, prompt claim),
  // so polling records nothing twice.
  const { pollingTimedOut } = useScanPolling(latestScan?.status);

  // Total findings in the latest completed scan — drives the consequence-lane
  // "so what" copy (the leftover-item sentence).
  const currentTotal =
    (findingSummary?.bySeverity?.HIGH ?? 0) +
    (findingSummary?.bySeverity?.MEDIUM ?? 0) +
    (findingSummary?.bySeverity?.LOW ?? 0);

  // The findings tile's number and tone, from the loader (gc-j8xq): it counts
  // known malicious code whether or not it was ignored, so it can be higher
  // than `currentTotal`. Without loader data it is the plain total.
  const tile: FindingsTile =
    findingsTile ??
    buildFindingsTile({ filteredTotal: currentTotal, maliciousFound: 0, maliciousKept: 0 });

  // Finding count for the dominant consequence lane — surfaced in the hero's
  // "most of the damage is in …" line so the merchant knows how many findings
  // that top lane represents.
  const dominantCount = dominant
    ? (laneSummary.find((row) => row.lane === dominant)?.count ?? 0)
    : 0;
  // Findings counted in a lane. A finding with no lane (an affected-app
  // advisory, gc-14x5) is in the tile's total but is not a "leftover item"
  // and has no cost to list, so the lane copy counts lanes only.
  const laneTotal = laneSummary.reduce((sum, row) => sum + row.count, 0);

  // Whether the plan's scan limit (weekly or monthly) has been reached.
  // isFirstScan overrides the limit — the first scan is always allowed on the free plan.
  const scanLimitReached = !isFirstScan && scanUsage !== null && scanUsage.used >= scanUsage.limit;

  // Show onboarding experience when the shop is set up but has never been scanned.
  const showOnboarding = !!shop && !latestScan;

  return (
    <s-page heading="GhostCode Scanner">
      <div style={hairline} />
      <div style={groundStyle}>
        {/* Security risk (gc-q5z8): known malicious code, and apps named in a
          security incident, at the very top on EVERY plan. Each links to its
          banner on the scan page, where the steps are. */}
        {/* gc-xtno: while a scan runs (or after one failed) they are the most
          recent successful scan's, and the line above them says so. */}
        {securityRiskSource && securityRisks.length > 0 && (
          <SecurityRiskSourceNote source={securityRiskSource} />
        )}
        {securityRiskSource &&
          securityRisks.map((risk) => (
            <SecurityRiskBanner
              key={securityRiskAnchorId(risk)}
              risk={risk}
              scanDate={securityRiskSource.scanDate}
              checkHref={`/app/scans/${securityRiskSource.scanId}#${securityRiskAnchorId(risk)}`}
            />
          ))}

        {/* Error banner — only rendered when the action returns an error */}
        {actionError && (
          <s-banner tone="critical">
            <s-paragraph>{actionError}</s-paragraph>
          </s-banner>
        )}

        {/* Summary emails are on (gc-ol95): the one-time consent notice. */}
        {visibleSummaryNotice && (
          <s-banner tone="info" heading={SUMMARY_NOTICE_HEADING}>
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {summaryNoticeLead(visibleSummaryNotice.email, visibleSummaryNotice.cadence)}{" "}
                <Link to="/app/settings">Settings</Link>.
              </s-paragraph>
              <div>
                <s-button variant="secondary" onClick={handleDismissSummaryNotice}>
                  {SUMMARY_NOTICE_DISMISS}
                </s-button>
              </div>
            </s-stack>
          </s-banner>
        )}

        {/* "New: summary emails" (gc-xorg): the one-time opt-in, an
          interruptive prompt (resolvePrompt in the loader). */}
        {visibleSummaryOptIn && (
          <s-banner tone="info" heading={SUMMARY_OPTIN_HEADING}>
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {summaryOptInBody(visibleSummaryOptIn.email, visibleSummaryOptIn.cadence)}
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" onClick={() => handleSummaryOptIn("accept")}>
                  {SUMMARY_OPTIN_ACCEPT}
                </s-button>
                <s-button variant="secondary" onClick={() => handleSummaryOptIn("decline")}>
                  {SUMMARY_OPTIN_DECLINE}
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}
        {summaryOptInConfirmed && (
          <s-banner tone="success">
            <s-paragraph>
              {SUMMARY_OPTIN_SUCCESS_LEAD} <Link to="/app/settings">Settings</Link>.
            </s-paragraph>
          </s-banner>
        )}
        {summaryOptInFailed && (
          <s-banner tone="info">
            <s-paragraph>
              {SUMMARY_OPTIN_FAILED_LEAD} <Link to="/app/settings">Settings</Link>.
            </s-paragraph>
          </s-banner>
        )}

        {/* App-removal banner (gc-frda): apps the latest scan found no longer
          active, or cleaned up. Top of the ground stack; none while a scan
          runs (the loader only builds it for a successful latest scan). */}
        {removalBanner && !scanInProgress && removalDismissedFor !== removalBanner.scanId && (
          <AppRemovalBanner
            notice={removalBanner.notice}
            scanId={removalBanner.scanId}
            fullList={removalBanner.fullList}
            linkParams={searchParams}
            onDismiss={() => handleDismissRemovalNotice(removalBanner.scanId)}
          />
        )}

        {/* New high-severity findings callout — shown once the lazily-loaded diff
          resolves with HIGH findings that are new since the previous scan. */}
        {newHigh > 0 && latestScanId && (
          <s-banner tone="warning">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {newHigh} new high-severity finding{newHigh === 1 ? "" : "s"} detected in your
                latest scan.
              </s-paragraph>
              <Link to={`/app/scans/${latestScanId}`}>
                <s-button variant="primary">Review</s-button>
              </Link>
            </s-stack>
          </s-banner>
        )}

        {/* Rescan nudge — Standard plan only, >30 days since last completed scan */}
        {showRescanNudge && (
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                It&apos;s been over 30 days since your last scan. Re-scan your theme to check for
                new orphaned code from recently uninstalled apps.
              </s-paragraph>
              <s-button
                variant="primary"
                onClick={handleStartScan}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Start New Scan
              </s-button>
            </s-stack>
          </s-banner>
        )}

        {/* Theme change nudge — shown when a theme was published since the last scan */}
        {showThemeChangeNudge && (
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Your theme was recently updated. Scan now to check for new orphaned code from app
                changes.
              </s-paragraph>
              <s-button
                variant="primary"
                onClick={handleStartScan}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Start New Scan
              </s-button>
            </s-stack>
          </s-banner>
        )}

        {/* Multi-theme upgrade nudge — Standard plan shops with more than one theme */}
        {showMultiThemeNudge && (
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Your store has more than one theme. Upgrade to Professional to scan any theme, not
                just your published one.
              </s-paragraph>
              <s-button variant="primary" onClick={() => navigate("/app/settings")}>
                Upgrade to Professional
              </s-button>
            </s-stack>
          </s-banner>
        )}

        {/* Merchant feedback nudge (gc-97k.3), an interruptive prompt
          (resolvePrompt in the loader; never alongside the summary opt-in). */}
        {showFeedbackBanner && (
          <s-banner tone="info" heading={FEEDBACK_NUDGE_COPY.heading}>
            <s-stack direction="block" gap="base">
              <s-paragraph>{FEEDBACK_NUDGE_COPY.body}</s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" onClick={() => navigate(FEEDBACK_NUDGE_HREF)}>
                  {FEEDBACK_NUDGE_COPY.cta}
                </s-button>
                <s-button variant="secondary" onClick={handleDismissFeedbackNudge}>
                  {FEEDBACK_NUDGE_COPY.dismiss}
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {showOnboarding ? (
          /* Onboarding card — shown on first install before any scan has run */
          <s-card>
            <s-stack direction="block" gap="large">
              <s-heading>Welcome to GhostCode</s-heading>
              <s-paragraph>
                <strong>GhostCode finds leftover code from uninstalled apps.</strong> Over time,
                apps you&apos;ve removed leave behind scripts, stylesheets, and snippets in your
                theme, slowing your store and cluttering your code. GhostCode scans your theme and
                flags everything that can be safely removed.
              </s-paragraph>
              {mainTheme ? (
                <s-paragraph>
                  Your active theme is <strong>{mainTheme.name}</strong>. GhostCode will scan that
                  theme for leftover code from uninstalled apps.
                </s-paragraph>
              ) : (
                <s-paragraph>
                  No published theme was detected. Publish a theme in your Shopify admin before
                  starting your first scan.
                </s-paragraph>
              )}
              <s-button
                variant="primary"
                onClick={handleStartScan}
                {...(isSubmitting ? { loading: true } : {})}
                {...(!mainTheme ? { disabled: true } : {})}
              >
                {isSubmitting ? "Starting scan…" : "Start First Scan"}
              </s-button>
              {/* gc-4n0y: optional, non-blocking deeper-scan permissions. */}
              <OptionalChecksLine scanStarting={isSubmitting} />
            </s-stack>
          </s-card>
        ) : (
          <>
            <style>{`
            .dashboard-top-row {
              display: grid;
              grid-template-columns: 1fr 3fr;
              gap: 16px;
              align-items: start;
            }
            @media (max-width: 600px) {
              .dashboard-top-row {
                grid-template-columns: 1fr;
              }
            }
            .health-score-tile {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 12px 8px;
              border-radius: 12px;
              border: 1px solid ${BORDER_DEFAULT};
            }
            .dashboard-section-title {
              font-size: 18px;
              font-weight: 600;
              color: ${TEXT_PRIMARY};
              margin: 0;
            }
            ${tileStatusTintCss({
              success: "health-score-tile--success",
              warning: "health-score-tile--warning",
              critical: "health-score-tile--critical",
            })}
            .health-score-number {
              font-size: 48px;
              font-weight: 700;
              line-height: 1;
              letter-spacing: -2px;
            }
            .health-score-number--success { color: ${COLOR_SUCCESS}; }
            .health-score-number--warning { color: ${COLOR_WARNING}; }
            .health-score-number--critical { color: ${COLOR_CRITICAL}; }
            .health-score-subtitle {
              font-size: 14px;
              color: ${TEXT_SUBDUED};
              margin-top: 4px;
            }
            .health-score-label {
              display: inline-block;
              margin-top: 12px;
              padding: 4px 12px;
              border-radius: 16px;
              font-size: 13px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
            .health-score-label--success {
              background: ${BG_BADGE_SUCCESS};
              color: ${COLOR_SUCCESS};
            }
            .health-score-label--warning {
              background: ${WARN_BD};
              color: ${WARN_TEXT};
            }
            .health-score-label--critical {
              background: ${CRIT_BD};
              color: ${COLOR_CRITICAL};
            }
            .health-score-delta {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
              margin-top: 8px;
            }
            .health-read {
              display: flex;
              flex-direction: column;
              gap: 8px;
              margin-top: 12px;
            }
            .health-read__damage {
              font-size: 15px;
              font-weight: 600;
              color: ${TEXT_PRIMARY};
            }
            .health-read__lead {
              font-size: 14px;
              color: ${TEXT_SUBDUED};
            }
            .lanes {
              display: flex;
              flex-direction: column;
              gap: 10px;
            }
            .lane {
              display: grid;
              grid-template-columns: 56px 1fr auto;
              align-items: center;
              gap: 12px;
              padding: 12px 14px;
              border-radius: 11px;
              text-decoration: none;
              color: inherit;
              transition:
                box-shadow 0.15s ease,
                border-color 0.15s ease;
            }
            .lane:hover {
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            }
            .lane:focus-visible {
              outline: 2px solid ${ACCENT_FILL};
              outline-offset: 2px;
            }
            .lane__count {
              font-size: 28px;
              font-weight: 700;
              line-height: 1;
              text-align: center;
            }
            .lane__body {
              display: flex;
              flex-direction: column;
              gap: 4px;
              min-width: 0;
            }
            .lane__label-row {
              display: flex;
              align-items: center;
              gap: 8px;
              flex-wrap: wrap;
            }
            .lane__label {
              font-size: 15px;
              font-weight: 600;
              color: ${TEXT_PRIMARY};
            }
            .lane__chip {
              display: inline-block;
              padding: 2px 7px;
              border-radius: 4px;
              font-size: 10px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              line-height: 16px;
            }
            .lane__chip--agentic {
              background: ${ACCENT_TINT};
              color: ${ACCENT_INK};
              border: 1px solid ${ACCENT_BORDER};
            }
            .lane__chip--start {
              background: ${ACCENT_FILL};
              color: ${BG_WHITE};
            }
            .lane__sowhat {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
            }
            .lane__review {
              font-size: 13px;
              font-weight: 600;
              white-space: nowrap;
            }
            .lanes-footer {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
              padding-top: 12px;
              border-top: 1px solid ${BORDER_DEFAULT};
            }
            .scan-meta {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
              text-align: center;
              padding: 4px 0;
            }
            .scan-meta strong {
              color: ${TEXT_PRIMARY};
            }
            .actions-row {
              display: flex;
              align-items: center;
              gap: 16px;
            }
            .usage-bar-container {
              margin-top: 4px;
            }
            .usage-bar-track {
              height: 8px;
              background: ${BORDER_DEFAULT};
              border-radius: 4px;
              overflow: hidden;
              max-width: 280px;
            }
            .usage-bar-fill {
              height: 100%;
              border-radius: 4px;
              transition: width 0.3s ease;
            }
            .usage-bar-fill--normal { background: ${COLOR_INFO}; }
            .usage-bar-fill--full { background: ${COLOR_CRITICAL}; }
            .usage-text {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
              margin-top: 6px;
            }
            .scan-progress-container {
              display: flex;
              flex-direction: column;
              align-items: center;
              padding: 32px 16px;
              text-align: center;
            }
            .scan-progress-text {
              font-size: 15px;
              color: ${TEXT_SUBDUED};
              margin-top: 8px;
              max-width: 360px;
            }
            .theme-picker-label {
              font-size: 13px;
              font-weight: 500;
              color: ${TEXT_PRIMARY};
              margin-bottom: 4px;
              display: block;
            }
            .theme-picker-select {
              width: 100%;
              padding: 7px 10px;
              border-radius: 8px;
              border: 1px solid ${BORDER_STRONG};
              background: ${BG_WHITE};
              font-size: 14px;
              color: ${TEXT_PRIMARY};
              outline: none;
              cursor: pointer;
              appearance: auto;
            }
            .theme-picker-select:focus {
              border-color: ${COLOR_INFO};
              box-shadow: 0 0 0 2px ${INFO_FOCUS_RING};
            }
            .theme-picker-select:disabled {
              background: ${BG_SURFACE};
              color: ${TEXT_DISABLED};
              cursor: not-allowed;
              border-color: ${BORDER_DEFAULT};
            }
            .theme-picker-nudge {
              font-size: 12px;
              color: ${TEXT_SUBDUED};
              margin-top: 4px;
            }
            .theme-picker-nudge a {
              color: ${COLOR_INFO};
            }
          `}</style>

            {/* Scan Summary — findings count + most recent findings, one floating card */}
            <div style={{ ...sectionCard, marginBottom: 0 }}>
              {/* Not a live region: Home now polls every 3s while a scan runs, so
                  a region here would announce every count and timer change and
                  double ScanProgress's single role="status", which is the one
                  announced line while a scan runs. */}
              <div>
                <s-stack direction="block" gap="base">
                  {scanInProgress ? (
                    <HomeScanInProgress
                      createdAt={latestScan.createdAt}
                      findingCount={latestScan.findingCount}
                      pollingTimedOut={pollingTimedOut}
                    />
                  ) : hasResults && latestScan ? (
                    <>
                      <div className="dashboard-top-row">
                        {/* Left: findings count tile */}
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <h2 className="dashboard-section-title">Findings</h2>
                          {/* Spacer to match the subtitle line height in the right column */}
                          <div style={{ height: "18px" }} />
                          <div
                            className={`health-score-tile health-score-tile--${tile.tone}`}
                            style={{ marginTop: "8px" }}
                          >
                            <div
                              className={`health-score-number health-score-number--${tile.tone}`}
                            >
                              {tile.total}
                            </div>
                            <div className="health-score-subtitle">
                              {findingsTileSubtitle(tile.total, tile.securityRisks)}
                            </div>
                            {findingTrend && (
                              <div
                                className="health-score-delta"
                                style={{
                                  fontWeight: 600,
                                  color:
                                    findingTrend.direction === "improving"
                                      ? COLOR_SUCCESS
                                      : findingTrend.direction === "declining"
                                        ? COLOR_WARNING
                                        : TEXT_SUBDUED,
                                }}
                              >
                                {findingTrend.direction === "improving"
                                  ? `▼ ${findingTrend.previousTotal - tile.total} fewer than last scan`
                                  : findingTrend.direction === "declining"
                                    ? `▲ ${tile.total - findingTrend.previousTotal} more than last scan`
                                    : "No change from last scan"}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Right: health read — the merchant "so what" for this scan */}
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <h2 className="dashboard-section-title">Most Recent Findings</h2>
                          <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginTop: "2px" }}>
                            Scanned{" "}
                            <strong style={{ color: TEXT_PRIMARY }}>{latestScan.themeName}</strong>{" "}
                            on{" "}
                            <FormattedDate value={latestScan.completedAt ?? latestScan.createdAt} />
                          </div>
                          <div className="health-read">
                            {dominant && (
                              <div className="health-read__damage">
                                Most of the damage is in{" "}
                                <span style={{ color: ACCENT_INK }}>
                                  {dominantPhraseForLane(dominant)}
                                </span>
                                {dominantCount > 0
                                  ? ` (${dominantCount} finding${dominantCount === 1 ? "" : "s"})`
                                  : ""}
                                .
                              </div>
                            )}
                            {/* A security risk (gc-q5z8): one line that accounts
                                for the tile (security risks are in no lane), then
                                "See all". Otherwise the leftover-items lead. */}
                            {riskSummaryLine ? (
                              <div className="health-read__lead">
                                {riskSummaryLine}{" "}
                                <Link to={`/app/scans/${latestScan.id}`}>See all</Link>
                              </div>
                            ) : (
                              laneSummary.length > 0 && (
                                <div className="health-read__lead">
                                  {laneTotal} leftover item{laneTotal === 1 ? "" : "s"} from apps
                                  you&apos;ve uninstalled {laneTotal === 1 ? "is" : "are"} still in
                                  your theme. See what each is costing you below.
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <s-text>Run your first scan to see your findings.</s-text>
                  )}
                </s-stack>
              </div>
            </div>

            {/* "Start here" (gc-bn0x): the latest scan's top 3 findings. Renders
              nothing while a scan runs (no successful latest scan) or when the
              scan is clean. */}
            {hasResults && latestScan && (
              <TopFindings findings={topFindings} newlyInactiveApps={newlyInactiveApps} />
            )}

            {/* Consequence lanes — "what it's costing you", worst-first. Lane
              counts leave out ignored findings, so with no lanes this card says
              the theme is clean. It is left out when the scan found known
              malicious code (ignored or not): Theme health below says so. It
              is also left out when the only findings have no lane (an
              affected-app advisory): "You're all clear" would be false, and
              "Start here" above already shows it. */}
            {hasResults &&
              latestScan &&
              !(laneSummary.length === 0 && (maliciousHealth || currentTotal > 0)) && (
                <div style={{ ...sectionCard, marginBottom: 0 }}>
                  <s-stack direction="block" gap="base">
                    <div>
                      <h2 className="dashboard-section-title">
                        {laneSummary.length === 0 ? "You're all clear" : "What it's costing you"}
                      </h2>
                      {laneSummary.length > 0 && (
                        <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginTop: "2px" }}>
                          Grouped by consequence. Start with the flagged lane.
                        </div>
                      )}
                    </div>
                    {laneSummary.length === 0 ? (
                      <div style={{ fontSize: "14px", color: COLOR_SUCCESS }}>
                        No leftover code found. Your theme is clean.
                      </div>
                    ) : (
                      <>
                        <div className="lanes">
                          {orderedLanes.map((row) => {
                            const chip = URGENCY_CHIP[row.urgency];
                            const isStart = row.lane === startHere;
                            const c = LANE_COLOR[row.lane];
                            return (
                              <Link
                                key={row.lane}
                                to={`/app/scans/${latestScanId}?${mergeSearchParams(searchParams, { lane: row.lane })}`}
                                aria-label={`Review ${row.count} ${row.label} finding${row.count === 1 ? "" : "s"}. ${chip.label}${isStart ? ", start here" : ""}`}
                                className={`lane${isStart ? " start" : ""}`}
                                style={{
                                  background: c.tint,
                                  border: `1px solid ${c.bd}`,
                                  borderLeft: `${isStart ? 6 : 5}px solid ${c.fill}`,
                                  ...(isStart
                                    ? {
                                        boxShadow: `0 0 0 1px ${c.bd}, 0 2px 8px rgba(0,0,0,0.06)`,
                                      }
                                    : {}),
                                }}
                              >
                                <div className="lane__count" style={{ color: c.ink }}>
                                  {row.count}
                                </div>
                                <div className="lane__body">
                                  <div className="lane__label-row">
                                    <span className="lane__label">{row.label}</span>
                                    {isStart && (
                                      <span className="lane__chip lane__chip--start">
                                        Start here
                                      </span>
                                    )}
                                    {row.hasAgentic && (
                                      <span className="lane__chip lane__chip--agentic">
                                        AI agents
                                      </span>
                                    )}
                                    <span
                                      className="lane__chip"
                                      style={{
                                        background: chip.bg,
                                        color: chip.text,
                                        ...(chip.border
                                          ? { border: `1px solid ${chip.border}` }
                                          : {}),
                                      }}
                                    >
                                      {chip.label}
                                    </span>
                                  </div>
                                  <div className="lane__sowhat">{soWhatForLane(row.lane)}</div>
                                </div>
                                <div className="lane__review" style={{ color: c.ink }}>
                                  Review →
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                        <div className="lanes-footer">
                          ✓ Then re-scan to confirm it&apos;s gone. Each fix drops your finding
                          count.
                        </div>
                      </>
                    )}
                  </s-stack>
                </div>
              )}

            {/* Theme health (gc-i6du): what the scan checked and found, by
              category. A plain list: no score, no percentage. */}
            {hasResults && latestScan && (
              <ThemeHealthChecklist rows={themeHealth} malicious={maliciousHealth} />
            )}

            {/* Findings Trend — feature-flagged, paid plans only */}
            <HealthScoreTrendChart
              trendChartEnabled={trendChartEnabled}
              healthScoreTrend={healthScoreTrend}
            />

            {/* Trend empty state — paid plan, fewer than 3 completed scans */}
            <HealthScoreTrendEmptyState
              trendChartEnabled={trendChartEnabled}
              showTrendEmptyState={showTrendEmptyState}
              scansNeeded={scansNeeded}
              onStartScan={handleStartScan}
              isSubmitting={isSubmitting}
              scanDisabled={!shop || scanLimitReached}
            />

            {/* Scan Actions — heading lives inside its own floating card */}
            <div style={{ ...sectionCard, marginBottom: 0 }}>
              <s-stack direction="block" gap="base">
                <h2 className="dashboard-section-title">Scan Actions</h2>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                  {/* Left: scan action */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      padding: "20px 16px",
                      borderRadius: "12px",
                      border: `1px solid ${BORDER_DEFAULT}`,
                      background: scanLimitReached ? BG_SURFACE_ALT : BG_WHITE,
                      textAlign: "center",
                      gap: "12px",
                    }}
                  >
                    <s-heading>New Scan</s-heading>
                    {isFirstScan ? (
                      <div style={{ fontSize: "13px", color: COLOR_SUCCESS }}>
                        Your first scan is free
                      </div>
                    ) : scanUsage !== null ? (
                      <div style={{ width: "100%" }}>
                        <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginBottom: "6px" }}>
                          {scanUsageLine(scanUsage)}
                        </div>
                        <div
                          className="usage-bar-track"
                          style={{ margin: "0 auto", maxWidth: "160px" }}
                        >
                          <div
                            className={`usage-bar-fill ${scanLimitReached ? "usage-bar-fill--full" : "usage-bar-fill--normal"}`}
                            style={{
                              width: `${Math.min((scanUsage.used / scanUsage.limit) * 100, 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {/* Theme picker — hidden on Free, disabled on Standard, active on Professional.
                      allThemes is only populated for Standard and Professional (loader skips
                      the fetch on Free), so checking length > 0 is sufficient to gate display. */}
                    {allThemes.length > 0 ? (
                      <div style={{ width: "100%", textAlign: "left" }}>
                        <label htmlFor="theme-picker" className="theme-picker-label">
                          Select theme to scan
                        </label>
                        {/* Native <select> used because Polaris Web Components do not expose <s-select> */}
                        <select
                          id="theme-picker"
                          className="theme-picker-select"
                          value={selectedThemeId}
                          onChange={(e) => setSelectedThemeId(e.target.value)}
                          disabled={!canSelectTheme || isSubmitting}
                          aria-label="Select theme to scan"
                        >
                          {allThemes.map((theme) => (
                            <option key={theme.id} value={theme.id}>
                              {theme.name}
                              {theme.role === "MAIN" ? " (Published)" : " (Draft)"}
                            </option>
                          ))}
                        </select>
                        {!canSelectTheme && (
                          <div className="theme-picker-nudge">
                            <Link to="/app/settings">Upgrade to Professional</Link> to scan any
                            theme
                          </div>
                        )}
                      </div>
                    ) : null}
                    <s-button
                      variant="primary"
                      onClick={handleStartScan}
                      {...(isSubmitting ? { loading: true } : {})}
                      {...(!shop || scanLimitReached ? { disabled: true } : {})}
                    >
                      {isSubmitting ? "Starting..." : "Start New Scan"}
                    </s-button>
                    {scanLimitReached && scanUsage.period === "day" && (
                      // Professional at its daily cap: no upgrade path, just when.
                      <div style={{ fontSize: "12px", color: TEXT_SUBDUED }}>
                        Your next scan is available{" "}
                        <FormattedDate value={scanUsage.nextScanAt} includeTime />
                      </div>
                    )}
                    {scanLimitReached && scanUsage.period !== "day" && (
                      <div style={{ fontSize: "12px", color: TEXT_SUBDUED }}>
                        <Link to="/app/settings" style={{ color: COLOR_INFO }}>
                          Upgrade for more scans
                        </Link>
                      </div>
                    )}
                  </div>
                  {/* Right: scan history */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "20px 16px",
                      borderRadius: "12px",
                      border: `1px solid ${BORDER_DEFAULT}`,
                      background: BG_WHITE,
                      textAlign: "center",
                      gap: "12px",
                    }}
                  >
                    <s-heading>Scan History</s-heading>
                    <div style={{ fontSize: "13px", color: TEXT_SUBDUED }}>
                      View all past scans and findings
                    </div>
                    <Link
                      to="/app/scans"
                      style={{
                        display: "inline-block",
                        padding: "8px 24px",
                        borderRadius: "8px",
                        background: COLOR_INFO,
                        color: BG_WHITE,
                        fontSize: "14px",
                        fontWeight: 600,
                        textDecoration: "none",
                        textAlign: "center",
                      }}
                    >
                      View Scan History
                    </Link>
                  </div>
                </div>
              </s-stack>
            </div>
          </>
        )}
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
