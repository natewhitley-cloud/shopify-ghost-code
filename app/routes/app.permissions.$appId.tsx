import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import {
  type ScopeSensitivity,
  getScopeSensitivity,
  getUnexpectedScopes,
} from "../data/category-permissions.server";
import { getPlanFeatures } from "../lib/billing.server";
import { formatDate } from "../lib/format";
import { riskTone, riskLabel, sensitivityTone } from "../lib/risk-display";
import { getInstalledAppById } from "../models/installed-app.server";
import { getShopByDomain } from "../models/shop.server";
import { enrichApp } from "../services/app-enrichment.server";
import type { AppRiskScore } from "../services/permission-scorer.server";
import { scoreApp } from "../services/permission-scorer.server";
// No longer imports fetchAllInstalledApps — detail route reads cached scopes from DB
import { authenticate } from "../shopify.server";
// db import removed — detail route reads from cached InstalledApp, no direct DB writes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeDetail {
  handle: string;
  description: string;
  sensitivity: ScopeSensitivity;
  isExpected: boolean;
}

interface PermissionDetailLoaderData {
  app: {
    id: string;
    appName: string;
    appHandle: string;
    presence: string;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  enrichment: {
    categoryName: string | null;
    rating: number | null;
    reviewCount: number | null;
    pricingModel: string | null;
  };
  riskScore: AppRiskScore;
  scopes: ScopeDetail[];
}

// ---------------------------------------------------------------------------
// Scope description defaults
// ---------------------------------------------------------------------------

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read_products: "Read product listings, variants, and collections",
  write_products: "Create, update, and delete products and collections",
  read_orders: "Read order details from the last 60 days",
  write_orders: "Create, update, cancel, and refund orders",
  read_all_orders: "Read full order history (beyond 60 days)",
  read_customers: "Read customer data including contact information",
  write_customers: "Create, update, and delete customer records",
  read_inventory: "Read inventory levels and locations",
  write_inventory: "Update inventory levels and manage locations",
  read_shipping: "Read shipping rates and carrier services",
  write_shipping: "Create and update shipping rates and carriers",
  read_fulfillments: "Read fulfillment and tracking information",
  write_fulfillments: "Create and update fulfillments",
  read_themes: "Read theme files and assets",
  write_themes: "Create, update, and delete theme files",
  read_content: "Read pages, blogs, and articles",
  write_content: "Create, update, and delete pages and blog posts",
  read_script_tags: "Read script tags injected into storefront",
  write_script_tags: "Inject and remove scripts from storefront pages",
  read_discounts: "Read discount codes and automatic discounts",
  write_discounts: "Create, update, and delete discounts",
  read_price_rules: "Read price rules for discounts",
  write_price_rules: "Create, update, and delete price rules",
  read_analytics: "Read store analytics and reports",
  read_marketing_events: "Read marketing events and campaigns",
  write_marketing_events: "Create and manage marketing campaigns",
  read_draft_orders: "Read draft orders",
  write_draft_orders: "Create, update, and delete draft orders",
  read_gift_cards: "Read gift card details",
  write_gift_cards: "Create and update gift cards",
  read_checkouts: "Read checkout data",
  write_checkouts: "Create and modify checkouts",
  read_payment_terms: "Read payment terms for orders",
  write_payment_terms: "Create and update payment terms",
  read_locales: "Read store locale settings",
  read_markets: "Read market configurations",
  read_reports: "Read store reports",
  read_translations: "Read content translations",
  read_shopify_payments_payouts: "Read Shopify Payments payout data",
  read_store_credit: "Read store credit balances",
  read_customer_merge: "Read customer merge history",
  read_online_store_pages: "Read online store pages",
  write_online_store_pages: "Create, update, and delete online store pages",
  write_payment_gateways: "Manage payment gateway configurations",
  write_merchant_managed_fulfillment_orders: "Manage merchant-managed fulfillment orders",
  write_third_party_fulfillment_orders: "Manage third-party fulfillment orders",
  read_merchant_managed_fulfillment_orders: "Read merchant-managed fulfillment orders",
  read_third_party_fulfillment_orders: "Read third-party fulfillment orders",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// riskTone, riskLabel, sensitivityTone imported from ../lib/risk-display

function getScopeDescription(handle: string, apiDescription: string | null): string {
  if (apiDescription) return apiDescription;
  return SCOPE_DESCRIPTIONS[handle] ?? `Access to ${handle.replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { appId } = params;

  if (!appId) {
    throw new Response("App ID is required", { status: 400 });
  }

  // Verify the authenticated shop and feature access
  const shop = await getShopByDomain(session.shop);
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const features = getPlanFeatures(shop.plan);
  if (!features.permissionAuditEnabled) {
    throw new Response("Permission Audit is not enabled", { status: 403 });
  }

  // Check if read_apps scope is granted
  const grantedScopes = session.scope ? session.scope.split(",") : [];
  if (!grantedScopes.includes("read_apps")) {
    throw new Response("read_apps scope not granted", { status: 403 });
  }

  // Look up the app record
  const installedApp = await getInstalledAppById(appId);
  if (!installedApp || installedApp.shopId !== shop.id) {
    throw new Response("App not found", { status: 404 });
  }

  // Read cached scopes from DB (synced by list route during last visit)
  let scopeHandles: string[] = [];
  try {
    scopeHandles = JSON.parse(installedApp.grantedScopes || "[]");
  } catch {
    // Corrupted JSON in DB — treat as no scopes rather than crashing the page
  }

  // Enrich with category/rating data
  const enrichment = enrichApp(installedApp.appHandle);
  const categorySlug = enrichment?.categorySlug ?? null;

  // Score the app
  const riskScore = scoreApp(scopeHandles, categorySlug);

  // Determine unexpected scopes
  const unexpectedSet = new Set(
    categorySlug !== null ? getUnexpectedScopes(categorySlug, scopeHandles) : [],
  );

  // Build scope details (scopes come from DB cache, descriptions from fallback map)
  const scopes: ScopeDetail[] = scopeHandles.map((handle) => ({
    handle,
    description: getScopeDescription(handle, null),
    sensitivity: getScopeSensitivity(handle),
    isExpected: !unexpectedSet.has(handle),
  }));

  // Sort scopes: unexpected first, then by sensitivity (critical > high > medium > low)
  const sensitivityOrder: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  scopes.sort((a, b) => {
    if (a.isExpected !== b.isExpected) return a.isExpected ? 1 : -1;
    return (sensitivityOrder[a.sensitivity] ?? 99) - (sensitivityOrder[b.sensitivity] ?? 99);
  });

  const data: PermissionDetailLoaderData = {
    app: {
      id: installedApp.id,
      appName: installedApp.appName,
      appHandle: installedApp.appHandle,
      presence: installedApp.presence,
      firstSeenAt: installedApp.firstSeenAt.toISOString(),
      lastSeenAt: installedApp.lastSeenAt.toISOString(),
    },
    enrichment: {
      categoryName: enrichment?.categoryName ?? installedApp.publicCategory ?? null,
      rating: enrichment?.rating ?? null,
      reviewCount: enrichment?.reviewCount ?? null,
      pricingModel: enrichment?.pricingModel ?? null,
    },
    riskScore,
    scopes,
  };

  return data;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PermissionDetail() {
  const { app, enrichment, riskScore, scopes } = useLoaderData<
    typeof loader
  >() as PermissionDetailLoaderData;

  return (
    <s-page heading={app.appName}>
      <s-link slot="primary-action" href="/app/permissions">
        Back to Permission Audit
      </s-link>

      {/* Risk score banner */}
      <s-banner tone={riskTone(riskScore.level)}>
        <s-stack direction="inline" gap="base">
          <s-text>
            <strong>Risk Score: {riskScore.score}/100</strong>
          </s-text>
          <s-badge tone={riskTone(riskScore.level)}>{riskLabel(riskScore.level)}</s-badge>
        </s-stack>
      </s-banner>

      {/* App info card */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>App Information</s-heading>
          <s-data-table>
            <table>
              <tbody>
                <tr>
                  <td>
                    <strong>Name</strong>
                  </td>
                  <td>{app.appName}</td>
                </tr>
                <tr>
                  <td>
                    <strong>Category</strong>
                  </td>
                  <td>{enrichment.categoryName ?? "Unknown category"}</td>
                </tr>
                {enrichment.rating !== null && (
                  <tr>
                    <td>
                      <strong>Rating</strong>
                    </td>
                    <td>
                      {enrichment.rating.toFixed(1)}
                      {enrichment.reviewCount !== null && ` (${enrichment.reviewCount} reviews)`}
                    </td>
                  </tr>
                )}
                {enrichment.pricingModel !== null && (
                  <tr>
                    <td>
                      <strong>Pricing</strong>
                    </td>
                    <td>{enrichment.pricingModel}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </s-data-table>
        </s-stack>
      </s-card>

      {/* Granted scopes card */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Granted Scopes ({scopes.length})</s-heading>
          {scopes.length === 0 ? (
            <s-paragraph>No scopes granted to this app.</s-paragraph>
          ) : (
            <s-data-table>
              <table>
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Description</th>
                    <th>Sensitivity</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scopes.map((scope) => (
                    <tr key={scope.handle}>
                      <td>
                        <code>{scope.handle}</code>
                      </td>
                      <td>{scope.description}</td>
                      <td>
                        <s-badge tone={sensitivityTone(scope.sensitivity)}>
                          {scope.sensitivity}
                        </s-badge>
                      </td>
                      <td>
                        {scope.isExpected ? (
                          <s-badge tone="success">Expected</s-badge>
                        ) : (
                          <s-badge tone="warning">Unexpected</s-badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </s-data-table>
          )}
        </s-stack>
      </s-card>

      {/* Risk factors card */}
      {riskScore.factors.length > 0 && (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Risk Factors</s-heading>
            <s-unordered-list>
              {riskScore.factors.map((factor, index) => (
                <s-list-item key={index}>
                  {factor.description} (impact: +{factor.impact})
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        </s-card>
      )}

      {/* Timestamps card */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Tracking Information</s-heading>
          <s-data-table>
            <table>
              <tbody>
                <tr>
                  <td>
                    <strong>Status</strong>
                  </td>
                  <td>
                    <s-badge tone={app.presence === "INSTALLED" ? "success" : "warning"}>
                      {app.presence === "INSTALLED" ? "Installed" : "Removed"}
                    </s-badge>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>First seen</strong>
                  </td>
                  <td>{formatDate(app.firstSeenAt)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>Last seen</strong>
                  </td>
                  <td>{formatDate(app.lastSeenAt)}</td>
                </tr>
              </tbody>
            </table>
          </s-data-table>
        </s-stack>
      </s-card>

      {/* Transparency footer */}
      <s-card>
        <s-paragraph>
          <s-text>
            Scopes shown are what this app has been granted access to — not necessarily what it
            actively uses. Shopify does not expose app activity data to other apps.
          </s-text>
        </s-paragraph>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
