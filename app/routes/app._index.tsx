import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import {
  getScansForShop,
  createScan,
  countScansForShopSince,
  hasCompletedScans,
} from "../models/scan.server";
import { getFindingSummary, getDistinctFileCount } from "../models/finding.server";
import { canStartScan } from "../lib/plan-gating.server";
import { getPlanFeatures, PLANS } from "../lib/billing.server";
import { fetchMainTheme } from "../services/theme-fetcher.server";
import { inngest } from "../../inngest/client";
import { formatDate } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    // Shop hasn't been upserted yet (e.g. install is still in progress).
    // Return minimal data so the page renders without crashing.
    return {
      shop: null,
      latestScan: null,
      findingSummary: null,
      mainTheme: null,
      scanUsage: null,
      isFirstScan: true,
      healthScore: null,
      previousHealthScore: null,
      showRescanNudge: false,
      showThemeChangeNudge: false,
    };
  }

  // Fetch the main theme so the UI can show which theme will be scanned.
  const mainTheme = await fetchMainTheme(admin);

  // Fetch the two most recent scans: [latest, previous?].
  // getScansForShop applies take: limit + 1 internally, so limit: 2 fetches 3
  // to detect hasNextPage. We only need 2 real rows, so slice to be safe.
  const recentScans = await getScansForShop(shop.id, { limit: 2 });
  const [latestScan = null, previousScan = null] = recentScans;

  const findingSummary = latestScan ? await getFindingSummary(latestScan.id) : null;

  // Compute health score for the latest COMPLETED scan.
  let healthScore: HealthScoreResult | null = null;
  if (latestScan && latestScan.status === "COMPLETED" && findingSummary) {
    const fileCount = await getDistinctFileCount(latestScan.id);
    healthScore = computeHealthScore(findingSummary.bySeverity, fileCount);
  }

  // Compute health score for the previous COMPLETED scan (for delta display).
  let previousHealthScore: HealthScoreResult | null = null;
  if (previousScan && previousScan.status === "COMPLETED") {
    const [prevSummary, prevFileCount] = await Promise.all([
      getFindingSummary(previousScan.id),
      getDistinctFileCount(previousScan.id),
    ]);
    previousHealthScore = computeHealthScore(prevSummary.bySeverity, prevFileCount);
  }

  // Compute scan usage for free-plan shops so the UI can show X of Y scans used.
  // Paid plans have unlimited scans; return null so the UI omits the indicator.
  const features = getPlanFeatures(shop.plan);
  let scanUsage: { used: number; limit: number } | null = null;
  let isFirstScan = false;
  if (features.maxScansPerMonth !== Infinity) {
    const alreadyScanned = await hasCompletedScans(shop.id);
    isFirstScan = !alreadyScanned;
    if (!isFirstScan) {
      // Only show the monthly usage counter after the first scan is complete.
      // Before that, the onboarding card handles messaging.
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const used = await countScansForShopSince(shop.id, monthStart);
      scanUsage = { used, limit: features.maxScansPerMonth };
    }
  }

  // Rescan nudge: show for Standard-plan shops whose last completed scan is
  // older than 30 days and no scan is currently running.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const showRescanNudge =
    shop.plan === PLANS.STANDARD &&
    latestScan !== null &&
    latestScan.status === "COMPLETED" &&
    latestScan.completedAt !== null &&
    Date.now() - new Date(latestScan.completedAt).getTime() > THIRTY_DAYS_MS;

  // Theme change nudge: show when a theme was published since the last completed
  // scan, indicating orphaned-code risk may have changed.
  // Suppressed for Professional plan shops — they get auto-rescan instead.
  const showThemeChangeNudge =
    !features.autoRescan &&
    shop.lastThemePublishAt !== null &&
    latestScan !== null &&
    latestScan.status === "COMPLETED" &&
    latestScan.completedAt !== null &&
    new Date(shop.lastThemePublishAt) > new Date(latestScan.completedAt);

  return {
    shop,
    latestScan,
    findingSummary,
    mainTheme,
    scanUsage,
    isFirstScan,
    healthScore,
    previousHealthScore,
    showRescanNudge,
    showThemeChangeNudge,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);
  if (!shop) {
    return { error: "Shop not found. Please reinstall the app." };
  }

  // Plan-gate: check if this shop is allowed to start a new scan.
  const gate = await canStartScan(shop.id, shop.plan);
  if (!gate.allowed) {
    return { error: gate.reason ?? "Scan limit reached for your current plan." };
  }

  // Fetch the shop's published (MAIN) theme to get a real themeId and name.
  const mainTheme = await fetchMainTheme(admin);
  if (!mainTheme) {
    return { error: "No published theme found. Please publish a theme before scanning." };
  }

  // mainTheme.id is already the full GID string (e.g. gid://shopify/Theme/123456).
  const themeId = mainTheme.id;
  const themeName = mainTheme.name;

  // createScan is atomic: it checks for an active scan and creates in one
  // transaction. Catch the "already in progress" error so it surfaces cleanly
  // rather than as an unhandled 500. canStartScan above is an advisory pre-flight
  // check for UX; createScan is the authoritative atomic guard.
  let scan: Awaited<ReturnType<typeof createScan>>;
  try {
    scan = await createScan(shop.id, themeId, themeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create scan.";
    return { error: message };
  }

  await inngest.send({
    name: "scan/requested",
    data: { shopId: shop.id, themeId, scanId: scan.id },
  });

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const {
    shop,
    latestScan,
    findingSummary,
    mainTheme,
    scanUsage,
    isFirstScan,
    healthScore,
    previousHealthScore,
    showRescanNudge,
    showThemeChangeNudge,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";

  const actionError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  const handleStartScan = () => {
    fetcher.submit({}, { method: "POST" });
  };

  // Whether the latest scan is still running (findings not yet available).
  const scanInProgress = latestScan?.status === "IN_PROGRESS" || latestScan?.status === "PENDING";

  // Show "—" while a scan is in progress; show counts once completed.
  const highCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.HIGH ?? 0);
  const mediumCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.MEDIUM ?? 0);
  const lowCount = scanInProgress ? "—" : String(findingSummary?.bySeverity?.LOW ?? 0);

  // Whether the free-plan monthly limit has been reached.
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

      {showOnboarding ? (
        /* Onboarding card — shown on first install before any scan has run */
        <s-card>
          <s-stack direction="block" gap="loose">
            <s-heading>Welcome to Ghost Code</s-heading>
            <s-paragraph>
              <strong>Ghost Code finds and removes leftover code from uninstalled apps.</strong>{" "}
              Over time, apps you&apos;ve removed leave behind scripts, stylesheets, and snippets in your
              theme — slowing your store and cluttering your code. Ghost Code scans your theme and
              flags everything that can be safely removed.
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
          {/* Theme Health Score — hero metric card */}
          <s-card>
            <s-stack direction="block" gap="base">
              <s-heading>Theme Health Score</s-heading>
              {scanInProgress ? (
                <s-stack direction="inline" gap="base">
                  <s-text variant="headingXl">—</s-text>
                  <s-text>Scan in progress. Score will update when complete.</s-text>
                </s-stack>
              ) : healthScore ? (
                <s-stack direction="inline" gap="base">
                  <s-text variant="headingXl">{healthScore.score}</s-text>
                  <s-badge tone={healthScore.tone}>{healthScore.label}</s-badge>
                  {previousHealthScore && (
                    <s-text>
                      {previousHealthScore.score} → {healthScore.score}
                      {scoreDelta ? ` (${scoreDelta})` : " (no change)"}
                    </s-text>
                  )}
                </s-stack>
              ) : (
                <s-text>Run your first scan to see your theme health score.</s-text>
              )}
            </s-stack>
          </s-card>

          {/* Last scan summary card */}
          <s-card>
            <s-stack direction="block" gap="base">
              <s-heading>Last Scan</s-heading>
              {latestScan ? (
                <>
                  <s-paragraph>
                    Scanned <strong>{latestScan.themeName}</strong> on{" "}
                    {formatDate(latestScan.completedAt ?? latestScan.createdAt)}
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-badge tone="critical">{highCount} High</s-badge>
                    <s-badge tone="warning">{mediumCount} Medium</s-badge>
                    <s-badge tone="info">{lowCount} Low</s-badge>
                  </s-stack>
                </>
              ) : (
                <s-paragraph>No scans yet. Run your first scan to detect ghost code.</s-paragraph>
              )}
            </s-stack>
          </s-card>

          {/* Quick actions card */}
          <s-card>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  onClick={handleStartScan}
                  {...(isSubmitting ? { loading: true } : {})}
                  {...(!shop || scanLimitReached ? { disabled: true } : {})}
                >
                  Start New Scan
                </s-button>
                <s-link href="/app/scans">View Scan History</s-link>
              </s-stack>
              {/* Free-plan usage indicator — only shown when the plan has a monthly cap */}
              {isFirstScan ? (
                <s-text>Your first scan is free — no limits apply.</s-text>
              ) : scanUsage !== null ? (
                <s-text>
                  {scanLimitReached ? (
                    <>
                      Monthly scan limit reached ({scanUsage.used} of {scanUsage.limit} used).{" "}
                      <a href="/app/settings">Upgrade for unlimited scans.</a>
                    </>
                  ) : (
                    <>
                      Scans this month: {scanUsage.used} of {scanUsage.limit}
                    </>
                  )}
                </s-text>
              ) : null}
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
