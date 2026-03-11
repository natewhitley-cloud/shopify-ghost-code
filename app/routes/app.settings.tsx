import type { LoaderFunctionArgs } from "react-router";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getPlanFeatures } from "../lib/billing.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const features = getPlanFeatures(shop.plan);

  return { shop: { plan: shop.plan, domain: shop.domain }, features };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Settings() {
  const { shop, features } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-link slot="primary-action" href="/app">
        Back to Dashboard
      </s-link>

      {/* Current Plan */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Current Plan</s-heading>
          <s-paragraph>
            You are on the <strong>{shop.plan}</strong> plan.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              {features.maxScansPerMonth === Infinity
                ? "Unlimited"
                : features.maxScansPerMonth}{" "}
              scans per month
            </s-list-item>
            <s-list-item>
              Finding details: {features.showFindingDetails ? "Yes" : "Count only"}
            </s-list-item>
            <s-list-item>
              Multiple themes:{" "}
              {features.maxThemes === Infinity ? "Yes" : "No"}
            </s-list-item>
            <s-list-item>
              Auto-rescan: {features.autoRescan ? "Yes" : "No"}
            </s-list-item>
            <s-list-item>
              Scan diffing: {features.scanDiffing ? "Yes" : "No"}
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      </s-card>

      {/* About */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>About Ghost Code</s-heading>
          <s-paragraph>
            Ghost Code scans your Shopify themes for leftover code from
            uninstalled apps. This orphaned code can slow down your store,
            break functionality, and create security risks.
          </s-paragraph>
          <s-paragraph>
            <s-text>Version: 1.0.0</s-text>
          </s-paragraph>
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
