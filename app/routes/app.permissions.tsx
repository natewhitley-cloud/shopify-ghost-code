import { useCallback, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { getPlanFeatures } from "../lib/billing.server";
import { riskTone, riskLabel } from "../lib/risk-display";
import { getInstalledApps } from "../models/installed-app.server";
import { getShopByDomain } from "../models/shop.server";
import { enrichApps } from "../services/app-enrichment.server";
import { fetchAllInstalledApps, syncInstalledApps } from "../services/permission-fetcher.server";
import type { AppRiskScore, StoreRiskScore } from "../services/permission-scorer.server";
import { scoreApp, scoreStore } from "../services/permission-scorer.server";
import { authenticate } from "../shopify.server";
// db import removed — syncInstalledApps uses model layer internally

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScoredApp {
  id: string;
  appName: string;
  appHandle: string;
  scopeCount: number;
  riskScore: AppRiskScore;
  categoryName: string | null;
}

type PermissionsLoaderData =
  | { state: "feature-gated" }
  | { state: "scope-request" }
  | { state: "onboarding" }
  | {
      state: "active";
      apps: ScoredApp[];
      storeScore: StoreRiskScore;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// riskTone, riskLabel imported from ../lib/risk-display

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const features = getPlanFeatures(shop.plan);

  if (!features.permissionAuditEnabled) {
    return { state: "feature-gated" as const };
  }

  // Check if the read_apps optional scope has been granted
  const grantedScopes = session.scope ? session.scope.split(",") : [];
  const hasReadAppsScope = grantedScopes.includes("read_apps");

  if (!hasReadAppsScope) {
    return { state: "scope-request" as const };
  }

  // Fetch and sync installed apps — skip if data is fresh (synced within last 5 minutes).
  // This avoids a full Shopify API call + N DB upserts on every page navigation.
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const existingApps = await getInstalledApps(shop.id);
  const lastSync = existingApps.length > 0 ? existingApps[0].lastSeenAt : null;
  const isStale = !lastSync || Date.now() - new Date(lastSync).getTime() > STALE_THRESHOLD_MS;

  if (isStale) {
    const fetchedApps = await fetchAllInstalledApps(admin);
    if (fetchedApps.length > 0) {
      await syncInstalledApps(shop.id, fetchedApps);
    }
  }

  const installedApps = isStale ? await getInstalledApps(shop.id) : existingApps;

  if (installedApps.length === 0) {
    return { state: "onboarding" as const };
  }

  // Build enrichment map for category data
  const appHandles = installedApps.map((a) => a.appHandle);
  const enrichmentMap = enrichApps(appHandles);

  // Score each app using cached scopes from DB
  const scoredApps: ScoredApp[] = installedApps.map((app) => {
    const enrichment = enrichmentMap.get(app.appHandle);
    const categorySlug = enrichment?.categorySlug ?? null;

    let scopes: string[] = [];
    try {
      scopes = JSON.parse(app.grantedScopes || "[]");
    } catch {
      // Corrupted JSON in DB — treat as no scopes rather than crashing the page
    }
    const riskScore = scoreApp(scopes, categorySlug);

    return {
      id: app.id,
      appName: app.appName,
      appHandle: app.appHandle,
      scopeCount: scopes.length,
      riskScore,
      categoryName: enrichment?.categoryName ?? app.publicCategory ?? null,
    };
  });

  // Sort by risk score descending (highest risk first)
  scoredApps.sort((a, b) => b.riskScore.score - a.riskScore.score);

  const appScores = scoredApps.map((a) => a.riskScore);
  const storeScore = scoreStore(appScores);

  return {
    state: "active" as const,
    apps: scoredApps,
    storeScore,
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PermissionAudit() {
  const data = useLoaderData<typeof loader>() as PermissionsLoaderData;

  if (data.state === "feature-gated") {
    return <FeatureGatedState />;
  }

  if (data.state === "scope-request") {
    return <ScopeRequestState />;
  }

  if (data.state === "onboarding") {
    return <OnboardingState />;
  }

  return <ActiveAuditState apps={data.apps} storeScore={data.storeScore} />;
}

// ---------------------------------------------------------------------------
// State 1: Feature Gated
// ---------------------------------------------------------------------------

function FeatureGatedState() {
  return (
    <s-page heading="Permission Audit">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Permission Audit is Coming Soon</s-heading>
          <s-paragraph>
            Every Shopify app you install gets access to parts of your store — orders, customers,
            products, and more. Permission Audit will help you see exactly what each app can access
            and flag permissions that deserve a closer look.
          </s-paragraph>
          <s-paragraph>
            <s-text>
              In the meantime, you can review your app permissions manually. Go to{" "}
              <strong>Settings &gt; Apps and sales channels</strong> in your Shopify admin, click
              any app, and review its &quot;Store access&quot; section.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// State 2: Scope Request (feature enabled, but read_apps scope not granted)
// ---------------------------------------------------------------------------

function ScopeRequestState() {
  const [declined, setDeclined] = useState(false);

  const handleRequestScope = useCallback(async () => {
    try {
      // shopify global is injected by App Bridge CDN in embedded apps
      const result = await (
        window as unknown as {
          shopify: {
            scopes: { request: (opts: { scopes: string[] }) => Promise<{ granted: boolean }> };
          };
        }
      ).shopify.scopes.request({
        scopes: ["read_apps"],
      });
      if (result.granted) {
        window.location.reload();
      } else {
        setDeclined(true);
      }
    } catch (error) {
      console.error("Scope request failed:", error);
      setDeclined(true);
    }
  }, []);

  return (
    <s-page heading="Permission Audit">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      <s-banner tone="warning">
        Every app you install gets API access to your store. If an app is compromised or its data is
        leaked, those permissions become attack vectors. Most merchants never review what access
        they&apos;ve granted.
      </s-banner>

      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Why This Matters: A Real Example</s-heading>
          <s-paragraph>
            In 2024, a popular chargeback management app (Disputifier) suffered an API credential
            leak. Because the app had <strong>write access to orders</strong>, attackers were able
            to issue unauthorized refunds — some merchants reported losses exceeding $12,000 before
            the breach was contained.
          </s-paragraph>
          <s-paragraph>
            The root issue was not the breach itself — breaches happen. The issue was that merchants
            had no visibility into what permissions the app held, and no habit of reviewing them.
          </s-paragraph>
        </s-stack>
      </s-card>

      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Enable Automated App Scanning</s-heading>
          <s-paragraph>
            To scan your installed apps and audit their permissions, Ghost Code needs read-only
            access to your app list. This permission lets us see which apps are installed and what
            access scopes they hold — we cannot modify or uninstall anything.
          </s-paragraph>
          <s-paragraph>
            <s-text>
              Click the button below to grant the <code>read_apps</code> permission. Shopify will
              show a confirmation dialog — review it and approve to enable automated scanning.
            </s-text>
          </s-paragraph>
          <s-button variant="primary" onClick={handleRequestScope}>
            Enable App Scanning
          </s-button>
          {declined && (
            <s-banner tone="info">
              You can still review your app permissions manually. Go to{" "}
              <strong>Settings &gt; Apps and sales channels</strong> in your Shopify admin, click
              any app, and review its &quot;Store access&quot; section. You can enable automated
              scanning at any time by revisiting this page.
            </s-banner>
          )}
          {!declined && (
            <s-paragraph>
              <s-text>
                If you prefer not to grant this permission, you can still review your app
                permissions manually. Go to <strong>Settings &gt; Apps and sales channels</strong>{" "}
                in your Shopify admin, click any app, and review its &quot;Store access&quot;
                section.
              </s-text>
            </s-paragraph>
          )}
        </s-stack>
      </s-card>

      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Permissions That Deserve Scrutiny</s-heading>
          <s-paragraph>
            Not all permissions are equal. These carry the most risk if an app is compromised:
          </s-paragraph>

          <s-data-table>
            <table>
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>Risk Level</th>
                  <th>What It Means</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>write_orders</code>
                  </td>
                  <td>
                    <s-badge tone="critical">Critical</s-badge>
                  </td>
                  <td>Can create, edit, or refund orders — direct financial risk</td>
                </tr>
                <tr>
                  <td>
                    <code>write_customers</code>
                  </td>
                  <td>
                    <s-badge tone="critical">Critical</s-badge>
                  </td>
                  <td>Can modify or export customer PII — privacy and compliance risk</td>
                </tr>
                <tr>
                  <td>
                    <code>read_all_orders</code>
                  </td>
                  <td>
                    <s-badge tone="critical">Critical</s-badge>
                  </td>
                  <td>Access to full order history, not just last 60 days</td>
                </tr>
                <tr>
                  <td>
                    <code>write_products</code>
                  </td>
                  <td>
                    <s-badge tone="warning">High</s-badge>
                  </td>
                  <td>Can modify product listings, prices, and inventory</td>
                </tr>
                <tr>
                  <td>
                    <code>write_themes</code>
                  </td>
                  <td>
                    <s-badge tone="warning">High</s-badge>
                  </td>
                  <td>Can inject code into your storefront theme</td>
                </tr>
                <tr>
                  <td>
                    <code>read_analytics</code>
                  </td>
                  <td>
                    <s-badge tone="info">Low</s-badge>
                  </td>
                  <td>Read-only access to store analytics — limited risk</td>
                </tr>
              </tbody>
            </table>
          </s-data-table>

          <s-paragraph>
            <s-text>
              Ask yourself: does this app actually need this permission for what it does? A reviews
              app should not need <code>write_orders</code>. A shipping app should not need{" "}
              <code>write_customers</code>.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// State 3: Onboarding (scope granted but no apps found)
// ---------------------------------------------------------------------------

function OnboardingState() {
  return (
    <s-page heading="Permission Audit">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      <s-banner tone="info">
        App scanning is enabled, but no installed apps were found. This is unusual — most stores
        have at least one app installed. If you just granted the permission, try refreshing the
        page.
      </s-banner>

      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>No Installed Apps Found</s-heading>
          <s-paragraph>
            Ghost Code scans the apps installed on your store and audits their permissions. We were
            not able to find any installed apps to audit.
          </s-paragraph>
          <s-paragraph>
            <s-text>
              If you believe this is an error, try refreshing the page. You can also verify your
              installed apps by going to <strong>Settings &gt; Apps and sales channels</strong> in
              your Shopify admin.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// State 4: Active Audit (apps found)
// ---------------------------------------------------------------------------

function ActiveAuditState({ apps, storeScore }: { apps: ScoredApp[]; storeScore: StoreRiskScore }) {
  const criticalCount = apps.filter((a) => a.riskScore.level === "critical").length;
  const highCount = apps.filter((a) => a.riskScore.level === "high").length;

  return (
    <s-page heading="Permission Audit">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      {/* Store-wide risk score banner */}
      <s-banner tone={riskTone(storeScore.level)}>
        <s-stack direction="block" gap="base">
          <s-text>
            <strong>Store Risk Score: {storeScore.score}/100</strong> ({riskLabel(storeScore.level)}
            )
          </s-text>
          <s-text>
            {storeScore.appCount} app{storeScore.appCount !== 1 ? "s" : ""} scanned
            {criticalCount > 0 && ` — ${criticalCount} critical risk`}
            {highCount > 0 && ` — ${highCount} high risk`}
          </s-text>
        </s-stack>
      </s-banner>

      {/* Transparency note */}
      <s-banner tone="info">
        <s-text>
          <strong>What you are seeing:</strong> Ghost Code shows the permissions each app has been{" "}
          <em>granted</em> — what they <em>can</em> access. We cannot determine what an app actually
          reads or writes. A permission flagged here does not mean the app is misusing it — it means
          the access exists and is worth knowing about.
        </s-text>
      </s-banner>

      {/* Audit summary */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Audit Summary</s-heading>
          <s-stack direction="inline" gap="base">
            <s-badge tone="critical">{criticalCount} Critical</s-badge>
            <s-badge tone="warning">{highCount} High</s-badge>
            <s-badge tone="info">
              {apps.filter((a) => a.riskScore.level === "medium").length} Medium
            </s-badge>
            <s-badge tone="success">
              {apps.filter((a) => a.riskScore.level === "low").length} Low
            </s-badge>
          </s-stack>
          <s-paragraph>
            {apps.length} app{apps.length !== 1 ? "s" : ""} scanned.
          </s-paragraph>
        </s-stack>
      </s-card>

      {/* App list */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Installed Apps</s-heading>
          <s-data-table>
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Scopes</th>
                  <th>Risk Level</th>
                  <th>Category</th>
                  <th>
                    <span
                      style={{
                        position: "absolute",
                        width: "1px",
                        height: "1px",
                        overflow: "hidden",
                        clip: "rect(0,0,0,0)",
                      }}
                    >
                      Actions
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id}>
                    <td>{app.appName}</td>
                    <td>{app.scopeCount}</td>
                    <td>
                      <s-badge tone={riskTone(app.riskScore.level)}>
                        {riskLabel(app.riskScore.level)} ({app.riskScore.score})
                      </s-badge>
                    </td>
                    <td>{app.categoryName ?? "—"}</td>
                    <td>
                      <Link to={`/app/permissions/${app.id}`}>View Details</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-data-table>
        </s-stack>
      </s-card>

      {/* Education footer */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Understanding Permission Levels</s-heading>
          <s-unordered-list>
            <s-list-item>
              <strong>Critical:</strong> Permissions that allow financial transactions or access to
              full customer data (<code>write_orders</code>, <code>write_customers</code>,{" "}
              <code>read_all_orders</code>)
            </s-list-item>
            <s-list-item>
              <strong>High:</strong> Permissions that allow modification of store content or theme
              code (<code>write_products</code>, <code>write_themes</code>)
            </s-list-item>
            <s-list-item>
              <strong>Low:</strong> Read-only permissions with limited blast radius (
              <code>read_analytics</code>, <code>read_products</code>)
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            <s-text>
              For more details, see{" "}
              <a
                href="https://shopify.dev/docs/api/usage/access-scopes"
                target="_blank"
                rel="noopener noreferrer"
              >
                Shopify&apos;s access scopes documentation
              </a>
              .
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
