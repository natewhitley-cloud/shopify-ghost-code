import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useFetcher, useLoaderData } from "react-router";

import {
  HealthScoreTrendChart,
  HealthScoreTrendEmptyState,
} from "../components/HealthScoreTrendChart";
import type { HealthScoreTrend, TrendScoreEntry } from "../components/HealthScoreTrendChart";
import { getPlanFeatures } from "../lib/billing.server";
import { formatDate, isSuccessfulScan } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";
import { canStartScan, getScanUsage, getWeekStartUTC } from "../lib/plan-gating.server";
import { PLANS } from "../lib/plans";
import { getFindingSummary } from "../models/finding.server";
import {
  getScansForShop,
  hasCompletedScans,
  getCompletedScansForShop,
} from "../models/scan.server";
import type { ScanQuota } from "../models/scan.server";
import { dismissReviewPrompt, getShopMetadata } from "../models/shop.server";
import { dispatchScan } from "../services/scan-dispatch.server";
import { fetchAllThemes, fetchMainTheme } from "../services/theme-fetcher.server";
import type { ThemeSummary } from "../services/theme-fetcher.server";
import { authenticate } from "../shopify.server";
import {
  BG_BADGE_SUCCESS,
  BG_SURFACE,
  BG_WHITE,
  BORDER_DEFAULT,
  BORDER_STRONG,
  COLOR_CRITICAL,
  COLOR_INFO,
  COLOR_WARNING,
  STATUS_TINTS,
  TEXT_DISABLED,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  tileStatusTintCss,
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
      showReviewPrompt: false,
      healthScoreTrend: null,
      showTrendEmptyState: false,
      scansNeeded: 0,
      trendChartEnabled: false,
    };
  }

  const features = getPlanFeatures(shop.plan);
  const canSelectTheme = features.maxThemes > 1;

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
  const [mainTheme, allThemes, recentScans, completedScansForTrend] = await Promise.all([
    fetchMainTheme(admin),
    shouldFetchThemes ? fetchAllThemes(admin) : Promise.resolve([] as ThemeSummary[]),
    getScansForShop(shop.id, { limit: 2 }),
    shouldFetchTrendScans
      ? getCompletedScansForShop(shop.id, { limit: 7 })
      : Promise.resolve([] as Array<{ id: string; completedAt: Date; themeName: string }>),
  ]);

  const [latestScan = null, previousScan = null] = recentScans.items;

  // Phase 1: queries that depend only on latestScan/previousScan IDs (parallel).
  // getFindingSummary for latestScan is included here — it only needs latestScan.id
  // which is available from Phase 0, so it can run concurrently with the other queries.
  const [findingSummary, prevSummary, usage, completedScanCheck, trendSummaries] =
    await Promise.all([
      latestScan ? getFindingSummary(latestScan.id) : Promise.resolve(null),
      previousScan && isSuccessfulScan(previousScan.status)
        ? getFindingSummary(previousScan.id)
        : Promise.resolve(null),
      getScanUsage(shop.id, shop.plan),
      hasCompletedScans(shop.id),
      // Fetch finding summaries for all trend scans in parallel.
      completedScansForTrend.length > 0
        ? Promise.all(completedScansForTrend.map((s) => getFindingSummary(s.id)))
        : Promise.resolve([] as Awaited<ReturnType<typeof getFindingSummary>>[]),
    ]);

  // Compute health scores from parallel results
  let healthScore: HealthScoreResult | null = null;
  if (latestScan && isSuccessfulScan(latestScan.status) && findingSummary) {
    healthScore = computeHealthScore(findingSummary.bySeverity);
  }

  let previousHealthScore: HealthScoreResult | null = null;
  if (prevSummary) {
    previousHealthScore = computeHealthScore(prevSummary.bySeverity);
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
      .map((scan, i) => {
        const summary = trendSummaries[i];
        const { score, tone, label } = computeHealthScore(summary.bySeverity);
        const highCount = summary.bySeverity.HIGH ?? 0;
        const mediumCount = summary.bySeverity.MEDIUM ?? 0;
        const lowCount = summary.bySeverity.LOW ?? 0;
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

  // Review prompt: show once after the first completed scan with 4+ findings.
  // Permanently dismissed when the merchant clicks "Dismiss" (sets hasSeenReviewPrompt).
  const REVIEW_PROMPT_MIN_FINDINGS = 4;
  const showReviewPrompt =
    latestScan !== null &&
    isSuccessfulScan(latestScan.status) &&
    latestScan.findingCount >= REVIEW_PROMPT_MIN_FINDINGS &&
    !shop.hasSeenReviewPrompt;

  return {
    shop,
    latestScan,
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
    showReviewPrompt,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
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
  const allowThemeSelection = actionFeatures.maxThemes > 1;

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
    ({ scan } = await dispatchScan(shop.id, themeId, themeName, { quota }));
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const {
    shop,
    latestScan,
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
    showReviewPrompt,
    healthScoreTrend,
    showTrendEmptyState,
    scansNeeded,
    trendChartEnabled,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const dismissFetcher = useFetcher<typeof action>();

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

  // Show "—" while a scan is in progress; show counts once completed.
  const highCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.HIGH ?? 0);
  const mediumCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.MEDIUM ?? 0);
  const lowCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.LOW ?? 0);

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
      {/* Error banner — only rendered when the action returns an error */}
      {actionError && (
        <s-banner tone="critical">
          <s-paragraph>{actionError}</s-paragraph>
        </s-banner>
      )}

      {/* Rescan nudge — Standard plan only, >30 days since last completed scan */}
      {showRescanNudge && (
        <s-banner tone="info">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              It&apos;s been over 30 days since your last scan. Re-scan your theme to check for new
              orphaned code from recently uninstalled apps.
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

      {/* App Store review prompt — shown once after first scan with 4+ findings */}
      {showReviewBanner && (
        <s-banner tone="info">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Ghost Code found {latestScan?.findingCount} issues in your theme. If this was helpful,
              we&apos;d love a quick review on the App Store.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={() => window.open("https://apps.shopify.com/ghost-code#reviews", "_blank")}
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
              Over time, apps you&apos;ve removed leave behind scripts, stylesheets, and snippets in
              your theme — slowing your store and cluttering your code. Ghost Code scans your theme
              and flags everything that can be safely removed.
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
            .health-score-number--success { color: ${STATUS_TINTS.success.text}; }
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
              color: ${STATUS_TINTS.success.text};
            }
            .health-score-label--warning {
              background: ${STATUS_TINTS.warning.border};
              color: ${STATUS_TINTS.warning.text};
            }
            .health-score-label--critical {
              background: ${STATUS_TINTS.critical.border};
              color: ${COLOR_CRITICAL};
            }
            .health-score-delta {
              font-size: 13px;
              color: ${TEXT_SUBDUED};
              margin-top: 8px;
            }
            .findings-row {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 16px;
              padding: 4px 0;
              height: 100%;
            }
            .finding-stat {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 24px 8px;
              border-radius: 12px;
              border: 1px solid ${BORDER_DEFAULT};
            }
            .finding-stat--high {
              border-color: ${STATUS_TINTS.critical.border};
              background: ${STATUS_TINTS.critical.bg};
            }
            .finding-stat--medium {
              border-color: ${STATUS_TINTS.warning.border};
              background: ${STATUS_TINTS.warning.bg};
            }
            .finding-stat--low {
              /* #dbeafe — intentionally lighter than STATUS_TINTS.info.border (#b4d5fe);
                 kept distinct to match original dashboard visual */
              border-color: #dbeafe;
              background: ${STATUS_TINTS.info.bg};
            }
            .finding-stat__count {
              font-size: 48px;
              font-weight: 700;
              line-height: 1;
            }
            .finding-stat__count--high { color: ${COLOR_CRITICAL}; }
            .finding-stat__count--medium { color: ${COLOR_WARNING}; }
            .finding-stat__count--low { color: ${COLOR_INFO}; }
            .finding-stat__label {
              font-size: 13px;
              font-weight: 500;
              color: ${TEXT_SUBDUED};
              margin-top: 6px;
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
              /* rgba derived from COLOR_INFO (#2c6ecb) at 20% opacity */
              box-shadow: 0 0 0 2px rgba(44, 110, 203, 0.2);
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

          {/* Theme Health + Findings — combined card */}
          <s-card>
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
                      {/* Right: findings */}
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <h2 className="dashboard-section-title">Most Recent Findings</h2>
                        <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginTop: "2px" }}>
                          Scanned{" "}
                          <strong style={{ color: TEXT_PRIMARY }}>{latestScan.themeName}</strong> on{" "}
                          {formatDate(latestScan.completedAt ?? latestScan.createdAt)}
                        </div>
                        <div className="findings-row" style={{ marginTop: "8px", flex: 1 }}>
                          <div className="finding-stat finding-stat--high">
                            <div className="finding-stat__count finding-stat__count--high">
                              {highCount}
                            </div>
                            <div className="finding-stat__label">High</div>
                          </div>
                          <div className="finding-stat finding-stat--medium">
                            <div className="finding-stat__count finding-stat__count--medium">
                              {mediumCount}
                            </div>
                            <div className="finding-stat__label">Medium</div>
                          </div>
                          <div className="finding-stat finding-stat--low">
                            <div className="finding-stat__count finding-stat__count--low">
                              {lowCount}
                            </div>
                            <div className="finding-stat__label">Low</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <s-text>Run your first scan to see your theme health score.</s-text>
                )}
              </s-stack>
            </div>
          </s-card>

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

          {/* Scan Actions */}
          <div style={{ marginTop: "24px", marginBottom: "8px" }}>
            <h2 className="dashboard-section-title">Scan Actions</h2>
          </div>
          <s-card>
            <s-stack direction="block" gap="base">
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
                    background: scanLimitReached ? "#fafbfb" : BG_WHITE,
                    textAlign: "center",
                    gap: "12px",
                  }}
                >
                  <s-heading>New Scan</s-heading>
                  {isFirstScan ? (
                    <div style={{ fontSize: "13px", color: STATUS_TINTS.success.text }}>
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
                    <div style={{ fontSize: "13px", color: STATUS_TINTS.success.text }}>
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
                          <Link to="/app/settings">Upgrade to Professional</Link> to scan any theme
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
          </s-card>
        </>
      )}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
