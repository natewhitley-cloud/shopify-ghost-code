import { ScanOrigin, Severity } from "@prisma/client";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import { FormattedDate } from "../components/FormattedDate";
import {
  HealthScoreTrendChart,
  HealthScoreTrendEmptyState,
} from "../components/HealthScoreTrendChart";
import type { HealthScoreTrend, TrendScoreEntry } from "../components/HealthScoreTrendChart";
import { ScanProgress } from "../components/ScanProgress";
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
import { isSuccessfulScan } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";
import { logger } from "../lib/logger.server";
import { mergeSearchParams } from "../lib/merge-search-params";
import {
  canStartScan,
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
  getWeekStartUTC,
} from "../lib/plan-gating.server";
import { PLANS } from "../lib/plans";
import { HOME_DEFERRED_PROMPTS, HOME_PROMPTS } from "../lib/prompt-cap";
import { homeScanStartPayload, parseScanSource } from "../lib/scan-source";
import { isScanStaleAfterThemeChange } from "../lib/stale-results";
import { HOME_POLL_TIMEOUT_MESSAGE, useScanPolling } from "../lib/use-scan-polling";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../models/finding.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import {
  getScansForShop,
  hasCompletedScans,
  getCompletedScansForShop,
} from "../models/scan.server";
import type { ScanQuota } from "../models/scan.server";
import { getOrCreateShopMetadata, getShopMetadata } from "../models/shop.server";
import { getFilteredFindingSummary } from "../services/finding-aggregation.server";
import {
  recordJourneyMilestoneOnce,
  recordScanResultsViewOnce,
} from "../services/journey-milestone.server";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { loadShopPromptState, resolvePrompt } from "../services/prompt-cap.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { dispatchScan } from "../services/scan-dispatch.server";
import { getCachedAllThemes, getCachedMainTheme } from "../services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../services/theme-fetcher.server";
import type { ThemeSummary } from "../services/theme-fetcher.server";
import { authenticate } from "../shopify.server";
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
  LANE_BLUE_BD,
  LANE_BLUE_FILL,
  LANE_BLUE_INK,
  LANE_BLUE_TINT,
  LANE_GREY_BD,
  LANE_GREY_FILL,
  LANE_GREY_INK,
  LANE_GREY_TINT,
  LANE_PURPLE_BD,
  LANE_PURPLE_FILL,
  LANE_PURPLE_INK,
  LANE_PURPLE_TINT,
  LANE_TEAL_BD,
  LANE_TEAL_FILL,
  LANE_TEAL_INK,
  LANE_TEAL_TINT,
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
      healthScore: null,
      showRescanNudge: false,
      showThemeChangeNudge: false,
      showMultiThemeNudge: false,
      showFeedbackNudge: false,
      healthScoreTrend: null,
      showTrendEmptyState: false,
      scansNeeded: 0,
      trendChartEnabled: false,
      laneSummary: [] as LaneSummaryRow[],
      startHere: null as LaneKey | null,
      dominant: null as LaneKey | null,
      findingTrend: null,
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
  const now = new Date();
  const [severityCounts, usage, completedScanCheck, typeCounts, ignores, promptState] =
    await Promise.all([
      getSeverityCountsForScans(severityScanIds),
      getScanUsage(shop.id, shop.plan),
      hasCompletedScans(shop.id),
      latestScan && isSuccessfulScan(latestScan.status)
        ? getTypeCountsForScan(latestScan.id)
        : Promise.resolve(null),
      getIgnoredFindingsForShop(shop.id),
      loadShopPromptState(shop, now),
    ]);

  const zeroSeverityRecord: Record<Severity, number> = {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };

  // Severity + per-type counts for the latest scan, used for the health score,
  // the findings display, and the consequence lanes. Kept in a `bySeverity`-
  // shaped object so the returned findingSummary stays compatible with the
  // component (which reads only findingSummary?.bySeverity?.HIGH/MEDIUM/LOW).
  //
  // E2.2 (gc-57t): the batch severity query and getTypeCountsForScan above are
  // lean groupBy aggregates that CANNOT exclude INSTANCE (fingerprint) ignores.
  // So when this shop has active suppressions we rebuild an ignore-filtered
  // severity map covering EVERY scan the dashboard aggregates — latest, previous,
  // AND the trend scans (exactly `severityScanIds`) — and route the health tile,
  // the finding-count trend, and the trend chart through that single source so
  // they can never disagree for the same scan. Filtering ALL scans (including
  // historical/previous) by the CURRENT ignore set is the correct, consistent
  // behavior: an ignored fingerprint or app-level rule applies across every scan,
  // so a merchant who suppresses a finding sees it removed from history too.
  //
  // Cost: shops with NO suppressions skip this entirely and keep the fast batch
  // groupBy path (zero extra queries). When ignores exist, the per-scan filtered
  // load runs once per dashboard load over the already-bounded severityScanIds
  // set (latest + previous + the trend window) — never for scans outside it.
  const hasIgnores = ignores.fingerprints.size > 0 || ignores.appNames.size > 0;
  let filteredSeverityByScanId: Map<string, Record<Severity, number>> | null = null;
  let latestTypeCounts = typeCounts;
  if (hasIgnores) {
    const summaries = await Promise.all(
      severityScanIds.map(
        async (id) => [id, await getFilteredFindingSummary(id, ignores)] as const,
      ),
    );
    filteredSeverityByScanId = new Map(summaries.map(([id, summary]) => [id, summary.bySeverity]));
    // The latest successful scan's ignore-filtered per-type counts feed the lanes.
    if (latestScan && isSuccessfulScan(latestScan.status)) {
      const latest = summaries.find(([id]) => id === latestScan.id);
      if (latest) latestTypeCounts = latest[1].byType;
    }
  }

  // Single ignore-aware severity accessor: reads the filtered map when the shop
  // has suppressions, else the lean batch groupBy. Every severity read below
  // (health tile, finding-count trend, trend chart) goes through this so they
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
  const startHere: LaneKey | null = startHereLane(laneSummary);
  const dominant: LaneKey | null = dominantLane(laneSummary);

  const findingSummary = latestSeverity ? { bySeverity: latestSeverity } : null;

  // Compute health scores from parallel results
  let healthScore: HealthScoreResult | null = null;
  if (latestScan && isSuccessfulScan(latestScan.status) && latestSeverity) {
    healthScore = computeHealthScore(latestSeverity);
  }

  // Finding-count trend: compare the latest scan's total finding count against
  // the previous successful scan's. Fewer findings = improving. Derived from the
  // severity counts already fetched — no extra query. null when there is no
  // successful previous scan to compare against.
  const sumSeverity = (r: Record<Severity, number>) => r.HIGH + r.MEDIUM + r.LOW;
  let findingTrend: {
    direction: "improving" | "declining" | "stable";
    previousTotal: number;
  } | null = null;
  if (latestSeverity && previousScan && isSuccessfulScan(previousScan.status)) {
    const currentTotal = sumSeverity(latestSeverity);
    const previousTotal = sumSeverity(severityForScan(previousScan.id));
    const direction =
      currentTotal < previousTotal
        ? "improving"
        : currentTotal > previousTotal
          ? "declining"
          : "stable";
    findingTrend = { direction, previousTotal };
  }

  // Compute health score trend — paid plans only, requires >= 3 completed scans.
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
        const { score, tone, label } = computeHealthScore(counts);
        const highCount = counts.HIGH ?? 0;
        const mediumCount = counts.MEDIUM ?? 0;
        const lowCount = counts.LOW ?? 0;
        return {
          scanId: scan.id,
          score,
          tone,
          label,
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

  // Compute scan usage for plans with caps (Free = monthly, Standard = weekly).
  const isFirstScan = !completedScanCheck;
  const scanUsage: { used: number; limit: number; period: "week" | "month" } | null =
    usage && !isFirstScan ? { used: usage.used, limit: usage.limit, period: usage.period } : null;

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
  // only the feedback nudge (gc-97k.3). resolvePrompt computes the shop's
  // GLOBAL eligibility, so while a higher-priority prompt (the review popup or
  // the Free return banner, both scan-page only) is pending, Home renders
  // nothing and claims nothing.
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
    healthScore,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showFeedbackNudge,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
    laneSummary,
    startHere,
    dominant,
    findingTrend,
  };
};

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

  const actionFeatures = getPlanFeatures(shop.plan);
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
  if (actionFeatures.maxScansPerMonth !== Infinity || actionFeatures.maxScansPerWeek !== Infinity) {
    const isFirstScan = !(await hasCompletedScans(shop.id));
    if (actionFeatures.maxScansPerWeek !== Infinity) {
      quota = {
        periodStart: getWeekStartUTC(),
        maxScans: actionFeatures.maxScansPerWeek,
        periodLabel: "week",
        isFirstScan,
      };
    } else {
      const now = new Date();
      quota = {
        periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        maxScans: actionFeatures.maxScansPerMonth,
        periodLabel: "month",
        isFirstScan,
      };
    }
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
    // toward the manual weekly/monthly quota (GC-iji). Passed explicitly for clarity.
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
        Ghost Code is analyzing your theme files for orphaned code. Results will appear here when
        the scan is complete.
      </div>
      <div style={{ marginTop: "12px" }}>
        <ScanProgress createdAt={createdAt} findingCount={findingCount} />
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

/** Per-lane brand identity: left stripe (fill), count/link ink, card tint, border. */
const LANE_COLOR: Record<LaneKey, { fill: string; ink: string; tint: string; bd: string }> = {
  "customers-see-it": {
    fill: LANE_BLUE_FILL,
    ink: LANE_BLUE_INK,
    tint: LANE_BLUE_TINT,
    bd: LANE_BLUE_BD,
  },
  discoverability: {
    fill: LANE_PURPLE_FILL,
    ink: LANE_PURPLE_INK,
    tint: LANE_PURPLE_TINT,
    bd: LANE_PURPLE_BD,
  },
  speed: { fill: LANE_TEAL_FILL, ink: LANE_TEAL_INK, tint: LANE_TEAL_TINT, bd: LANE_TEAL_BD },
  privacy: { fill: ACCENT_FILL, ink: ACCENT_INK, tint: ACCENT_TINT, bd: ACCENT_BORDER },
  housekeeping: {
    fill: LANE_GREY_FILL,
    ink: LANE_GREY_INK,
    tint: LANE_GREY_TINT,
    bd: LANE_GREY_BD,
  },
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
    healthScore,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showFeedbackNudge,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
    laneSummary,
    startHere,
    dominant,
    findingTrend,
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

  // Finding count for the dominant consequence lane — surfaced in the hero's
  // "most of the damage is in …" line so the merchant knows how many findings
  // that top lane represents.
  const dominantCount = dominant
    ? (laneSummary.find((row) => row.lane === dominant)?.count ?? 0)
    : 0;

  // Whether the plan's scan limit (weekly or monthly) has been reached.
  // isFirstScan overrides the limit — the first scan is always allowed on the free plan.
  const scanLimitReached = !isFirstScan && scanUsage !== null && scanUsage.used >= scanUsage.limit;

  // Show onboarding experience when the shop is set up but has never been scanned.
  const showOnboarding = !!shop && !latestScan;

  return (
    <s-page heading="Ghost Code Scanner">
      <div style={hairline} />
      <div style={groundStyle}>
        {/* Error banner — only rendered when the action returns an error */}
        {actionError && (
          <s-banner tone="critical">
            <s-paragraph>{actionError}</s-paragraph>
          </s-banner>
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

        {/* Merchant feedback nudge (gc-97k.3), the only interruptive prompt Home
          can render (resolvePrompt in the loader). */}
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
              <s-heading>Welcome to Ghost Code</s-heading>
              <s-paragraph>
                <strong>Ghost Code finds and removes leftover code from uninstalled apps.</strong>{" "}
                Over time, apps you&apos;ve removed leave behind scripts, stylesheets, and snippets
                in your theme — slowing your store and cluttering your code. Ghost Code scans your
                theme and flags everything that can be safely removed.
              </s-paragraph>
              {mainTheme ? (
                <s-paragraph>
                  Your active theme is <strong>{mainTheme.name}</strong>. Ghost Code will scan that
                  theme for ghost code left behind by uninstalled apps.
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

            {/* Scan Summary — Theme Health + Findings, one floating card */}
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
                  ) : healthScore && latestScan ? (
                    <>
                      <div className="dashboard-top-row">
                        {/* Left: health score tile */}
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <h2 className="dashboard-section-title">Theme Health</h2>
                          {/* Spacer to match the subtitle line height in the right column */}
                          <div style={{ height: "18px" }} />
                          <div
                            className={`health-score-tile health-score-tile--${currentTotal === 0 ? "success" : "warning"}`}
                            style={{ marginTop: "8px" }}
                          >
                            <div
                              className={`health-score-number health-score-number--${currentTotal === 0 ? "success" : "warning"}`}
                            >
                              {currentTotal}
                            </div>
                            <div className="health-score-subtitle">
                              {currentTotal === 1 ? "finding" : "findings"}
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
                                  ? `▼ ${findingTrend.previousTotal - currentTotal} fewer than last scan`
                                  : findingTrend.direction === "declining"
                                    ? `▲ ${currentTotal - findingTrend.previousTotal} more than last scan`
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
                            {laneSummary.length > 0 && (
                              <div className="health-read__lead">
                                {currentTotal} leftover item{currentTotal === 1 ? "" : "s"} from
                                apps you&apos;ve uninstalled {currentTotal === 1 ? "is" : "are"}{" "}
                                still in your theme. See what each is costing you below.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <s-text>Run your first scan to see your theme health score.</s-text>
                  )}
                </s-stack>
              </div>
            </div>

            {/* Consequence lanes — "what it's costing you", worst-first */}
            {healthScore && latestScan && (
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
                                    <span className="lane__chip lane__chip--start">Start here</span>
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
                        ✓ Then re-scan to confirm it&apos;s gone. Each fix drops your finding count.
                        Watch the trend climb back toward 100.
                      </div>
                    </>
                  )}
                </s-stack>
              </div>
            )}

            {/* Health Score Trend — feature-flagged, paid plans only */}
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
                          {scanUsage.used} of {scanUsage.limit} used this {scanUsage.period}
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
                    ) : (
                      <div style={{ fontSize: "13px", color: COLOR_SUCCESS }}>
                        Unlimited scans on your plan
                      </div>
                    )}
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
                    {scanLimitReached && (
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
