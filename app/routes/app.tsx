import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";

import { logger } from "../lib/logger.server";
import { getShopMetadata, upsertShop } from "../models/shop.server";
import { isPlanReconcileStale, reconcileShopPlan } from "../services/billing-reconciler.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  let shop = await getShopMetadata(session.shop);
  if (!shop) {
    // Shop record doesn't exist yet — create it on first authenticated visit.
    // This covers the case where the app/installed webhook isn't available.
    await upsertShop(session.shop);
    shop = await getShopMetadata(session.shop);
  }

  // Lazy plan reconciliation (CMP-2 / GC-fur): plan state is otherwise set only
  // from the APP_SUBSCRIPTIONS_UPDATE webhook, so a missed/stale webhook can
  // silently drift the stored plan. When the stored plan is stale (or never
  // reconciled), reconcile it against Shopify's actual active subscriptions.
  // Wrapped in try/catch — reconciliation must NEVER break the app load; on any
  // error we log and continue with the stored plan.
  if (shop && isPlanReconcileStale(shop.planReconciledAt)) {
    try {
      await reconcileShopPlan(admin, { domain: shop.domain, plan: shop.plan });
    } catch (err) {
      logger.error("billing-reconcile-loader-failed", {
        shop: session.shop,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/scans">Scan History</s-link>
        <s-link href="/app/settings">Billing</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
