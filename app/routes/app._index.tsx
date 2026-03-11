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
import { getFindingSummary } from "../models/finding.server";
import { canStartScan } from "../lib/plan-gating.server";
import { getPlanFeatures, PLANS } from "../lib/billing.server";
import { fetchMainTheme } from "../services/theme-fetcher.server";
import { inngest } from "../../inngest/client";
import { formatDate } from "../lib/format";

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
    };
  }

  // Fetch the main theme so the UI can show which theme will be scanned.
  const mainTheme = await fetchMainTheme(admin);

  // getScansForShop returns newest-first; take the first result.
  const [latestScan = null] = await getScansForShop(shop.id, { limit: 1 });

  const findingSummary = latestScan ? await getFindingSummary(latestScan.id) : null;

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

  return { shop, latestScan, findingSummary, mainTheme, scanUsage, isFirstScan };
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
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { shop, latestScan, findingSummary, mainTheme, scanUsage, isFirstScan } =
    useLoaderData<typeof loader>();
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

  return (
    <s-page heading="Ghost Code Scanner">
      {/* Error banner — only rendered when the action returns an error */}
      {actionError && (
        <s-banner tone="critical">
          <s-paragraph>{actionError}</s-paragraph>
        </s-banner>
      )}

      {showOnboarding ? (
        /* Onboarding card — shown on first install before any scan has run */
        <s-card>
          <s-stack direction="block" gap="loose">
            <s-heading>Welcome to Ghost Code</s-heading>
            <s-paragraph>
              <strong>Ghost Code finds and removes leftover code from uninstalled apps.</strong>{" "}
              Over time, apps you've removed leave behind scripts, stylesheets, and snippets in your
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
