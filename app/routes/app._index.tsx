import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useFetcher,
  useLoaderData,
} from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getScansForShop, createScan } from "../models/scan.server";
import { getFindingSummary } from "../models/finding.server";
import { canStartScan } from "../lib/plan-gating.server";
import { inngest } from "../../inngest/client";
import { formatDate } from "../lib/format";

/**
 * Fetch the shop's MAIN (published) theme and return its GID and name.
 * Returns null if no MAIN theme is found.
 */
async function fetchMainTheme(
  admin: { graphql: (query: string) => Promise<{ json: () => Promise<unknown> }> }
): Promise<{ id: string; name: string } | null> {
  const response = await admin.graphql(`
    {
      themes(first: 1, roles: MAIN) {
        nodes {
          id
          name
        }
      }
    }
  `);

  const body = (await response.json()) as {
    data?: {
      themes?: {
        nodes?: Array<{ id: string; name: string }>;
      };
    };
  };

  const node = body?.data?.themes?.nodes?.[0];
  if (!node) return null;

  return { id: node.id, name: node.name };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    // Shop hasn't been upserted yet (e.g. install is still in progress).
    // Return minimal data so the page renders without crashing.
    return { shop: null, latestScan: null, findingSummary: null, mainTheme: null };
  }

  // Fetch the main theme so the UI can show which theme will be scanned.
  const mainTheme = await fetchMainTheme(admin);

  // getScansForShop returns newest-first; take the first result.
  const [latestScan = null] = await getScansForShop(shop.id, { limit: 1 });

  const findingSummary = latestScan
    ? await getFindingSummary(latestScan.id)
    : null;

  return { shop, latestScan, findingSummary, mainTheme };
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

  const scan = await createScan(shop.id, themeId, themeName);

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
  const { shop, latestScan, findingSummary, mainTheme } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const actionError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  // Errors are rendered via inline <s-banner>; no side-effects needed here.
  useEffect(() => {}, [actionError]);

  const handleStartScan = () => {
    fetcher.submit({}, { method: "POST" });
  };

  const severityCounts = findingSummary?.bySeverity ?? {
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };

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
              Over time, apps you've removed leave behind scripts, stylesheets, and snippets
              in your theme — slowing your store and cluttering your code. Ghost Code scans your
              theme and flags everything that can be safely removed.
            </s-paragraph>
            {mainTheme ? (
              <s-paragraph>
                Your active theme is <strong>{mainTheme.name}</strong>. Ghost Code will scan
                that theme for ghost code left behind by uninstalled apps.
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
                    <s-badge tone="critical">{severityCounts.HIGH} High</s-badge>
                    <s-badge tone="warning">{severityCounts.MEDIUM} Medium</s-badge>
                    <s-badge tone="info">{severityCounts.LOW} Low</s-badge>
                  </s-stack>
                </>
              ) : (
                <s-paragraph>
                  No scans yet. Run your first scan to detect ghost code.
                </s-paragraph>
              )}
            </s-stack>
          </s-card>

          {/* Quick actions card */}
          <s-card>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={handleStartScan}
                {...(isSubmitting ? { loading: true } : {})}
                {...(!shop ? { disabled: true } : {})}
              >
                Start New Scan
              </s-button>
              <s-link href="/app/scans">View Scan History</s-link>
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
