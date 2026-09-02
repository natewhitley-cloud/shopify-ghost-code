import { ScanOrigin, Severity } from "@prisma/client";
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useFetcher, useLoaderData, useNavigate } from "react-router";

import {
  HealthScoreTrendChart,
  HealthScoreTrendEmptyState,
} from "../components/HealthScoreTrendChart";
import type { HealthScoreTrend, TrendScoreEntry } from "../components/HealthScoreTrendChart";
import { getPlanFeatures } from "../lib/billing.server";
import {
  computeLaneSummary,
  dominantLane,
  dominantPhraseForLane,
  soWhatForLane,
  startHereLane,
} from "../lib/finding-consequence";
import type { LaneKey, LaneSummaryRow, UrgencyKey } from "../lib/finding-consequence";
import { formatDate, isSuccessfulScan } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";
import {
  canStartScan,
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
  getWeekStartUTC,
} from "../lib/plan-gating.server";
import { PLANS } from "../lib/plans";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../models/finding.server";
import {
  getScansForShop,
  hasCompletedScans,
  getCompletedScansForShop,
} from "../models/scan.server";
import type { ScanQuota } from "../models/scan.server";
import { dismissReviewPrompt, getShopMetadata } from "../models/shop.server";
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

  const shop = await getShopMetadata(session.shop);

  const trendChartEnabled = process.env.ENABLE_TREND_CHART === "true";

  if (!shop) {
    // Shop hasn't been upserted yet (e.g. install is still in progress).
    // Return minimal data so the page renders without crashing.
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
      previousHealthScore: null,
      showRescanNudge: false,
      showThemeChangeNudge: false,
      showMultiThemeNudge: false,
      showReviewPrompt: false,
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
  const [severityCounts, usage, completedScanCheck, typeCounts] = await Promise.all([
    getSeverityCountsForScans(severityScanIds),
    getScanUsage(shop.id, shop.plan),
    hasCompletedScans(shop.id),
    latestScan && isSuccessfulScan(latestScan.status)
      ? getTypeCountsForScan(latestScan.id)
      : Promise.resolve(null),
  ]);

  // Consequence lanes: roll the latest scan's per-type counts up into merchant
  // "so what" lanes. Empty array when there is no successful scan or no findings.
  const laneSummary: LaneSummaryRow[] = typeCounts ? computeLaneSummary(typeCounts) : [];
  const startHere: LaneKey | null = startHereLane(laneSummary);
  const dominant: LaneKey | null = dominantLane(laneSummary);

  const zeroSeverityRecord: Record<Severity, number> = {
    [Severity.HIGH]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.LOW]: 0,
  };

  // Severity record for the latest scan, used both for the health score and the
  // findings display. Kept in a `bySeverity`-shaped object so the returned
  // findingSummary stays compatible with the component (which reads only
  // findingSummary?.bySeverity?.HIGH/MEDIUM/LOW).
  const latestSeverity = latestScan
    ? (severityCounts.get(latestScan.id) ?? zeroSeverityRecord)
    : null;
  const findingSummary = latestSeverity ? { bySeverity: latestSeverity } : null;

  // Compute health scores from parallel results
  let healthScore: HealthScoreResult | null = null;
  if (latestScan && isSuccessfulScan(latestScan.status) && latestSeverity) {
    healthScore = computeHealthScore(latestSeverity);
  }

  let previousHealthScore: HealthScoreResult | null = null;
  if (previousScan && isSuccessfulScan(previousScan.status)) {
    previousHealthScore = computeHealthScore(
      severityCounts.get(previousScan.id) ?? zeroSeverityRecord,
    );
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
    const previousTotal = sumSeverity(severityCounts.get(previousScan.id) ?? zeroSeverityRecord);
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
        const counts = severityCounts.get(scan.id) ?? zeroSeverityRecord;
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
  const showThemeChangeNudge =
    !features.autoRescan &&
    shop.lastThemePublishAt !== null &&
    latestScan !== null &&
    isSuccessfulScan(latestScan.status) &&
    latestScan.completedAt !== null &&
    new Date(shop.lastThemePublishAt) > new Date(latestScan.completedAt);

  // Multi-theme upgrade nudge: a shop whose plan can't scan multiple themes but
  // whose store HAS more than one theme is missing Professional's flagship
  // unlimited-theme differentiator. allThemes is only populated for Standard and
  // Professional (loader skips the fetch on Free), and Professional passes
  // canUseMultipleThemes, so this naturally targets Standard shops with 2+ themes.
  const showMultiThemeNudge = !canUseMultipleThemes(shop.plan) && allThemes.length > 1;

  // Review prompt: show once after the first completed scan with 4+ findings.
  // Permanently dismissed when the merchant clicks "Dismiss" (sets hasSeenReviewPrompt).
  const REVIEW_PROMPT_MIN_FINDINGS = 4;
  const showReviewPrompt =
    latestScan !== null &&
    isSuccessfulScan(latestScan.status) &&
    latestScan.findingCount >= REVIEW_PROMPT_MIN_FINDINGS &&
    !shop.hasSeenReviewPrompt;

  // Expose the latest successful scan id and whether this shop+plan can diff it,
  // so the component can lazily fetch the diff resource route (same pattern as
  // the scan-detail page) to surface NEW high-severity findings without loading
  // findings here (avoids the expensive 2-scan full-findings load — see PRF-2).
  const latestScanId = latestScan && isSuccessfulScan(latestScan.status) ? latestScan.id : null;
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
    previousHealthScore,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showReviewPrompt,
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

  // Handle review prompt dismissal — no plan gating needed.
  if (intent === "dismiss-review-prompt") {
    await dismissReviewPrompt(shop.id);
    return { dismissed: true };
  }

  // Plan-gate: check if this shop is allowed to start a new scan.
  const gate = await canStartScan(shop.id, shop.plan);
  if (!gate.allowed) {
    return { error: gate.reason ?? "Scan limit reached for your current plan." };
  }

  const selectedThemeId = formData.get("themeId") as string | null;

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
  // PENDING for the watchdog to expire, but we still redirect so the merchant
  // can see the queued scan in their history.
  let scan: { id: string };
  try {
    // MANUAL origin: this merchant-initiated scan is the only kind that counts
    // toward the manual weekly/monthly quota (GC-iji). Passed explicitly for clarity.
    ({ scan } = await dispatchScan(shop.id, themeId, themeName, {
      quota,
      origin: ScanOrigin.MANUAL,
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
 * Format a score delta as a signed string, e.g. "+17" or "-5".
 * Returns null when the delta is zero (no change to display).
 */
function formatDelta(current: number, previous: number): string | null {
  const delta = current - previous;
  if (delta === 0) return null;
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * Format elapsed seconds into a human-readable string.
 * Examples: "a few seconds", "30 seconds", "1 minute", "2 minutes", "3 minutes 15 seconds"
 */
function formatElapsedTime(elapsedSeconds: number): string {
  if (elapsedSeconds < 10) return "a few seconds";
  if (elapsedSeconds < 60) return `${Math.floor(elapsedSeconds)} seconds`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = Math.floor(elapsedSeconds % 60);
  if (minutes === 1 && remainingSeconds === 0) return "1 minute";
  if (minutes === 1) return `1 minute ${remainingSeconds} seconds`;
  if (remainingSeconds === 0) return `${minutes} minutes`;
  return `${minutes} minutes ${remainingSeconds} seconds`;
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
  compounding: { label: "Compounding", bg: WARN_BD, text: COLOR_WARNING },
  whenever: { label: "Whenever", bg: BG_SURFACE, text: TEXT_SUBDUED, border: BORDER_DEFAULT },
};

/** Lane count color by urgency — most-urgent lanes read loudest. */
const URGENCY_COUNT_COLOR: Record<UrgencyKey, string> = {
  "act-now": COLOR_CRITICAL,
  compounding: COLOR_WARNING,
  whenever: TEXT_DISABLED,
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
    previousHealthScore,
    showRescanNudge,
    showThemeChangeNudge,
    showMultiThemeNudge,
    showReviewPrompt,
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

  // Lazily fetch the diff for the latest successful scan via the resource route
  // (same pattern as scan-detail — see app.scans.$scanId.tsx) to surface NEW
  // high-severity findings. The diff is never computed in the loader (PRF-2).
  const diffFetcher = useFetcher<{ scanDiff: ScanDiff | null }>();
  // Ref guard prevents re-requesting the diff on subsequent re-renders.
  const diffLoadTriggered = useRef(false);

  useEffect(() => {
    if (!canDiffLatest || !latestScanId || diffLoadTriggered.current) return;
    diffLoadTriggered.current = true;
    diffFetcher.load(`/app/scans/${latestScanId}/diff`);
    // diffFetcher is a stable object; canDiffLatest and latestScanId are the
    // meaningful dependencies here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDiffLatest, latestScanId]);

  // New high-severity findings from the lazily-loaded diff (null until resolved).
  const scanDiff = diffFetcher.data?.scanDiff ?? null;
  const newHigh = scanDiff ? scanDiff.newFindings.filter((f) => f.severity === "HIGH").length : 0;

  // Optimistically hide the review prompt once the merchant clicks Dismiss,
  // so it disappears immediately without waiting for the server round-trip.
  const [reviewPromptDismissed, setReviewPromptDismissed] = useState(false);
  const showReviewBanner = showReviewPrompt && !reviewPromptDismissed;

  const handleDismissReviewPrompt = () => {
    setReviewPromptDismissed(true);
    dismissFetcher.submit({ intent: "dismiss-review-prompt" }, { method: "POST" });
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

  const handleStartScan = () => {
    fetcher.submit({ themeId: selectedThemeId }, { method: "POST" });
  };

  // Whether the latest scan is still running (findings not yet available).
  const scanInProgress = latestScan?.status === "IN_PROGRESS" || latestScan?.status === "PENDING";

  // Elapsed time timer — updates every 5 seconds while a scan is in progress.
  const [elapsedText, setElapsedText] = useState<string>("");

  useEffect(() => {
    if (!scanInProgress || !latestScan?.createdAt) {
      setElapsedText("");
      return;
    }

    const startTime = new Date(latestScan.createdAt).getTime();

    const update = () => {
      const seconds = (Date.now() - startTime) / 1000;
      setElapsedText(formatElapsedTime(seconds));
    };

    // Set initial value immediately.
    update();

    const interval = setInterval(update, 5_000);
    return () => clearInterval(interval);
  }, [scanInProgress, latestScan?.createdAt]);

  // Total findings in the latest completed scan — drives the consequence-lane
  // "so what" copy (the leftover-item sentence).
  const currentTotal =
    (findingSummary?.bySeverity?.HIGH ?? 0) +
    (findingSummary?.bySeverity?.MEDIUM ?? 0) +
    (findingSummary?.bySeverity?.LOW ?? 0);

  // Whether the plan's scan limit (weekly or monthly) has been reached.
  // isFirstScan overrides the limit — the first scan is always allowed on the free plan.
  const scanLimitReached = !isFirstScan && scanUsage !== null && scanUsage.used >= scanUsage.limit;

  // Show onboarding experience when the shop is set up but has never been scanned.
  const showOnboarding = !!shop && !latestScan;

  // Score delta: only meaningful when both latest and previous are completed.
  const scoreDelta =
    healthScore && previousHealthScore
      ? formatDelta(healthScore.score, previousHealthScore.score)
      : null;

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

        {/* App Store review prompt — shown once after first scan with 4+ findings */}
        {showReviewBanner && (
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Ghost Code found {latestScan?.findingCount} issues in your theme. If this was
                helpful, we&apos;d love a quick review on the App Store.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  onClick={() =>
                    window.open(
                      "https://apps.shopify.com/ghost-code#modal-show=WriteReviewModal",
                      "_blank",
                    )
                  }
                >
                  Leave a Review
                </s-button>
                <s-button variant="secondary" onClick={handleDismissReviewPrompt}>
                  Dismiss
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
              align-items: stretch;
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
            .health-read__trend {
              font-size: 13px;
              font-weight: 600;
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
              border: 1px solid ${BORDER_DEFAULT};
              background: ${BG_WHITE};
              text-decoration: none;
              color: inherit;
              transition:
                box-shadow 0.15s ease,
                border-color 0.15s ease;
            }
            .lane:hover {
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            }
            .lane.start {
              border-color: ${ACCENT_FILL};
              box-shadow: 0 0 0 3px ${ACCENT_TINT};
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
            .scan-progress-elapsed {
              font-size: 13px;
              color: ${TEXT_DISABLED};
              margin-top: 12px;
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
              {/* aria-live="polite" ensures screen readers announce when scan status changes */}
              <div aria-live="polite">
                <s-stack direction="block" gap="base">
                  {scanInProgress ? (
                    <div className="scan-progress-container">
                      <s-spinner accessibilityLabel="Scanning theme" size="large" />
                      <s-heading>Scanning your theme...</s-heading>
                      <div className="scan-progress-text">
                        Ghost Code is analyzing your theme files for orphaned code. Results will
                        appear here when the scan is complete.
                      </div>
                      {elapsedText && (
                        <div className="scan-progress-elapsed">Started {elapsedText} ago</div>
                      )}
                      <div className="scan-progress-elapsed">
                        This typically takes 1–3 minutes depending on theme size.
                      </div>
                    </div>
                  ) : healthScore && latestScan ? (
                    <>
                      <div className="dashboard-top-row">
                        {/* Left: health score tile */}
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <h2 className="dashboard-section-title">Theme Health</h2>
                          {/* Spacer to match the subtitle line height in the right column */}
                          <div style={{ height: "18px" }} />
                          <div
                            className={`health-score-tile health-score-tile--${healthScore.tone}`}
                            style={{ marginTop: "8px", flex: 1 }}
                          >
                            <div
                              className={`health-score-number health-score-number--${healthScore.tone}`}
                            >
                              {healthScore.score}
                            </div>
                            <div className="health-score-subtitle">out of 100</div>
                            <div
                              className={`health-score-label health-score-label--${healthScore.tone}`}
                            >
                              {healthScore.label}
                            </div>
                            {previousHealthScore && (
                              <div className="health-score-delta">
                                Prev: {previousHealthScore.score}
                                {scoreDelta ? ` (${scoreDelta})` : ""}
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
                            on {formatDate(latestScan.completedAt ?? latestScan.createdAt)}
                          </div>
                          <div className="health-read">
                            {dominant && (
                              <div className="health-read__damage">
                                Most of the damage is in{" "}
                                <span style={{ color: ACCENT_INK }}>
                                  {dominantPhraseForLane(dominant)}
                                </span>
                                .
                              </div>
                            )}
                            {findingTrend && (
                              <div
                                className="health-read__trend"
                                style={{
                                  color:
                                    findingTrend.direction === "improving"
                                      ? COLOR_SUCCESS
                                      : findingTrend.direction === "declining"
                                        ? COLOR_WARNING
                                        : TEXT_SUBDUED,
                                }}
                              >
                                {findingTrend.direction === "improving"
                                  ? `▲ Improving: down from ${findingTrend.previousTotal} findings last scan`
                                  : findingTrend.direction === "declining"
                                    ? `▼ Up from ${findingTrend.previousTotal} findings last scan`
                                    : "No change from last scan"}
                              </div>
                            )}
                            {laneSummary.length > 0 && (
                              <div className="health-read__lead">
                                {currentTotal} leftover item{currentTotal === 1 ? "" : "s"} from
                                apps you&apos;ve uninstalled are still in your theme. Here&apos;s
                                what they&apos;re doing, worst first.
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
                    <h2 className="dashboard-section-title">What it&apos;s costing you</h2>
                    <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginTop: "2px" }}>
                      Grouped by consequence. Start with the flagged lane.
                    </div>
                  </div>
                  {laneSummary.length === 0 ? (
                    <div style={{ fontSize: "14px", color: COLOR_SUCCESS }}>
                      No leftover code found. Your theme is clean.
                    </div>
                  ) : (
                    <>
                      <div className="lanes">
                        {laneSummary.map((row) => {
                          const chip = URGENCY_CHIP[row.urgency];
                          const isStart = row.lane === startHere;
                          const isWhenever = row.urgency === "whenever";
                          return (
                            <Link
                              key={row.lane}
                              to={`/app/scans/${latestScanId}?lane=${row.lane}`}
                              aria-label={`Review ${row.label} findings`}
                              className={`lane${isStart ? " start" : ""}`}
                            >
                              <div
                                className="lane__count"
                                style={{ color: URGENCY_COUNT_COLOR[row.urgency] }}
                              >
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
                              <div
                                className="lane__review"
                                style={{ color: isWhenever ? TEXT_SUBDUED : ACCENT_INK }}
                              >
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
