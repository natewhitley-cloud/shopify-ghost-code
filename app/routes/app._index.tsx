import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  isRouteErrorResponse,
  redirect,
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getScansForShop, createScan } from "../models/scan.server";
import { getFindingSummary } from "../models/finding.server";
import { canStartScan } from "../lib/plan-gating.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    // Shop hasn't been upserted yet (e.g. install is still in progress).
    // Return minimal data so the page renders without crashing.
    return { shop: null, latestScan: null, findingSummary: null };
  }

  // getScansForShop returns newest-first; take the first result.
  const [latestScan = null] = await getScansForShop(shop.id, { limit: 1 });

  const findingSummary = latestScan
    ? await getFindingSummary(latestScan.id)
    : null;

  return { shop, latestScan, findingSummary };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);
  if (!shop) {
    return { error: "Shop not found. Please reinstall the app." };
  }

  // Plan-gate: check if this shop is allowed to start a new scan.
  const gate = await canStartScan(shop.id, shop.plan);
  if (!gate.allowed) {
    return { error: gate.reason ?? "Scan limit reached for your current plan." };
  }

  // TODO: Replace hardcoded themeId/themeName with values from a theme-selector
  // UI once theme listing is implemented. These placeholders allow the record
  // creation and Inngest dispatch path to be exercised in the meantime.
  const themeId = "placeholder-theme-id";
  const themeName = "Active Theme";

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
  const { shop, latestScan, findingSummary } = useLoaderData<typeof loader>();
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

  return (
    <s-page heading="Ghost Code Scanner">
      {/* Error banner — only rendered when the action returns an error */}
      {actionError && (
        <s-banner tone="critical">
          <s-paragraph>{actionError}</s-paragraph>
        </s-banner>
      )}

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
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <s-page heading={`Error ${error.status}`}>
        <s-card>
          <s-banner tone="critical">
            <s-paragraph>{error.statusText || "Something went wrong"}</s-paragraph>
          </s-banner>
        </s-card>
      </s-page>
    );
  }

  return (
    <s-page heading="Error">
      <s-card>
        <s-banner tone="critical">
          <s-paragraph>An unexpected error occurred. Please try again.</s-paragraph>
        </s-banner>
      </s-card>
    </s-page>
  );
}
